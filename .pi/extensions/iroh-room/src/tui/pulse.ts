/**
 * Pure renderers for the room pulse: the <=2-line below-editor widget
 * (renderPulse) and the plain footer pill (renderPill), brief §4 M1.
 *
 * - The freshness glyph is ALWAYS present: ● ok, ◌ stale (data older than
 *   staleAfterMs, derived from now - lastOkAt at render time), ✗ failure
 *   (with "poll failed (…) · retry Ns"), ⚙ broken config.
 * - Task counts are heuristic and always ~-marked.
 * - Every room-authored string passes roomText; every line gets a final
 *   width clamp at the component boundary (M0 clamp pattern, U3).
 * - Style-last: cells are measured/truncated plain, colored per finished
 *   cell; the injected fit does the final (ANSI-aware at runtime) clamp.
 * - Never throws: hostile snapshot content degrades, it does not crash the
 *   render loop.
 */

import { summarizeTailRow, type TailRow } from "../cli.js";
import type { PulseDensity } from "../constants.js";
import { tailEventRow } from "./cards.js";
import { describePollFailure, type FeedFailure } from "./feed.js";
import { roomText } from "./sanitize.js";
import { GLYPHS, STATUS_LABEL_COLS, naiveFit, type FitFn, type Styler } from "./style.js";

/** Display budget for the room label (room_label config or roomId(8)). */
export const PULSE_LABEL_COLS = 24;

/**
 * The composed view the ambient layer feeds the renderers: the pure feed
 * snapshot plus ambient-owned context (label, cadence, pipe count, retry).
 */
export interface PulseView {
	/** room_label config or the first 8 hex of the room id. */
	label: string;
	/** Render-time clock (same source the ambient layer polls with). */
	now: number;
	/** Snapshot is stale once now - lastOkAt exceeds this. */
	staleAfterMs: number;
	/** Time until the next poll attempt (retry countdown on failure). */
	retryInMs?: number;
	/** Live pipes owned by this session (PipeManager.list().length). */
	pipeCount: number;
	/** Heuristic unclaimed task count (M2 fills this in); always ~-marked. */
	unclaimedTasks?: number;
	/** Config resolution failed: render the ⚙ pill and nothing else. */
	brokenConfig?: boolean;
	feed: {
		initialized: boolean;
		lastOkAt?: number;
		failure?: FeedFailure;
		gap: boolean;
		latestRow?: TailRow;
		latestStatusRow?: TailRow;
	};
}

type Freshness = "ok" | "stale" | "fail" | "starting";

function freshness(view: PulseView): Freshness {
	if (view.feed.failure !== undefined) return "fail";
	if (view.feed.lastOkAt === undefined) return "starting";
	if (view.now - view.feed.lastOkAt > view.staleAfterMs) return "stale";
	return "ok";
}

function seconds(ms: number): number {
	return Math.max(0, Math.round(ms / 1000));
}

/** Plain freshness cell (glyph always first). */
function freshnessCell(view: PulseView, state: Freshness): string {
	switch (state) {
		case "ok":
			return GLYPHS.ok;
		case "starting":
			return `${GLYPHS.stale} starting`;
		case "stale": {
			const age = seconds(view.now - (view.feed.lastOkAt ?? view.now));
			return `${GLYPHS.stale} data ${age}s old`;
		}
		case "fail": {
			const base = `${GLYPHS.fail} ${describePollFailure(view.feed.failure ?? { kind: "local" })}`;
			return view.retryInMs !== undefined
				? `${base} · retry ${seconds(view.retryInMs)}s`
				: base;
		}
	}
}

const FRESHNESS_COLOR: Record<Freshness, string> = {
	ok: "success",
	stale: "warning",
	fail: "error",
	starting: "dim",
};

/**
 * The widget lines: [] for density off/pill, one line for "1", up to two
 * lines for "2". Every line is hard-clamped by the injected fit.
 */
export function renderPulse(
	view: PulseView,
	density: PulseDensity,
	width: number,
	styler: Styler,
	fit: FitFn,
): string[] {
	try {
		if (density === "off" || density === "pill") {
			return [];
		}
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
		const state = freshness(view);
		const cells: string[] = [
			styler(FRESHNESS_COLOR[state], freshnessCell(view, state)),
			styler("accent", `room ${roomText(view.label, PULSE_LABEL_COLS, fit) || "?"}`),
		];
		const statusRow = view.feed.latestStatusRow;
		if (statusRow !== undefined && typeof statusRow.state === "string") {
			// agent.status carries its label in row.state (row.status is
			// membership state on every row — brief §2.5).
			const label = roomText(statusRow.state, STATUS_LABEL_COLS, fit);
			const progress = typeof statusRow.progress === "number" ? ` ${statusRow.progress}%` : "";
			cells.push(styler("muted", `sts ${label}${progress}`));
		}
		if (typeof view.unclaimedTasks === "number" && view.unclaimedTasks > 0) {
			const n = view.unclaimedTasks;
			cells.push(styler("text", `${GLYPHS.task} ${n} task${n === 1 ? "" : "s"}${GLYPHS.heuristic}`));
		}
		if (view.feed.gap) {
			cells.push(styler("warning", "⚠ gap"));
		}
		if (view.pipeCount > 0) {
			cells.push(
				styler("muted", `${GLYPHS.pipe} ${view.pipeCount} pipe${view.pipeCount === 1 ? "" : "s"}`),
			);
		}
		if (state === "ok" && view.retryInMs !== undefined) {
			cells.push(styler("dim", `${GLYPHS.refresh} ${seconds(view.retryInMs)}s`));
		}
		const lines = [fit(cells.join("  "), safeWidth)];
		if (density === "2" && view.feed.latestRow !== undefined) {
			const row = view.feed.latestRow;
			const event = {
				type: row.event_type,
				author: row.display_name ?? row.from,
				timestamp: row.at,
				summary: summarizeTailRow(row),
			};
			lines.push(
				fit(`${styler("dim", "└")} ${tailEventRow(event, styler, fit, Math.max(0, safeWidth - 2))}`, safeWidth),
			);
		}
		// Final clamp at the component boundary (U3): no line may exceed the
		// render width, whatever the per-cell budget math produced.
		return lines.map((line) => fit(line, safeWidth));
	} catch {
		// Deliberately plain (no injected styler/fit — they may be the throwers).
		return [naiveFit("iroh-room pulse (render failed)", Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80)];
	}
}

/**
 * The footer pill: plain text for ctx.ui.setStatus (pi styles the footer).
 * Carries NO room-authored strings — glyphs and counts only.
 */
export function renderPill(view: PulseView): string {
	try {
		if (view.brokenConfig === true) {
			return `iroh ${GLYPHS.gear} unconfigured`;
		}
		const state = freshness(view);
		const glyph =
			state === "fail" ? GLYPHS.fail : state === "ok" ? GLYPHS.ok : GLYPHS.stale;
		const parts = [`iroh ${glyph}`];
		if (typeof view.unclaimedTasks === "number" && view.unclaimedTasks > 0) {
			parts.push(`${GLYPHS.task}${view.unclaimedTasks}${GLYPHS.heuristic}`);
		}
		if (view.pipeCount > 0) {
			parts.push(`${GLYPHS.pipe}${view.pipeCount}`);
		}
		return parts.join(" ");
	} catch {
		return `iroh ${GLYPHS.stale}`;
	}
}
