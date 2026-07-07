/**
 * notify.ts classifier tests (M2): cooldown, batching, self-suppression,
 * boot-watermark suppression, mention on/off, member + pipe id shape gates,
 * and the hostile toast-string invariants (no ESC/C1/ticket, bounded).
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension } from "./helpers.mjs";
import {
	HOSTILE_TICKET,
	IDENTITY_ADMIN,
	IDENTITY_AGENT,
	PIPE_ID,
	hostileTailRows,
} from "./fixtures.mjs";

const ext = await loadExtension();
const { ToastClassifier } = await ext.importModule("tui/notify");

after(() => ext.cleanup());

const FROM_ADMIN = IDENTITY_ADMIN.slice(0, 8);
const FROM_AGENT = IDENTITY_AGENT.slice(0, 8);

const fence = "```";
const taskBody = (id, title = "a title") =>
	`${fence}room-task\nid: ${id}\ntype: implement\ntitle: ${title}\n${fence}`;

let eventSeq = 0;
const row = (body, { lamport = 100 + ++eventSeq, from = FROM_ADMIN } = {}) => ({
	event_id: `blake3:${String(lamport).padStart(4, "0").repeat(16)}`,
	event_type: "message.text",
	lamport,
	from,
	body,
});

function makeClassifier({ identity = true, cooldownMs } = {}) {
	const classifier = new ToastClassifier(cooldownMs !== undefined ? { cooldownMs } : {});
	if (identity) {
		classifier.setIdentity({ identityId: IDENTITY_AGENT, name: "pi-agent" });
	}
	return classifier;
}

const classify = (classifier, input) =>
	classifier.classify({ now: 0, freshRows: [], ...input });

/* ------------------------------- task_new --------------------------------- */

test("task_new: one task => id + title toast; ids are shape-checked before display", () => {
	const classifier = makeClassifier();
	const toasts = classify(classifier, { freshRows: [row(taskBody("T-1", "Fix the bug"))] });
	assert.equal(toasts.length, 1);
	assert.equal(toasts[0].kind, "task_new");
	assert.equal(toasts[0].type, "info");
	assert.equal(toasts[0].message, "iroh-room: new task~ T-1: Fix the bug");

	const weird = makeClassifier();
	// id fails TASK_ID_COMPLETION_RE (leading dash) -> omitted from the toast
	const hidden = classify(weird, { freshRows: [row(taskBody("-lead", "odd id"))] });
	assert.equal(hidden[0].message, "iroh-room: new task~: odd id");
});

test("task_new: batching — N new tasks => ONE count-only toast (no titles)", () => {
	const classifier = makeClassifier();
	const toasts = classify(classifier, {
		freshRows: [row(taskBody("B-1")), row(`${taskBody("B-2")}\n${taskBody("B-3")}`)],
	});
	assert.equal(toasts.length, 1);
	assert.equal(toasts[0].message, "iroh-room: 3 new tasks~");
});

test("task_new: knownTaskIds dedupe — already-tracked ids never re-toast", () => {
	const classifier = makeClassifier();
	const toasts = classify(classifier, {
		freshRows: [row(taskBody("K-1")), row(taskBody("K-2"))],
		knownTaskIds: new Set(["K-1"]),
	});
	assert.equal(toasts[0].message, "iroh-room: new task~ K-2: a title");
});

/* ------------------------------ suppression -------------------------------- */

test("self-author suppression: rows from our own from8 never toast", () => {
	const classifier = makeClassifier();
	const toasts = classify(classifier, {
		freshRows: [row(taskBody("SELF-1"), { from: FROM_AGENT })],
	});
	assert.deepEqual(toasts, []);
});

test("boot-watermark suppression: rows at-or-below the init watermark never toast", () => {
	const classifier = makeClassifier();
	classifier.markBoot([row("old", { lamport: 50 }), row("older", { lamport: 40 })]);
	const atBoot = classify(classifier, { freshRows: [row(taskBody("OLD-1"), { lamport: 45 })] });
	assert.deepEqual(atBoot, [], "below the watermark: suppressed");
	const after = classify(classifier, { freshRows: [row(taskBody("NEW-1"), { lamport: 60 })] });
	assert.equal(after.length, 1, "above the watermark: toasts");
});

