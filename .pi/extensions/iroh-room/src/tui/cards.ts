/**
 * Pure line builders for the "/room" health card, the "/room-tail" events
 * card, and one-line receipts (brief §4 M0). Rendered by the message renderer
 * registered in wire.ts.
 *
 * SECURITY CONTRACT:
 * - Every room-authored string passes roomText() before display.
 * - These builders NEVER throw and always return at least one line: the
 *   registered renderer must always yield a Component, because a renderer
 *   that returns undefined or throws falls through to the host's Markdown
 *   component — a room-content Markdown-injection path.
 * - Unknown card kinds / event types render as a dim generic row.
 * - The untrusted-content framing (U7) survives rendering: the tail card
 *   carries a trailing "untrusted room content" tag, collapsed and expanded.
 */

import { roomText } from "./sanitize.js";
import {
	AUTHOR_COLS,
	GLYPHS,
	STATUS_LABEL_COLS,
	idPrefix,
	naiveFit,
	shortEventId,
	styledCell,
	type FitFn,
	type Styler,
} from "./style.js";

/** Rows shown by the collapsed /room-tail card. */
export const COLLAPSED_TAIL_ROWS = 4;

export const UNTRUSTED_TAG = "untrusted room content";

/** Dim divider inserted before the first event newer than the last look (M2). */
export const NEW_SINCE_DIVIDER = "── new since last look ──";

export interface CardRenderOptions {
	expanded: boolean;
}

/** One event of a tail card's details (shape of opTailSnapshot's events). */
export interface TailCardEvent {
	type?: unknown;
	author?: unknown;
	timestamp?: unknown;
	summary?: unknown;
	event_id?: unknown;
	lamport?: unknown;
	[key: string]: unknown;
}

export interface TailCardDetails {
	kind: "tail";
	room_id?: string;
	count: number;
	events: TailCardEvent[];
	/** Last-look watermark (ambient noteTailLook): divider goes after it. */
	new_since?: { lamport?: number; event_id?: string };
}

export interface RoomCardDetails {
	kind: "room";
	room_id?: string;
	config_file?: string;
	data_dir?: string;
	agent_name?: string;
	cwd?: string;
	binary?: string;
	binary_version?: string;
	identity_name?: string;
	identity_id8?: string;
	pipes: { pipe_id?: string; target?: string; label?: string }[];
	issues: string[];
	/** Unclaimed room-task ids (heuristic, ≤5 rendered, always ~-marked). */
	unclaimed_tasks?: string[];
}

