/**
 * Cockpit ↔ AmbientController data-architecture bridge (brief §7 + §14).
 *
 * The render/lifecycle suite (tui-cockpit-render.test.mjs) drives the cockpit
 * against a FAKE CockpitDataSource. This suite exercises the REAL
 * AmbientController.getSnapshot/requestRefresh/subscribe — the code the brief's
 * §7 "no second room-tail loop" and §14 "single-flight manual refresh /
 * immutable snapshot rendering" acceptance criteria are actually about.
 */

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadExtension, stubCtx, stubExec, stubTimers } from "./helpers.mjs";
import { ERROR_STDERR_ROOM, FILE_LIST_JSON, IDENTITY_AGENT, IDENTITY_JSON, MEMBERS_JSON, ROOM_ID, TAIL_ROWS, TAIL_JSON, fail, ok } from "./fixtures.mjs";

const ext = await loadExtension();
const { AmbientController } = await ext.importModule("tui/ambient");

const cwd = await mkdtemp(join(tmpdir(), "iroh-room-cockpit-bridge-"));
const binPath = join(cwd, "fake-iroh-rooms");
await writeFile(binPath, "#!/bin/sh\nexit 0\n");
await chmod(binPath, 0o755);
const baseEnv = { IROH_ROOM_ID: ROOM_ID, IROH_ROOMS_BIN: binPath };

after(async () => {
	await rm(cwd, { recursive: true, force: true });
	await ext.cleanup();
});

function makeController(queue, { env = baseEnv, options = {} } = {}) {
	const shim = stubTimers();
	const { calls, exec } = stubExec(queue);
	const controller = new AmbientController({ env, exec, now: shim.now, timers: shim.timers, ...options });
	return { controller, shim, calls };
}

function tuiCtx(overrides = {}) {
	return stubCtx({ cwd, mode: "tui", hasUI: true, ...overrides });
}

async function flushMicrotasks(rounds = 16) {
	for (let i = 0; i < rounds; i++) {
		await Promise.resolve();
	}
}

