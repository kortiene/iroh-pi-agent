import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadExtension, stubCtx, stubExec, stubPi, stubTimers } from "./helpers.mjs";
import { ERROR_STDERR_ROOM, IDENTITY_JSON, ROOM_ID, TAIL_JSON, TAIL_ROWS, fail, ok } from "./fixtures.mjs";

const ext = await loadExtension();
const { AmbientController } = await ext.importModule("tui/ambient");
const { registerIrohCommands } = await ext.importModule("commands");
const {
	COMMAND_NAMES,
	DENSITY_ENTRY_TYPE,
	PULSE_STATUS_KEY,
	PULSE_WIDGET_KEY,
} = await ext.importModule("constants");
const entry = await ext.importEntry();

/* ------------------------------ shared fixtures ---------------------------- */

const cwd = await mkdtemp(join(tmpdir(), "iroh-room-ambient-"));
const binPath = join(cwd, "fake-iroh-rooms");
await writeFile(binPath, "#!/bin/sh\nexit 0\n");
await chmod(binPath, 0o755);

/** Cwd whose .iroh-room-pi.json is malformed (broken-config mode). */
const brokenCwd = await mkdtemp(join(tmpdir(), "iroh-room-ambient-broken-"));
await writeFile(join(brokenCwd, ".iroh-room-pi.json"), "{ not json ");

const baseEnv = { IROH_ROOM_ID: ROOM_ID, IROH_ROOMS_BIN: binPath };
const identityTheme = { fg: (_color, text) => text, bold: (text) => text };

after(async () => {
	await rm(cwd, { recursive: true, force: true });
	await rm(brokenCwd, { recursive: true, force: true });
	await ext.cleanup();
});

const TAIL_ARGS = (limit) => ["room", "tail", "--offline", "--json", `--limit=${limit}`, "--", ROOM_ID];
/** The M2 identity fetch: the FIRST exec of the init tick, once per session. */
const WHOAMI_ARGS = ["identity", "show", "--json"];

/** Drain enough microtasks for an in-flight tick to reach its blocked exec
 * (the init tick now awaits the identity fetch before the tail poll). */
async function flushMicrotasks(rounds = 16) {
	for (let i = 0; i < rounds; i++) {
		await Promise.resolve();
	}
}

function makeController(queue, { env = baseEnv, options = {} } = {}) {
	const shim = stubTimers();
	const { calls, exec } = stubExec(queue);
	const controller = new AmbientController({
		env,
		exec,
		now: shim.now,
		timers: shim.timers,
		...options,
	});
	return { controller, shim, calls };
}

function tuiCtx(overrides = {}) {
	return stubCtx({ cwd, mode: "tui", hasUI: true, ...overrides });
}

function fakeTui() {
	let renders = 0;
	return { requestRender: () => renders++, rendersSoFar: () => renders };
}

/** Rows with ids disjoint from TAIL_JSON (forces gap detection). */
const GAP_ROWS = [500, 501].map((lamport) => ({
	event_id: `blake3:${String(lamport).repeat(22).slice(0, 64)}`,
	event_type: "message.text",
	lamport,
	at: "2026-07-05T11:00:00Z",
	from: "e1d2c3b4",
	body: `late ${lamport}`,
}));
const GAP_JSON = `${JSON.stringify(GAP_ROWS)}\n`;

/* --------------------------- mode + config gating --------------------------- */

test("non-tui modes (rpc/json/print): zero ambient activity — no exec, no ui, no timers", async () => {
	for (const mode of ["rpc", "json", "print"]) {
		const { controller, shim, calls } = makeController([]);
		const ctx = tuiCtx({ mode });
		await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
		assert.equal(calls.length, 0, `${mode}: exec`);
		assert.equal(shim.pending(), 0, `${mode}: timers`);
		assert.equal(ctx.ui.notifications.length, 0, `${mode}: toasts`);
		assert.equal(ctx.ui.widgets.size, 0, `${mode}: widgets`);
		assert.equal(ctx.ui.statuses.size, 0, `${mode}: statuses`);
	}
});

test("unconfigured (no room_id): TOTAL silence — no widget, no pill, no timer, no poll", async () => {
	const { controller, shim, calls } = makeController([], { env: { IROH_ROOMS_BIN: binPath } });
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(calls.length, 0);
	assert.equal(shim.pending(), 0);
	assert.equal(ctx.ui.notifications.length, 0);
	assert.equal(ctx.ui.widgets.size, 0);
	assert.equal(ctx.ui.statuses.size, 0);
});

