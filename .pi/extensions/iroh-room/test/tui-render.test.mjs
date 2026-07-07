import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension } from "./helpers.mjs";
import {
	ERROR_STDERR_ROOM,
	EVENT_STATUS,
	GOLDEN_EXPOSE_CALL,
	GOLDEN_RECEIPT,
	GOLDEN_RECEIPT_DETAILS,
	GOLDEN_ROOM_CARD,
	GOLDEN_ROOM_DETAILS,
	GOLDEN_SEND_RESULT_FAIL,
	GOLDEN_STATUS_RESULT_OK,
	GOLDEN_TAIL_COLLAPSED,
	GOLDEN_TAIL_EXPANDED_80,
	HOSTILE_TICKET,
	ROOM_ID,
	TAIL_ROWS,
} from "./fixtures.mjs";

const ext = await loadExtension();
const { identityStyler, naiveFit, styledCell, idPrefix, shortEventId } = await ext.importModule("tui/style");
const { roomText } = await ext.importModule("tui/sanitize");
const { buildCardLines } = await ext.importModule("tui/cards");
const { buildToolCallLines, buildToolResultLines, NEXT_HINT_RE } = await ext.importModule("tui/toolviews");
const { snapshotFromRows } = await ext.importModule("cli");

after(() => ext.cleanup());

const WIDTHS = [80, 60, 40];

/* --------------------------------- style ----------------------------------- */

test("naiveFit truncates by code units with a single-char ellipsis", () => {
	assert.equal(naiveFit("hello", 5), "hello");
	assert.equal(naiveFit("hello!", 5), "hell…");
	assert.equal(naiveFit("hello", 0), "");
	assert.equal(naiveFit("hello", -3), "");
});

test("styledCell is style-last: truncation happens on the plain cell, color wraps the finished cell", () => {
	const marker = (color, text) => `[${color}]${text}[/]`;
	assert.equal(styledCell("error", "abcdef", 4, marker, naiveFit), "[error]abc…[/]");
	// ANSI-style wrapping never enters the width math
	assert.equal(styledCell("dim", "ok", 10, marker, naiveFit), "[dim]ok[/]");
});

test("idPrefix / shortEventId shorten protocol ids without masking them", () => {
	assert.equal(idPrefix("a".repeat(64)), "aaaaaaaa");
	assert.equal(idPrefix(undefined), "?");
	assert.equal(shortEventId(EVENT_STATUS), `${EVENT_STATUS.slice(0, 15)}…`);
	assert.equal(shortEventId(undefined), "?");
});

/* -------------------------------- sanitize --------------------------------- */

test("roomText kills C0 controls including ESC (ANSI/CSI/OSC can never render)", () => {
	const esc = String.fromCharCode(0x1b);
	const out = roomText(`a${esc}[31mred${esc}]8;;http://evil${String.fromCharCode(7)}b`, 200, naiveFit);
	assert.ok(!out.includes(esc));
	assert.ok(!out.includes(String.fromCharCode(7)));
});

test("roomText kills C1 bytes (8-bit CSI/DCS/OSC) that CONTROL_CHARS_RE misses", () => {
	const c1 = String.fromCharCode(0x9b) + String.fromCharCode(0x90) + String.fromCharCode(0x9d);
	const out = roomText(`x${c1}y`, 200, naiveFit);
	for (let code = 0x80; code <= 0x9f; code++) {
		assert.ok(!out.includes(String.fromCharCode(code)), `C1 0x${code.toString(16)} survived`);
	}
	assert.equal(out, "x y");
});

test("roomText strips bidi overrides and isolates", () => {
	const rlo = String.fromCharCode(0x202e);
	const pdi = String.fromCharCode(0x2069);
	assert.equal(roomText(`a${rlo}b${pdi}c`, 200, naiveFit), "abc");
});

test("roomText strips zero-width/invisible chars (mention-evasion guard)", () => {
	// ZWSP, ZWNJ, ZWJ, word joiner, soft hyphen: render as nothing, so
	// "@al<char>ice" would LOOK like a mention while defeating the literal
	// matcher in notify.ts if any survived sanitization.
	for (const code of [0x200b, 0x200c, 0x200d, 0x2060, 0x00ad]) {
		const zw = String.fromCharCode(code);
		assert.equal(
			roomText(`hey @al${zw}ice ping`, 200, naiveFit),
			"hey @alice ping",
			`U+${code.toString(16)} survived roomText`,
		);
	}
	// BOM/ZWNBSP is \s in JS: stripping (not collapsing to a space) keeps
	// the handle contiguous for the matcher too.
	assert.equal(roomText(`@al${String.fromCharCode(0xfeff)}ice`, 200, naiveFit), "@alice");
});

test("roomText masks the ENTIRE invite ticket at the UI layer (bech32 data alphabet included)", () => {
	// exact-equality: a partial mask (e.g. one stopping at the first char
	// outside RFC4648 base32) would leave ticket material in the output
	const out = roomText(`join via ${HOSTILE_TICKET} now`, 200, naiveFit);
	assert.equal(out, "join via roomtkt1…[masked] now");
	// the worker's canonical bech32-shaped fixture ticket masks fully too
	const bechTicket = ["room", "tkt1", "q", "fake0".repeat(12)].join("");
	assert.equal(roomText(`t ${bechTicket} t`, 200, naiveFit), "t roomtkt1…[masked] t");
});

