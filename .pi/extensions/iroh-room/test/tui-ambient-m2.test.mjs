/**
 * M2 ambient integration (brief §4 M2): members-poll cadence + defensive
 * parse, join/removed diff toasts, identity-driven mentions through the poll
 * loop, per-tick pipe diff with expectedCloses, task counts feeding the
 * pulse/pill/card slots, the /room-tail divider record, the ctrl+alt+r
 * shortcut (same code path as /room-pulse no-arg), and the /room-preview
 * member-pick select (tui only, fail-closed).
 */

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadExtension, stubCtx, stubExec, stubPi, stubTimers } from "./helpers.mjs";
import {
	IDENTITY_ADMIN,
	IDENTITY_AGENT,
	IDENTITY_JSON,
	PIPE_ID,
	ROOM_ID,
	TAIL_ROWS,
	fail,
	ok,
} from "./fixtures.mjs";

const ext = await loadExtension();
const entry = await ext.importEntry();
const { AmbientController } = await ext.importModule("tui/ambient");
const { registerIrohCommands } = await ext.importModule("commands");
const { buildCardLines, NEW_SINCE_DIVIDER } = await ext.importModule("tui/cards");
const { identityStyler, naiveFit } = await ext.importModule("tui/style");
const { COMMAND_NAMES, DENSITY_ENTRY_TYPE, PULSE_STATUS_KEY } = await ext.importModule("constants");

const cwd = await mkdtemp(join(tmpdir(), "iroh-room-m2-"));
const binPath = join(cwd, "fake-iroh-rooms");
await writeFile(binPath, "#!/bin/sh\nexit 0\n");
await chmod(binPath, 0o755);

const baseEnv = { IROH_ROOM_ID: ROOM_ID, IROH_ROOMS_BIN: binPath };
const FROM_ADMIN = IDENTITY_ADMIN.slice(0, 8);
const NEW_MEMBER = "c".repeat(64);

after(async () => {
	await rm(cwd, { recursive: true, force: true });
	await ext.cleanup();
});

const TAIL_JSON = `${JSON.stringify(TAIL_ROWS)}\n`;
const MEMBERS_ARGS = ["room", "members", "--json", "--", ROOM_ID];

const membersJson = (ids) =>
	`${JSON.stringify({
		room: ROOM_ID,
		admin: IDENTITY_ADMIN,
		members: ids.map((id) => ({ identity_id: id, role: id === IDENTITY_ADMIN ? "admin" : "agent", status: "active", is_admin: id === IDENTITY_ADMIN })),
	})}\n`;

const fence = "```";
const hex64 = (seed) => seed.repeat(Math.ceil(64 / seed.length)).slice(0, 64);
const extraRow = (lamport, body, from = FROM_ADMIN) => ({
	event_id: `blake3:${hex64(`efef${String(lamport).padStart(4, "0")}`)}`,
	event_type: "message.text",
	lamport,
	at: "2026-07-05T10:00:00Z",
	from,
	body,
});
const taskBody = (id) => `${fence}room-task\nid: ${id}\ntype: implement\ntitle: title of ${id}\n${fence}`;
const tailPlus = (...rows) => `${JSON.stringify([...TAIL_ROWS, ...rows])}\n`;

function makeController(queue, { options = {}, pipes } = {}) {
	const shim = stubTimers();
	const { calls, exec } = stubExec(queue);
	const controller = new AmbientController({
		env: baseEnv,
		exec,
		now: shim.now,
		timers: shim.timers,
		...(pipes !== undefined ? { pipes } : {}),
		...options,
	});
	return { controller, shim, calls };
}

const tuiCtx = (overrides = {}) => stubCtx({ cwd, mode: "tui", hasUI: true, ...overrides });

async function startController(controller, shim, ctx) {
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	await shim.advance(0); // init tick
}

/* --------------------------- members poll cadence --------------------------- */

