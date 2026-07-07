/**
 * Impure TUI wiring — THE ONLY M0 module importing pi-tui values.
 *
 * Adapts pi-tui's truncateToWidth into the structural FitFn and the pi Theme
 * into the structural Styler consumed by the pure builders (style/sanitize/
 * cards/toolviews), builds Component adapters (plain object literals with
 * render + the MANDATORY invalidate — pi-tui calls invalidate() on theme
 * change), and registers the message renderer for the card/receipt custom
 * message types.
 *
 * The card renderer ALWAYS returns a Component — never undefined, never
 * throws. If the renderer falls through, the host renders the message
 * `content` through the Markdown component, which is a room-content
 * Markdown-injection path; bad/missing details therefore degrade to a
 * one-line fallback Component instead.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

import { CARD_TYPE, RECEIPT_TYPE } from "../constants.js";
import { buildCardLines } from "./cards.js";
import { buildToolCallLines, buildToolResultLines } from "./toolviews.js";
import { naiveFit, type FitFn, type Styler } from "./style.js";

/** pi-tui-backed width clamp (ANSI/wide-char aware; cells are plain when fit). */
export const fitWidth: FitFn = (text, maxCols) =>
	maxCols <= 0 ? "" : truncateToWidth(text, maxCols);

/** Adapt theme.fg(color, text) into the structural Styler; degrades to plain text. */
export function themeStyler(theme: Theme): Styler {
	return (color, text) => {
		try {
			return theme.fg(color as Parameters<Theme["fg"]>[0], text);
		} catch {
			return text;
		}
	};
}

interface ComponentLike {
	render(width: number): string[];
	invalidate(): void;
}

/** Wrap a line builder into a Component; render never throws, invalidate is mandatory. */
function linesComponent(build: (width: number) => string[]): ComponentLike {
	return {
		render(width: number): string[] {
			const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
			try {
				return build(w);
			} catch {
				return [naiveFit("[iroh-room] render failed", w)];
			}
		},
		// Mandatory per pi-tui Component; fires on theme change. Nothing is
		// cached here — every render() styles fresh from the current theme.
		invalidate(): void {},
	};
}

/**
 * Register the renderer for "iroh-room.card" and "iroh-room.receipt"
 * messages. Must run synchronously in the factory body (commands.ts calls it).
 */
export function registerCardRenderers(pi: ExtensionAPI): void {
	const renderer = (
		message: { details?: unknown },
		options: { expanded: boolean },
		theme: Theme,
	): ComponentLike =>
		linesComponent((width) =>
			buildCardLines(message.details, { expanded: options.expanded }, themeStyler(theme), fitWidth, width),
		);
	pi.registerMessageRenderer(CARD_TYPE, renderer);
	pi.registerMessageRenderer(RECEIPT_TYPE, renderer);
}

export interface ToolRenderers {
	renderCall: (args: unknown, theme: Theme) => ComponentLike;
	renderResult: (
		result: { content?: unknown; details?: unknown },
		options: { expanded: boolean },
		theme: Theme,
	) => ComponentLike;
}

/**
 * First text block of a tool result. When execute() throws (validation,
 * missing config, binary not found, timeout, host abort/block), the host
 * builds `{content: [{type: "text", text: <message>}], details: {}}` — the
 * thrown message lives ONLY here, so the result view must surface it.
 */
function resultText(result: { content?: unknown }): string | undefined {
	if (!Array.isArray(result.content)) return undefined;
	for (const block of result.content) {
		if (
			block !== null &&
			typeof block === "object" &&
			(block as Record<string, unknown>).type === "text" &&
			typeof (block as Record<string, unknown>).text === "string"
		) {
			return (block as Record<string, unknown>).text as string;
		}
	}
	return undefined;
}

/**
 * renderCall/renderResult adapters for one iroh_* tool. Error styling keys
 * off the {ok:false} envelope in result.details — never context.isError.
 */
export function toolRenderers(toolName: string): ToolRenderers {
	return {
		renderCall: (args, theme) =>
			linesComponent((width) =>
				buildToolCallLines(toolName, args, themeStyler(theme), fitWidth, width),
			),
		renderResult: (result, options, theme) =>
			linesComponent((width) =>
				buildToolResultLines(
					toolName,
					result.details,
					{ expanded: options.expanded },
					themeStyler(theme),
					fitWidth,
					width,
					resultText(result),
				),
			),
	};
}