test("roomText masks tickets split by invisible chars (strip-before-mask ordering)", () => {
	// A zero-width/bidi char injected INSIDE the ticket renders as nothing,
	// so if masking ran before stripping, the mask would stop at the split
	// and the leaked tail would visually reassemble next to it on screen.
	// exact-equality proves zero ticket material survives.
	const splitCodes = [0x200b, 0x200c, 0x200d, 0x2060, 0x00ad, 0xfeff, 0x202e, 0x2066];
	for (const code of splitCodes) {
		const zw = String.fromCharCode(code);
		const split = `${HOSTILE_TICKET.slice(0, 12)}${zw}${HOSTILE_TICKET.slice(12)}`;
		assert.equal(
			roomText(`join ${split} now`, 200, naiveFit),
			"join roomtkt1…[masked] now",
			`ticket split by U+${code.toString(16)} leaked past the mask`,
		);
	}
	// many splits at once (one invisible char every 8 chars) still mask fully
	const shredded = HOSTILE_TICKET.replace(/(.{8})/g, `$1${String.fromCharCode(0x200b)}`);
	assert.equal(roomText(shredded, 200, naiveFit), "roomtkt1…[masked]");
});

test("roomText redacts secret-shaped values (redact() runs first)", () => {
	const key = ["sk-", "a".repeat(24)].join("");
	const out = roomText(`token here ${key} end`, 200, naiveFit);
	assert.ok(!out.includes(key));
	assert.ok(out.includes("[REDACTED]"));
});

test("roomText pre-caps hostile bodies at 4096 code units before regex work", () => {
	const body = `${"B".repeat(12 * 1024)} TAIL-MARKER`;
	const out = roomText(body, 10_000, naiveFit);
	assert.ok(out.length <= 4096);
	assert.ok(!out.includes("TAIL-MARKER"));
});

test("roomText collapses whitespace, trims, applies the injected fit, and never throws on non-strings", () => {
	assert.equal(roomText("  a \n\t b  ", 200, naiveFit), "a b");
	assert.equal(roomText("abcdef", 4, naiveFit), "abc…");
	assert.equal(roomText(undefined, 10, naiveFit), "");
	assert.equal(roomText(null, 10, naiveFit), "");
	assert.equal(roomText(42, 10, naiveFit), "42");
});

/* ----------------------------- golden renders ------------------------------ */

function tailDetails() {
	const snapshot = snapshotFromRows(TAIL_ROWS, {});
	return { kind: "tail", room_id: ROOM_ID, count: snapshot.events.length, events: snapshot.events };
}

test("golden: /room-tail card collapsed at 80/60/40 (identity styler + naive fit)", () => {
	for (const width of WIDTHS) {
		assert.deepEqual(
			buildCardLines(tailDetails(), { expanded: false }, identityStyler, naiveFit, width),
			GOLDEN_TAIL_COLLAPSED[width],
			`width ${width}`,
		);
	}
});

test("golden: /room-tail card expanded at 80 shows all rows + untrusted tag", () => {
	assert.deepEqual(
		buildCardLines(tailDetails(), { expanded: true }, identityStyler, naiveFit, 80),
		GOLDEN_TAIL_EXPANDED_80,
	);
});

test("golden: /room health card at 80/60/40", () => {
	for (const width of WIDTHS) {
		assert.deepEqual(
			buildCardLines(GOLDEN_ROOM_DETAILS, { expanded: false }, identityStyler, naiveFit, width),
			GOLDEN_ROOM_CARD[width],
			`width ${width}`,
		);
	}
});

test("golden: receipt line at 80/60/40", () => {
	for (const width of WIDTHS) {
		assert.deepEqual(
			buildCardLines(GOLDEN_RECEIPT_DETAILS, { expanded: false }, identityStyler, naiveFit, width),
			GOLDEN_RECEIPT[width],
			`width ${width}`,
		);
	}
});

test("golden: iroh_agent_status success result at 80/60/40", () => {
	for (const width of WIDTHS) {
		assert.deepEqual(
			buildToolResultLines(
				"iroh_agent_status",
				{ ok: true, event_id: EVENT_STATUS },
				{ expanded: false },
				identityStyler,
				naiveFit,
				width,
			),
			GOLDEN_STATUS_RESULT_OK[width],
			`width ${width}`,
		);
	}
});

test("golden: iroh_room_send failure result at 80/60/40 (envelope-keyed, next: hint shown)", () => {
	for (const width of WIDTHS) {
		assert.deepEqual(
			buildToolResultLines(
				"iroh_room_send",
				{
					ok: false,
					exit_code: 2,
					error_code: "invalid_room_id",
					error_detail: "room id must look like blake3:<64 hex chars>",
					stderr: ERROR_STDERR_ROOM,
				},
				{ expanded: false },
				identityStyler,
				naiveFit,
				width,
			),
			GOLDEN_SEND_RESULT_FAIL[width],
			`width ${width}`,
		);
	}
});

test("golden: iroh_pipe_expose call view at 80/60/40", () => {
	for (const width of WIDTHS) {
		assert.deepEqual(
			buildToolCallLines(
				"iroh_pipe_expose",
				{ tcp: "127.0.0.1:3000", allow: ["a".repeat(64)] },
				identityStyler,
				naiveFit,
				width,
			),
			GOLDEN_EXPOSE_CALL[width],
			`width ${width}`,
		);
	}
});

test("NEXT_HINT_RE extracts the CLI remediation hint from redacted stderr", () => {
	assert.equal(NEXT_HINT_RE.exec(ERROR_STDERR_ROOM)?.[1], "run `iroh-rooms room members --help`");
	assert.equal(NEXT_HINT_RE.exec("error[x]: nope\n"), null);
});
