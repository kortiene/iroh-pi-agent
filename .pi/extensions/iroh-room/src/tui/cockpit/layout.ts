/** Pure layout helpers for the Room Cockpit. */

import { roomText } from "../sanitize.js";
import { GLYPHS, idPrefix, shortEventId, type FitFn, type Styler } from "../style.js";

export interface RenderKit {
	styler: Styler;
	fit: FitFn;
	width: number;
	now: number;
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

export function borderTop(title: string, right: string, width: number, fit: FitFn): string {
	const w = safeWidth(width);
	if (w === 1) return fit("╭", w);
	const left = `╭─ ${title} `;
	const r = right === "" ? "" : ` ${right} ─╮`;
	const available = Math.max(0, w - left.length - r.length);
	if (available === 0) return fit(`${left}${r}`, w);
	return fit(`${left}${"─".repeat(available)}${r}`, w);
}

export function borderMid(width: number, fit: FitFn): string {
	const w = safeWidth(width);
	if (w === 1) return fit("├", w);
	return fit(`├${"─".repeat(Math.max(0, w - 2))}┤`, w);
}

export function borderBottom(width: number, fit: FitFn): string {
	const w = safeWidth(width);
	if (w === 1) return fit("╰", w);
	return fit(`╰${"─".repeat(Math.max(0, w - 2))}╯`, w);
}

export function boxLine(content: string, width: number, fit: FitFn): string {
	const w = safeWidth(width);
	if (w === 1) return fit("│", w);
	return `│${padCell(content, Math.max(0, w - 2), fit)}│`;
}

export function sectionTitle(title: string, kit: RenderKit): string {
	return kit.styler("accent", roomText(title, Math.max(0, kit.width), kit.fit));
}

export function kv(label: string, value: unknown, kit: RenderKit, valueCols?: number): string {
	const l = kit.styler("muted", padCell(label, 16, kit.fit));
	const v = roomText(value, valueCols ?? Math.max(0, kit.width - 18), kit.fit) || "—";
	return fitLine(`  ${l} ${v}`, kit.width, kit.fit);
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
