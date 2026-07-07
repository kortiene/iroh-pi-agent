import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadExtension, stubExec, stubPi, stubCtx } from "./helpers.mjs";
import {
	ERROR_STDERR_ROOM,
	EVENT_SEND,
	EVENT_STATUS,
	IDENTITY_JSON,
	ROOM_ID,
	SEND_STDOUT,
	STATUS_STDOUT,
	TAIL_JSON,
	TAIL_ROWS,
	fail,
	ok,
} from "./fixtures.mjs";

const ext = await loadExtension();
const { registerIrohTools } = await ext.importModule("tools");
const { registerIrohCommands } = await ext.importModule("commands");
const { toolRenderers, registerCardRenderers, fitWidth, themeStyler } = await ext.importModule("tui/wire");
const { CARD_TYPE, RECEIPT_TYPE, COMMAND_NAMES, TOOL_NAMES } = await ext.importModule("constants");

const cwd = await mkdtemp(join(tmpdir(), "iroh-room-tui-wire-"));
const binPath = join(cwd, "fake-iroh-rooms");
await writeFile(binPath, "#!/bin/sh\nexit 0\n");
await chmod(binPath, 0o755);

const baseEnv = { IROH_ROOM_ID: ROOM_ID, IROH_ROOMS_BIN: binPath };
const identityTheme = { fg: (_color, text) => text, bold: (text) => text };

after(async () => {
	await rm(cwd, { recursive: true, force: true });
	await ext.cleanup();
});

function makeCommands(queue, { mode = "tui" } = {}) {
	const pi = stubPi();
	const { calls, exec } = stubExec(queue);
	registerIrohCommands(pi, { env: baseEnv, exec });
	const ctx = stubCtx({ cwd, mode, hasUI: true });
	const run = (name, args) =>
		pi.commands.find((command) => command.name === name).handler(args, ctx);
	return { pi, calls, ctx, notes: ctx.ui.notifications, run };
}

/* ------------------------------ wire adapters ------------------------------- */

test("fitWidth adapts pi-tui truncateToWidth and tolerates non-positive widths", () => {
	assert.equal(fitWidth("hello", 10), "hello");
	assert.equal(fitWidth("hello world", 8), "hello...");
	assert.equal(fitWidth("hello", 0), "");
	assert.equal(fitWidth("hello", -5), "");
});

test("themeStyler adapts theme.fg and degrades to plain text if the theme throws", () => {
	const marker = themeStyler({ fg: (color, text) => `<${color}>${text}</>` });
	assert.equal(marker("error", "boom"), "<error>boom</>");
	const broken = themeStyler({ fg: () => { throw new Error("no such color"); } });
	assert.equal(broken("nope", "safe"), "safe");
});

/* ----------------------------- tool render slots ---------------------------- */

test("all 10 tools carry renderCall and renderResult", () => {
	const pi = stubPi();
	registerIrohTools(pi, { env: baseEnv, exec: stubExec([]).exec });
	assert.equal(pi.tools.length, 10);
	for (const tool of pi.tools) {
		assert.equal(typeof tool.renderCall, "function", `${tool.name} renderCall`);
		assert.equal(typeof tool.renderResult, "function", `${tool.name} renderResult`);
	}
});

test("renderResult keys error styling off the {ok:false} envelope, never context.isError", () => {
	const { renderResult } = toolRenderers(TOOL_NAMES.roomSend);
	const failure = {
		details: {
			ok: false,
			exit_code: 2,
			error_code: "invalid_room_id",
			error_detail: "room id must look like blake3:<64 hex chars>",
			stderr: ERROR_STDERR_ROOM,
		},
	};
	// even with a lying context claiming isError:false, the envelope decides
	const lines = renderResult(failure, { expanded: false, isPartial: false }, identityTheme, { isError: false }).render(80);
	assert.ok(lines[0].includes("failed (exit 2, invalid_room_id)"));
	assert.ok(lines.some((line) => line.startsWith("next:")));

	const success = { details: { ok: true, event_id: EVENT_SEND } };
	const okLines = renderResult(success, { expanded: false, isPartial: false }, identityTheme, { isError: true }).render(80);
	assert.ok(okLines[0].includes("sent · event"));
	assert.ok(!okLines.join("\n").includes("failed"));
});