export interface ReceiptDetails {
	kind: "receipt";
	action: string;
	label?: string;
	event_id?: string;
	file_id?: string;
	pipe_id?: string;
	target?: string;
	count?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/**
 * Extract HH:MM from a room-supplied ISO timestamp BY SHAPE (only digits and
 * a colon can pass), so hostile timestamp strings cannot smuggle anything.
 */
function timeCell(timestamp: unknown): string {
	if (typeof timestamp === "string") {
		const match = /T(\d{2}:\d{2})/.exec(timestamp);
		if (match?.[1] !== undefined) return match[1];
	}
	return "--:--";
}

const TYPE_ABBREV: Record<string, string> = {
	"message.text": "msg",
	"agent.status": "sts",
	"file.shared": "file",
	"pipe.opened": "pipe",
	"pipe.closed": "pipe",
	"member.invited": "mbr",
	"member.joined": "mbr",
	"member.left": "mbr",
	"member.removed": "mbr",
	"room.created": "room",
};

/**
 * One line per tail event: `HH:MM author type summary`. Cells are truncated
 * plain, styled last; the summary gets the leftover budget so room content
 * can never push the chrome off the line. Also reused by the
 * iroh_room_tail_snapshot result view (toolviews.ts).
 */
export function tailEventRow(
	event: TailCardEvent,
	styler: Styler,
	fit: FitFn,
	width: number,
): string {
	const time = timeCell(event.timestamp);
	const author = roomText(event.author ?? "?", AUTHOR_COLS, fit) || "?";
	const rawType = typeof event.type === "string" ? event.type : "unknown";
	const known = TYPE_ABBREV[rawType];
	const type = known ?? (roomText(rawType, STATUS_LABEL_COLS, fit) || "?");
	const used = time.length + 1 + author.length + 1 + type.length + 1;
	const summary = roomText(event.summary ?? "", Math.max(0, width - used), fit);
	const cells = [
		styler("dim", time),
		styler(known === undefined ? "dim" : "accent", author),
		styler("muted", type),
	];
	if (summary !== "") cells.push(summary);
	// Final clamp (U3): the per-cell budgets are measured in code units, which
	// undercounts wide (CJK/emoji) columns, and the fixed chrome alone exceeds
	// very narrow widths — the composed line must never exceed the render
	// width (at runtime the injected fit is pi-tui's width-aware truncate).
	return fit(cells.join(" "), width);
}

function tailCardLines(
	details: Record<string, unknown>,
	options: CardRenderOptions,
	styler: Styler,
	fit: FitFn,
	width: number,
): string[] {
	const events = Array.isArray(details.events) ? (details.events as unknown[]) : [];
	const rows = events.filter(isRecord);
	const roomId = typeof details.room_id === "string" ? idPrefix(details.room_id.replace(/^blake3:/, "")) : undefined;
	const count = typeof details.count === "number" ? details.count : rows.length;
	// Measure both header cells plain so the finished line fits the width.
	const countText = naiveFit(`${count} event${count === 1 ? "" : "s"}`, 16);
	const roomLabel = fit(
		roomId === undefined ? "room" : `room ${roomId}`,
		Math.max(0, width - countText.length - 3),
	);
	const lines: string[] = [`${styler("accent", roomLabel)} · ${styler("text", countText)}`];
	const shown = options.expanded ? rows : rows.slice(-COLLAPSED_TAIL_ROWS);
	// New-since-last-look divider (M2): the controller records the max
	// (lamport, event_id) at each /room-tail emission; the NEXT card marks
	// the first strictly-newer event. No record => no divider.
	const since = isRecord(details.new_since) ? details.new_since : undefined;
	const sinceLamport = typeof since?.lamport === "number" ? since.lamport : undefined;
	const sinceId = typeof since?.event_id === "string" ? since.event_id : "";
	let dividerPending = sinceLamport !== undefined;
	for (const row of shown) {
		if (dividerPending) {
			const lamport = typeof row.lamport === "number" ? row.lamport : -1;
			const id = typeof row.event_id === "string" ? row.event_id : "";
			if (lamport > (sinceLamport as number) || (lamport === sinceLamport && id > sinceId)) {
				lines.push(styledCell("dim", NEW_SINCE_DIVIDER, width, styler, fit));
				dividerPending = false;
			}
		}
		lines.push(tailEventRow(row, styler, fit, Math.max(0, width)));
	}
	const hidden = rows.length - shown.length;
	const footer =
		hidden > 0 ? `${hidden} more · ctrl+o to expand · ${UNTRUSTED_TAG}` : UNTRUSTED_TAG;
	lines.push(styledCell("dim", footer, width, styler, fit));
	return lines;
}

function roomCardLines(
	details: Record<string, unknown>,
	styler: Styler,
	fit: FitFn,
	width: number,
): string[] {
	const str = (key: string): string | undefined =>
		typeof details[key] === "string" ? (details[key] as string) : undefined;
	const roomId = str("room_id");
	const issues = Array.isArray(details.issues)
		? (details.issues as unknown[]).filter((issue): issue is string => typeof issue === "string")
		: [];
	const pipes = Array.isArray(details.pipes) ? (details.pipes as unknown[]).filter(isRecord) : [];
	const healthText = naiveFit(
		issues.length === 0 ? "health ok" : `health ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
		20,
	);
	const roomLabel = fit(
		roomId === undefined ? "iroh-room (room not set)" : `iroh-room ${idPrefix(roomId.replace(/^blake3:/, ""))}`,
		Math.max(0, width - healthText.length - 3),
	);
	const health = styler(issues.length === 0 ? "success" : "warning", healthText);
	const lines: string[] = [`${styler("accent", roomLabel)} · ${health}`];
	const body = Math.max(0, width - 1);
	const push = (label: string, value: string): void => {
		const labelCell = styler("muted", label);
		lines.push(` ${labelCell} ${roomText(value, Math.max(0, body - label.length - 1), fit)}`);
	};
	push("config", str("config_file") ?? "(none found)");
	push("data dir", str("data_dir") ?? "(iroh-rooms default)");
	const version = str("binary_version");
	push("binary", `${str("binary") ?? "NOT FOUND"}${version !== undefined ? ` (${version})` : ""}`);
	const identityName = str("identity_name");
	push(
		"identity",
		identityName === undefined ? "(none)" : `${identityName} (${str("identity_id8") ?? "?"}…)`,
	);
	// Unclaimed room-task ids (M2 catch-up affordance, brief §3.4): up to 5,
	// always ~-marked. Room-authored ids — the whole cell passes roomText.
	const unclaimedTasks = Array.isArray(details.unclaimed_tasks)
		? (details.unclaimed_tasks as unknown[]).filter((id): id is string => typeof id === "string")
		: [];
	if (unclaimedTasks.length > 0) {
		push("tasks~", unclaimedTasks.slice(0, 5).join(" "));
	}
	if (pipes.length === 0) {
		push("pipes", "(none)");
	} else {
		for (const pipe of pipes) {
			const pipeId = typeof pipe.pipe_id === "string" ? pipe.pipe_id : "?";
			const target = typeof pipe.target === "string" ? pipe.target : "?";
			const label = typeof pipe.label === "string" ? ` (${roomText(pipe.label, STATUS_LABEL_COLS, fit)})` : "";
			lines.push(
				` ${styler("muted", GLYPHS.pipe)} ${fit(`${pipeId} → ${target}${label}`, Math.max(0, body - 2))}`,
			);
		}
	}
	for (const issue of issues) {
		lines.push(` ${styler("warning", GLYPHS.fail)} ${roomText(issue, Math.max(0, body - 2), fit)}`);
	}
	return lines;
}

function receiptLines(
	details: Record<string, unknown>,
	styler: Styler,
	fit: FitFn,
	width: number,
): string[] {
	const parts: string[] = [];
	if (typeof details.action === "string") {
		parts.push(roomText(details.action, 24, fit));
	} else {
		parts.push("done");
	}
	if (typeof details.label === "string") parts.push(roomText(details.label, STATUS_LABEL_COLS, fit));
	if (typeof details.count === "number") parts.push(`×${details.count}`);
	const ids: string[] = [];
	if (typeof details.event_id === "string") ids.push(`event ${shortEventId(details.event_id)}`);
	if (typeof details.file_id === "string") ids.push(`file ${details.file_id}`);
	if (typeof details.pipe_id === "string") {
		ids.push(
			`pipe ${details.pipe_id}${typeof details.target === "string" ? ` → ${details.target}` : ""}`,
		);
	}
	const plain = [parts.join(" "), ...ids].join(" · ");
	return [`${styler("success", GLYPHS.ok)} ${fit(plain, Math.max(0, width - 2))}`];
}

/**
 * Dispatcher for the "iroh-room.card" / "iroh-room.receipt" message renderer.
 * NEVER throws, never returns an empty array — bad/missing/hostile details
 * degrade to a one-line dim fallback (fallthrough would be Markdown).
 */
export function buildCardLines(
	details: unknown,
	options: CardRenderOptions,
	styler: Styler,
	fit: FitFn,
	width: number,
): string[] {
	try {
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
		if (isRecord(details)) {
			let lines: string[] | undefined;
			if (details.kind === "tail") lines = tailCardLines(details, options, styler, fit, safeWidth);
			else if (details.kind === "room") lines = roomCardLines(details, styler, fit, safeWidth);
			else if (details.kind === "receipt") lines = receiptLines(details, styler, fit, safeWidth);
			// Final clamp at the component boundary (U3): no line may exceed
			// the render width, whatever the per-cell budget math produced.
			if (lines !== undefined) return lines.map((line) => fit(line, safeWidth));
		}
		return [naiveFit("[iroh-room] card", safeWidth)];
	} catch {
		// Deliberately plain (no injected styler/fit — they may be the throwers).
		return [naiveFit("[iroh-room] card (render failed)", Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80)];
	}
}
