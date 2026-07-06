import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadExtension, stubExec, stubPi } from "./helpers.mjs";
import {
	ERROR_STDERR_ROOM,
	EVENT_SHARE,
	EVENT_STATUS,
	EXPOSE_STDOUT,
	FILE_ID,
	IDENTITY_ADMIN,
	IDENTITY_JSON,
	PIPE_CLOSE_STDOUT,
	PIPE_ID,
	ROOM_ID,
	SHARE_STDOUT,
	STATUS_STDOUT,
	TAIL_JSON,
	TAIL_ROWS,
	fail,
	ok,
} from "./fixtures.mjs";

const ext = await loadExtension();
const { registerIrohTools } = await ext.importModule("tools");
const { registerIrohCommands } = await ext.importModule("commands");
const { PipeManager } = await ext.importModule("pipes");
const { TOOL_NAMES, COMMAND_NAMES } = await ext.importModule("constants");
const entry = await ext.importEntry();

/* ------------------------------ shared fixtures ---------------------------- */

const cwd = await mkdtemp(join(tmpdir(), "iroh-room-tools-"));
const binPath = join(cwd, "fake-iroh-rooms");
await writeFile(binPath, "#!/bin/sh\nexit 0\n");
await chmod(binPath, 0o755);
const home = join(cwd, ".iroh-agent");

/** Long-running fake `pipe expose`: prints the startup block, then serves. */
const exposeBin = join(cwd, "fake-expose");
await writeFile(exposeBin, `#!/bin/sh\ncat <<'EOF'\n${EXPOSE_STDOUT}EOF\nexec sleep 30\n`);
await chmod(exposeBin, 0o755);

/** Fake expose that dies before printing a pipe_id. */
const exposeFailBin = join(cwd, "fake-expose-fail");
await writeFile(
	exposeFailBin,
	'#!/bin/sh\necho "error[permission_denied]: only active members may expose pipes" >&2\nexit 3\n',
);
await chmod(exposeFailBin, 0o755);

/** Fake expose that never prints anything (deadline test). */
const exposeSilentBin = join(cwd, "fake-expose-silent");
await writeFile(exposeSilentBin, "#!/bin/sh\nexec sleep 30\n");
await chmod(exposeSilentBin, 0o755);

const baseEnv = {
	IROH_ROOM_ID: ROOM_ID,
	IROH_ROOMS_BIN: binPath,
	IROH_ROOMS_HOME: home,
};

const sharedPipes = new PipeManager();
after(async () => {
	await sharedPipes.closeAll();
	await rm(cwd, { recursive: true, force: true });
	await ext.cleanup();
});

function makeTools(queue, env = baseEnv, pipes = sharedPipes) {
	const pi = stubPi();
	const { calls, exec } = stubExec(queue);
	registerIrohTools(pi, { env, exec, pipes });
	const byName = new Map(pi.tools.map((tool) => [tool.name, tool]));
	const run = (name, params) => byName.get(name).execute("call-1", params, undefined, undefined, { cwd });
	return { pi, calls, run, byName };
}

function makeCommands(queue, env = baseEnv, pipes = sharedPipes) {
	const pi = stubPi();
	const { calls, exec } = stubExec(queue);
	registerIrohCommands(pi, { env, exec, pipes });
	const byName = new Map(pi.commands.map((command) => [command.name, command]));
	const notes = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: { notify: (message, type = "info") => notes.push({ message, type }) },
	};
	const run = (name, args) => byName.get(name).handler(args, ctx);
	return { pi, calls, notes, run, byName };
}

/* -------------------------------- registration ----------------------------- */

