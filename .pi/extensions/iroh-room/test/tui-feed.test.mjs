import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension } from "./helpers.mjs";
import { TAIL_ROWS, hostileTailRows } from "./fixtures.mjs";

const ext = await loadExtension();
const { RoomFeedStore, classifyPollError, describePollFailure, failureFromRun } =
	await ext.importModule("tui/feed");

after(() => ext.cleanup());

/** Minimal TailRow factory: ascending (lamport, event_id) like the CLI. */
function row(lamport, extra = {}) {
	return {
		event_id: `blake3:${String(lamport).padStart(4, "0").repeat(16)}`,
		event_type: "message.text",
		lamport,
		at: "2026-07-05T10:00:00Z",
		from: "e1d2c3b4",
		body: `event ${lamport}`,
		...extra,
	};
}

function rows(...lamports) {
	return lamports.map((lamport) => row(lamport));
}

/* --------------------------------- init ------------------------------------ */

test("init seeds the ring + watermark and emits zero signals (backlog suppression)", () => {
	const store = new RoomFeedStore();
	store.init(TAIL_ROWS, 1_000);
	const snapshot = store.snapshot();
	assert.equal(snapshot.initialized, true);
	assert.equal(snapshot.lastOkAt, 1_000);
	assert.equal(snapshot.seenCount, TAIL_ROWS.length);
	assert.equal(snapshot.rowCount, TAIL_ROWS.length);
	assert.equal(snapshot.latestRow, TAIL_ROWS[TAIL_ROWS.length - 1]);
	// the latest agent.status row is tracked; its label lives in row.state
	assert.equal(snapshot.latestStatusRow?.state, "implementing");
	// re-ingesting the seeded backlog yields nothing fresh
	const delta = store.ingest(TAIL_ROWS, 2_000);
	assert.deepEqual(delta, { freshRows: [], gap: false, repair: false, recovered: false });
});

test("re-init fully resets carried state: latestRow/latestStatusRow/newestId never leak across rooms", () => {
	const store = new RoomFeedStore();
	store.init(TAIL_ROWS, 1_000); // room A: contains an agent.status row
	assert.equal(store.snapshot().latestStatusRow?.state, "implementing");
	// room B's window has no agent.status: the old room's status must vanish
	store.init(rows(50, 51), 2_000);
	const snapshot = store.snapshot();
	assert.equal(snapshot.latestStatusRow, undefined, "no stale status under the new room's label");
	assert.equal(snapshot.latestRow?.lamport, 51);
	assert.equal(snapshot.seenCount, 2);
	// an EMPTY re-init clears the last event too
	store.init([], 3_000);
	const empty = store.snapshot();
	assert.equal(empty.latestRow, undefined);
	assert.equal(empty.latestStatusRow, undefined);
	assert.equal(empty.rowCount, 0);
	assert.equal(empty.seenCount, 0);
});

test("reset() returns to construction state: nothing leaks into the next session", () => {
	const store = new RoomFeedStore();
	store.init(TAIL_ROWS, 1_000);
	store.recordFailure({ kind: "coded", exitCode: 2, errorCode: "room_not_found" }, 2_000);
	store.reset(); // session teardown
	const snapshot = store.snapshot();
	assert.equal(snapshot.initialized, false, "widget must render the uninitialized state");
	assert.equal(snapshot.lastOkAt, undefined);
	assert.equal(snapshot.failure, undefined, "a dangling failure episode must not survive teardown");
	assert.equal(snapshot.latestRow, undefined);
	assert.equal(snapshot.latestStatusRow, undefined);
	assert.equal(snapshot.seenCount, 0);
	assert.equal(snapshot.rowCount, 0);
	// the next session's first poll is an init (backlog suppression), and a
	// subsequent ingest reports recovered:false — the old episode is gone
	store.init(rows(60, 61), 3_000);
	const delta = store.ingest(rows(60, 61, 62), 4_000);
	assert.equal(delta.recovered, false, "spurious cross-session feed_recovered");
	assert.deepEqual(delta.freshRows.map((r) => r.lamport), [62]);
});

test("re-init resets newestId: a stale fingerprint can never fake the fast path", () => {
	const store = new RoomFeedStore();
	store.init(rows(1, 2, 3), 1_000);
	// re-init with 3 id-less rows: count matches, and without the reset the
	// stale newestId of row 3 would make the next ingest hit the fast path
	store.init(
		[{ event_type: "message.text" }, { event_type: "message.text" }, { event_type: "message.text" }],
		2_000,
	);
	const delta = store.ingest(rows(1, 2, 3), 3_000);
	assert.deepEqual(
		delta.freshRows.map((entry) => entry.lamport),
		[1, 2, 3],
	);
});