test("broken config: exactly one warning toast + dim unconfigured pill, nothing else", async () => {
	const { controller, shim, calls } = makeController([]);
	const ctx = tuiCtx({ cwd: brokenCwd });
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(ctx.ui.notifications.length, 1);
	assert.equal(ctx.ui.notifications[0].type, "warning");
	assert.match(ctx.ui.notifications[0].message, /config error/);
	assert.equal(ctx.ui.statuses.get(PULSE_STATUS_KEY), "iroh ⚙ unconfigured");
	assert.equal(ctx.ui.widgets.size, 0);
	assert.equal(calls.length, 0);
	assert.equal(shim.pending(), 0);
	// shutdown clears the pill and stays idempotent
	controller.shutdown();
	controller.shutdown();
	assert.equal(ctx.ui.statuses.size, 0);
});

/* ------------------------------ startup + widget ---------------------------- */

test("tui session start: identity fetch + deep init poll (--limit=500), widget belowEditor, pill, chained 5s timer", async () => {
	const { controller, shim, calls } = makeController([ok(IDENTITY_JSON), ok(TAIL_JSON)]);
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	await shim.advance(0); // the init poll is scheduled, never awaited

	// The init tick runs the ONE-per-session identity fetch, then the deep poll.
	assert.equal(calls.length, 2);
	assert.equal(calls[0].command, binPath);
	assert.deepEqual(calls[0].args, WHOAMI_ARGS);
	assert.equal(calls[1].command, binPath);
	assert.deepEqual(calls[1].args, TAIL_ARGS(500));

	const widget = ctx.ui.widgets.get(PULSE_WIDGET_KEY);
	assert.ok(widget !== undefined, "widget registered");
	assert.equal(typeof widget.content, "function", "factory form");
	assert.deepEqual(widget.options, { placement: "belowEditor" });

	const tui = fakeTui();
	const component = widget.content(tui, identityTheme);
	assert.equal(typeof component.invalidate, "function");
	const lines = component.render(80);
	assert.equal(lines.length, 2);
	assert.ok(lines[0].startsWith("●  room 7c9e1a2b"), lines[0]);
	assert.ok(lines[0].includes("sts implementing 45%"), lines[0]);
	assert.ok(lines[0].includes("↻ 5s"), lines[0]);
	assert.equal(lines[1], "└ 05:33 e1d2c3b4 future.event future.event");
	for (const line of lines) assert.ok(line.length <= 80);

	// dispose is safe + idempotent
	component.dispose();
	assert.doesNotThrow(() => component.dispose());

	assert.equal(ctx.ui.statuses.get(PULSE_STATUS_KEY), "iroh ●");
	assert.equal(shim.pending(), 1);
	assert.deepEqual(shim.delays, [0, 5000]);
});

test("steady loop: chained setTimeout ticks poll with --limit=100 and repaint the widget", async () => {
	const { controller, shim, calls } = makeController([
		ok(IDENTITY_JSON),
		ok(TAIL_JSON),
		ok(TAIL_JSON),
		ok(TAIL_JSON),
	]);
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	await shim.advance(0);
	const tui = fakeTui();
	ctx.ui.widgets.get(PULSE_WIDGET_KEY).content(tui, identityTheme);

	await shim.advance(5_000);
	assert.equal(calls.length, 3);
	assert.deepEqual(calls[2].args, TAIL_ARGS(100));
	await shim.advance(5_000);
	assert.equal(calls.length, 4);
	assert.equal(shim.pending(), 1, "always exactly one pending chained timer");
	assert.ok(tui.rendersSoFar() >= 2, "requestRender on ticks");
});

test("gap delta requests exactly one deep repair poll (--limit=500), then back to 100", async () => {
	const { controller, shim, calls } = makeController([
		ok(IDENTITY_JSON), // init-tick identity fetch (once per session)
		ok(TAIL_JSON), // init (500)
		ok(GAP_JSON), // all-unseen window -> gap + repair
		ok(TAIL_JSON), // repair poll (500)
		ok(TAIL_JSON), // steady again (100)
	]);
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	await shim.advance(0);
	await shim.advance(5_000);
	await shim.advance(5_000);
	await shim.advance(5_000);
	assert.deepEqual(calls[0].args, WHOAMI_ARGS);
	assert.deepEqual(
		calls.slice(1).map((call) => call.args[4]),
		["--limit=500", "--limit=100", "--limit=500", "--limit=100"],
	);
});