test("members poll: default cadence — only every 6th successful tail tick", async () => {
	const { controller, shim, calls } = makeController([
		ok(IDENTITY_JSON),
		...Array.from({ length: 6 }, () => ok(TAIL_JSON)),
		ok(membersJson([IDENTITY_ADMIN, IDENTITY_AGENT])),
	]);
	const ctx = tuiCtx();
	await startController(controller, shim, ctx);
	for (let i = 0; i < 5; i++) {
		await shim.advance(5_000);
	}
	assert.equal(calls.length, 8, "identity + 6 tails + 1 members poll");
	assert.deepEqual(calls[7].args, MEMBERS_ARGS, "members poll rides the 6th tail tick");
	for (const call of calls.slice(0, 7)) {
		assert.notEqual(call.args[1], "members", "no members poll before the 6th tick");
	}
	assert.deepEqual(
		controller.listMembers().map((member) => member.id).sort(),
		[IDENTITY_ADMIN, IDENTITY_AGENT].sort(),
	);
});

test("members poll: defensive parse — junk JSON/shapes are silent, never a feed failure", async () => {
	const { controller, shim } = makeController(
		[
			ok(IDENTITY_JSON),
			ok(TAIL_JSON),
			ok("not json at all\n"),
			ok(TAIL_JSON),
			ok(`${JSON.stringify({ members: "nope" })}\n`),
			ok(TAIL_JSON),
			ok(`${JSON.stringify({ members: [{ identity_id: "too-short" }, null, 42] })}\n`),
		],
		{ options: { membersEveryTicks: 1 } },
	);
	const ctx = tuiCtx();
	await startController(controller, shim, ctx);
	await shim.advance(5_000);
	await shim.advance(5_000);
	assert.deepEqual(ctx.ui.notifications, [], "no toast from malformed members output");
	assert.deepEqual(controller.listMembers(), [], "invalid entries all dropped");
	assert.equal(ctx.ui.statuses.get(PULSE_STATUS_KEY), "iroh ●", "feed stays healthy");
});

test("members poll: baseline never toasts; later joins/removals toast via the diff", async () => {
	const { controller, shim } = makeController(
		[
			ok(IDENTITY_JSON),
			ok(TAIL_JSON),
			ok(membersJson([IDENTITY_ADMIN, IDENTITY_AGENT])), // baseline
			ok(TAIL_JSON),
			ok(membersJson([IDENTITY_ADMIN, IDENTITY_AGENT, NEW_MEMBER])), // join
			ok(TAIL_JSON),
			ok(membersJson([IDENTITY_ADMIN, IDENTITY_AGENT])), // removal
		],
		{ options: { membersEveryTicks: 1 } },
	);
	const ctx = tuiCtx();
	await startController(controller, shim, ctx);
	assert.deepEqual(ctx.ui.notifications, [], "baseline members poll is silent");
	await shim.advance(5_000);
	assert.deepEqual(ctx.ui.notifications, [
		{ message: `iroh-room: member joined ${NEW_MEMBER.slice(0, 8)}…`, type: "info" },
	]);
	await shim.advance(5_000);
	assert.equal(ctx.ui.notifications.length, 2);
	assert.deepEqual(ctx.ui.notifications[1], {
		message: `iroh-room: member removed ${NEW_MEMBER.slice(0, 8)}…`,
		type: "info",
	});
});

/* ------------------------------ identity + mentions ------------------------- */

test("identity fetched once at init wires mention toasts (from8-attributed)", async () => {
	const { controller, shim } = makeController([
		ok(IDENTITY_JSON), // identity: pi-agent / IDENTITY_AGENT
		ok(TAIL_JSON),
		ok(tailPlus(extraRow(11, "hey @pi-agent can you take a look?"))),
	]);
	const ctx = tuiCtx();
	await startController(controller, shim, ctx);
	await shim.advance(5_000);
	assert.deepEqual(ctx.ui.notifications, [
		{ message: `iroh-room: mentioned by ${FROM_ADMIN}`, type: "info" },
	]);
});

test("identity fetch failure: mention detection silently off (no toast, no feed failure)", async () => {
	const { controller, shim } = makeController([
		fail(1, "error: no local identity"),
		ok(TAIL_JSON),
		ok(tailPlus(extraRow(11, "hey @pi-agent can you take a look?"))),
	]);
	const ctx = tuiCtx();
	await startController(controller, shim, ctx);
	await shim.advance(5_000);
	assert.deepEqual(ctx.ui.notifications, [], "silently off — not even a warning");
	assert.equal(ctx.ui.statuses.get(PULSE_STATUS_KEY), "iroh ●");
});