test("init returns no value and never throws on hostile rows (missing event_id tolerated)", () => {
	const store = new RoomFeedStore();
	assert.equal(store.init(hostileTailRows, 1_000), undefined);
	const snapshot = store.snapshot();
	// the orphan row (no event_id) is skipped, everything else is seen
	assert.equal(snapshot.seenCount, hostileTailRows.length - 1);
});

/* ------------------------------- fast path ---------------------------------- */

test("fast path: newest event_id + row count unchanged -> no fresh rows, lastOkAt still advances", () => {
	const store = new RoomFeedStore();
	store.init(rows(1, 2, 3), 1_000);
	const delta = store.ingest(rows(1, 2, 3), 6_000);
	assert.deepEqual(delta, { freshRows: [], gap: false, repair: false, recovered: false });
	assert.equal(store.snapshot().lastOkAt, 6_000);
});

/* -------------------------------- ingest ------------------------------------ */

test("new rows at the head come back as freshRows exactly once", () => {
	const store = new RoomFeedStore();
	store.init(rows(1, 2, 3), 1_000);
	const first = store.ingest(rows(2, 3, 4, 5), 6_000);
	assert.deepEqual(
		first.freshRows.map((entry) => entry.lamport),
		[4, 5],
	);
	assert.equal(first.gap, false);
	const again = store.ingest(rows(2, 3, 4, 5), 11_000);
	assert.deepEqual(again.freshRows, []);
});

test("rows missing a string event_id are skipped, never thrown on", () => {
	const store = new RoomFeedStore();
	store.init(rows(1, 2), 1_000);
	const polluted = [row(3), { event_type: "message.text", body: "orphan" }, { event_id: 42, lamport: 9 }];
	const delta = store.ingest(polluted, 6_000);
	assert.deepEqual(
		delta.freshRows.map((entry) => entry.lamport),
		[3],
	);
});

test("gossip backfill within the ring (lamport <= max, unseen id) is detected as fresh, not dropped", () => {
	const store = new RoomFeedStore();
	// lamport 3 is causally incomplete at init and excluded by the CLI
	store.init(rows(1, 2, 4, 5), 1_000);
	const delta = store.ingest(rows(1, 2, 3, 4, 5), 6_000);
	assert.deepEqual(
		delta.freshRows.map((entry) => entry.lamport),
		[3],
	);
	assert.equal(delta.gap, false);
});

test("saturated-window backfill: a mid-window insert that shifts the oldest row defeats the fast path", () => {
	const store = new RoomFeedStore();
	// steady state at --limit: every poll returns exactly 5 rows
	store.init(rows(11, 12, 14, 15, 16), 1_000);
	// lamport 13 backfills MID-window; row 11 scrolls out: count (5) and the
	// newest event_id (16) are both unchanged — only the oldest id moved
	const delta = store.ingest(rows(12, 13, 14, 15, 16), 6_000);
	assert.deepEqual(
		delta.freshRows.map((entry) => entry.lamport),
		[13],
	);
	assert.equal(delta.gap, false);
	assert.equal(store.snapshot().seenCount, 6, "backfilled id entered the ring");
	// the now-identical window takes the fast path again
	const again = store.ingest(rows(12, 13, 14, 15, 16), 11_000);
	assert.deepEqual(again, { freshRows: [], gap: false, repair: false, recovered: false });
});

/* ---------------------------------- ring ------------------------------------ */

test("ring evicts the lowest (lamport, event_id) beyond capacity (constructor-injectable)", () => {
	const store = new RoomFeedStore({ ringCapacity: 4 });
	store.init(rows(1, 2, 3, 4), 1_000);
	store.ingest(rows(3, 4, 5, 6), 6_000); // evicts 1 and 2
	assert.equal(store.snapshot().seenCount, 4);
	// evicted ids re-count as fresh (the documented tolerance boundary)
	const delta = store.ingest(rows(1, 2, 4, 5, 6), 11_000);
	assert.deepEqual(
		delta.freshRows.map((entry) => entry.lamport),
		[1, 2],
	);
});

test("default ring capacity is 2048 ids", () => {
	const store = new RoomFeedStore();
	const bulk = [];
	for (let i = 1; i <= 3_000; i++) bulk.push(row(i));
	store.init(bulk, 1_000);
	assert.equal(store.snapshot().seenCount, 2_048);
});

/* ----------------------------------- gap ------------------------------------ */