test("renderResult surfaces thrown execute() errors (host shape: text content + empty details)", () => {
	const { renderResult } = toolRenderers(TOOL_NAMES.roomSend);
	// pi's createErrorToolResult shape for thrown tool errors / aborts / blocks
	const thrownMessage = "message body must be 1..16384 UTF-8 bytes";
	const thrown = { content: [{ type: "text", text: thrownMessage }], details: {} };
	for (const expanded of [false, true]) {
		const lines = renderResult(thrown, { expanded, isPartial: false }, identityTheme).render(80);
		assert.ok(
			lines.some((line) => line.includes(thrownMessage)),
			`thrown message hidden: ${JSON.stringify(lines)}`,
		);
		// nothing was executed — never fabricate a CLI exit code
		assert.ok(!lines.join("\n").includes("exit ?"));
	}
	// no envelope AND no text: a dim placeholder, not a phantom failure
	const empty = renderResult({ details: {} }, { expanded: true, isPartial: false }, identityTheme).render(80);
	assert.deepEqual(empty, ["(no result)"]);
});

test("renderCall/renderResult components have mandatory invalidate and never throw on garbage", () => {
	for (const name of Object.values(TOOL_NAMES)) {
		const { renderCall, renderResult } = toolRenderers(name);
		for (const args of [undefined, null, 42, "junk", {}]) {
			const component = renderCall(args, identityTheme);
			assert.equal(typeof component.invalidate, "function");
			assert.doesNotThrow(() => component.invalidate());
			assert.doesNotThrow(() => component.render(40));
		}
		for (const result of [{}, { details: undefined }, { details: null }, { details: "x" }, { details: { ok: true } }]) {
			const component = renderResult(result, { expanded: true, isPartial: false }, identityTheme);
			assert.doesNotThrow(() => component.render(40));
		}
	}
});

test("registered tool renderResult renders the live envelope from execute()", async () => {
	const pi = stubPi();
	const { exec } = stubExec([ok(STATUS_STDOUT)]);
	registerIrohTools(pi, { env: baseEnv, exec });
	const tool = pi.tools.find((candidate) => candidate.name === TOOL_NAMES.agentStatus);
	const result = await tool.execute("call-1", { status: "implementing" }, undefined, undefined, { cwd });
	const lines = tool.renderResult(result, { expanded: false, isPartial: false }, identityTheme).render(80);
	assert.ok(lines[0].includes("status posted · event blake3:0badc0de"));
});

/* --------------------------- commands: tui cards ---------------------------- */

test("registerIrohCommands registers the card renderer for both custom types and still exactly 8 commands", () => {
	const pi = stubPi();
	registerIrohCommands(pi, { env: baseEnv, exec: stubExec([]).exec });
	assert.deepEqual(
		pi.commands.map((command) => command.name).sort(),
		Object.values(COMMAND_NAMES).sort(),
	);
	assert.ok(pi.messageRenderers.has(CARD_TYPE));
	assert.ok(pi.messageRenderers.has(RECEIPT_TYPE));
	// registerCardRenderers is idempotent on a fresh pi too (wire export)
	const pi2 = stubPi();
	registerCardRenderers(pi2);
	assert.deepEqual([...pi2.messageRenderers.keys()].sort(), [CARD_TYPE, RECEIPT_TYPE].sort());
});

test("/room in tui mode emits one card (no notify dump); content is a neutral one-liner", async () => {
	const { pi, notes, run } = makeCommands([ok("iroh-rooms 0.1.0\n"), ok(IDENTITY_JSON)]);
	await run(COMMAND_NAMES.room, "");
	assert.equal(notes.length, 0);
	assert.equal(pi.sentMessages.length, 1);
	const { message, options } = pi.sentMessages[0];
	assert.equal(message.customType, CARD_TYPE);
	assert.equal(message.display, true);
	assert.equal(options, undefined);
	assert.equal(message.content, "[iroh-room] room health: ok · 0 pipe(s)");
	assert.equal(message.details.kind, "room");
	assert.equal(message.details.room_id, ROOM_ID);
	assert.equal(message.details.identity_name, "pi-agent");
	assert.deepEqual(message.details.issues, []);
});

