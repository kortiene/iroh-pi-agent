import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension, stubExec, stubPi, stubCtx } from "./helpers.mjs";
import {
	HOSTILE_FRAGMENTS,
	HOSTILE_TAIL_JSON,
	HOSTILE_TICKET,
	ROOM_ID,
	hostileTailRows,
	ok,
} from "./fixtures.mjs";

const ext = await loadExtension();
const { identityStyler, naiveFit } = await ext.importModule("tui/style");
const { buildCardLines, tailEventRow } = await ext.importModule("tui/cards");
const { buildToolResultLines } = await ext.importModule("tui/toolviews");
const { snapshotFromRows } = await ext.importModule("cli");
const { registerIrohCommands } = await ext.importModule("commands");
const { CARD_TYPE, RECEIPT_TYPE, COMMAND_NAMES } = await ext.importModule("constants");

after(() => ext.cleanup());

// 30/24/20 sit below the tail row's fixed chrome budget (~36 cols) \u2014 the
// final component-boundary clamp (U3) must keep every line within width.
const WIDTHS = [80, 60, 40, 30, 24, 20];
const ESC = String.fromCharCode(0x1b);
const C1_RE = /[\u0080-\u009f]/;
// The ticket's bech32 data tail: a partial mask (stopping at the first char
// outside RFC4648 base32) leaks this even when the full ticket is absent.
const TICKET_TAIL = HOSTILE_TICKET.slice(-16);

const baseEnv = {
	IROH_ROOM_ID: ROOM_ID,
	IROH_ROOMS_BIN: process.execPath, // any executable path; exec is stubbed
};

/** Every hostile surface render must satisfy the display invariants. */
function assertLineInvariants(lines, width, label) {
	assert.ok(Array.isArray(lines) && lines.length > 0, `${label}: no lines`);
	for (const line of lines) {
		assert.equal(typeof line, "string", `${label}: non-string line`);
		assert.ok(!line.includes(ESC), `${label}: ESC leaked: ${JSON.stringify(line)}`);
		assert.ok(!C1_RE.test(line), `${label}: C1 byte leaked: ${JSON.stringify(line)}`);
		assert.ok(!line.includes(HOSTILE_TICKET), `${label}: full invite ticket leaked`);
		assert.ok(!line.includes(TICKET_TAIL), `${label}: invite ticket tail leaked: ${JSON.stringify(line)}`);
		assert.ok(line.length <= width, `${label}: line ${line.length} > width ${width}`);
	}
}

function hostileTailDetails() {
	const snapshot = snapshotFromRows(hostileTailRows, {});
	return { kind: "tail", room_id: ROOM_ID, count: snapshot.events.length, events: snapshot.events };
}

/* ------------------------- pure builder invariants -------------------------- */

test("tail card over the hostile corpus: no ESC/C1/ticket, every line fits, collapsed and expanded", () => {
	for (const width of WIDTHS) {
		for (const expanded of [false, true]) {
			const lines = buildCardLines(
				hostileTailDetails(),
				{ expanded },
				identityStyler,
				naiveFit,
				width,
			);
			assertLineInvariants(lines, width, `tail(expanded=${expanded}, width=${width})`);
		}
	}
});

test("tail card fed RAW hostile rows (wrong shape: event_type/body instead of type/summary) never throws", () => {
	for (const width of WIDTHS) {
		const lines = buildCardLines(
			{ kind: "tail", count: hostileTailRows.length, events: hostileTailRows },
			{ expanded: true },
			identityStyler,
			naiveFit,
			width,
		);
		assertLineInvariants(lines, width, `raw rows width=${width}`);
	}
});

test("unknown event types render as a generic row, missing event_id/lamport/at tolerated", () => {
	const snapshot = snapshotFromRows(hostileTailRows, {});
	const unknown = snapshot.events.find((event) => event.type === "totally.unknown.event");
	assert.ok(unknown !== undefined);
	const line = tailEventRow(unknown, identityStyler, naiveFit, 80);
	assert.ok(line.startsWith("--:-- ") === false); // this row has a timestamp
	assert.ok(line.includes("totally.unk…"));
	const orphan = snapshot.events.find((event) => event.summary.includes("orphan-body"));
	assert.ok(orphan !== undefined);
	assert.ok(tailEventRow(orphan, identityStyler, naiveFit, 80).startsWith("--:-- "));
});

test("tail rows are clamped to the render width even below the fixed chrome budget (~36 cols)", () => {
	// time(5) + author(16) + unknown-type(12) + separators = 35 cols of chrome:
	// without the final clamp this row overflows any width < 36 and pi-tui
	// throws "Rendered line exceeds terminal width" at runtime.
	const details = {
		kind: "tail",
		count: 1,
		events: [
			{
				type: "totally.unknown.event",
				author: "sixteencharsname",
				timestamp: "2026-07-05T09:00:08Z",
				summary: "hello",
			},
		],
	};
	for (const width of [35, 30, 24, 20, 10, 5, 1]) {
		const lines = buildCardLines(details, { expanded: true }, identityStyler, naiveFit, width);
		for (const line of lines) {
			assert.ok(line.length <= width, `width ${width}: line ${line.length} cols: ${JSON.stringify(line)}`);
		}
	}
});

