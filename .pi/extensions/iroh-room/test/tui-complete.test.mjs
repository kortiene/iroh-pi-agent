/**
 * complete.ts tests (M2, invariant U5): completion VALUES must pass their
 * shape validators or be dropped — hostile ids (63/65-hex, room-string
 * injection) never become completion values, and labels never carry raw
 * room strings. Also covers the command wiring (getArgumentCompletions on
 * /room-preview and /room-send).
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension, stubCtx, stubExec, stubPi } from "./helpers.mjs";
import { IDENTITY_ADMIN, IDENTITY_AGENT, PIPE_ID, ROOM_ID } from "./fixtures.mjs";

const ext = await loadExtension();
const { previewArgCompletions, sendArgCompletions, mentionCompletions } =
	await ext.importModule("tui/complete");
const { COMMAND_NAMES } = await ext.importModule("constants");
const { registerIrohCommands } = await ext.importModule("commands");

after(() => ext.cleanup());

const ESC = String.fromCharCode(0x1b);

const MEMBERS = [
	{ id: IDENTITY_ADMIN, role: "admin" },
	{ id: IDENTITY_AGENT, role: "agent" },
];

/* ------------------------------ --allow= (64-hex) --------------------------- */

test("--allow=: only 64-hex member ids become values; hostile ids are dropped", () => {
	const hostile = [
		...MEMBERS,
		{ id: "a".repeat(63), role: "member" }, // 63-hex: too short
		{ id: "a".repeat(65), role: "member" }, // 65-hex: too long
		{ id: `${ESC}[31m${"b".repeat(58)}`, role: "member" }, // room-string injection
		{ id: 42, role: "member" },
		{},
	];
	const items = previewArgCompletions("--allow=", hostile, []);
	assert.deepEqual(
		items.map((item) => item.value),
		[`--allow=${IDENTITY_ADMIN}`, `--allow=${IDENTITY_AGENT}`],
	);
});

test("--allow=: typed prefix filters; head (earlier args) is preserved in values", () => {
	const prefix = `--tcp=127.0.0.1:3000 --allow=${IDENTITY_ADMIN.slice(0, 4)}`;
	const items = previewArgCompletions(prefix, MEMBERS, []);
	assert.equal(items.length, 1);
	assert.equal(items[0].value, `--tcp=127.0.0.1:3000 --allow=${IDENTITY_ADMIN}`);
});

test("--allow=: labels are id8 + sanitized role — never raw room strings", () => {
	const items = previewArgCompletions(
		"--allow=",
		[{ id: IDENTITY_ADMIN, role: `${ESC}[31mevil-role` }],
		[],
	);
	assert.equal(items.length, 1);
	assert.ok(items[0].label.startsWith(`${IDENTITY_ADMIN.slice(0, 8)}…`), items[0].label);
	assert.ok(!items[0].label.includes(ESC), "label must not carry ANSI");
	for (const item of items) {
		assert.ok(!item.value.includes(ESC));
		assert.ok(!(item.description ?? "").includes(ESC));
	}
});

/* ------------------------------ --close= (32-hex) --------------------------- */

test("--close=: only 32-hex pipe ids; junk and wrong lengths dropped", () => {
	const items = previewArgCompletions(
		"--close=",
		[],
		[PIPE_ID, "a".repeat(31), "a".repeat(33), `${ESC}]0;x`, 7],
	);
	assert.deepEqual(items.map((item) => item.value), [`--close=${PIPE_ID}`]);
	assert.equal(items[0].label, PIPE_ID);
});

test("no matching token or no valid values => null (house convention)", () => {
	assert.equal(previewArgCompletions("", MEMBERS, [PIPE_ID]), null);
	assert.equal(previewArgCompletions("--tcp=127.0.0.1:80", MEMBERS, []), null);
	assert.equal(previewArgCompletions("--allow=zzz", MEMBERS, []), null);
	assert.equal(previewArgCompletions("--close=", [], []), null);
	assert.equal(sendArgCompletions("hello world", ["T-1"]), null);
	assert.equal(sendArgCompletions("#zzz", ["T-1"]), null);
});

/* ------------------------- #task-id (TASK_ID_COMPLETION_RE) ----------------- */