/* -------------------------------- cooldown --------------------------------- */

test("per-kind 30s cooldown with injected now; kinds cool down independently", () => {
	const classifier = makeClassifier();
	const first = classifier.classify({ now: 1_000, freshRows: [row(taskBody("C-1"))] });
	assert.equal(first.length, 1);
	const inside = classifier.classify({ now: 20_000, freshRows: [row(taskBody("C-2"))] });
	assert.deepEqual(inside, [], "second task_new inside 30s is dropped");
	// a DIFFERENT kind is not affected by the task_new cooldown
	const otherKind = classifier.classify({ now: 20_000, freshRows: [], closedOwnPipes: [PIPE_ID] });
	assert.equal(otherKind.length, 1);
	assert.equal(otherKind[0].kind, "pipe_closed_own");
	const past = classifier.classify({ now: 31_001, freshRows: [row(taskBody("C-3"))] });
	assert.equal(past.length, 1, "cooldown expired");
});

/* -------------------------------- mentions --------------------------------- */

test("mention: @display_name (>=3 chars) and @from8, word-boundary, case-insensitive", () => {
	const classifier = makeClassifier();
	const byName = classify(classifier, { freshRows: [row("hey @PI-AGENT look at this")] });
	assert.equal(byName.length, 1);
	assert.equal(byName[0].kind, "mention");
	assert.equal(byName[0].message, `iroh-room: mentioned by ${FROM_ADMIN}`);

	const two = makeClassifier();
	const byFrom8 = classify(two, { freshRows: [row(`ping @${FROM_AGENT}!`)] });
	assert.equal(byFrom8.length, 1);

	const three = makeClassifier();
	// substring of a longer word: NOT a mention (word boundary)
	assert.deepEqual(classify(three, { freshRows: [row("email x@pi-agentxyz.example")] }), []);
});

test("mention: short display names (<3 chars) only match via from8", () => {
	const classifier = new ToastClassifier();
	classifier.setIdentity({ identityId: IDENTITY_AGENT, name: "pi" });
	assert.deepEqual(classify(classifier, { freshRows: [row("hi @pi")] }), []);
	assert.equal(classify(classifier, { freshRows: [row(`hi @${FROM_AGENT}`)] }).length, 1);
});

test("mention detection is silently OFF without identity (fetch failed)", () => {
	const classifier = makeClassifier({ identity: false });
	assert.deepEqual(classify(classifier, { freshRows: [row("hey @pi-agent")] }), []);
	classifier.setIdentity(undefined);
	assert.deepEqual(classify(classifier, { freshRows: [row("hey @pi-agent")] }), []);
});

test("mention: zero-width chars inside the handle cannot evade the toast", () => {
	// "@pi<ZW>-agent" renders visually as "@pi-agent" (the char is invisible)
	// — sanitize.ts must strip it BEFORE the literal match so the target's
	// notification fires exactly like the visually identical plain mention.
	for (const code of [0x200b, 0x200c, 0x200d, 0x2060, 0x00ad, 0xfeff]) {
		const zw = String.fromCharCode(code);
		const classifier = makeClassifier();
		const toasts = classify(classifier, {
			freshRows: [row(`hey @pi${zw}-agent can you approve the deploy`)],
		});
		assert.equal(toasts.length, 1, `U+${code.toString(16)} evaded the mention toast`);
		assert.equal(toasts[0].kind, "mention");
	}
});

test("mention batching: several mentioning rows => one count toast", () => {
	const classifier = makeClassifier();
	const toasts = classify(classifier, {
		freshRows: [row("a @pi-agent"), row("b @pi-agent")],
	});
	assert.equal(toasts.length, 1);
	assert.equal(toasts[0].message, "iroh-room: 2 mentions");
});

/* ---------------------------- members + pipes ------------------------------ */