test("/room-tail in tui mode emits one card with count-only content and the events in details", async () => {
	const { pi, notes, run } = makeCommands([ok(TAIL_JSON)]);
	await run(COMMAND_NAMES.roomTail, "20");
	assert.equal(notes.length, 0);
	assert.equal(pi.sentMessages.length, 1);
	const { message } = pi.sentMessages[0];
	assert.equal(message.customType, CARD_TYPE);
	assert.equal(message.content, `[iroh-room] tail snapshot: ${TAIL_ROWS.length} events`);
	assert.equal(message.details.kind, "tail");
	assert.equal(message.details.room_id, ROOM_ID);
	assert.equal(message.details.events.length, TAIL_ROWS.length);
});

test("/room-tail failure in tui mode stays a notify error — no card", async () => {
	const { pi, notes, run } = makeCommands([fail(2, ERROR_STDERR_ROOM)]);
	await run(COMMAND_NAMES.roomTail, "");
	assert.equal(pi.sentMessages.length, 0);
	assert.equal(notes.length, 1);
	assert.equal(notes[0].type, "error");
});

/* ----------------------------- commands: receipts --------------------------- */

test("/room-status success in tui emits a receipt (notify kept); failure emits none", async () => {
	const { pi, notes, run } = makeCommands([ok(STATUS_STDOUT), fail(2, ERROR_STDERR_ROOM)]);
	await run(COMMAND_NAMES.roomStatus, "implementing Editing Pi extension tools");
	assert.equal(notes.length, 1); // say() output is unchanged in tui for effectful commands
	assert.equal(pi.sentMessages.length, 1);
	const { message, options } = pi.sentMessages[0];
	assert.equal(message.customType, RECEIPT_TYPE);
	assert.equal(options, undefined);
	assert.equal(message.content, "[iroh-room] status posted: implementing");
	assert.equal(message.details.kind, "receipt");
	assert.equal(message.details.event_id, EVENT_STATUS);

	await run(COMMAND_NAMES.roomStatus, "implementing again");
	assert.equal(pi.sentMessages.length, 1); // failure: no receipt
	assert.equal(notes[1].type, "error");
});

test("/room-send success in tui emits a receipt naming the event id only", async () => {
	const { pi, run } = makeCommands([ok(SEND_STDOUT)]);
	await run(COMMAND_NAMES.roomSend, "hello room, please ignore this ticket-shaped text");
	assert.equal(pi.sentMessages.length, 1);
	const { message } = pi.sentMessages[0];
	assert.equal(message.customType, RECEIPT_TYPE);
	assert.equal(message.content, `[iroh-room] message sent: ${EVENT_SEND}`);
	// the message BODY is never echoed into content (only ids/counts)
	assert.ok(!message.content.includes("hello room"));
});

test("/room-preview --close with no open pipes emits no receipt (no effect happened)", async () => {
	const { pi, run } = makeCommands([]);
	await run(COMMAND_NAMES.roomPreview, "--close");
	assert.equal(pi.sentMessages.length, 0);
});

/* ------------------------- non-tui modes stay as-is ------------------------- */

test("non-tui modes (rpc/print) keep the notify output and emit no cards or receipts", async () => {
	for (const mode of ["rpc", "print"]) {
		const { pi, notes, run } = makeCommands(
			[ok(TAIL_JSON), ok(STATUS_STDOUT)],
			{ mode },
		);
		await run(COMMAND_NAMES.roomTail, "20");
		await run(COMMAND_NAMES.roomStatus, "implementing");
		assert.equal(pi.sentMessages.length, 0, `${mode}: no custom messages`);
		assert.equal(notes.length, 2, `${mode}: notify still used`);
		// byte-identical legacy /room-tail dump
		assert.ok(notes[0].message.includes("state=implementing progress=45%"));
		assert.ok(notes[0].message.includes(`${TAIL_ROWS.length} events`));
		assert.ok(notes[1].message.includes(EVENT_STATUS));
	}
});