/* ----------------------------- density handling ----------------------------- */

test("density restores from the latest iroh-room.density custom entry on the branch", async () => {
	const branch = [
		{ type: "custom", customType: DENSITY_ENTRY_TYPE, data: { density: "2" } },
		{ type: "custom", customType: "other.extension", data: { density: "off" } },
		{ type: "custom", customType: DENSITY_ENTRY_TYPE, data: { density: "pill" } },
	];
	const { controller, shim, calls } = makeController([ok(IDENTITY_JSON), ok(TAIL_JSON)]);
	const ctx = tuiCtx({ sessionManager: { getBranch: () => branch } });
	await controller.onSessionStart({ type: "session_start", reason: "resume" }, ctx);
	await shim.advance(0);
	assert.equal(controller.getDensity(), "pill");
	// pill density: polling on (identity fetch + tail), pill on, NO widget
	assert.equal(calls.length, 2);
	assert.equal(shim.pending(), 1);
	assert.equal(ctx.ui.widgets.size, 0);
	assert.equal(ctx.ui.statuses.get(PULSE_STATUS_KEY), "iroh ●");
});

test("density falls back to pulse_density config, then to the default 2", async () => {
	const labeled = await mkdtemp(join(tmpdir(), "iroh-room-ambient-cfg-"));
	await writeFile(
		join(labeled, ".iroh-room-pi.json"),
		JSON.stringify({ room_id: ROOM_ID, iroh_rooms_bin: binPath, pulse_density: "1", room_label: "demo room" }),
	);
	try {
		const { controller, shim } = makeController([ok(IDENTITY_JSON), ok(TAIL_JSON)], { env: {} });
		const ctx = tuiCtx({ cwd: labeled });
		await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
		await shim.advance(0);
		assert.equal(controller.getDensity(), "1");
		// room_label wins over roomId(8) in the widget line
		const component = ctx.ui.widgets.get(PULSE_WIDGET_KEY).content(fakeTui(), identityTheme);
		assert.ok(component.render(80)[0].includes("room demo room"));

		const fallback = makeController([ok(IDENTITY_JSON), ok(TAIL_JSON)]);
		const ctx2 = tuiCtx();
		await fallback.controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx2);
		assert.equal(fallback.controller.getDensity(), "2");
	} finally {
		await rm(labeled, { recursive: true, force: true });
	}
});

test("density off: config default off starts NO poll loop at all", async () => {
	const offCwd = await mkdtemp(join(tmpdir(), "iroh-room-ambient-off-"));
	await writeFile(
		join(offCwd, ".iroh-room-pi.json"),
		JSON.stringify({ room_id: ROOM_ID, iroh_rooms_bin: binPath, pulse_density: "off" }),
	);
	try {
		const { controller, shim, calls } = makeController([], { env: {} });
		const ctx = tuiCtx({ cwd: offCwd });
		await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
		assert.equal(controller.getDensity(), "off");
		assert.equal(calls.length, 0);
		assert.equal(shim.pending(), 0);
		assert.equal(ctx.ui.widgets.size, 0);
		assert.equal(ctx.ui.statuses.size, 0);
	} finally {
		await rm(offCwd, { recursive: true, force: true });
	}
});

test("setDensity('off') tears the loop down entirely: no pending timers, widget + pill cleared", async () => {
	const { controller, shim } = makeController([ok(IDENTITY_JSON), ok(TAIL_JSON)]);
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	await shim.advance(0);
	assert.equal(shim.pending(), 1);
	await controller.setDensity("off");
	assert.equal(shim.pending(), 0);
	assert.equal(ctx.ui.widgets.size, 0);
	assert.equal(ctx.ui.statuses.size, 0);
	// no zombie polls later
	await shim.advance(120_000);
	assert.equal(shim.pending(), 0);
});

test("density can come back from off: widget + pill + loop restart (re-init poll)", async () => {
	// identity is fetched once per SESSION — not again after off/on
	const { controller, shim, calls } = makeController([ok(IDENTITY_JSON), ok(TAIL_JSON), ok(TAIL_JSON)]);
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	await shim.advance(0);
	await controller.setDensity("off");
	assert.equal(calls.length, 2);
	await controller.setDensity("2");
	await shim.advance(0);
	assert.equal(calls.length, 3);
	assert.equal(shim.pending(), 1);
	assert.ok(ctx.ui.widgets.has(PULSE_WIDGET_KEY));
	assert.equal(ctx.ui.statuses.get(PULSE_STATUS_KEY), "iroh ●");
});