test("registerIrohTools registers exactly the 10 contract tools", () => {
	const { pi } = makeTools([]);
	assert.deepEqual(
		pi.tools.map((tool) => tool.name).sort(),
		Object.values(TOOL_NAMES).sort(),
	);
	// the 5 required tools carry a promptSnippet for the system prompt
	for (const name of [
		TOOL_NAMES.agentStatus,
		TOOL_NAMES.roomSend,
		TOOL_NAMES.tailSnapshot,
		TOOL_NAMES.fileShare,
		TOOL_NAMES.pipeExpose,
	]) {
		const tool = pi.tools.find((candidate) => candidate.name === name);
		assert.equal(typeof tool.promptSnippet, "string", `${name} needs a promptSnippet`);
	}
	// safety guidelines on the sensitive tools
	assert.ok(pi.tools.find((tool) => tool.name === TOOL_NAMES.pipeExpose).promptGuidelines.length > 0);
	assert.ok(pi.tools.find((tool) => tool.name === TOOL_NAMES.agentStatus).promptGuidelines.length > 0);
});

test("index.ts entry registers 10 tools + 6 commands + a session_shutdown handler", async () => {
	const pi = stubPi();
	entry.default(pi);
	assert.equal(pi.tools.length, 10);
	assert.deepEqual(
		pi.commands.map((command) => command.name).sort(),
		Object.values(COMMAND_NAMES).sort(),
	);
	const shutdown = pi.handlers.get("session_shutdown");
	assert.equal(shutdown?.length, 1);
	await shutdown[0]({ type: "session_shutdown" }, { cwd });
});

/* ------------------------------ happy-path envelope ------------------------ */