/* ----------------------- tasks feed pulse / pill / card --------------------- */

test("task slots: backlog tasks count (catch-up) without toasting; fresh tasks toast + bump the pill", async () => {
	const { controller, shim } = makeController([
		ok(IDENTITY_JSON),
		ok(tailPlus(extraRow(11, taskBody("T-A")))), // init: backlog task
		ok(tailPlus(extraRow(11, taskBody("T-A")), extraRow(12, taskBody("T-B")))),
		ok(
			tailPlus(
				extraRow(11, taskBody("T-A")),
				extraRow(12, taskBody("T-B")),
				extraRow(13, "Claiming task T-A as someone-else."),
			),
		),
	]);
	const ctx = tuiCtx();
	await startController(controller, shim, ctx);
	assert.deepEqual(ctx.ui.notifications, [], "backlog task suppressed (boot watermark)");
	assert.equal(ctx.ui.statuses.get(PULSE_STATUS_KEY), "iroh ● ○1~", "…but it still counts");
	assert.deepEqual(controller.listUnclaimedTaskIds(), ["T-A"]);

	await shim.advance(5_000);
	assert.deepEqual(ctx.ui.notifications, [
		{ message: "iroh-room: new task~ T-B: title of T-B", type: "info" },
	]);
	assert.equal(ctx.ui.statuses.get(PULSE_STATUS_KEY), "iroh ● ○2~");
	assert.deepEqual(controller.listTaskIds(), ["T-A", "T-B"]);

	await shim.advance(5_000);
	assert.equal(ctx.ui.notifications.length, 1, "a claim is not a toast");
	assert.equal(ctx.ui.statuses.get(PULSE_STATUS_KEY), "iroh ● ○1~", "claimed task leaves the count");
	assert.deepEqual(controller.listUnclaimedTaskIds(), ["T-B"]);
});

/* ------------------------- pipe diff + expectedCloses ----------------------- */

function fakePipes(initial) {
	const ids = [...initial];
	return {
		ids,
		list: () => ids.map((pipeId) => ({ pipeId, roomId: ROOM_ID, target: "127.0.0.1:3000", startedAt: 0 })),
	};
}

test("pipe_closed_own: an unexpected pipes.list() disappearance toasts a warning", async () => {
	const pipes = fakePipes([PIPE_ID]);
	const { controller, shim } = makeController([ok(IDENTITY_JSON), ok(TAIL_JSON), ok(TAIL_JSON)], { pipes });
	const ctx = tuiCtx();
	await startController(controller, shim, ctx); // baseline tick sees the pipe
	pipes.ids.length = 0; // the expose child died underneath us
	await shim.advance(5_000);
	assert.deepEqual(ctx.ui.notifications, [
		{ message: `iroh-room: preview pipe closed unexpectedly: ${PIPE_ID}`, type: "warning" },
	]);
});

test("pipe_closed_own: expectedCloses (our own close) suppresses the toast, once", async () => {
	const pipes = fakePipes([PIPE_ID]);
	const { controller, shim } = makeController([ok(IDENTITY_JSON), ok(TAIL_JSON), ok(TAIL_JSON)], { pipes });
	const ctx = tuiCtx();
	await startController(controller, shim, ctx);
	controller.noteExpectedPipeClose(PIPE_ID); // e.g. /room-preview --close
	pipes.ids.length = 0;
	await shim.advance(5_000);
	assert.deepEqual(ctx.ui.notifications, [], "our own close never toasts");
});

