/**
 * tasks.ts unit tests (M2): detector gating + TaskTracker claim semantics
 * (message-claim vs status-claim, the state-vs-status field trap, cap 50).
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension } from "./helpers.mjs";

const ext = await loadExtension();
const { detectTasks, TaskTracker } = await ext.importModule("tui/tasks");

after(() => ext.cleanup());

const fence = "```";
const taskBlock = (id, type = "implement", title = "a title") =>
	`${fence}room-task\nid: ${id}\ntype: ${type}\ntitle: ${title}\n${fence}`;

const msg = (body, extra = {}) => ({ event_type: "message.text", body, ...extra });

/* -------------------------------- detector -------------------------------- */

test("detectTasks: required-field gate — id/type/title all present, type in vocabulary", () => {
	assert.deepEqual(detectTasks(taskBlock("T-1", "debug", "fix it")), [
		{ id: "T-1", type: "debug", title: "fix it" },
	]);
	assert.deepEqual(detectTasks(`${fence}room-task\nid: T-2\ntitle: no type\n${fence}`), []);
	assert.deepEqual(detectTasks(`${fence}room-task\nid: T-3\ntype: deploy\ntitle: bad type\n${fence}`), []);
	assert.deepEqual(detectTasks(`${fence}room-task\ntype: test\ntitle: no id\n${fence}`), []);
	assert.deepEqual(detectTasks(`${fence}room-task\nid:\ntype: test\ntitle: empty id\n${fence}`), []);
});

test("detectTasks: duplicate id keys last-wins; quoted values stripped one layer", () => {
	assert.deepEqual(
		detectTasks(`${fence}room-task\nid: A\nid: B\ntype: review\ntitle: "quoted"\n${fence}`),
		[{ id: "B", type: "review", title: "quoted" }],
	);
});

test("detectTasks: quoted openers (foreign fences) and unterminated blocks yield nothing", () => {
	assert.deepEqual(
		detectTasks(`${fence}markdown\n${taskBlock("QUOTED")}\n${fence}`),
		[],
	);
	assert.deepEqual(detectTasks(`${fence}room-task\nid: OPEN\ntype: test\ntitle: open`), []);
	assert.deepEqual(detectTasks(`    ${fence}room-task\n    id: I\n    ${fence}`), []);
});

test("detectTasks never throws on hostile bodies", () => {
	for (const hostile of ["", "``", "`".repeat(10_000), `${fence}room-task\n${"x:".repeat(500)}\n${fence}`]) {
		assert.doesNotThrow(() => detectTasks(hostile));
	}
});

/* -------------------------------- tracker --------------------------------- */

test("tracker: extraction + claim via 'Claiming task <id>' message body", () => {
	const tracker = new TaskTracker();
	const fresh = tracker.ingest([msg(taskBlock("T-1")), msg(taskBlock("T-2"))]);
	assert.deepEqual(fresh.map((task) => task.id), ["T-1", "T-2"]);
	assert.equal(tracker.unclaimedCount(), 2);

	tracker.ingest([msg("Claiming task T-1 as pi-agent. I will post progress.")]);
	assert.deepEqual(tracker.unclaimed().map((task) => task.id), ["T-2"]);
	assert.deepEqual(tracker.taskIds(), ["T-1", "T-2"], "claims never drop tracking");
});

test("tracker: claim via agent.status state === 'claimed' whose message mentions the id", () => {
	const tracker = new TaskTracker();
	tracker.ingest([msg(taskBlock("T-9"))]);
	tracker.ingest([{ event_type: "agent.status", state: "claimed", message: "claimed T-9 for work" }]);
	assert.equal(tracker.unclaimedCount(), 0);
});