test("hostile room-card details (spoofed issues, junk pipes) keep the invariants", () => {
	const details = {
		kind: "room",
		room_id: ROOM_ID,
		issues: [
			`${ESC}[31mspoofed issue`,
			["ticket ", HOSTILE_TICKET].join(""),
			String.fromCharCode(0x9b) + "c1 issue",
		],
		pipes: [null, 42, { pipe_id: 7, target: { evil: true }, label: `${ESC}]0;title` }],
	};
	for (const width of WIDTHS) {
		assertLineInvariants(
			buildCardLines(details, { expanded: false }, identityStyler, naiveFit, width),
			width,
			`room width=${width}`,
		);
	}
});

test("tail-snapshot tool result over the hostile corpus keeps invariants and the untrusted framing", () => {
	const snapshot = snapshotFromRows(hostileTailRows, {});
	const envelope = { ok: true, untrusted_note: "untrusted", events: snapshot.events };
	for (const width of WIDTHS) {
		for (const expanded of [false, true]) {
			const lines = buildToolResultLines(
				"iroh_room_tail_snapshot",
				envelope,
				{ expanded },
				identityStyler,
				naiveFit,
				width,
			);
			assertLineInvariants(lines, width, `tool tail(expanded=${expanded}, width=${width})`);
			// U7 framing survives; at widths narrower than the tag itself the
			// final clamp may truncate it, but its head must still be there.
			assert.ok(
				lines.some((line) => line.includes(naiveFit("untrusted room content", width))),
				`untrusted framing missing at width ${width}`,
			);
		}
	}
});

/* -------------------- renderer always returns a Component ------------------- */

test("the card renderer returns a render/invalidate Component for EVERY hostile input (fallthrough = Markdown injection)", () => {
	const pi = stubPi();
	registerIrohCommands(pi, { env: baseEnv, exec: stubExec([]).exec });
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const hostileDetails = [
		undefined,
		null,
		42,
		"a string",
		[],
		{ kind: "tail" },
		{ kind: "tail", count: "x", events: "not-an-array" },
		{ kind: "tail", count: 9, events: hostileTailRows },
		{ kind: "room" },
		{ kind: "room", issues: null, pipes: "junk" },
		{ kind: "receipt" },
		{ kind: "receipt", action: { evil: 1 }, event_id: 42 },
		{ kind: "something.else" },
		{ kind: "tail", events: [{ get summary() { throw new Error("boom"); } }] },
	];
	for (const customType of [CARD_TYPE, RECEIPT_TYPE]) {
		const renderer = pi.messageRenderers.get(customType);
		assert.equal(typeof renderer, "function", `${customType} renderer registered`);
		for (const details of hostileDetails) {
			for (const expanded of [false, true]) {
				const component = renderer(
					{ role: "custom", customType, content: "x", display: true, details, timestamp: 0 },
					{ expanded },
					theme,
				);
				assert.ok(component !== undefined && component !== null, "renderer returned undefined");
				assert.equal(typeof component.render, "function");
				assert.equal(typeof component.invalidate, "function");
				assert.doesNotThrow(() => component.invalidate());
				for (const width of WIDTHS) {
					const lines = component.render(width);
					assertLineInvariants(lines, width, `renderer(${customType})`);
				}
				// degenerate widths must not throw either
				assert.doesNotThrow(() => component.render(0));
				assert.doesNotThrow(() => component.render(Number.NaN));
			}
		}
	}
});

/* ------------------------- model-visibility invariant ----------------------- */

test("card content (LLM-visible) contains ZERO room-authored text over the hostile corpus; details carry it; triggerTurn never set", async () => {
	const pi = stubPi();
	const { exec } = stubExec([ok(HOSTILE_TAIL_JSON)]);
	registerIrohCommands(pi, { env: baseEnv, exec });
	const ctx = stubCtx({ mode: "tui", hasUI: true });
	const tail = pi.commands.find((command) => command.name === COMMAND_NAMES.roomTail);
	await tail.handler("", ctx);

	assert.equal(pi.sentMessages.length, 1);
	const { message, options } = pi.sentMessages[0];
	assert.equal(message.customType, CARD_TYPE);
	assert.equal(message.display, true);
	// triggerTurn is NEVER set from room-derived content (U6)
	assert.equal(options, undefined);
	// the model sees a count, nothing room-authored
	assert.equal(message.content, `[iroh-room] tail snapshot: ${hostileTailRows.length} events`);
	for (const row of hostileTailRows) {
		for (const field of ["body", "display_name"]) {
			const value = row[field];
			if (typeof value === "string" && value.length > 0) {
				assert.ok(
					!message.content.includes(value),
					`content leaked row ${field}: ${JSON.stringify(value.slice(0, 40))}`,
				);
			}
		}
	}
	for (const fragment of HOSTILE_FRAGMENTS) {
		assert.ok(!message.content.includes(fragment), `content leaked fragment ${fragment}`);
	}
	// the renderer-only details DO carry the (sanitizable) room content
	assert.equal(message.details.kind, "tail");
	assert.equal(message.details.events.length, hostileTailRows.length);
});
