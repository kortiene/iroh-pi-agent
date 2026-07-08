/** Room Cockpit — Settings tab (read-only). */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension, stubCtx, stubExec, stubPi } from "./helpers.mjs";
import { ROOM_ID } from "./fixtures.mjs";

const ext = await loadExtension();
const { CockpitComponent } = await ext.importModule("tui/cockpit/component");
const { registerIrohCommands } = await ext.importModule("commands");
const { COMMAND_NAMES } = await ext.importModule("constants");
const { renderSettings } = await ext.importModule("tui/cockpit/settings");
const { COCKPIT_TABS } = await ext.importModule("tui/cockpit/model");
const { cockpitKeys } = await ext.importModule("tui/cockpit/wire");
const { identityStyler, naiveFit } = await ext.importModule("tui/style");

after(async () => {
	await ext.cleanup();
});

function snapshot(overrides = {}) {
	return {
		config: { roomId: ROOM_ID, agentName: "pi-agent", pulseDensity: "2", cwd: "/tmp/work", configFile: "/tmp/work/.iroh-room-pi.json" },
		identity: { name: "pi-agent", identityId: "1".repeat(64), from8: "11111111" },
		feed: { state: "ok", lastOkAt: Date.now() - 1_000, gap: false, rowCount: 0, seenCount: 0 },
		latest: {},
		tasks: { all: [], unclaimed: [], claimed: [], readyForReview: [], done: [] },
		members: [],
		files: [],
		pipes: [],
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

test("settings is a registered tab reachable by hotkey 8", () => {
	assert.deepEqual([...COCKPIT_TABS], ["overview", "timeline", "tasks", "members", "artifacts", "pipes", "health", "settings"]);
	assert.equal(cockpitKeys.tabFor("8"), "settings");
	const component = makeComponent(snapshot());
	component.handleInput("8");
	const body = component.render(100).join("\n");
	assert.ok(body.includes("Settings"), "settings section title renders on tab 8");
	assert.ok(body.includes("Local display controls only"));
});

test("/room-cockpit accepts tab settings and exposes settings in completions/usage", async () => {
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
	assert.ok(command.getArgumentCompletions("set").some((item) => item.value === "settings"));
	await command.handler("tab settings", stubCtx({ mode: "tui", hasUI: true }));
	assert.deepEqual(events, ["tab:settings", "boost"]);
	const badCtx = stubCtx({ mode: "tui", hasUI: true });
	await command.handler("tab nope", badCtx);
	assert.ok(badCtx.ui.notifications[0].message.includes("tab settings"), "usage lists settings");
});

test("settings renderer shows display, safety, and resolved local context", () => {
	const body = renderSettings(snapshot(), kit, "settings").join("\n");
	assert.ok(body.includes("DISPLAY"));
	assert.ok(body.includes("pulse density"));
	assert.ok(body.includes("SAFETY"));
	assert.ok(body.includes("mutations"));
	assert.ok(body.includes("RESOLVED LOCAL CONTEXT"));
	assert.ok(body.includes("/tmp/work"));
});

test("settings tab never throws at degenerate widths", () => {
	const component = makeComponent(snapshot());
	component.handleInput("8");
	for (const width of [120, 80, 40, 20, 8, 1]) {
		let lines;
		assert.doesNotThrow(() => {
			lines = component.render(width);
		});
		for (const line of lines) assert.ok(line.length <= width, `width ${width}: ${JSON.stringify(line)}`);
	}
});