test("iroh_agent_status: validates, applies default progress, builds argv, parses event id", async () => {
	const env = { ...baseEnv, IROH_ROOM_DEFAULT_PROGRESS: "45" };
	const { calls, run } = makeTools([ok(STATUS_STDOUT)], env);
	const result = await run(TOOL_NAMES.agentStatus, {
		status: "implementing",
		message: "Editing Pi extension tools",
		artifact_ids: [FILE_ID],
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, binPath);
	assert.deepEqual(calls[0].args, [
		"--data-dir",
		home,
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
	]);
	assert.equal(result.details.ok, true);
	assert.equal(result.details.event_id, EVENT_STATUS);
	assert.equal(result.details.stdout, STATUS_STDOUT);
	assert.equal(result.content[0].type, "text");
	assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});

/* ------------------------------ CLI failure envelope ----------------------- */

test("CLI failure comes back as ok:false envelope (returned, not thrown)", async () => {
	const { run } = makeTools([fail(2, ERROR_STDERR_ROOM)]);
	const result = await run(TOOL_NAMES.roomSend, { message: "hello room" });
	assert.equal(result.details.ok, false);
	assert.equal(result.details.exit_code, 2);
	assert.equal(result.details.error_code, "invalid_room_id");
	assert.equal(result.details.error_detail, "room id must look like blake3:<64 hex chars>");
	assert.ok(String(result.details.stderr).includes("error[invalid_room_id]"));
});

/* ------------------------------ local errors throw ------------------------- */

test("validation failures throw before any CLI call (no partial sends)", async () => {
	const { calls, run } = makeTools([]);
	await assert.rejects(run(TOOL_NAMES.agentStatus, { status: "x".repeat(65) }), /65 bytes/);
	await assert.rejects(run(TOOL_NAMES.roomSend, { message: "" }), /non-empty/);
	await assert.rejects(
		run(TOOL_NAMES.pipeExpose, { tcp: "192.168.1.4:80", allow: [IDENTITY_ADMIN] }),
		/only 127\.0\.0\.1:<port> is allowed/,
	);
	assert.equal(calls.length, 0);
});

test("missing room_id fails closed with remediation options", async () => {
	const env = { IROH_ROOMS_BIN: binPath };
	const { run } = makeTools([], env);
	await assert.rejects(run(TOOL_NAMES.roomSend, { message: "hi" }), /no room_id configured/);
});

test("missing binary fails closed naming all three fixes", async () => {
	const env = { IROH_ROOM_ID: ROOM_ID, PATH: "/nonexistent" };
	const { run } = makeTools([], env);
	await assert.rejects(run(TOOL_NAMES.roomSend, { message: "hi" }), /IROH_ROOMS_BIN.*PATH/s);
});

/* -------------------------------- tail snapshot ---------------------------- */

test("iroh_room_tail_snapshot: compact envelope without raw stdout, filters applied", async () => {
	const { calls, run } = makeTools([ok(TAIL_JSON)]);
	const result = await run(TOOL_NAMES.tailSnapshot, { limit: 10, include_files: false });
	assert.deepEqual(calls[0].args, [
		"--data-dir",
		home,
		"room",
		"tail",
		ROOM_ID,
		"--offline",
		"--json",
		"--limit",
		"10",
	]);
	assert.equal(result.details.ok, true);
	assert.equal(result.details.stdout, undefined);
	assert.equal(result.details.events.length, TAIL_ROWS.length - 1); // file.shared filtered out
	assert.equal(result.details.events.some((event) => event.type === "file.shared"), false);
	assert.ok(result.details.summary.includes(`${TAIL_ROWS.length} events`));
});

/* --------------------------------- file share ------------------------------ */

test("iroh_file_share: real-path containment, argv, file_id + event id parsed", async () => {
	const artifact = join(cwd, "report.md");
	await writeFile(artifact, "# report\n");
	const { calls, run } = makeTools([ok(SHARE_STDOUT)]);
	const result = await run(TOOL_NAMES.fileShare, { path: "report.md", name: "report.md" });
	assert.deepEqual(calls[0].args, [
		"--data-dir",
		home,
		"file",
		"share",
		ROOM_ID,
		realpathSync(artifact),
		"--name",
		"report.md",
	]);
	assert.equal(result.details.ok, true);
	assert.equal(result.details.file_id, FILE_ID);
	assert.equal(result.details.event_id, EVENT_SHARE);
});

test("iroh_file_share: paths outside the workspace are refused", async () => {
	const outside = await mkdtemp(join(tmpdir(), "iroh-room-outside-"));
	await writeFile(join(outside, "secret.txt"), "shh");
	const { calls, run } = makeTools([]);
	await assert.rejects(
		run(TOOL_NAMES.fileShare, { path: join(outside, "secret.txt") }),
		/outside the workspace/,
	);
	assert.equal(calls.length, 0);
	await rm(outside, { recursive: true, force: true });
});

/* ------------------------------- pipes lifecycle --------------------------- */

test("iroh_pipe_expose + iroh_pipe_close: spawn, parse pipe_id, close locally", async () => {
	const env = { ...baseEnv, IROH_ROOMS_BIN: exposeBin };
	const pipes = new PipeManager();
	const { run } = makeTools([], env, pipes);
	const exposed = await run(TOOL_NAMES.pipeExpose, {
		tcp: "127.0.0.1:3000",
		allow: [IDENTITY_ADMIN],
		label: "preview",
	});
	assert.equal(exposed.details.ok, true);
	assert.equal(exposed.details.pipe_id, PIPE_ID);
	assert.equal(exposed.details.target, "127.0.0.1:3000");
	assert.ok(String(exposed.details.connect_hint).includes("pipe connect"));
	assert.equal(pipes.list().length, 1);
	assert.equal(pipes.list()[0].label, "preview");

	const closed = await run(TOOL_NAMES.pipeClose, { pipe_id: PIPE_ID });
	assert.equal(closed.details.ok, true);
	assert.equal(closed.details.closed, "local");
	assert.equal(pipes.list().length, 0);
});

test("iroh_pipe_close falls back to the CLI for pipes we do not own", async () => {
	const { calls, run } = makeTools([ok(PIPE_CLOSE_STDOUT)], baseEnv, new PipeManager());
	const result = await run(TOOL_NAMES.pipeClose, { pipe_id: PIPE_ID });
	assert.equal(result.details.ok, true);
	assert.equal(result.details.closed, "cli");
	assert.deepEqual(calls[0].args, ["--data-dir", home, "pipe", "close", PIPE_ID]);
});

test("pipe expose: early exit before pipe_id throws with redacted stderr", async () => {
	const env = { ...baseEnv, IROH_ROOMS_BIN: exposeFailBin };
	const { run } = makeTools([], env, new PipeManager());
	await assert.rejects(
		run(TOOL_NAMES.pipeExpose, { tcp: "127.0.0.1:3000", allow: [IDENTITY_ADMIN] }),
		/before printing a pipe_id.*permission_denied/s,
	);
});

test("PipeManager: pipe_id parse deadline kills the child; closeAll is idempotent", async () => {
	const pipes = new PipeManager();
	await assert.rejects(
		pipes.expose({
			bin: exposeSilentBin,
			args: [],
			roomId: ROOM_ID,
			target: "127.0.0.1:3000",
			parseTimeoutMs: 300,
		}),
		/did not print a pipe_id within 300ms/,
	);
	assert.deepEqual(await pipes.closeAll(), []);
	assert.deepEqual(await pipes.closeAll(), []);
});

/* ------------------------------- slash commands ---------------------------- */

test("registerIrohCommands registers the 6 contract commands", () => {
	const { pi } = makeCommands([]);
	assert.deepEqual(
		pi.commands.map((command) => command.name).sort(),
		Object.values(COMMAND_NAMES).sort(),
	);
});

test("/room-status: parses '<status> [message...]', shares the tool core, notifies the event id", async () => {
	const { calls, notes, run } = makeCommands([ok(STATUS_STDOUT)]);
	await run(COMMAND_NAMES.roomStatus, 'implementing "Editing Pi extension tools"');
	assert.deepEqual(calls[0].args, [
		"--data-dir",
		home,
		"agent",
		"status",
		ROOM_ID,
		"implementing",
		"--message",
		"Editing Pi extension tools",
	]);
	assert.equal(notes.length, 1);
	assert.ok(notes[0].message.includes(EVENT_STATUS));
	assert.equal(notes[0].type, "info");
});

test("/room-status: empty args shows usage, invalid status surfaces the validation error", async () => {
	const { calls, notes, run } = makeCommands([]);
	await run(COMMAND_NAMES.roomStatus, "");
	assert.match(notes[0].message, /usage: \/room-status/);
	await run(COMMAND_NAMES.roomStatus, "x".repeat(65));
	assert.match(notes[1].message, /65 bytes/);
	assert.equal(notes[1].type, "error");
	assert.equal(calls.length, 0);
});

test("/room-status: argument completions offer the status vocabulary", () => {
	const { byName } = makeCommands([]);
	const completions = byName.get(COMMAND_NAMES.roomStatus).getArgumentCompletions("impl");
	assert.deepEqual(completions, [{ value: "implementing", label: "implementing" }]);
	assert.equal(byName.get(COMMAND_NAMES.roomStatus).getArgumentCompletions("zzz"), null);
});

test("/room-preview: refuses non-loopback targets with the exact reason", async () => {
	const { notes, run } = makeCommands([]);
	await run(COMMAND_NAMES.roomPreview, `--tcp 192.168.1.4:80 --allow ${IDENTITY_ADMIN}`);
	assert.equal(notes[0].type, "error");
	assert.match(notes[0].message, /only 127\.0\.0\.1:<port> is allowed/);
});

test("/room: renders config, binary version, identity, and health", async () => {
	const { notes, run } = makeCommands([ok("iroh-rooms 0.1.0\n"), ok(IDENTITY_JSON)]);
	await run(COMMAND_NAMES.room, "");
	assert.equal(notes.length, 1);
	const text = notes[0].message;
	assert.ok(text.includes(`room_id: ${ROOM_ID}`));
	assert.ok(text.includes("iroh-rooms 0.1.0"));
	assert.ok(text.includes("identity: pi-agent"));
	assert.ok(text.includes("health: ok"));
	assert.equal(notes[0].type, "info");
});

test("/room-tail: renders one line per event plus the overall summary", async () => {
	const { notes, run } = makeCommands([ok(TAIL_JSON)]);
	await run(COMMAND_NAMES.roomTail, "20");
	const text = notes[0].message;
	assert.ok(text.includes("state=implementing progress=45%"));
	assert.ok(text.includes(`${TAIL_ROWS.length} events`));
});
