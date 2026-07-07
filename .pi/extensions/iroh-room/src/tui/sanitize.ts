/**
 * roomText(): the single chokepoint EVERY room-authored string passes through
 * before reaching ANY UI surface (proposal §6 U1/U4; brief §4 M0). Room
 * content is attacker-controlled — signed does not mean safe.
 *
 * Pipeline order (load-bearing):
 *   pre-cap 4096 code units (hostile 10kB+ bodies must not cost regex time)
 *   → C0 + DEL + C1 kill (includes ESC and 8-bit CSI — no ANSI, no OSC
 *     titles/hyperlinks, no cursor movement can survive)
 *   → bidi override/isolate strip (no visually reversed lines)
 *   → zero-width/invisible strip (ZWSP ZWNJ ZWJ, word joiner, soft hyphen,
 *     BOM/ZWNBSP — an invisible char inside "@name" must not defeat the
 *     mention matcher while still rendering as a mention on screen)
 *   → redact() (secret patterns)
 *   → invite-ticket mask (a roomtkt1… in a message must not sit on screen
 *     during a screen share, even though tool envelopes deliberately pass it)
 *   → whitespace collapse + trim
 *   → fit(flat, maxCols) (injected width clamp).
 *
 * Stripping MUST precede masking: a zero-width char injected inside a ticket
 * renders as nothing, so masking first splits the match and the leaked tail
 * visually reassembles next to the mask. Stripping first rejoins the ticket
 * (and any zero-width-split secret, helping redact too) before the mask runs.
 *
 * Deliberately does NOT reuse constants.CONTROL_CHARS_RE: that one is
 * narrower (C0+DEL only), non-global, and misses C1.
 *
 * Pure module: imports only ../redact.js; the fit function is injected.
 */

import { redact } from "../redact.js";
import type { FitFn } from "./style.js";

const PRE_CAP_CODE_UNITS = 4096;
// Tickets are bech32-shaped: "roomtkt1" + data whose alphabet includes 0/8/9
// and more — an RFC4648-base32 class ([a-z2-7]) stops at the first such char
// and leaks the bulk of the ticket. Mask the whole alphanumeric tail (U4).
const TICKET_RE = /\broomtkt1[0-9a-z]+/gi;
const CTRL_RE = /[\x00-\x1f\x7f-\x9f]/gu;
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/gu;
// Zero-width + invisible-format chars (soft hyphen, ZWSP/ZWNJ/ZWJ, word
// joiner, BOM/ZWNBSP): they render as nothing in typical terminals, so
// "@al<ZWJ>ice" LOOKS exactly like a mention while defeating notify.ts's
// literal matcher — strip them BEFORE the whitespace collapse and any
// downstream matching (mirrors the bidi strip-before-match pattern).
const ZERO_WIDTH_RE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/gu;

/**
 * Sanitize one room-authored string for display. Accepts unknown input
 * (hostile rows may carry non-string values in string-shaped fields) and
 * never throws.
 */
export function roomText(raw: unknown, maxCols: number, fit: FitFn): string {
	const text =
		typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : String(raw);
	const capped = text.slice(0, PRE_CAP_CODE_UNITS);
	const stripped = capped
		.replace(CTRL_RE, " ")
		.replace(BIDI_RE, "")
		.replace(ZERO_WIDTH_RE, "");
	const flat = redact(stripped)
		.replace(TICKET_RE, "roomtkt1…[masked]")
		.replace(/\s+/g, " ")
		.trim();
	return fit(flat, maxCols);
}
