import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension, stubExec } from "./helpers.mjs";
import {
	ERROR_STDERR_IDENTITY,
	ERROR_STDERR_ROOM,
	EVENT_SEND,
	EVENT_SHARE,
	EVENT_STATUS,
	EXPOSE_STDOUT,
	FILE_ID,
	IDENTITY_AGENT,
	PIPE_ID,
	ROOM_ID,
	SEND_STDOUT,
	SHARE_STDOUT,
	STATUS_STDOUT,
	TAIL_JSON,
	TAIL_ROWS,
	fail,
	ok,
} from "./fixtures.mjs";

const ext = await loadExtension();
const {
	buildCloseArgs,
	buildExposeArgs,
	buildFileListArgs,
	buildMembersArgs,
	buildPipeListArgs,
	buildSendArgs,
	buildShareArgs,
	buildStatusArgs,
	buildTailArgs,
	buildWhoamiArgs,
	parseCodedError,
	parseConnectHint,
	parseJsonLine,
	parsePipeId,
	parseSendEventId,
	parseShareOutput,
	parseStatusEventId,
	parseTailJson,
	runCli,
	snapshotFromRows,
	summarizeTailRow,
	tokenize,
	withDataDir,
} = await ext.importModule("cli");

after(() => ext.cleanup());

/* ------------------------------ argv builders ----------------------------- */

test("buildStatusArgs: minimal and fully-optioned", () => {
	assert.deepEqual(buildStatusArgs({ room: ROOM_ID, status: "claimed" }), [
		"agent",
		"status",
		ROOM_ID,
		"claimed",
	]);
	assert.deepEqual(
		buildStatusArgs({
			room: ROOM_ID,
			status: "implementing",
			message: "Editing Pi extension tools",
			progress: 45,
			artifactIds: [FILE_ID, "0".repeat(32)],
		}),
		[
			"agent",
			"status",
			ROOM_ID,
			"implementing",
			"--message",
			"Editing Pi extension tools",
			"--progress",
			"45",
			"--artifact",
			FILE_ID,
			"--artifact",
			"0".repeat(32),
		],
	);
});

test("buildSendArgs / buildTailArgs / buildShareArgs", () => {
	assert.deepEqual(buildSendArgs({ room: ROOM_ID, message: "hello" }), [
		"room",
		"send",
		ROOM_ID,
		"hello",
	]);
	assert.deepEqual(buildTailArgs({ room: ROOM_ID, limit: 25 }), [
		"room",
		"tail",
		ROOM_ID,
		"--offline",
		"--json",
		"--limit",
		"25",
	]);
	assert.deepEqual(buildTailArgs({ room: ROOM_ID }), [
		"room",
		"tail",
		ROOM_ID,
		"--offline",
		"--json",
		"--limit",
		"50",
	]);
	assert.deepEqual(buildShareArgs({ room: ROOM_ID, path: "/abs/report.md" }), [
		"file",
		"share",
		ROOM_ID,
		"/abs/report.md",
	]);
	assert.deepEqual(
		buildShareArgs({ room: ROOM_ID, path: "/abs/report.md", name: "report.md", mime: "text/markdown" }),
		["file", "share", ROOM_ID, "/abs/report.md", "--name", "report.md", "--mime", "text/markdown"],
	);
});

test("buildExposeArgs: allow repeats, label and ttl become --label/--expires <n>s", () => {
	assert.deepEqual(
		buildExposeArgs({ room: ROOM_ID, tcp: "127.0.0.1:3000", allow: [IDENTITY_AGENT] }),
		["pipe", "expose", ROOM_ID, "--tcp", "127.0.0.1:3000", "--allow", IDENTITY_AGENT],
	);
	const second = "b".repeat(64);
	assert.deepEqual(
		buildExposeArgs({
			room: ROOM_ID,
			tcp: "127.0.0.1:3000",
			allow: [IDENTITY_AGENT, second],
			label: "preview",
			ttlSeconds: 900,
		}),
		[
			"pipe",
			"expose",
			ROOM_ID,
			"--tcp",
			"127.0.0.1:3000",
			"--allow",
			IDENTITY_AGENT,
			"--allow",
			second,
			"--label",
			"preview",
			"--expires",
			"900s",
		],
	);
});

test("close / members / file list / pipe list / whoami builders", () => {
	assert.deepEqual(buildCloseArgs({ pipeId: PIPE_ID }), ["pipe", "close", PIPE_ID]);
	assert.deepEqual(buildMembersArgs({ room: ROOM_ID }), ["room", "members", ROOM_ID, "--json"]);
	assert.deepEqual(buildFileListArgs({ room: ROOM_ID }), ["file", "list", ROOM_ID, "--json"]);
	assert.deepEqual(buildPipeListArgs({ room: ROOM_ID }), ["pipe", "list", ROOM_ID]);
	assert.deepEqual(buildWhoamiArgs(), ["identity", "show", "--json"]);
});