test("#task-id: tracked ids must pass TASK_ID_COMPLETION_RE; head preserved", () => {
	const tracked = [
		"IR-PI-001",
		"a.b_c-d",
		"-leading-dash", // fails: first char must be alnum
		"has space", // fails: charset
		"x".repeat(65), // fails: >64 chars
		`${ESC}[31mevil`, // room-string injection
		1234,
	];
	const items = sendArgCompletions("done with #", tracked);
	assert.deepEqual(
		items.map((item) => item.value),
		["done with #IR-PI-001", "done with #a.b_c-d"],
	);
	assert.deepEqual(
		items.map((item) => item.label),
		["#IR-PI-001", "#a.b_c-d"],
	);
	const filtered = sendArgCompletions("see #IR", tracked);
	assert.deepEqual(filtered.map((item) => item.value), ["see #IR-PI-001"]);
});

/* ------------------------------ command wiring ------------------------------ */

function makeWiredCommands() {
	const pi = stubPi();
	const { exec } = stubExec([]);
	const ambient = {
		onSessionStart: async () => {},
		boost: () => {},
		getDensity: () => "2",
		setDensity: async () => {},
		cycleDensity: () => "2",
		shutdown: () => {},
		listMembers: () => MEMBERS,
		listTaskIds: () => ["IR-PI-001", "bad id"],
	};
	registerIrohCommands(pi, { env: { IROH_ROOM_ID: ROOM_ID }, exec, ambient });
	return new Map(pi.commands.map((command) => [command.name, command]));
}

test("/room-preview getArgumentCompletions offers members-poll ids and live pipe ids", () => {
	const byName = makeWiredCommands();
	const complete = byName.get(COMMAND_NAMES.roomPreview).getArgumentCompletions;
	assert.deepEqual(
		complete("--allow=").map((item) => item.value),
		[`--allow=${IDENTITY_ADMIN}`, `--allow=${IDENTITY_AGENT}`],
	);
	assert.equal(complete("--close="), null, "no live pipes -> no close values");
	assert.equal(complete(""), null);
});

test("/room-send getArgumentCompletions offers only shape-valid tracked task ids", () => {
	const byName = makeWiredCommands();
	const complete = byName.get(COMMAND_NAMES.roomSend).getArgumentCompletions;
	assert.deepEqual(
		complete("#").map((item) => item.value),
		["#IR-PI-001"],
	);
	assert.equal(complete("plain text"), null);
});

/* ------------------------- @mention (editor provider) ----------------------- */

test("mentionCompletions: @-token at a word boundary offers @from8 for valid roster ids only", () => {
	const members = new Map([
		[IDENTITY_ADMIN, "admin"],
		[IDENTITY_AGENT, "agent"],
		["a".repeat(63), "member"], // 63-hex: dropped (U5)
		[`${ESC}[31m${"b".repeat(58)}`, "member"], // room-string injection: dropped
	]);
	const line = "ping @";
	const out = mentionCompletions(line, line.length, members);
	assert.deepEqual(
		out.items.map((item) => item.value).sort(),
		[`@${IDENTITY_ADMIN.slice(0, 8)}`, `@${IDENTITY_AGENT.slice(0, 8)}`].sort(),
	);
	assert.equal(out.prefix, "@");
	for (const item of out.items) {
		assert.ok(!item.label.includes(ESC), "label carried a raw room string");
	}
});

test("mentionCompletions: typed prefix filters case-insensitively; mid-word @ never triggers", () => {
	const members = new Map([[IDENTITY_ADMIN, "admin"]]);
	const from8 = IDENTITY_ADMIN.slice(0, 8);
	const typed = `hey @${from8.slice(0, 3).toUpperCase()}`;
	const out = mentionCompletions(typed, typed.length, members);
	assert.equal(out.items.length, 1);
	assert.equal(out.items[0].value, `@${from8}`);
	// "user@host" is an email-ish token, not a mention
	const mid = "mail user@";
	assert.equal(mentionCompletions(mid, mid.length, members), null);
});

test("mentionCompletions: no roster or no match -> null (caller must delegate)", () => {
	const line = "ping @";
	assert.equal(mentionCompletions(line, line.length, undefined), null);
	assert.equal(mentionCompletions(line, line.length, new Map()), null);
	const noMatch = "ping @zzzz";
	assert.equal(
		mentionCompletions(noMatch, noMatch.length, new Map([[IDENTITY_ADMIN, "admin"]])),
		null,
	);
	assert.equal(mentionCompletions("no token here", 4, new Map([[IDENTITY_ADMIN, "admin"]])), null);
});