test("entry wiring: a SUCCESSFUL iroh_pipe_close completion feeds expectedCloses (and only then)", async () => {
	const pi = stubPi();
	const noted = [];
	const ambient = {
		...recorderAmbient(),
		onSessionStart: async () => {},
		noteExpectedPipeClose: (pipeId) => noted.push(pipeId),
	};
	entry.createIrohRoomExtension({ env: baseEnv, exec: stubExec([]).exec, ambient })(pi);
	const toolEnd = pi.handlers.get("tool_execution_end")[0];
	const ctx = tuiCtx();
	await toolEnd(
		{ type: "tool_execution_end", toolCallId: "c1", toolName: "iroh_pipe_close", result: { details: { ok: true, pipe_id: PIPE_ID } }, isError: false },
		ctx,
	);
	assert.deepEqual(noted, [PIPE_ID]);
	// failed closes and other iroh tools never mark an expected close
	await toolEnd(
		{ type: "tool_execution_end", toolCallId: "c2", toolName: "iroh_pipe_close", result: { details: { ok: false, exit_code: 2 } }, isError: false },
		ctx,
	);
	await toolEnd(
		{ type: "tool_execution_end", toolCallId: "c3", toolName: "iroh_room_send", result: { details: { ok: true, pipe_id: PIPE_ID } }, isError: false },
		ctx,
	);
	assert.deepEqual(noted, [PIPE_ID]);
	assert.equal(ambient.events.filter((event) => event === "boost").length, 3, "all iroh_* still boost");
});

test("opPipeClose REGRESSION: marks the expected close BEFORE the registry close starts", async () => {
	// PipeManager.close() removes the registry entry synchronously, then
	// waits up to ~7s for the child — a boosted tick landing mid-await must
	// already find the suppression entry, or our own close toasts.
	const { opPipeClose } = await ext.importModule("tools");
	const order = [];
	const pipes = {
		list: () => [],
		has: (id) => id === PIPE_ID,
		close: async (id) => {
			order.push(`close:${id}`);
			return true;
		},
		closeAll: async () => [],
		expose: async () => {
			throw new Error("not used");
		},
	};
	const ambient = { noteExpectedPipeClose: (id) => order.push(`noted:${id}`) };
	const envelope = await opPipeClose(
		{ env: baseEnv, exec: stubExec([]).exec, pipes, ambient },
		{ cwd },
		{ pipe_id: PIPE_ID },
	);
	assert.equal(envelope.ok, true);
	assert.deepEqual(order, [`noted:${PIPE_ID}`, `close:${PIPE_ID}`], "noted strictly before the close");
});

test("entry wiring REGRESSION: the iroh_pipe_close TOOL feeds expectedCloses while the close is still in flight", async () => {
	const pi = stubPi();
	const noted = [];
	let resolveClose;
	const pipes = {
		list: () => [{ pipeId: PIPE_ID, roomId: ROOM_ID, target: "127.0.0.1:3000", startedAt: 0 }],
		has: (id) => id === PIPE_ID,
		close: () =>
			new Promise((resolve) => {
				resolveClose = resolve; // a wedged child: SIGINT grace still running
			}),
		closeAll: async () => [],
		expose: async () => {
			throw new Error("not used");
		},
	};
	const ambient = { ...recorderAmbient(), noteExpectedPipeClose: (id) => noted.push(id) };
	entry.createIrohRoomExtension({ env: baseEnv, exec: stubExec([]).exec, pipes, ambient })(pi);
	const tool = pi.tools.find((candidate) => candidate.name === "iroh_pipe_close");
	const pending = tool.execute("c1", { pipe_id: PIPE_ID }, undefined, undefined, tuiCtx());
	assert.deepEqual(noted, [PIPE_ID], "marked before pipes.close() resolved (registry entry already gone)");
	resolveClose(true);
	const result = await pending;
	assert.equal(result.details.ok, true);
	assert.equal(result.details.closed, "local");
});

test("/room-preview --close feeds expectedCloses for the closed pipe id(s)", async () => {
	const pi = stubPi();
	const noted = [];
	const ambient = { ...recorderAmbient(), noteExpectedPipeClose: (pipeId) => noted.push(pipeId) };
	const pipes = {
		list: () => [{ pipeId: PIPE_ID, roomId: ROOM_ID, target: "127.0.0.1:3000", startedAt: 0 }],
		has: (id) => id === PIPE_ID,
		expose: async () => {
			throw new Error("not used");
		},
		close: async () => true,
		closeAll: async () => [PIPE_ID],
	};
	registerIrohCommands(pi, { env: baseEnv, exec: stubExec([]).exec, ambient, pipes });
	const preview = pi.commands.find((command) => command.name === COMMAND_NAMES.roomPreview);
	await preview.handler(`--close ${PIPE_ID}`, tuiCtx());
	assert.deepEqual(noted, [PIPE_ID], "single close noted (before the close runs)");
	await preview.handler("--close", tuiCtx());
	assert.deepEqual(noted, [PIPE_ID, PIPE_ID], "close-all notes every live pipe id");
});