test("cycleDensity walks off -> pill -> 1 -> 2 -> off", async () => {
	const { controller } = makeController([]);
	assert.equal(controller.getDensity(), "2");
	assert.equal(controller.cycleDensity(), "off");
	assert.equal(controller.cycleDensity(), "pill");
	assert.equal(controller.cycleDensity(), "1");
	assert.equal(controller.cycleDensity(), "2");
});

/* ------------------------------- boost window ------------------------------- */

test("boost: 2s cadence for the boost window after our own activity, then back to 5s", async () => {
	const { controller, shim, calls } = makeController(
		[ok(IDENTITY_JSON), ok(TAIL_JSON), ok(TAIL_JSON), ok(TAIL_JSON), ok(TAIL_JSON)],
		{ options: { boostWindowMs: 5_000 } },
	);
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	await shim.advance(0);
	assert.deepEqual(shim.delays, [0, 5000]);
	controller.boost();
	// the pending 5s timer is pulled in to the boost cadence
	assert.deepEqual(shim.delays, [0, 5000, 2000]);
	assert.equal(shim.pending(), 1);
	await shim.advance(2_000); // t=2s, still inside the 5s window -> 2s again
	assert.equal(calls.length, 3);
	assert.deepEqual(shim.delays, [0, 5000, 2000, 2000]);
	await shim.advance(2_000); // t=4s tick; next fires at t=6s (window over at 5s)
	await shim.advance(2_000);
	assert.equal(calls.length, 5);
	assert.equal(shim.delays[shim.delays.length - 1], 5000, "back to ambient cadence");
});

test("boost is a no-op while the loop is not running (off density / unconfigured)", async () => {
	const { controller, shim } = makeController([]);
	controller.boost();
	assert.equal(shim.pending(), 0);
});

/* ------------------------- backoff + failure episodes ----------------------- */

test("backoff ladder 5->10->20->40->60(cap) with ONE feed_failing toast, then feed_recovered", async () => {
	const failures = Array.from({ length: 6 }, () => fail(2, ERROR_STDERR_ROOM));
	const { controller, shim, calls } = makeController([ok(IDENTITY_JSON), ...failures, ok(TAIL_JSON)]);
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	await shim.advance(0);
	await shim.advance(5_000);
	await shim.advance(10_000);
	await shim.advance(20_000);
	await shim.advance(40_000);
	await shim.advance(60_000);
	await shim.advance(60_000); // recovery poll
	assert.equal(calls.length, 8);
	assert.deepEqual(shim.delays, [0, 5000, 10000, 20000, 40000, 60000, 60000, 5000]);

	const toasts = ctx.ui.notifications;
	assert.equal(toasts.length, 2, JSON.stringify(toasts));
	assert.equal(toasts[0].type, "warning");
	assert.match(toasts[0].message, /feed failing — poll failed \(invalid_room_id\)/);
	assert.equal(toasts[1].type, "info");
	assert.match(toasts[1].message, /feed recovered/);
	// degraded pill while failing was ✗, healthy again after recovery
	assert.equal(ctx.ui.statuses.get(PULSE_STATUS_KEY), "iroh ●");
});

test("session teardown wipes the store: no stale snapshot render, no cross-session feed_recovered", async () => {
	// Session A ends inside a failure episode; session B (same controller —
	// it outlives sessions) must start from "◌ starting" and its first
	// successful poll must NOT emit the matching "feed recovered" toast.
	const { controller, shim } = makeController([
		ok(IDENTITY_JSON),
		fail(2, ERROR_STDERR_ROOM), // session A: init poll fails -> episode
		ok(IDENTITY_JSON),
		ok(TAIL_JSON), // session B: first poll succeeds
	]);
	const ctxA = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctxA);
	await shim.advance(0);
	assert.match(ctxA.ui.notifications[0].message, /feed failing/);

	controller.shutdown();
	const ctxB = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "new" }, ctxB);
	// BEFORE session B's init poll lands: the widget must not render session
	// A's failure/rows — the reset store reads as "starting".
	const component = ctxB.ui.widgets.get(PULSE_WIDGET_KEY).content(fakeTui(), identityTheme);
	const [preLine] = component.render(80);
	assert.ok(!preLine.includes("poll failed"), `stale failure rendered: ${preLine}`);
	assert.ok(preLine.includes("starting"), preLine);

	await shim.advance(0); // session B init poll (success)
	const recovered = ctxB.ui.notifications.filter((toast) => /feed recovered/.test(toast.message));
	assert.equal(recovered.length, 0, "spurious cross-session feed_recovered toast");
	assert.equal(ctxB.ui.statuses.get(PULSE_STATUS_KEY), "iroh ●");
});