test("tracker REGRESSION (brief §2.5 field trap): row.status is MEMBERSHIP, never a claim", () => {
	const tracker = new TaskTracker();
	tracker.ingest([msg(taskBlock("T-5"))]);
	// membership status "claimed"-shaped values on the row must be ignored;
	// only row.STATE carries the agent.status label.
	tracker.ingest([{ event_type: "agent.status", status: "claimed", message: "T-5" }]);
	assert.equal(tracker.unclaimedCount(), 1, "status field must not claim");
	tracker.ingest([{ event_type: "agent.status", state: "claimed", status: "active", message: "T-5" }]);
	assert.equal(tracker.unclaimedCount(), 0, "state field does claim");
});

test("tracker: claim-id boundary — claiming T-10 does not claim T-1", () => {
	const tracker = new TaskTracker();
	tracker.ingest([msg(taskBlock("T-1")), msg(taskBlock("T-10"))]);
	tracker.ingest([msg("Claiming task T-10 as pi-agent.")]);
	assert.deepEqual(tracker.unclaimed().map((task) => task.id), ["T-1"]);
});

test("tracker: claim arriving BEFORE the task (gossip backfill) still counts", () => {
	const tracker = new TaskTracker();
	tracker.ingest([msg("Claiming task LATE-1 as pi-agent.")]);
	tracker.ingest([msg(taskBlock("LATE-1"))]);
	assert.equal(tracker.unclaimedCount(), 0);
});

test("tracker: unclaimed capped at 50", () => {
	const tracker = new TaskTracker();
	const rows = Array.from({ length: 60 }, (_, i) => msg(taskBlock(`BULK-${i}`)));
	tracker.ingest(rows);
	assert.equal(tracker.unclaimedCount(), 50);
	assert.equal(tracker.unclaimed().length, 50);
	assert.equal(tracker.taskIds().length, 60, "tracking itself is not capped at 50");
});

test("tracker: re-posted task ids are not fresh twice; reset clears everything", () => {
	const tracker = new TaskTracker();
	assert.equal(tracker.ingest([msg(taskBlock("R-1"))]).length, 1);
	assert.equal(tracker.ingest([msg(taskBlock("R-1", "implement", "new title"))]).length, 0);
	assert.equal(tracker.unclaimed()[0].title, "new title", "last wins");
	tracker.reset();
	assert.equal(tracker.unclaimedCount(), 0);
	assert.deepEqual(tracker.taskIds(), []);
});

test("tracker REGRESSION: unclaimed() is memoized between ingests (per-frame reads must not rescan)", () => {
	// The pulse widget calls unclaimedCount() on EVERY render frame (per
	// keystroke); the claimed-set only changes in ingest()/reset(). Without
	// memoization a hostile flood at the tracker caps (200 tasks × 400
	// signals × 512 chars) costs tens of ms of substring scans per repaint.
	const tracker = new TaskTracker();
	tracker.ingest([msg(taskBlock("M-1")), msg(taskBlock("M-2"))]);
	const first = tracker.unclaimed();
	assert.equal(tracker.unclaimed(), first, "repeat render reads return the cached array");
	assert.equal(tracker.unclaimedCount(), 2);

	// ingest invalidates: a claim arriving in the next poll must be visible
	tracker.ingest([msg("Claiming task M-1 as pi-agent.")]);
	const second = tracker.unclaimed();
	assert.notEqual(second, first, "ingest invalidates the cache");
	assert.deepEqual(second.map((task) => task.id), ["M-2"]);

	// even a no-signal ingest re-derives (cheap: once per poll, not per frame)
	tracker.ingest([]);
	assert.deepEqual(tracker.unclaimed().map((task) => task.id), ["M-2"]);

	// reset invalidates too — a stale cache must never leak across sessions
	tracker.reset();
	assert.deepEqual(tracker.unclaimed(), []);
});

test("tracker never throws on hostile rows (non-objects, non-string bodies)", () => {
	const tracker = new TaskTracker();
	assert.doesNotThrow(() =>
		tracker.ingest([null, 42, {}, { event_type: "message.text", body: 7 }, { event_type: "agent.status", state: "claimed", message: null }]),
	);
	assert.equal(tracker.unclaimedCount(), 0);
});