test("gap: all rows unseen while a watermark exists -> flag + exactly ONE repair request", () => {
	const store = new RoomFeedStore();
	store.init(rows(1, 2, 3), 1_000);
	const first = store.ingest(rows(100, 101, 102), 6_000);
	assert.equal(first.gap, true);
	assert.equal(first.repair, true);
	assert.deepEqual(
		first.freshRows.map((entry) => entry.lamport),
		[100, 101, 102],
	);
	// still gapped, but the repair request fired once per episode
	const second = store.ingest(rows(200, 201), 11_000);
	assert.equal(second.gap, true);
	assert.equal(second.repair, false);
	// overlap restored (deep repair poll) clears the gap
	const repaired = store.ingest(rows(100, 101, 102, 200, 201, 202), 16_000);
	assert.equal(repaired.gap, false);
	assert.equal(repaired.repair, false);
	assert.deepEqual(
		repaired.freshRows.map((entry) => entry.lamport),
		[202],
	);
	assert.equal(store.snapshot().gap, false);
});

test("no gap without a watermark: an empty init then a full window is just backlog", () => {
	const store = new RoomFeedStore();
	store.init([], 1_000);
	const delta = store.ingest(rows(1, 2, 3), 6_000);
	assert.equal(delta.gap, false);
	assert.equal(delta.repair, false);
	assert.deepEqual(
		delta.freshRows.map((entry) => entry.lamport),
		[1, 2, 3],
	);
});

/* ------------------------------ failure taxonomy ---------------------------- */

test("failureFromRun maps coded and uncoded CLI failures", () => {
	assert.deepEqual(failureFromRun({ code: 2, errorCode: "room_not_found" }), {
		kind: "coded",
		exitCode: 2,
		errorCode: "room_not_found",
	});
	assert.deepEqual(failureFromRun({ code: 1 }), { kind: "exit", exitCode: 1 });
});

test("classifyPollError maps thrown local errors (timeout, binary missing, other)", () => {
	assert.equal(
		classifyPollError(new Error("iroh-rooms did not finish within 60000ms (killed): /x/iroh-rooms room tail")).kind,
		"timeout",
	);
	assert.equal(
		classifyPollError(new Error("iroh-rooms binary not found — fix one of: (1) set IROH_ROOMS_BIN=…")).kind,
		"binary_missing",
	);
	assert.equal(
		classifyPollError(new Error("configured iroh-rooms binary does not exist: /gone")).kind,
		"binary_missing",
	);
	assert.equal(
		classifyPollError(new Error("failed to run /x/iroh-rooms room tail: spawn /x/iroh-rooms ENOENT")).kind,
		"binary_missing",
	);
	assert.equal(classifyPollError(new Error("something odd")).kind, "local");
	assert.equal(classifyPollError("not-an-error").kind, "local");
});

test("describePollFailure renders the §2.1 taxonomy — and can never say no_admin_reachable", () => {
	assert.equal(
		describePollFailure({ kind: "coded", exitCode: 2, errorCode: "invalid_room_id" }),
		"poll failed (invalid_room_id)",
	);
	assert.equal(describePollFailure({ kind: "exit", exitCode: 3 }), "poll failed (exit 3)");
	assert.equal(describePollFailure({ kind: "binary_missing" }), "poll failed (binary missing)");
	assert.equal(describePollFailure({ kind: "timeout" }), "poll failed (timeout)");
	assert.equal(describePollFailure({ kind: "local", message: "x" }), "poll failed (local error)");
	// `room tail --offline` is a pure local read: the admin is never contacted
	for (const kind of ["coded", "exit", "binary_missing", "timeout", "local"]) {
		assert.ok(!describePollFailure({ kind }).includes("no_admin_reachable"));
	}
});

/* --------------------------- failure/recovery episode ----------------------- */

test("recordFailure starts one episode; the next successful ingest reports recovered", () => {
	const store = new RoomFeedStore();
	store.init(rows(1, 2), 1_000);
	assert.deepEqual(store.recordFailure({ kind: "exit", exitCode: 1 }, 6_000), {
		episodeStart: true,
	});
	// still failing: not a new episode
	assert.deepEqual(store.recordFailure({ kind: "timeout" }, 11_000), { episodeStart: false });
	const snapshot = store.snapshot();
	assert.equal(snapshot.failure?.kind, "timeout");
	// last good data is KEPT with its honest timestamp
	assert.equal(snapshot.lastOkAt, 1_000);
	const delta = store.ingest(rows(1, 2, 3), 16_000);
	assert.equal(delta.recovered, true);
	assert.equal(store.snapshot().failure, undefined);
	// recovery via the fast path also clears the episode
	store.recordFailure({ kind: "exit", exitCode: 1 }, 20_000);
	const fastRecovered = store.ingest(rows(1, 2, 3), 21_000);
	assert.equal(fastRecovered.recovered, true);
	assert.deepEqual(fastRecovered.freshRows, []);
});

test("staleness is derived, never stored: the snapshot exposes lastOkAt and no stale flag", () => {
	const store = new RoomFeedStore();
	store.init(rows(1), 1_000);
	const snapshot = store.snapshot();
	assert.ok(!("stale" in snapshot));
	assert.equal(typeof snapshot.lastOkAt, "number");
});