test("thrown exec errors map to the taxonomy (timeout) and render in the widget line", async () => {
	const { controller, shim } = makeController([
		ok(IDENTITY_JSON),
		() => {
			throw new Error("iroh-rooms did not finish within 60000ms (killed): fake room tail");
		},
	]);
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	await shim.advance(0);
	assert.match(ctx.ui.notifications[0].message, /poll failed \(timeout\)/);
	assert.equal(ctx.ui.statuses.get(PULSE_STATUS_KEY), "iroh ✗");
	const component = ctx.ui.widgets.get(PULSE_WIDGET_KEY).content(fakeTui(), identityTheme);
	const [line] = component.render(80);
	assert.ok(line.startsWith("✗ poll failed (timeout) · retry 5s"), line);
	assert.equal(shim.pending(), 1);
});

/* -------------------------------- single-flight ----------------------------- */

test("single-flight: an overlapping tick never double-executes, boosts included", async () => {
	let release;
	const blocked = new Promise((resolve) => {
		release = resolve;
	});
	const { controller, shim, calls } = makeController([ok(IDENTITY_JSON), () => blocked, ok(TAIL_JSON)]);
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	const advancing = shim.advance(0); // fires the init tick, which blocks in exec
	await flushMicrotasks(); // let the init tick pass identity + reach the blocked exec
	assert.equal(calls.length, 2);
	controller.boost();
	controller.boost();
	assert.equal(calls.length, 2, "no overlapping poll started");
	assert.equal(shim.pending(), 0, "no timer scheduled while in flight");
	release(ok(TAIL_JSON));
	await advancing;
	assert.equal(calls.length, 2);
	assert.equal(shim.pending(), 1, "chain resumes after the in-flight tick");
	await shim.advance(2_000); // boost window is still active
	assert.equal(calls.length, 3);
});

/* ------------------------------ teardown paths ------------------------------ */

test("shutdown teardown is idempotent: timers gone, widget + pill cleared, repeat is a no-op", async () => {
	const { controller, shim } = makeController([ok(IDENTITY_JSON), ok(TAIL_JSON)]);
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	await shim.advance(0);
	assert.equal(shim.pending(), 1);
	controller.shutdown();
	assert.equal(shim.pending(), 0);
	assert.equal(ctx.ui.widgets.size, 0);
	assert.equal(ctx.ui.statuses.size, 0);
	assert.doesNotThrow(() => controller.shutdown());
	assert.equal(shim.pending(), 0);
	// boost after shutdown is inert
	controller.boost();
	assert.equal(shim.pending(), 0);
});

test("a second session_start restarts cleanly (previous loop torn down first)", async () => {
	// teardown resets the once-per-session identity fetch too
	const { controller, shim, calls } = makeController([
		ok(IDENTITY_JSON),
		ok(TAIL_JSON),
		ok(IDENTITY_JSON),
		ok(TAIL_JSON),
	]);
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	await shim.advance(0);
	const ctx2 = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "new" }, ctx2);
	await shim.advance(0);
	assert.equal(calls.length, 4, "one identity fetch + one init poll per session start");
	assert.equal(shim.pending(), 1, "exactly one chained loop");
	assert.ok(ctx2.ui.widgets.has(PULSE_WIDGET_KEY));
});

/* --------------------- in-flight polls across lifecycle edges --------------- */

test("session_start never blocks on the init poll: scheduled at 0, not awaited", async () => {
	let release;
	const blocked = new Promise((resolve) => {
		release = resolve;
	});
	const { controller, shim, calls } = makeController([ok(IDENTITY_JSON), () => blocked]);
	const ctx = tuiCtx();
	// resolves immediately even though the exec would hang (slow/hung binary,
	// untrusted-log-sized offline fold): the deep poll runs on the chain.
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(calls.length, 0, "no exec inside the session_start handler");
	assert.equal(shim.pending(), 1);
	assert.deepEqual(shim.delays, [0], "deep init poll scheduled, not awaited");
	const advancing = shim.advance(0);
	await flushMicrotasks();
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0].args, WHOAMI_ARGS, "identity fetch leads the init tick");
	assert.deepEqual(calls[1].args, TAIL_ARGS(500), "deep poll still runs first");
	release(ok(TAIL_JSON));
	await advancing;
	assert.equal(ctx.ui.statuses.get(PULSE_STATUS_KEY), "iroh ●");
});

