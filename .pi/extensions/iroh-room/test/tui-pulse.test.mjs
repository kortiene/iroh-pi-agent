import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension } from "./helpers.mjs";
import {
	GOLDEN_PILL,
	GOLDEN_PULSE,
	GOLDEN_PULSE_FAIL,
	GOLDEN_PULSE_FAIL_VIEW,
	GOLDEN_PULSE_STALE,
	GOLDEN_PULSE_STALE_VIEW,
	GOLDEN_PULSE_VIEW,
	HOSTILE_TICKET,
	hostileTailRows,
} from "./fixtures.mjs";

const ext = await loadExtension();
const { renderPulse, renderPill } = await ext.importModule("tui/pulse");
const { identityStyler, naiveFit, GLYPHS } = await ext.importModule("tui/style");

after(() => ext.cleanup());

const WIDTHS = [80, 60, 40];
const ESC = String.fromCharCode(0x1b);
const C1_RE = /[\u0080-\u009f]/;
const TICKET_TAIL = HOSTILE_TICKET.slice(-16);

function assertLineInvariants(lines, width, label) {
	for (const line of lines) {
		assert.equal(typeof line, "string", `${label}: non-string line`);
		assert.ok(!line.includes(ESC), `${label}: ESC leaked: ${JSON.stringify(line)}`);
		assert.ok(!C1_RE.test(line), `${label}: C1 byte leaked: ${JSON.stringify(line)}`);
		assert.ok(!line.includes(HOSTILE_TICKET), `${label}: full invite ticket leaked`);
		assert.ok(!line.includes(TICKET_TAIL), `${label}: ticket tail leaked: ${JSON.stringify(line)}`);
		assert.ok(line.length <= width, `${label}: line ${line.length} > width ${width}`);
	}
}

/* --------------------------------- goldens ---------------------------------- */

test("pulse golden renders at 80/60/40 (healthy, density 2)", () => {
	for (const width of WIDTHS) {
		assert.deepEqual(
			renderPulse(GOLDEN_PULSE_VIEW, "2", width, identityStyler, naiveFit),
			GOLDEN_PULSE[width],
		);
	}
});

test("pulse golden renders at 80/60/40 (coded failure with retry countdown)", () => {
	for (const width of WIDTHS) {
		assert.deepEqual(
			renderPulse(GOLDEN_PULSE_FAIL_VIEW, "2", width, identityStyler, naiveFit),
			GOLDEN_PULSE_FAIL[width],
		);
	}
});

test("pulse golden renders at 80/60/40 (stale data, staleness derived from now - lastOkAt)", () => {
	for (const width of WIDTHS) {
		assert.deepEqual(
			renderPulse(GOLDEN_PULSE_STALE_VIEW, "2", width, identityStyler, naiveFit),
			GOLDEN_PULSE_STALE[width],
		);
	}
});

test("density controls the line budget: 2 -> two lines, 1 -> one line, pill/off -> none", () => {
	assert.equal(renderPulse(GOLDEN_PULSE_VIEW, "2", 80, identityStyler, naiveFit).length, 2);
	assert.deepEqual(renderPulse(GOLDEN_PULSE_VIEW, "1", 80, identityStyler, naiveFit), [
		GOLDEN_PULSE[80][0],
	]);
	assert.deepEqual(renderPulse(GOLDEN_PULSE_VIEW, "pill", 80, identityStyler, naiveFit), []);
	assert.deepEqual(renderPulse(GOLDEN_PULSE_VIEW, "off", 80, identityStyler, naiveFit), []);
});

test("the freshness glyph is always the first cell of line 1", () => {
	for (const [view, glyph] of [
		[GOLDEN_PULSE_VIEW, GLYPHS.ok],
		[GOLDEN_PULSE_FAIL_VIEW, GLYPHS.fail],
		[GOLDEN_PULSE_STALE_VIEW, GLYPHS.stale],
	]) {
		const [line] = renderPulse(view, "1", 80, identityStyler, naiveFit);
		assert.ok(line.startsWith(glyph), `expected ${glyph} first: ${JSON.stringify(line)}`);
	}
});

