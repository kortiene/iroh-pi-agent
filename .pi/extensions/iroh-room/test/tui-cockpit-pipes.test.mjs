/** Room Cockpit — Pipes tab (read-only). */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension, stubCtx, stubExec, stubPi } from "./helpers.mjs";
import { ROOM_ID } from "./fixtures.mjs";

const ext = await loadExtension();
const { CockpitComponent } = await ext.importModule("tui/cockpit/component");
const { registerIrohCommands } = await ext.importModule("commands");
const { COMMAND_NAMES } = await ext.importModule("constants");
const { renderPipes, orderedPipes } = await ext.importModule("tui/cockpit/pipes");
const { COCKPIT_TABS } = await ext.importModule("tui/cockpit/model");
const { cockpitKeys } = await ext.importModule("tui/cockpit/wire");
const { identityStyler, naiveFit } = await ext.importModule("tui/style");

after(async () => {
	await ext.cleanup();
});

const PIPE_A = "a".repeat(32);
const PIPE_B = "b".repeat(32);

function snapshot(overrides = {}) {
	return {
		config: { roomId: ROOM_ID, agentName: "pi-agent" },
		identity: { name: "pi-agent", identityId: "1".repeat(64), from8: "11111111" },
		feed: { state: "ok", lastOkAt: Date.now() - 1_000, gap: false, rowCount: 0, seenCount: 0 },
		latest: {},
		tasks: { all: [], unclaimed: [], claimed: [], readyForReview: [], done: [] },
		members: [],
		files: [],
		pipes: [
			{ id: PIPE_B, target: "127.0.0.1:3000", label: "preview", state: "open", trustedLocal: true, startedAt: Date.now() - 5_000 },
			{ id: PIPE_A, target: "127.0.0.1:5173", state: "open", trustedLocal: true, startedAt: Date.now() - 10_000 },
		],
		events: [],
		...overrides,
	};
}

const kit = { styler: identityStyler, fit: naiveFit, width: 100, now: Date.now() };

function makeComponent(snap) {
	return new CockpitComponent({
		snapshot: snap,
		styler: identityStyler,
		fit: naiveFit,
		keys: cockpitKeys,
		getHeight: () => 24,
		onClose: () => {},
		onRefresh: async () => {},
		requestRender: () => {},
	});
}

test("pipes is a registered tab reachable by hotkey 6 (artifacts 5, health 7)", () => {
	assert.deepEqual([...COCKPIT_TABS], ["overview", "timeline", "tasks", "members", "artifacts", "pipes", "health"]);
	assert.equal(cockpitKeys.tabFor("5"), "artifacts");
	assert.equal(cockpitKeys.tabFor("6"), "pipes");
	assert.equal(cockpitKeys.tabFor("7"), "health");
	const component = makeComponent(snapshot());
	component.handleInput("6");
	const body = component.render(100).join("\n");
	assert.ok(body.includes("Pipes"), "pipes section title renders on tab 6");
	assert.ok(body.includes("PIPES"), "pipes header renders");
});

test("/room-cockpit accepts tab pipes and exposes pipes in completions/usage", async () => {
	const pi = stubPi();
	const events = [];
	const cockpit = {
		open: async (mode) => events.push(`open:${mode}`),
		close: (reason) => events.push(`close:${reason}`),
		isOpen: () => false,
		selectTab: (tab) => events.push(`tab:${tab}`),
		shutdown: () => {},
	};
	const ambient = {
		boost: () => events.push("boost"),
		getDensity: () => "2",
		setDensity: async () => {},
		cycleDensity: () => "off",
		shutdown: () => {},
	};
	registerIrohCommands(pi, { exec: stubExec([]).exec, env: {}, ambient, cockpit });
	const command = pi.commands.find((entry) => entry.name === COMMAND_NAMES.roomCockpit);
	assert.ok(command !== undefined, "room-cockpit command registered");
	assert.ok(command.getArgumentCompletions("pi").some((item) => item.value === "pipes"));
	await command.handler("tab pipes", stubCtx({ mode: "tui", hasUI: true }));
	assert.deepEqual(events, ["tab:pipes", "boost"]);
	const badCtx = stubCtx({ mode: "tui", hasUI: true });
	await command.handler("tab nope", badCtx);
	assert.ok(badCtx.ui.notifications[0].message.includes("tab pipes"), "usage lists pipes");
});

test("orderedPipes sorts deterministically by state then id", () => {
	const ordered = orderedPipes(snapshot({
		pipes: [
			{ id: PIPE_B, target: "127.0.0.1:3000", state: "open", trustedLocal: true },
			{ id: PIPE_A, target: "127.0.0.1:5173", state: "open", trustedLocal: true },
		],
	}).pipes);
	assert.deepEqual(ordered.map((pipe) => pipe.id), [PIPE_A, PIPE_B]);
});

test("empty pipe registry shows a friendly local-state empty state", () => {
	const body = renderPipes(snapshot({ pipes: [] }), kit, 0).join("\n");
	assert.ok(body.includes("No active local preview pipes in this session."));
	assert.ok(!body.includes("INSPECTOR"), "no inspector when there are no pipes");
});

test("pipes renderer shows columns, trusted-local source, and selected inspector", () => {
	const body = renderPipes(snapshot(), kit, 0).join("\n");
	assert.ok(body.includes("pipe"), "pipe column header renders");
	assert.ok(body.includes("target"), "target column header renders");
	assert.ok(body.includes("state"), "state column header renders");
	assert.ok(body.includes("trusted"), "trusted column header renders");
	assert.ok(body.includes("trusted-local"), "summary calls out trusted local state");
	assert.ok(body.includes("INSPECTOR"));
	assert.ok(body.includes("yes, local registry"));
});

test("selection can move and exposes pipe label/age in the inspector", () => {
	const component = makeComponent(snapshot());
	component.handleInput("6");
	component.handleInput("down");
	const body = component.render(100).join("\n");
	assert.ok(body.includes("preview"), "selected second pipe label is shown");
	assert.ok(body.includes("age"), "inspector includes age row");
});

test("selection is clamped and never throws at degenerate widths", () => {
	const component = makeComponent(snapshot());
	component.handleInput("6");
	for (let i = 0; i < 10; i++) component.handleInput("down");
	for (let i = 0; i < 10; i++) component.handleInput("up");
	for (const width of [120, 80, 40, 20, 8, 1]) {
		let lines;
		assert.doesNotThrow(() => {
			lines = component.render(width);
		});
		for (const line of lines) assert.ok(line.length <= width, `width ${width}: ${JSON.stringify(line)}`);
	}
});

test("tab strip and overview surface pipe counts", () => {
	const component = makeComponent(snapshot());
	const chrome = component.render(120).join("\n");
	assert.ok(chrome.includes("Pipes 2"), "tab strip shows the pipe count");
});