test("restart during an in-flight poll: the stale poll cannot seed the new session's store", async () => {
	let release;
	const blocked = new Promise((resolve) => {
		release = resolve;
	});
	const OLD_JSON = `${JSON.stringify([
		{
			event_id: `blake3:${"9".repeat(64)}`,
			event_type: "agent.status",
			lamport: 900,
			at: "2026-07-05T09:00:00Z",
			from: "0ld5e55a",
			state: "old-room-state",
			progress: 99,
		},
	])}\n`;
	const { controller, shim, calls } = makeController([
		ok(IDENTITY_JSON),
		() => blocked,
		ok(IDENTITY_JSON),
		ok(TAIL_JSON),
	]);
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	const advancing = shim.advance(0);
	await flushMicrotasks(); // session A's deep poll is now blocked in exec
	assert.equal(calls.length, 2);

	controller.shutdown();
	const ctx2 = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "new" }, ctx2);
	// the STALE poll resolves (old rows) only after the new session began
	release(ok(OLD_JSON));
	await advancing; // drives the stale resume AND the new session's init poll
	assert.equal(calls.length, 4, "new session ran its own identity fetch + deep init poll");
	assert.equal(shim.pending(), 1, "exactly one chained loop (no stale reschedule)");

	const component = ctx2.ui.widgets.get(PULSE_WIDGET_KEY).content(fakeTui(), identityTheme);
	const lines = component.render(80);
	assert.ok(lines[0].includes("sts implementing 45%"), lines[0]);
	assert.ok(!lines.join("\n").includes("old-room-state"), "no stale store seed");
	assert.ok(!lines[0].includes("⚠"), "no spurious gap from a stale init");
	assert.equal(ctx2.ui.notifications.length, 0, "no toast leaked into the new session");
});

test("restart during an in-flight poll: a stale FAILURE never toasts or backs off the new session", async () => {
	let release;
	const blocked = new Promise((resolve) => {
		release = resolve;
	});
	const { controller, shim, calls } = makeController([
		ok(IDENTITY_JSON),
		() => blocked,
		ok(IDENTITY_JSON),
		ok(TAIL_JSON),
	]);
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	const advancing = shim.advance(0);
	await flushMicrotasks();

	controller.shutdown();
	const ctx2 = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "new" }, ctx2);
	release(fail(2, ERROR_STDERR_ROOM)); // the stale poll fails AFTER the restart
	await advancing;
	assert.equal(calls.length, 4);
	assert.equal(ctx2.ui.notifications.length, 0, "no feed-failing toast for a stale poll");
	assert.equal(ctx2.ui.statuses.get(PULSE_STATUS_KEY), "iroh ●", "new session stays healthy");
	assert.equal(shim.delays[shim.delays.length - 1], 5000, "no backoff from a stale failure");
});

test("density off during an in-flight poll: its failure is silenced, and no stale recovered toast follows", async () => {
	let release;
	const blocked = new Promise((resolve) => {
		release = resolve;
	});
	const { controller, shim, calls } = makeController([
		ok(IDENTITY_JSON),
		ok(TAIL_JSON),
		() => blocked,
		ok(TAIL_JSON),
	]);
	const ctx = tuiCtx();
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
	await shim.advance(0);
	const advancing = shim.advance(5_000); // this tick blocks in exec
	await flushMicrotasks();
	assert.equal(calls.length, 3);
	await controller.setDensity("off"); // user silences the pulse mid-poll
	release(fail(2, ERROR_STDERR_ROOM)); // ... and the poll then fails
	await advancing;
	assert.equal(ctx.ui.notifications.length, 0, "no feed-failing toast after off");
	assert.equal(shim.pending(), 0, "loop stays torn down");
	assert.equal(ctx.ui.statuses.size, 0);
	// back on: the silenced episode never happened, so no stale "recovered"
	await controller.setDensity("2");
	await shim.advance(0);
	assert.equal(calls.length, 4);
	assert.equal(ctx.ui.notifications.length, 0, "no stale feed-recovered toast");
	assert.equal(ctx.ui.statuses.get(PULSE_STATUS_KEY), "iroh ●");
});