test("task counts are always ~-marked; zero/undefined counts render no task cell", () => {
	const [line] = renderPulse(GOLDEN_PULSE_VIEW, "1", 80, identityStyler, naiveFit);
	assert.ok(line.includes("○ 2 tasks~"));
	const noTasks = { ...GOLDEN_PULSE_VIEW, unclaimedTasks: 0 };
	assert.ok(!renderPulse(noTasks, "1", 80, identityStyler, naiveFit)[0].includes("○"));
	const noCount = { ...GOLDEN_PULSE_VIEW };
	delete noCount.unclaimedTasks;
	assert.ok(!renderPulse(noCount, "1", 80, identityStyler, naiveFit)[0].includes("~"));
});

test("a gap shows on line 1 until repaired", () => {
	const gapped = { ...GOLDEN_PULSE_VIEW, feed: { ...GOLDEN_PULSE_VIEW.feed, gap: true } };
	assert.ok(renderPulse(gapped, "1", 80, identityStyler, naiveFit)[0].includes("⚠ gap"));
});

test("room_label wins over the id prefix as the pulse label", () => {
	const labeled = { ...GOLDEN_PULSE_VIEW, label: "demo-room" };
	assert.ok(renderPulse(labeled, "1", 80, identityStyler, naiveFit)[0].includes("room demo-room"));
});

/* ----------------------------------- pill ----------------------------------- */

test("pill goldens: healthy / failing / stale / broken-config", () => {
	assert.equal(renderPill(GOLDEN_PULSE_VIEW), GOLDEN_PILL.healthy);
	assert.equal(renderPill(GOLDEN_PULSE_FAIL_VIEW), GOLDEN_PILL.failing);
	assert.equal(renderPill(GOLDEN_PULSE_STALE_VIEW), GOLDEN_PILL.stale);
	assert.equal(
		renderPill({
			label: "?",
			now: 0,
			staleAfterMs: 0,
			pipeCount: 0,
			brokenConfig: true,
			feed: { initialized: false, gap: false },
		}),
		GOLDEN_PILL.broken,
	);
});

test("pill with nothing to count is just the freshness glyph", () => {
	const bare = { ...GOLDEN_PULSE_VIEW, unclaimedTasks: 0, pipeCount: 0 };
	assert.equal(renderPill(bare), "iroh ●");
});

/* --------------------------------- hostile ---------------------------------- */

test("pulse over hostile snapshot content keeps the line invariants at every width/density", () => {
	for (const hostileRow of hostileTailRows) {
		const view = {
			label: "● room spoof ✗",
			now: 100_000,
			staleAfterMs: 15_000,
			retryInMs: 4_000,
			pipeCount: 1,
			unclaimedTasks: 3,
			feed: {
				initialized: true,
				lastOkAt: 99_000,
				gap: false,
				latestRow: hostileRow,
				latestStatusRow: {
					event_type: "agent.status",
					state: `${String.fromCharCode(0x1b)}[31mevil-state`,
					progress: 45,
				},
			},
		};
		for (const width of [...WIDTHS, 30, 20]) {
			for (const density of ["1", "2"]) {
				const lines = renderPulse(view, density, width, identityStyler, naiveFit);
				assert.ok(lines.length <= 2);
				assertLineInvariants(lines, width, `pulse(width=${width}, density=${density})`);
			}
		}
	}
});

test("pulse never throws on degenerate widths or a malformed view", () => {
	assert.doesNotThrow(() => renderPulse(GOLDEN_PULSE_VIEW, "2", 0, identityStyler, naiveFit));
	assert.doesNotThrow(() => renderPulse(GOLDEN_PULSE_VIEW, "2", Number.NaN, identityStyler, naiveFit));
	const junkView = { label: 42, now: "x", staleAfterMs: null, pipeCount: "y", feed: {} };
	assert.doesNotThrow(() => renderPulse(junkView, "2", 80, identityStyler, naiveFit));
	assert.doesNotThrow(() => renderPill(junkView));
});
