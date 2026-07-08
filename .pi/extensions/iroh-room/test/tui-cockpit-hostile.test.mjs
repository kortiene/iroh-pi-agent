/**
 * Cockpit hostile-corpus end-to-end (brief §12 security invariants + §14).
 *
 * The render suite proves ONE hand-built hostile snapshot is sanitized. This
 * suite feeds the SHARED hostile corpus (fixtures.hostileTailRows, the same
 * attacker-controlled bodies the pulse/card hostile suites use) through the
 * REAL AmbientController.getSnapshot() into the REAL cockpit component, and
 * asserts that on every tab, at every width:
 *   - no raw ESC / C0 / C1 control byte survives (no ANSI, no OSC hyperlink);
 *   - no bidi override survives;
 *   - no invite ticket body survives (masked);
 *   - every rendered line fits the width;
 *   - the renderer never throws and always returns lines (no Markdown fallback).
 *
 * NOTE: unlike the card/receipt model-visibility tests, the cockpit is a
 * DISPLAY surface: its job is to render room text with control bytes/tickets
 * neutralized. Inert plaintext residue (e.g. "[31m" after the ESC is stripped)
 * is expected on screen and is NOT a leak — the invariant is that nothing
 * EXECUTABLE (ESC/CSI/OSC/bidi) or secret-shaped (ticket body) survives.
 */

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadExtension, stubCtx, stubExec, stubTimers } from "./helpers.mjs";
import { HOSTILE_TAIL_JSON, IDENTITY_JSON, ROOM_ID, ok } from "./fixtures.mjs";

const ext = await loadExtension();
const { AmbientController } = await ext.importModule("tui/ambient");
const { CockpitComponent } = await ext.importModule("tui/cockpit/component");
const { cockpitKeys } = await ext.importModule("tui/cockpit/wire");
const { identityStyler, naiveFit } = await ext.importModule("tui/style");

const cwd = await mkdtemp(join(tmpdir(), "iroh-room-cockpit-hostile-"));
const binPath = join(cwd, "fake-iroh-rooms");
await writeFile(binPath, "#!/bin/sh\nexit 0\n");
await chmod(binPath, 0o755);
const baseEnv = { IROH_ROOM_ID: ROOM_ID, IROH_ROOMS_BIN: binPath };

after(async () => {
	await rm(cwd, { recursive: true, force: true });
	await ext.cleanup();
});

/**
 * Control/bidi bytes that must never reach the terminal (mirrors sanitize.ts).
 * NOTE: excludes \x0a/\x0d so joining lines with "\n" for a whole-block scan
 * does not self-trip; renderers never emit newlines inside a line anyway.
 */
const FORBIDDEN_RE = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f\u202A-\u202E\u2066-\u2069\u200E\u200F]/u;

function assertClean(lines, label) {
	for (const line of lines) {
		// No EXECUTABLE control/bidi byte (ESC/CSI/OSC/DCS, bidi overrides).
		assert.ok(!FORBIDDEN_RE.test(line), `control/bidi byte leaked (${label}): ${JSON.stringify(line)}`);
		// No secret-shaped invite ticket body (masked by roomText).
		assert.ok(!/roomtkt1[0-9a-z]{8}/i.test(line), `invite ticket leaked (${label}): ${JSON.stringify(line)}`);
	}
}

async function hostileSnapshot() {
	const shim = stubTimers();
	const { exec } = stubExec([ok(IDENTITY_JSON), ok(HOSTILE_TAIL_JSON)]);
	const controller = new AmbientController({ env: baseEnv, exec, now: shim.now, timers: shim.timers });
	await controller.onSessionStart(
		{ type: "session_start", reason: "startup" },
		stubCtx({ cwd, mode: "tui", hasUI: true }),
	);
	await shim.advance(0); // init tick: identity + hostile tail poll
	return controller.getSnapshot();
}