test("member_joined / member_removed: 64-hex gate, self-suppression, batching", () => {
	const classifier = makeClassifier();
	const joined = classify(classifier, { memberJoined: [IDENTITY_ADMIN, "zz-not-hex", IDENTITY_AGENT] });
	assert.equal(joined.length, 1, "invalid + self ids dropped");
	assert.equal(joined[0].kind, "member_joined");
	assert.equal(joined[0].message, `iroh-room: member joined ${FROM_ADMIN}…`);

	const removed = classify(classifier, {
		memberRemoved: [IDENTITY_ADMIN, `${"f".repeat(64)}`],
	});
	assert.equal(removed[0].message, "iroh-room: 2 members removed");
});

test("pipe_closed_own: 32-hex gate, warning type, batching", () => {
	const classifier = makeClassifier();
	const one = classify(classifier, { closedOwnPipes: [PIPE_ID, "not-a-pipe"] });
	assert.equal(one.length, 1);
	assert.equal(one[0].kind, "pipe_closed_own");
	assert.equal(one[0].type, "warning");
	assert.equal(one[0].message, `iroh-room: preview pipe closed unexpectedly: ${PIPE_ID}`);

	const many = makeClassifier();
	const both = classify(many, { closedOwnPipes: [PIPE_ID, "a".repeat(32)] });
	assert.equal(both[0].message, "iroh-room: 2 preview pipes closed unexpectedly");
});

/* --------------------------- hostile invariants ---------------------------- */

const ESC = String.fromCharCode(0x1b);
const C1_CSI = String.fromCharCode(0x9b);
const RLO = String.fromCharCode(0x202e);

function assertToastInvariants(toast) {
	assert.ok(!toast.message.includes(ESC), `ESC leaked: ${JSON.stringify(toast.message)}`);
	assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(toast.message), "C0/C1 leaked");
	assert.ok(!/[\u202A-\u202E\u2066-\u2069]/u.test(toast.message), "bidi leaked");
	assert.ok(!/roomtkt1[0-9a-z]/i.test(toast.message), "ticket leaked");
	assert.ok(toast.message.length <= 160, `unbounded toast: ${toast.message.length}`);
}

test("HOSTILE: a single-task toast sanitizes the raw title (ANSI/C1/bidi/ticket, 12kB)", () => {
	const classifier = makeClassifier();
	const title = [
		ESC,
		"[31mred",
		C1_CSI,
		"31m ",
		RLO,
		"txet ",
		HOSTILE_TICKET,
		" ",
		"B".repeat(12 * 1024),
	].join("");
	const toasts = classify(classifier, { freshRows: [row(taskBody("EVIL-9", title))] });
	assert.equal(toasts.length, 1);
	assert.ok(toasts[0].message.startsWith("iroh-room: new task~ EVIL-9: "), toasts[0].message);
	assertToastInvariants(toasts[0]);
});

test("HOSTILE: the full hostile tail corpus + junk ids never leak into toasts", () => {
	const classifier = makeClassifier();
	const toasts = classifier.classify({
		now: 0,
		freshRows: hostileTailRows,
		memberJoined: [`${ESC}[31m`, "a".repeat(63), "a".repeat(65)],
		memberRemoved: [RLO + "f".repeat(63)],
		closedOwnPipes: [`${ESC}]0;t`, "roomtkt1abc"],
	});
	// the fence-nested EVIL-TASK-1 row is a VALID task -> exactly one toast;
	// every invalid member/pipe id was dropped by its shape gate (U5).
	assert.equal(toasts.length, 1);
	assert.equal(toasts[0].kind, "task_new");
	for (const toast of toasts) {
		assertToastInvariants(toast);
	}
});

test("classifier never throws on garbage input", () => {
	const classifier = makeClassifier();
	assert.doesNotThrow(() =>
		classifier.classify({
			now: 0,
			freshRows: [null, 42, {}, { event_type: "message.text", body: { nested: true } }],
			memberJoined: [null, 5],
			closedOwnPipes: [undefined],
		}),
	);
});
