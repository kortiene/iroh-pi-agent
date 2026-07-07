/**
 * Pure styling primitives for the iroh-room TUI surfaces (M0).
 *
 * STYLE-LAST INVARIANT (load-bearing, not a testing convenience): every cell
 * is measured and truncated as a PLAIN string first; color is applied per
 * finished cell. ANSI must never enter width math — pi-tui's truncateToWidth
 * injects a reset (\x1b[0m) when truncating styled text, which kills
 * continuation styling and renders the ellipsis unstyled.
 *
 * This module is pure: no pi / pi-tui imports. The styler and fit function
 * are injected structurally (wire.ts adapts the real theme + truncateToWidth;
 * tests inject identityStyler + naiveFit).
 */

/** Structural stand-in for theme.fg(color, text) — two arguments, not curried. */
export type Styler = (color: string, text: string) => string;

/** Structural stand-in for pi-tui's truncateToWidth(text, maxWidth). */
export type FitFn = (text: string, maxCols: number) => string;

/** Identity styler: returns the text unchanged (tests, unstyled surfaces). */
export const identityStyler: Styler = (_color, text) => text;

/**
 * Naive code-unit fit: measures by code units, truncates with a single-char
 * ellipsis. Used by tests and as the fail-safe fallback; runtime surfaces
 * inject pi-tui's ANSI/wide-char-aware truncateToWidth instead (accepted,
 * documented gap: emoji/CJK column math delegates to pi-tui at runtime).
 */
export const naiveFit: FitFn = (text, maxCols) => {
	if (maxCols <= 0) return "";
	return text.length <= maxCols ? text : `${text.slice(0, Math.max(0, maxCols - 1))}…`;
};

/** Glyph vocabulary shared by cards/toolviews (and the M1 pulse later). */
export const GLYPHS = {
	ok: "●",
	stale: "◌",
	fail: "✗",
	gear: "⚙",
	task: "○",
	pipe: "⇄",
	refresh: "↻",
	heuristic: "~",
} as const;

/** Structural truncation budgets (proposal §6 U3): content can't push chrome off the line. */
export const AUTHOR_COLS = 16;
export const STATUS_LABEL_COLS = 12;
export const FILE_NAME_COLS = 32;
export const TASK_TITLE_COLS = 40;
export const ID_PREFIX_COLS = 8;

/** Style-last step 1: truncate a plain cell. */
export function cell(text: string, maxCols: number, fit: FitFn): string {
	return fit(text, maxCols);
}

/** Style-last steps 1+2: truncate the plain cell, then color the finished cell. */
export function styledCell(
	color: string,
	text: string,
	maxCols: number,
	styler: Styler,
	fit: FitFn,
): string {
	return styler(color, fit(text, maxCols));
}

/** First 8 chars of a protocol id ("?" when absent) — display shortening, not masking. */
export function idPrefix(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? value.slice(0, ID_PREFIX_COLS) : "?";
}

/**
 * Short display form of an event/blob id: keeps the `blake3:` scheme plus the
 * first 8 hex chars. Protocol currency stays visible — this is layout, not
 * redaction (full ids always travel in details/envelopes).
 */
export function shortEventId(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return "?";
	if (value.startsWith("blake3:")) {
		return value.length > 15 ? `${value.slice(0, 15)}…` : value;
	}
	return value.length > ID_PREFIX_COLS ? `${value.slice(0, ID_PREFIX_COLS)}…` : value;
}