test("withDataDir prepends the global flag only when home is set", () => {
	assert.deepEqual(withDataDir(undefined, ["room", "send"]), ["room", "send"]);
	assert.deepEqual(withDataDir("/data/agent", ["room", "send"]), [
		"--data-dir",
		"/data/agent",
		"room",
		"send",
	]);
});

/* --------------------------------- parsers -------------------------------- */

test("parseStatusEventId / parseSendEventId pull the event id off line 1", () => {
	assert.equal(parseStatusEventId(STATUS_STDOUT), EVENT_STATUS);
	assert.equal(parseStatusEventId(SEND_STDOUT), undefined);
	assert.equal(parseSendEventId(SEND_STDOUT), EVENT_SEND);
	assert.equal(parseSendEventId(""), undefined);
});

test("parseShareOutput pulls file_id and event id", () => {
	assert.deepEqual(parseShareOutput(SHARE_STDOUT), { fileId: FILE_ID, eventId: EVENT_SHARE });
	assert.deepEqual(parseShareOutput("nothing here"), {});
});

test("parsePipeId / parseConnectHint read the pipe expose startup block", () => {
	assert.equal(parsePipeId(EXPOSE_STDOUT), PIPE_ID);
	assert.equal(parsePipeId("no pipes"), undefined);
	assert.equal(
		parseConnectHint(EXPOSE_STDOUT),
		`iroh-rooms pipe connect ${ROOM_ID} ${PIPE_ID} --local <PORT>`,
	);
});

test("parseCodedError decodes error[<code>]: lines; plain errors return undefined", () => {
	assert.deepEqual(parseCodedError(ERROR_STDERR_ROOM), {
		code: "invalid_room_id",
		detail: "room id must look like blake3:<64 hex chars>",
	});
	assert.deepEqual(parseCodedError(ERROR_STDERR_IDENTITY), {
		code: "identity_not_found",
		detail: "no local identity found",
	});
	assert.equal(parseCodedError("error: something uncoded"), undefined);
	assert.equal(parseCodedError(""), undefined);
});

test("parseJsonLine parses single-line JSON and names the source on failure", () => {
	assert.deepEqual(parseJsonLine('{"a":1}\n', "identity show"), { a: 1 });
	assert.throws(() => parseJsonLine("nope", "identity show"), /identity show JSON/);
});

test("parseTailJson: full fixture round-trip, unknown fields pass through verbatim", () => {
	const rows = parseTailJson(TAIL_JSON);
	assert.equal(rows.length, TAIL_ROWS.length);
	assert.deepEqual(rows, TAIL_ROWS);
	const future = rows.find((row) => row.event_type === "future.event");
	assert.equal(future.mystery_field, "keep-me");
});

test("parseTailJson: defensive — non-object rows dropped, junk throws with context", () => {
	assert.deepEqual(parseTailJson('[1, null, {"event_id":"x"}]'), [{ event_id: "x" }]);
	assert.throws(() => parseTailJson("no json here"), /no JSON array/);
	assert.throws(() => parseTailJson('{"an":"object"}'), /no JSON array/);
	assert.throws(() => parseTailJson("[unclosed"), /could not parse/);
});

/* --------------------------- tail snapshot mapping ------------------------- */

test("summarizeTailRow: one rule per event type, unknown types fall back to the type name", () => {
	const byType = new Map(TAIL_ROWS.map((row) => [row.event_type, row]));
	assert.equal(
		summarizeTailRow(byType.get("message.text")),
		"Please pick up IR-PI-001 — implement the Pi extension and share the report when done.",
	);
	assert.equal(
		summarizeTailRow(byType.get("agent.status")),
		"state=implementing progress=45% Editing Pi extension tools",
	);
	assert.equal(summarizeTailRow(byType.get("file.shared")), "shared report.md (1834 bytes)");
	assert.equal(summarizeTailRow(byType.get("pipe.opened")), `pipe ${PIPE_ID} opened (preview)`);
	assert.equal(summarizeTailRow(byType.get("pipe.closed")), `pipe ${PIPE_ID} closed (closed)`);
	assert.equal(
		summarizeTailRow(byType.get("member.invited")),
		`invited ${IDENTITY_AGENT.slice(0, 8)} as agent`,
	);
	assert.equal(summarizeTailRow(byType.get("member.joined")), "joined as agent");
	assert.equal(summarizeTailRow(byType.get("member.left")), "left the room");
	assert.equal(
		summarizeTailRow({ event_type: "member.removed", subject: IDENTITY_AGENT }),
		`removed ${IDENTITY_AGENT.slice(0, 8)}`,
	);
	assert.equal(summarizeTailRow(byType.get("room.created")), "room created");
	assert.equal(summarizeTailRow(byType.get("future.event")), "future.event");
	assert.equal(summarizeTailRow({}), "unknown");
});