/* ------------------------- /room-tail divider record ------------------------ */

test("noteTailLook: records the max (lamport, event_id); previous record is the divider mark", async () => {
	const { controller, shim } = makeController([ok(IDENTITY_JSON), ok(TAIL_JSON)]);
	const ctx = tuiCtx();
	assert.equal(
		controller.noteTailLook([{ event_id: "a", lamport: 1 }]),
		undefined,
		"inactive controller records nothing",
	);
	await startController(controller, shim, ctx);
	assert.equal(controller.noteTailLook([{ event_id: "a", lamport: 3 }, { event_id: "b", lamport: 5 }]), undefined, "first look: no record => no divider");
	assert.deepEqual(controller.noteTailLook([{ event_id: "c", lamport: 7 }]), { lamport: 5, event_id: "b" });
	assert.deepEqual(controller.noteTailLook([]), { lamport: 7, event_id: "c" }, "empty events keep the record");
	controller.shutdown();
	assert.equal(controller.noteTailLook([{ event_id: "d", lamport: 9 }]), undefined, "teardown clears the record");
});

test("cards: the dim divider renders before the first event newer than new_since", () => {
	const events = [
		{ event_id: "a", lamport: 3, type: "message.text", summary: "old-row", timestamp: "2026-07-05T09:00:00Z", author: "x" },
		{ event_id: "b", lamport: 5, type: "message.text", summary: "new-row", timestamp: "2026-07-05T09:01:00Z", author: "x" },
	];
	const withDivider = buildCardLines(
		{ kind: "tail", count: 2, events, new_since: { lamport: 3, event_id: "a" } },
		{ expanded: true },
		identityStyler,
		naiveFit,
		80,
	);
	const dividerAt = withDivider.indexOf(NEW_SINCE_DIVIDER);
	assert.notEqual(dividerAt, -1, "divider present");
	assert.ok(withDivider[dividerAt - 1].includes("old-row"), "divider sits after the old row");
	assert.ok(withDivider[dividerAt + 1].includes("new-row"), "…and before the first newer row");

	const noRecord = buildCardLines(
		{ kind: "tail", count: 2, events },
		{ expanded: true },
		identityStyler,
		naiveFit,
		80,
	);
	assert.ok(!noRecord.some((line) => line.includes(NEW_SINCE_DIVIDER)), "no record => no divider");

	const allOld = buildCardLines(
		{ kind: "tail", count: 2, events, new_since: { lamport: 9, event_id: "z" } },
		{ expanded: true },
		identityStyler,
		naiveFit,
		80,
	);
	assert.ok(!allOld.some((line) => line.includes(NEW_SINCE_DIVIDER)), "nothing newer => no divider");
});

test("cards: /room card renders the unclaimed tasks~ slot only when present", () => {
	const base = {
		kind: "room",
		room_id: ROOM_ID,
		pipes: [],
		issues: [],
	};
	const withTasks = buildCardLines(
		{ ...base, unclaimed_tasks: ["T-1", "T-2"] },
		{ expanded: false },
		identityStyler,
		naiveFit,
		80,
	);
	assert.ok(
		withTasks.some((line) => line.includes("tasks~ T-1 T-2")),
		`tasks row missing: ${JSON.stringify(withTasks)}`,
	);
	const without = buildCardLines(base, { expanded: false }, identityStyler, naiveFit, 80);
	assert.ok(!without.some((line) => line.includes("tasks~")), "absent => no row");
});

/* -------------------- card wiring: /room tasks + /room-tail divider --------- */