function deferred() {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function startSteady(queue) {
	const made = makeController(queue);
	await made.controller.onSessionStart({ type: "session_start", reason: "startup" }, tuiCtx());
	await made.shim.advance(0); // init tick: identity fetch + deep tail poll (never awaited)
	return made;
}

/* --------------------------- no second poll loop --------------------------- */

test("cockpit bridge starts NO second room-tail loop: getSnapshot/subscribe schedule no timers, no exec", async () => {
	const { controller, shim, calls } = await startSteady([ok(IDENTITY_JSON), ok(TAIL_JSON)]);

	// After the init tick the ambient owns exactly ONE chained timer.
	assert.equal(shim.pending(), 1, "one ambient timer after init");
	const delaysAfterInit = shim.delays.length;
	const callsAfterInit = calls.length;
	assert.equal(callsAfterInit, 2, "identity + deep poll only");

	// Cockpit consumption (read snapshot, subscribe) must not add a poller.
	const unsub = controller.subscribe(() => {});
	for (let i = 0; i < 5; i++) {
		controller.getSnapshot();
	}
	unsub();

	assert.equal(shim.pending(), 1, "still exactly one timer — cockpit owns none");
	assert.equal(shim.delays.length, delaysAfterInit, "getSnapshot/subscribe scheduled no timer");
	assert.equal(calls.length, callsAfterInit, "getSnapshot/subscribe shelled out to no CLI");
});

/* --------------------------- single-flight refresh ------------------------- */

test("requestRefresh is single-flight: a concurrent refresh reuses the in-flight poll", async () => {
	const gate = deferred();
	const { controller, shim, calls } = await startSteady([
		ok(IDENTITY_JSON),
		ok(TAIL_JSON),
		// manual-refresh tail poll blocks on the gate so we can race a 2nd call
		() => gate.promise.then(() => ok(TAIL_JSON)),
		// Members/Artifacts tabs: manual refresh updates roster/file metadata
		// immediately after the single tail poll; this is not a second room-tail loop.
		ok(MEMBERS_JSON),
		ok(FILE_LIST_JSON),
	]);
	assert.equal(calls.length, 2);

	const r1 = controller.requestRefresh(); // clears the chained timer, runs tick(true)
	await flushMicrotasks();
	assert.equal(calls.length, 3, "manual refresh started exactly one poll");

	const r2 = controller.requestRefresh(); // in-flight → must reuse, not re-poll
	await flushMicrotasks();
	assert.equal(calls.length, 3, "single-flight: no second poll while one is in flight");

	gate.resolve();
	await Promise.all([r1, r2]);
	assert.equal(calls.length, 5, "one manual tail poll plus immediate members/file metadata polls after both awaits resolve");
	assert.equal(calls.filter((call) => call.args[0] === "room" && call.args[1] === "tail").length, 2, "init tail + one manual tail only");
	assert.equal(calls.filter((call) => call.args[0] === "room" && call.args[1] === "members").length, 1, "single roster poll after manual refresh");
	assert.equal(calls.filter((call) => call.args[0] === "file" && call.args[1] === "list").length, 1, "single file metadata poll after manual refresh");
	// After the manual poll completes it re-arms the ambient chain (no leak).
	assert.equal(shim.pending(), 1, "exactly one chained timer after refresh");
});

test("requestRefresh is inert before a session is configured (no exec, no timer)", async () => {
	const { controller, shim, calls } = makeController([]);
	await controller.requestRefresh();
	assert.equal(calls.length, 0, "no CLI without a session");
	assert.equal(shim.pending(), 0, "no timer scheduled");
});

/* --------------------------- immutable snapshot --------------------------- */

test("getSnapshot returns a deeply frozen snapshot that mirrors real polled rows", async () => {
	const { controller } = await startSteady([ok(IDENTITY_JSON), ok(TAIL_JSON)]);
	const snap = controller.getSnapshot();

	// mirrors real state
	assert.equal(snap.config.roomId, ROOM_ID);
	assert.equal(snap.feed.state, "ok");
	assert.equal(typeof snap.feed.lastOkAt, "number");
	assert.equal(snap.identity?.name, "pi-agent");
	assert.equal(snap.identity?.from8, IDENTITY_AGENT.slice(0, 8));
	assert.equal(snap.events.length, TAIL_ROWS.length);
	assert.equal(snap.latest.status?.label, "implementing");
	assert.equal(snap.latest.status?.progress, 45);

	// deeply frozen: rendering can never mutate live feed internals (§7)
	assert.ok(Object.isFrozen(snap), "snapshot frozen");
	assert.ok(Object.isFrozen(snap.feed), "feed frozen");
	assert.ok(Object.isFrozen(snap.tasks), "tasks frozen");
	assert.ok(Object.isFrozen(snap.events), "events array frozen");
	if (snap.events[0] !== undefined) {
		assert.ok(Object.isFrozen(snap.events[0]), "event row frozen");
	}
	assert.throws(() => {
		snap.events.push({ type: "x", summary: "y" });
	}, TypeError);

	// successive reads are independent frozen copies, not the same mutable ref
	const snap2 = controller.getSnapshot();
	assert.notEqual(snap2, snap, "fresh snapshot per call");
	assert.notEqual(snap2.events, snap.events, "fresh events array per call");
});

/* --------------------------- subscribe / notify --------------------------- */

test("subscribe fires on poll completion; unsubscribe stops further notifications", async () => {
	const { controller, shim } = await startSteady([
		ok(IDENTITY_JSON),
		ok(TAIL_JSON),
		ok(TAIL_JSON),
		ok(TAIL_JSON),
	]);
	let hits = 0;
	const unsub = controller.subscribe(() => {
		hits += 1;
	});

	await shim.advance(5_000); // one steady tick → notifySubscribers in tick.finally
	assert.ok(hits >= 1, "listener fired on a successful poll");
	const afterFirst = hits;

	unsub();
	await shim.advance(5_000); // another tick
	assert.equal(hits, afterFirst, "no notifications after unsubscribe");

	// a throwing listener never breaks the poll loop
	controller.subscribe(() => {
		throw new Error("boom");
	});
	await assert.doesNotReject(shim.advance(5_000));
});

/* --------------------------- feed-state truth ----------------------------- */

test("snapshot feed state tracks the real store: ok → failing → recovered", async () => {
	const { controller, shim } = await startSteady([
		ok(IDENTITY_JSON),
		ok(TAIL_JSON), // init → ok
		fail(2, ERROR_STDERR_ROOM), // steady tick → failing
		ok(TAIL_JSON), // steady tick → recovered
	]);
	assert.equal(controller.getSnapshot().feed.state, "ok");

	await shim.advance(5_000);
	const failing = controller.getSnapshot();
	assert.equal(failing.feed.state, "failing");
	assert.equal(typeof failing.feed.failure, "string");
	assert.ok(failing.feed.failure.length > 0, "failure carries a description");

	await shim.advance(5_000);
	assert.equal(controller.getSnapshot().feed.state, "ok", "recovers on the next good poll");
});