/* -------------------------- entry wiring + /room-pulse ---------------------- */

function recorderAmbient() {
	const events = [];
	let density = "2";
	return {
		events,
		onSessionStart: async () => {
			events.push("session_start");
		},
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

test("entry wires session_start, iroh_*-filtered tool_execution_end boosts, and shutdown into ONE handler each", async () => {
	const pi = stubPi();
	const ambient = recorderAmbient();
	entry.createIrohRoomExtension({ env: baseEnv, exec: stubExec([]).exec, ambient })(pi);

	assert.equal(pi.handlers.get("session_start")?.length, 1);
	assert.equal(pi.handlers.get("tool_execution_end")?.length, 1);
	assert.equal(pi.handlers.get("session_shutdown")?.length, 1);

	const ctx = tuiCtx();
	await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(ambient.events, ["session_start"]);

	const toolEnd = pi.handlers.get("tool_execution_end")[0];
	await toolEnd({ type: "tool_execution_end", toolCallId: "c1", toolName: "iroh_room_send", result: {}, isError: false }, ctx);
	assert.deepEqual(ambient.events, ["session_start", "boost"]);
	await toolEnd({ type: "tool_execution_end", toolCallId: "c2", toolName: "bash", result: {}, isError: false }, ctx);
	assert.deepEqual(ambient.events, ["session_start", "boost"], "non-iroh tools never boost");

	await pi.handlers.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" }, ctx);
	assert.deepEqual(ambient.events, ["session_start", "boost", "shutdown"]);
});

function makePulseCommands(queue = []) {
	const pi = stubPi();
	const ambient = recorderAmbient();
	const { exec } = stubExec(queue);
	registerIrohCommands(pi, { env: baseEnv, exec, ambient });
	const byName = new Map(pi.commands.map((command) => [command.name, command]));
	const ctx = tuiCtx();
	const run = (name, args) => byName.get(name).handler(args, ctx);
	return { pi, ambient, ctx, byName, run };
}

test("/room-pulse <density> applies + persists via appendEntry; bad args are a usage error", async () => {
	const { pi, ambient, ctx, run } = makePulseCommands();
	await run(COMMAND_NAMES.roomPulse, "1");
	assert.ok(ambient.events.includes("set:1"));
	assert.deepEqual(pi.entries, [{ customType: DENSITY_ENTRY_TYPE, data: { density: "1" } }]);
	assert.match(ctx.ui.notifications[0].message, /room pulse density: 1/);

	await run(COMMAND_NAMES.roomPulse, "bogus");
	assert.equal(ctx.ui.notifications[1].type, "error");
	assert.match(ctx.ui.notifications[1].message, /usage: \/room-pulse/);
	assert.equal(pi.entries.length, 1, "no persistence on bad args");
});

test("/room-pulse with no argument cycles and persists the new density", async () => {
	const { pi, ambient, run } = makePulseCommands();
	await run(COMMAND_NAMES.roomPulse, "");
	assert.ok(ambient.events.includes("cycle:off"));
	assert.deepEqual(pi.entries, [{ customType: DENSITY_ENTRY_TYPE, data: { density: "off" } }]);
});

test("/room-pulse argument completions offer the four densities", () => {
	const { byName } = makePulseCommands();
	const complete = byName.get(COMMAND_NAMES.roomPulse).getArgumentCompletions;
	assert.deepEqual(
		complete("").map((item) => item.value),
		["off", "pill", "1", "2"],
	);
	assert.deepEqual(
		complete("p").map((item) => item.value),
		["pill"],
	);
	assert.equal(complete("z"), null);
});

test("every /room* command handler boosts the ambient poll after running", async () => {
	const { ambient, run } = makePulseCommands([ok(TAIL_JSON)]);
	await run(COMMAND_NAMES.roomTail, String(TAIL_ROWS.length));
	assert.ok(ambient.events.includes("boost"), JSON.stringify(ambient.events));
	const before = ambient.events.filter((event) => event === "boost").length;
	// even a failing/usage-error handler still boosts
	await run(COMMAND_NAMES.roomStatus, "");
	assert.equal(ambient.events.filter((event) => event === "boost").length, before + 1);
});