test("/room (tui) card details carry the unclaimed task ids (≤5) from the tracker", async () => {
	const pi = stubPi();
	const ambient = {
		...recorderAmbient(),
		listUnclaimedTaskIds: () => ["T-1", "T-2", "T-3", "T-4", "T-5", "T-6", "T-7"],
	};
	registerIrohCommands(pi, {
		env: baseEnv,
		exec: stubExec([ok("iroh-rooms 0.1.0\n"), ok(IDENTITY_JSON)]).exec,
		ambient,
	});
	const ctx = tuiCtx();
	await pi.commands.find((command) => command.name === COMMAND_NAMES.room).handler("", ctx);
	assert.equal(pi.sentMessages.length, 1);
	const details = pi.sentMessages[0].message.details;
	assert.deepEqual(details.unclaimed_tasks, ["T-1", "T-2", "T-3", "T-4", "T-5"], "capped at 5");
	// model-visibility split: the room-authored ids stay OUT of content
	assert.ok(!pi.sentMessages[0].message.content.includes("T-1"));
});

test("/room-tail (tui) records the look via the ambient and carries new_since in details", async () => {
	const pi = stubPi();
	const looks = [];
	const ambient = {
		...recorderAmbient(),
		noteTailLook: (events) => {
			looks.push(events.length);
			return looks.length === 1 ? undefined : { lamport: 5, event_id: "blake3:aa" };
		},
	};
	registerIrohCommands(pi, {
		env: baseEnv,
		exec: stubExec([ok(TAIL_JSON), ok(TAIL_JSON)]).exec,
		ambient,
	});
	const ctx = tuiCtx();
	const tail = pi.commands.find((command) => command.name === COMMAND_NAMES.roomTail);
	await tail.handler("", ctx);
	assert.deepEqual(looks, [TAIL_ROWS.length], "every card emission records its events");
	assert.equal(pi.sentMessages[0].message.details.new_since, undefined, "no record => no divider key");
	await tail.handler("", ctx);
	assert.deepEqual(pi.sentMessages[1].message.details.new_since, { lamport: 5, event_id: "blake3:aa" });
	// events in details carry the ordering key the divider needs
	assert.equal(typeof pi.sentMessages[1].message.details.events[0].lamport, "number");
});

/* --------------------- shortcut + command wiring (same path) ---------------- */

function recorderAmbient() {
	const events = [];
	let density = "2";
	return {
		events,
		onSessionStart: async () => {},
		boost: () => events.push("boost"),
		getDensity: () => density,
		setDensity: async (next) => {
			density = next;
			events.push(`set:${next}`);
		},
		cycleDensity: () => {
			const order = ["off", "pill", "1", "2"];
			density = order[(order.indexOf(density) + 1) % order.length];
			events.push(`cycle:${density}`);
			return density;
		},
		shutdown: () => events.push("shutdown"),
	};
}

test("ctrl+alt+r shortcut: registered once, cycles density through the /room-pulse no-arg path", async () => {
	const pi = stubPi();
	const ambient = recorderAmbient();
	registerIrohCommands(pi, { env: baseEnv, exec: stubExec([]).exec, ambient });
	assert.equal(pi.shortcuts.length, 1);
	assert.equal(pi.shortcuts[0].shortcut, "ctrl+alt+r");

	const ctx = tuiCtx();
	await pi.shortcuts[0].handler(ctx);
	assert.deepEqual(ambient.events, ["cycle:off", "boost"], "cycle + boost, exactly like /room-pulse");
	assert.deepEqual(pi.entries, [{ customType: DENSITY_ENTRY_TYPE, data: { density: "off" } }]);
	assert.match(ctx.ui.notifications[0].message, /room pulse density: off/);

	// byte-identical to running /room-pulse with no argument
	const pi2 = stubPi();
	const ambient2 = recorderAmbient();
	registerIrohCommands(pi2, { env: baseEnv, exec: stubExec([]).exec, ambient: ambient2 });
	const ctx2 = tuiCtx();
	await pi2.commands.find((command) => command.name === COMMAND_NAMES.roomPulse).handler("", ctx2);
	assert.deepEqual(ambient2.events, ambient.events);
	assert.deepEqual(pi2.entries, pi.entries);
	assert.deepEqual(ctx2.ui.notifications, ctx.ui.notifications);
});

/* ----------------------- /room-preview member-pick select ------------------- */