test("summarizeTailRow truncates long message bodies to ~160 chars", () => {
	const summary = summarizeTailRow({ event_type: "message.text", body: "y".repeat(500) });
	assert.equal(summary.length, 160);
	assert.ok(summary.endsWith("…"));
});

test("snapshotFromRows: maps rows, filters by flags, builds the overall summary", () => {
	const all = snapshotFromRows(TAIL_ROWS);
	assert.equal(all.events.length, TAIL_ROWS.length);
	const message = all.events.find((event) => event.type === "message.text");
	assert.equal(message.author, "sekou");
	assert.equal(message.timestamp, "2026-07-04T05:33:23Z");
	assert.equal(message.event_id, TAIL_ROWS[3].event_id);
	// author falls back to the 8-hex `from` when display_name is missing
	const left = all.events.find((event) => event.type === "member.left");
	assert.equal(left.author, IDENTITY_AGENT.slice(0, 8));
	// overall summary: counts, last activity, latest agent.status
	assert.ok(all.summary.startsWith(`${TAIL_ROWS.length} events`));
	assert.ok(all.summary.includes("message.text×1"));
	assert.ok(all.summary.includes("last activity 2026-07-04T05:33:29Z"));
	assert.ok(
		all.summary.includes("latest status: state=implementing progress=45% Editing Pi extension tools by pi-agent"),
	);

	const filtered = snapshotFromRows(TAIL_ROWS, { includeAgentStatus: false, includeFiles: false });
	assert.equal(filtered.events.some((event) => event.type === "agent.status"), false);
	assert.equal(filtered.events.some((event) => event.type === "file.shared"), false);
	assert.equal(filtered.events.length, TAIL_ROWS.length - 2);
});

test("snapshotFromRows: empty log", () => {
	const empty = snapshotFromRows([]);
	assert.deepEqual(empty.events, []);
	assert.equal(empty.summary, "0 events");
});

/* --------------------------------- tokenize -------------------------------- */

test("tokenize splits on whitespace and respects double quotes", () => {
	assert.deepEqual(tokenize(""), []);
	assert.deepEqual(tokenize("   "), []);
	assert.deepEqual(tokenize("a b  c"), ["a", "b", "c"]);
	assert.deepEqual(tokenize('artifacts/report.md "Final Report"'), [
		"artifacts/report.md",
		"Final Report",
	]);
	assert.deepEqual(tokenize('"/path with spaces/f.md" name'), ["/path with spaces/f.md", "name"]);
	assert.deepEqual(tokenize('--tcp 127.0.0.1:3000 --allow abc'), [
		"--tcp",
		"127.0.0.1:3000",
		"--allow",
		"abc",
	]);
	assert.deepEqual(tokenize('""'), [""]);
});

/* ---------------------------------- runner --------------------------------- */

test("runCli: prepends --data-dir, passes timeout, returns ok on exit 0", async () => {
	const { calls, exec } = stubExec([ok(STATUS_STDOUT)]);
	const run = await runCli(exec, "/bin/iroh-rooms", ["agent", "status", ROOM_ID, "claimed"], {
		home: "/data/agent",
	});
	assert.equal(run.ok, true);
	assert.equal(run.code, 0);
	assert.equal(run.stdout, STATUS_STDOUT);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, "/bin/iroh-rooms");
	assert.deepEqual(calls[0].args, ["--data-dir", "/data/agent", "agent", "status", ROOM_ID, "claimed"]);
	assert.equal(calls[0].options.timeout, 60_000);
});

test("runCli: nonzero exit is returned (ok:false) with the coded error decoded", async () => {
	const { exec } = stubExec([fail(2, ERROR_STDERR_ROOM)]);
	const run = await runCli(exec, "iroh-rooms", ["room", "members", "bogus", "--json"]);
	assert.equal(run.ok, false);
	assert.equal(run.code, 2);
	assert.equal(run.errorCode, "invalid_room_id");
	assert.equal(run.errorDetail, "room id must look like blake3:<64 hex chars>");
});

test("runCli: killed (timeout) throws a local error", async () => {
	const { exec } = stubExec([{ stdout: "", stderr: "", code: 1, killed: true }]);
	await assert.rejects(
		runCli(exec, "iroh-rooms", ["room", "tail", ROOM_ID], { timeoutMs: 5 }),
		/did not finish within 5ms/,
	);
});

test("runCli: exec (spawn) failure throws with the full command line", async () => {
	const { exec } = stubExec([
		() => {
			throw new Error("ENOENT: no such file");
		},
	]);
	await assert.rejects(
		runCli(exec, "/missing/iroh-rooms", ["identity", "show", "--json"]),
		/failed to run \/missing\/iroh-rooms identity show --json.*ENOENT/s,
	);
});