test("real hostile corpus survives getSnapshot() → cockpit render on every tab/width", async () => {
	const snapshot = await hostileSnapshot();
	// sanity: the hostile rows actually made it into the snapshot
	assert.ok(snapshot.events.length > 0, "hostile rows present in snapshot");

	const component = new CockpitComponent({
		snapshot,
		styler: identityStyler,
		fit: naiveFit,
		keys: cockpitKeys,
		getHeight: () => 24,
		onClose: () => {},
		onRefresh: async () => {},
		requestRender: () => {},
	});

	for (const tab of ["1", "2", "3", "4", "5", "6"]) {
		component.handleInput(tab);
		for (const width of [120, 80, 60, 40, 20, 8, 1]) {
			let lines;
			assert.doesNotThrow(() => {
				lines = component.render(width);
			}, `render threw on tab ${tab} width ${width}`);
			assert.ok(Array.isArray(lines) && lines.length > 0, "renderer always returns lines");
			for (const line of lines) {
				assert.ok(line.length <= width, `line exceeds width ${width} on tab ${tab}: ${JSON.stringify(line)}`);
			}
			assertClean(lines, `tab ${tab}, width ${width}`);
		}
	}
});

test("hostile inspector rows (selection) stay sanitized on timeline and tasks", async () => {
	const snapshot = await hostileSnapshot();
	const component = new CockpitComponent({
		snapshot,
		styler: identityStyler,
		fit: naiveFit,
		keys: cockpitKeys,
		getHeight: () => 24,
		onClose: () => {},
		onRefresh: async () => {},
		requestRender: () => {},
	});
	// Timeline: walk the selection across every hostile event, rendering each.
	component.handleInput("2");
	for (let i = 0; i < snapshot.events.length + 2; i++) {
		assertClean(component.render(80), `timeline inspector sel=${i}`);
		component.handleInput("down");
	}
	// Members: walk the selection across the roster (may be empty on this feed).
	component.handleInput("4");
	for (let i = 0; i < Math.max(1, snapshot.members.length) + 2; i++) {
		assertClean(component.render(80), `members inspector sel=${i}`);
		component.handleInput("down");
	}
	// Pipes: walk the selection across active local pipes (may be empty here).
	component.handleInput("5");
	for (let i = 0; i < Math.max(1, snapshot.pipes.length) + 2; i++) {
		assertClean(component.render(80), `pipes inspector sel=${i}`);
		component.handleInput("down");
	}
});

test("hostile member roster (role/status) stays sanitized on the members tab", () => {
	const HOSTILE = "\u001b[31mred\u001b[0m \u202Eevil roomtkt1qpzry9x8gf2tvdw0";
	const snapshot = {
		config: { roomId: ROOM_ID },
		identity: { name: "pi-agent", identityId: "a".repeat(64), from8: "aaaaaaaa" },
		feed: { state: "ok", lastOkAt: Date.now(), gap: false },
		latest: {},
		tasks: { all: [], unclaimed: [], claimed: [], readyForReview: [], done: [] },
		members: [
			{ id: "a".repeat(64), role: HOSTILE, status: HOSTILE, isAdmin: true },
			{ id: "b".repeat(64), role: HOSTILE, status: HOSTILE, isAdmin: false },
		],
		files: [],
		pipes: [],
		events: [],
	};
	const component = new CockpitComponent({
		snapshot,
		styler: identityStyler,
		fit: naiveFit,
		keys: cockpitKeys,
		getHeight: () => 24,
		onClose: () => {},
		onRefresh: async () => {},
		requestRender: () => {},
	});
	component.handleInput("4");
	for (const width of [120, 80, 40, 20, 8, 1]) {
		assertClean(component.render(width), `members hostile width=${width}`);
	}
});

test("hostile pipe labels stay sanitized on the pipes tab", () => {
	const HOSTILE = "\u001b[31mred\u001b[0m \u202Eevil roomtkt1qpzry9x8gf2tvdw0";
	const snapshot = {
		config: { roomId: ROOM_ID },
		identity: { name: "pi-agent", identityId: "a".repeat(64), from8: "aaaaaaaa" },
		feed: { state: "ok", lastOkAt: Date.now(), gap: false },
		latest: {},
		tasks: { all: [], unclaimed: [], claimed: [], readyForReview: [], done: [] },
		members: [],
		files: [],
		pipes: [
			{ id: "a".repeat(32), target: "127.0.0.1:3000", label: HOSTILE, state: "open", trustedLocal: true, startedAt: Date.now() - 1_000 },
		],
		events: [],
	};
	const component = new CockpitComponent({
		snapshot,
		styler: identityStyler,
		fit: naiveFit,
		keys: cockpitKeys,
		getHeight: () => 24,
		onClose: () => {},
		onRefresh: async () => {},
		requestRender: () => {},
	});
	component.handleInput("5");
	for (const width of [120, 80, 40, 20, 8, 1]) {
		assertClean(component.render(width), `pipes hostile width=${width}`);
	}
});
