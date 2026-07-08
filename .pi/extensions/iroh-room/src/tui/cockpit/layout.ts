/** Pure layout helpers for the Room Cockpit. */

import { roomText } from "../sanitize.js";
import { GLYPHS, idPrefix, shortEventId, type FitFn, type Styler } from "../style.js";

export interface RenderKit {
	styler: Styler;
	fit: FitFn;
	width: number;
	now: number;
}

/** Theme roles for the cockpit frame — a single subtle chrome color + accented title. */
export const CHROME_COLOR = "border";
export const SECTION_BAR = "▌";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Apply a styler when present; identity (raw) otherwise. Keeps plain-mode output byte-identical. */
function paint(styler: Styler | undefined, color: string, text: string): string {
	return styler === undefined ? text : styler(color, text);
}

/** Approximate visible width for already-fitted cells that may now carry ANSI from the theme. */
function visibleCells(text: string): number {
	return [...text.replace(ANSI_RE, "")].length;
}

function padStyledCell(text: string, width: number): string {
	const w = Math.max(0, width);
	const visible = visibleCells(text);
	return visible >= w ? text : `${text}${" ".repeat(w - visible)}`;
}

export function safeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
}

export function fitLine(text: string, width: number, fit: FitFn): string {
	return fit(text, safeWidth(width));
}

export function padCell(text: string, width: number, fit: FitFn): string {
	const w = Math.max(0, width);
	const fitted = fit(text, w);
	return fitted.length >= w ? fitted : `${fitted}${" ".repeat(w - fitted.length)}`;
}

export function borderTop(
	title: string,
	right: string,
	width: number,
	fit: FitFn,
	styler?: Styler,
): string {
	const w = safeWidth(width);
	if (w === 1) return paint(styler, CHROME_COLOR, "╭");
	const left = `╭─ ${title} `;
	const r = right === "" ? "" : ` ${right} ─╮`;
	const available = Math.max(0, w - left.length - r.length);
	if (available === 0) return paint(styler, CHROME_COLOR, fit(`${left}${r}`, w));
	// Style-last: plain composition sets the width; color is applied per segment
	// so the accented title + muted room label read against the subtle frame.
	const run = "─".repeat(available);
	const colored =
		paint(styler, CHROME_COLOR, "╭─ ") +
		paint(styler, "accent", title) +
		paint(styler, CHROME_COLOR, ` ${run}`) +
		(right === ""
			? ""
			: paint(styler, CHROME_COLOR, " ") +
				paint(styler, "muted", right) +
				paint(styler, CHROME_COLOR, " ─╮"));
	return colored;
}

export function borderMid(width: number, _fit: FitFn, styler?: Styler): string {
	const w = safeWidth(width);
	if (w === 1) return paint(styler, CHROME_COLOR, "├");
	return paint(styler, CHROME_COLOR, `├${"─".repeat(Math.max(0, w - 2))}┤`);
}

export function borderBottom(width: number, _fit: FitFn, styler?: Styler): string {
	const w = safeWidth(width);
	if (w === 1) return paint(styler, CHROME_COLOR, "╰");
	return paint(styler, CHROME_COLOR, `╰${"─".repeat(Math.max(0, w - 2))}╯`);
}

export function boxLine(content: string, width: number, fit: FitFn, styler?: Styler): string {
	const w = safeWidth(width);
	if (w === 1) return paint(styler, CHROME_COLOR, "│");
	const bar = paint(styler, CHROME_COLOR, "│");
	const inner = Math.max(0, w - 2);
	const fitted = visibleCells(content) > inner ? fit(content, inner) : content;
	return `${bar}${padStyledCell(fitted, inner)}${bar}`;
}

export function sectionTitle(title: string, kit: RenderKit): string {
	const text = roomText(title, Math.max(0, kit.width - 2), kit.fit);
	return kit.styler("accent", kit.fit(`${SECTION_BAR} ${text}`, kit.width));
}

/** A dim, upper-cased subsection label — groups related kv() rows under a tab. */
export function groupLabel(label: string, kit: RenderKit): string {
	return kit.styler("dim", kit.fit(` ${label.toUpperCase()}`, kit.width));
}

export function kv(label: string, value: unknown, kit: RenderKit, valueCols?: number): string {
	const labelCell = padCell(label, 16, kit.fit);
	const valueCell = roomText(value, valueCols ?? Math.max(0, kit.width - 19), kit.fit);
	const v = valueCell === "" ? kit.styler("dim", "—") : valueCell;
	return `  ${kit.styler("muted", labelCell)} ${v}`;
}

export function bullet(glyph: string, text: unknown, kit: RenderKit, color = "text"): string {
	const g = kit.styler(color, glyph);
	const body = roomText(text, Math.max(0, kit.width - 3), kit.fit);
	return fitLine(`${g} ${body}`, kit.width, kit.fit);
}

export function shortRoom(roomId: unknown): string {
	if (typeof roomId !== "string" || roomId === "") return "room ?";
	return `room ${idPrefix(roomId.replace(/^blake3:/, ""))}`;
}

export function shortId(value: unknown): string {
	return shortEventId(value);
}

export function formatAge(now: number, then: number | undefined): string {
	if (then === undefined) return "never";
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.round(minutes / 60)}h ago`;
}

export function feedGlyph(state: string): string {
	switch (state) {
		case "ok":
			return GLYPHS.ok;
		case "stale":
			return GLYPHS.stale;
		case "failing":
			return GLYPHS.fail;
		case "broken_config":
			return GLYPHS.gear;
		default:
			return GLYPHS.stale;
	}
}

export function feedColor(state: string): string {
	switch (state) {
		case "ok":
			return "success";
		case "stale":
			return "warning";
		case "failing":
		case "broken_config":
			return "error";
		default:
			return "dim";
	}
}

export function timeCell(timestamp: unknown): string {
	if (typeof timestamp === "string") {
		const match = /T(\d{2}:\d{2})/.exec(timestamp);
		if (match?.[1] !== undefined) return match[1];
	}
	return "--:--";
}

export function clampLines(lines: string[], width: number, fit: FitFn): string[] {
	const w = safeWidth(width);
	return lines.map((line) => fit(line, w));
}