function stubPipesRecorder() {
	const exposeCalls = [];
	return {
		exposeCalls,
		list: () => [],
		has: () => false,
		expose: async (options) => {
			exposeCalls.push(options);
			return {
				record: { pipeId: PIPE_ID, roomId: options.roomId, target: options.target, startedAt: 0 },
				stdout: "",
			};
		},
		close: async () => true,
		closeAll: async () => [],
	};
}

function makePreviewCommands({ select, members } = {}) {
	const pi = stubPi();
	const pipes = stubPipesRecorder();
	const ambient = {
		...recorderAmbient(),
		listMembers: () =>
			members ?? [
				{ id: IDENTITY_ADMIN, role: "admin" },
				{ id: IDENTITY_AGENT, role: "agent" },
			],
	};
	registerIrohCommands(pi, { env: baseEnv, exec: stubExec([]).exec, ambient, pipes });
	const byName = new Map(pi.commands.map((command) => [command.name, command]));
	const selectCalls = [];
	const ctx = tuiCtx();
	ctx.ui.select = async (title, options, opts) => {
		selectCalls.push({ title, options, opts });
		return select === undefined ? undefined : select(options);
	};
	return { pipes, ctx, selectCalls, run: (args) => byName.get(COMMAND_NAMES.roomPreview).handler(args, ctx) };
}

test("member-pick: tui /room-preview without --allow selects a member id (id8 + role labels)", async () => {
	const { pipes, ctx, selectCalls, run } = makePreviewCommands({ select: (options) => options[0] });
	await run("");
	assert.equal(selectCalls.length, 1);
	assert.deepEqual(selectCalls[0].options, [
		`${IDENTITY_ADMIN.slice(0, 8)}… (admin)`,
		`${IDENTITY_AGENT.slice(0, 8)}… (agent)`,
	]);
	assert.equal(pipes.exposeCalls.length, 1);
	assert.ok(
		pipes.exposeCalls[0].args.includes(`--allow=${IDENTITY_ADMIN}`),
		`selected member missing from argv: ${JSON.stringify(pipes.exposeCalls[0].args)}`,
	);
	assert.equal(ctx.ui.notifications.at(-1).type, "info");
});

test("member-pick: undefined select (timeout/dismiss) declines — errors exactly as today", async () => {
	const { pipes, ctx, selectCalls, run } = makePreviewCommands();
	await run("");
	assert.equal(selectCalls.length, 1, "select was offered");
	assert.equal(pipes.exposeCalls.length, 0, "fail closed: nothing exposed");
	assert.equal(ctx.ui.notifications.at(-1).type, "error");
	assert.match(ctx.ui.notifications.at(-1).message, /allow must be a non-empty array/);
});

test("member-pick: non-tui behavior is byte-identical to today (no select, same error)", async () => {
	const { pipes, ctx, selectCalls, run } = makePreviewCommands({ select: (options) => options[0] });
	ctx.mode = "print";
	await run("");
	assert.equal(selectCalls.length, 0, "no select outside the TUI");
	assert.equal(pipes.exposeCalls.length, 0);
	assert.match(ctx.ui.notifications.at(-1).message, /allow must be a non-empty array/);
});

test("member-pick REGRESSION: colliding id prefixes lengthen until unique (never indistinguishable choices)", async () => {
	// A malicious member can grind an identity sharing a short hex prefix
	// with a trusted one (~2^32 keygens for 8 hex); the pick is an
	// access-control grant, so the two must never render identically.
	const TWIN_A = `abcdef123456${"a".repeat(52)}`;
	const TWIN_B = `abcdef123456${"b".repeat(52)}`;
	const { pipes, selectCalls, run } = makePreviewCommands({
		select: (options) => options[1], // pick the SECOND twin
		members: [
			{ id: TWIN_A, role: "member" },
			{ id: TWIN_B, role: "member" },
			{ id: TWIN_B, role: "member" }, // exact duplicate: offered once
		],
	});
	await run("");
	assert.equal(selectCalls.length, 1);
	// shared 12-hex prefix => 8 and 12 collide, 16 is the first unique length
	assert.deepEqual(selectCalls[0].options, [
		`${TWIN_A.slice(0, 16)}… (member)`,
		`${TWIN_B.slice(0, 16)}… (member)`,
	]);
	assert.ok(
		!selectCalls[0].options.some((label) => label.endsWith("+")),
		"no ambiguous ' +' disambiguation",
	);
	assert.equal(pipes.exposeCalls.length, 1);
	assert.ok(
		pipes.exposeCalls[0].args.includes(`--allow=${TWIN_B}`),
		`picked twin B must be the granted id: ${JSON.stringify(pipes.exposeCalls[0].args)}`,
	);
	assert.ok(!pipes.exposeCalls[0].args.includes(`--allow=${TWIN_A}`), "twin A never granted");
});

