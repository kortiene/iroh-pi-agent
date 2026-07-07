/**
 * Completion-value filters (brief §4 M2, invariant U5): every completion
 * VALUE must pass its shape validator or be dropped —
 * - `--allow=` → 64-hex member identity ids (members poll data),
 * - `--close=` → 32-hex pipe ids (PipeManager.list(), trusted local),
 * - `#<task-id>` → tracked task ids passing TASK_ID_COMPLETION_RE (a
 *   completions-only tightening: non-conforming ids are dropped from
 *   completions, never from tracking),
 * - `@<mention>` (editor autocomplete provider) → `@` + first-8-hex of
 *   member identity ids — the only universally resolvable member handle
 *   (`room members --json` carries no display names).
 *
 * Labels/descriptions never carry raw room strings: values are the validated
 * ids themselves; the only room-authored display text (member role) passes
 * roomText.
 *
 * Completion values preserve the already-typed argument head: the host
 * replaces the whole argument string with `value`, so each item's value is
 * `head + completed-last-token`.
 *
 * PURE module: no pi/pi-tui imports.
 */

import { IDENTITY_ID_RE, PIPE_ID_RE, TASK_ID_COMPLETION_RE } from "../constants.js";
import { roomText } from "./sanitize.js";
import { naiveFit } from "./style.js";

/** Structural AutocompleteItem (pi's shape). */
export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

export interface MemberLike {
	id?: unknown;
	role?: unknown;
}

/** Split an args prefix into everything-before + the token being completed. */
function splitLastToken(prefix: string): { head: string; token: string } {
	const match = /^([\s\S]*\s)?(\S*)$/.exec(prefix);
	return { head: match?.[1] ?? "", token: match?.[2] ?? "" };
}

/**
 * /room-preview argument completions: `--allow=<64-hex>` from the members
 * poll, `--close=<32-hex>` from pipes.list(). Returns null when nothing fits
 * (house convention for getArgumentCompletions).
 */
export function previewArgCompletions(
	prefix: string,
	members: readonly MemberLike[],
	pipeIds: readonly unknown[],
): CompletionItem[] | null {
	const { head, token } = splitLastToken(prefix);
	if (token.startsWith("--allow=")) {
		const typed = token.slice("--allow=".length);
		const items: CompletionItem[] = [];
		for (const member of members) {
			const id = typeof member?.id === "string" ? member.id : "";
			if (!IDENTITY_ID_RE.test(id) || !id.startsWith(typed)) {
				continue; // U5: invalid values are dropped, never offered
			}
			const role = roomText(member?.role, 12, naiveFit) || "member";
			items.push({
				value: `${head}--allow=${id}`,
				label: `${id.slice(0, 8)}… ${role}`,
				description: "member identity id",
			});
		}
		return items.length > 0 ? items : null;
	}
	if (token.startsWith("--close=")) {
		const typed = token.slice("--close=".length);
		const items: CompletionItem[] = [];
		for (const pipeId of pipeIds) {
			if (typeof pipeId !== "string" || !PIPE_ID_RE.test(pipeId) || !pipeId.startsWith(typed)) {
				continue;
			}
			items.push({
				value: `${head}--close=${pipeId}`,
				label: pipeId,
				description: "close this preview pipe",
			});
		}
		return items.length > 0 ? items : null;
	}
	return null;
}

/**
 * /room-send `#<task-id>` completions over the tracked task ids. Ids failing
 * TASK_ID_COMPLETION_RE are dropped from completions only (tracking keeps
 * them — the grammar accepts any non-empty scalar).
 */
export function sendArgCompletions(
	prefix: string,
	taskIds: readonly unknown[],
): CompletionItem[] | null {
	const { head, token } = splitLastToken(prefix);
	if (!token.startsWith("#")) {
		return null;
	}
	const typed = token.slice(1);
	const items: CompletionItem[] = [];
	for (const id of taskIds) {
		if (typeof id !== "string" || !TASK_ID_COMPLETION_RE.test(id) || !id.startsWith(typed)) {
			continue;
		}
		items.push({
			value: `${head}#${id}`,
			label: `#${id}`,
			description: "room task (heuristic~)",
		});
	}
	return items.length > 0 ? items : null;
}

/** Suggestions payload for the editor @mention provider (pi-tui's shape). */
export interface MentionSuggestions {
	items: CompletionItem[];
	prefix: string;
}

/**
 * Editor `@mention` completions (brief §4 M2, optional provider). Scans the
 * text before the cursor for an `@`-token at a word boundary and offers
 * `@<from8>` for every roster member whose 64-hex identity id validates
 * (U5: invalid ids are dropped, never offered). Returns null when there is
 * no @-token or no roster — the caller must then delegate to the wrapped
 * provider unchanged.
 */
export function mentionCompletions(
	line: string,
	col: number,
	members: ReadonlyMap<string, string> | undefined,
): MentionSuggestions | null {
	if (members === undefined || members.size === 0) {
		return null;
	}
	const before = line.slice(0, Math.max(0, col));
	const match = /(?:^|\s)(@[0-9a-zA-Z]*)$/.exec(before);
	const prefix = match?.[1];
	if (prefix === undefined) {
		return null;
	}
	const typed = prefix.slice(1).toLowerCase();
	const items: CompletionItem[] = [];
	for (const [id, role] of members) {
		if (!IDENTITY_ID_RE.test(id)) {
			continue; // U5: invalid values are dropped, never offered
		}
		const from8 = id.slice(0, 8);
		if (!from8.startsWith(typed)) {
			continue;
		}
		const roleText = roomText(role, 12, naiveFit) || "member";
		items.push({
			value: `@${from8}`,
			label: `@${from8} ${roleText}`,
			description: "room member (mention)",
		});
	}
	return items.length > 0 ? { items, prefix } : null;
}