test("member-pick REGRESSION: the select carries a timeout (never parks the handler forever)", async () => {
	const { selectCalls, run } = makePreviewCommands({ select: (options) => options[0] });
	await run("");
	assert.equal(selectCalls.length, 1);
	const timeout = selectCalls[0].opts?.timeout;
	assert.equal(typeof timeout, "number", "select must pass { timeout }");
	assert.ok(Number.isFinite(timeout) && timeout > 0, `timeout must be a positive ms count, got ${timeout}`);
});

test("member-pick: explicit --allow (equals form) skips the select entirely", async () => {
	const { pipes, selectCalls, run } = makePreviewCommands({ select: (options) => options[0] });
	await run(`--allow=${IDENTITY_AGENT}`);
	assert.equal(selectCalls.length, 0);
	assert.equal(pipes.exposeCalls.length, 1);
	assert.ok(pipes.exposeCalls[0].args.includes(`--allow=${IDENTITY_AGENT}`));
});

/* ------------------------- @mention editor provider ------------------------- */

test("@mention provider: registers once per process, offers roster from8 values, delegates otherwise", async () => {
	const { controller, shim } = makeController([
		ok(IDENTITY_JSON),
		...Array.from({ length: 6 }, () => ok(TAIL_JSON)),
		ok(membersJson([IDENTITY_ADMIN, IDENTITY_AGENT])),
	]);
	const ctx = tuiCtx();
	await startController(controller, shim, ctx);
	assert.equal(ctx.ui.autocompleteProviders.length, 1, "provider registered at session start");

	const sentinel = { items: [{ value: "/x", label: "/x" }], prefix: "/" };
	const current = {
		triggerCharacters: ["/"],
		getSuggestions: async () => sentinel,
		applyCompletion: () => ({ lines: ["DELEGATED"], cursorLine: 0, cursorCol: 0 }),
	};
	const provider = ctx.ui.autocompleteProviders[0](current);
	assert.ok(provider.triggerCharacters.includes("@"), "our trigger");
	assert.ok(provider.triggerCharacters.includes("/"), "wrapped provider's triggers kept");

	// before the members poll: no roster -> delegate unchanged
	const early = await provider.getSuggestions(["ping @"], 0, 6, {});
	assert.equal(early, sentinel, "no roster must delegate");

	for (let i = 0; i < 5; i++) {
		await shim.advance(5_000); // 6th successful tail tick loads the roster
	}
	const out = await provider.getSuggestions(["ping @"], 0, 6, {});
	assert.deepEqual(
		out.items.map((item) => item.value).sort(),
		[`@${IDENTITY_ADMIN.slice(0, 8)}`, `@${IDENTITY_AGENT.slice(0, 8)}`].sort(),
	);

	// applyCompletion: our offered item replaces the @-token; foreign items delegate
	const mention = out.items[0].value;
	const applied = provider.applyCompletion(["ping @ tail"], 0, 6, { value: mention }, "@");
	assert.deepEqual(applied.lines, [`ping ${mention}  tail`]);
	assert.equal(applied.cursorCol, 6 - 1 + mention.length + 1);
	const foreign = provider.applyCompletion(["ping @"], 0, 6, { value: "@zzzzzzzz" }, "@");
	assert.deepEqual(foreign.lines, ["DELEGATED"], "unoffered values must delegate");

	// restart: the guard keeps host-side registration once per process
	const ctxB = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "new" }, ctxB);
	assert.equal(ctxB.ui.autocompleteProviders.length, 0, "no duplicate provider on restart");

	// after shutdown the provider goes inert (delegates again)
	controller.shutdown();
	const inert = await provider.getSuggestions(["ping @"], 0, 6, {});
	assert.equal(inert, sentinel);
});
