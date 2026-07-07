import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension, stubCtx, stubExec, stubPi } from "./helpers.mjs";
import { ROOM_ID } from "./fixtures.mjs";

const ext = await loadExtension();
const { CockpitController } = await ext.importModule("tui/cockpit/controller");
const { registerIrohCommands } = await ext.importModule("commands");
const { COMMAND_NAMES } = await ext.importModule("constants");

after(async () => {
	await ext.cleanup();
});

function snapshot(overrides = {}) {
	return {
		config: { roomId: ROOM_ID, agentName: "pi-agent" },
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

async function drain(rounds = 4) {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
}

test("/room-cockpit overlay opens the cockpit in overlay mode (TUI only)", async () => {
	const pi = stubPi();
	const events = [];
	const cockpit = {
		open: async (mode) => events.push(`open:${mode}`),
		close: (reason) => events.push(`close:${reason}`),
		isOpen: () => false,
		selectTab: (tab) => events.push(`tab:${tab}`),
		shutdown: () => events.push("shutdown"),
	};
	const ambient = {
		onSessionStart: async () => {},
		boost: () => events.push("boost"),
		getDensity: () => "2",
		setDensity: async () => {},
		cycleDensity: () => "off",
		shutdown: () => {},
		getSnapshot: () => snapshot(),
		requestRefresh: async () => events.push("refresh"),
		subscribe: () => () => {},
	};
	registerIrohCommands(pi, { exec: stubExec([]).exec, env: {}, ambient, cockpit });
	const command = pi.commands.find((entry) => entry.name === COMMAND_NAMES.roomCockpit);
	assert.ok(command.getArgumentCompletions("").some((item) => item.value === "overlay"));

	await command.handler("overlay", stubCtx({ mode: "json", hasUI: false }));
	assert.deepEqual(events, [], "json mode has no custom UI and no ambient side effects");

	await command.handler("overlay", stubCtx({ mode: "tui", hasUI: true }));
	assert.deepEqual(events, ["boost", "open:overlay"]);
});

test("CockpitController overlay uses right-side options, focuses, hides on close, and reopens fresh", async () => {
	let refreshes = 0;
	let unsubscribed = 0;
	const source = {
		getSnapshot: () => snapshot(),
		requestRefresh: async () => { refreshes++; },
		subscribe: () => () => { unsubscribed++; },
	};
	const controller = new CockpitController({ dataSource: source });
	const ctx = stubCtx({ mode: "tui", hasUI: true });

	const opened = controller.open("overlay", ctx);
	await drain();
	assert.equal(ctx.ui.customComponents.length, 1);
	const first = ctx.ui.customComponents[0];
	assert.equal(first.options.overlay, true);
	assert.equal(first.options.overlayOptions.anchor, "right-center");
	assert.equal(first.options.overlayOptions.width, "35%");
	assert.equal(first.options.overlayOptions.minWidth, 44);
	assert.equal(first.options.overlayOptions.maxHeight, "85%");
	assert.equal(first.options.overlayOptions.visible(99, 40), false);
	assert.equal(first.options.overlayOptions.visible(100, 40), true);
	assert.ok(first.handle.calls.includes("focus"), "overlay focused when opened");

	// Re-open while still open: no second component; hidden overlay is shown + focused; refresh requested.
	first.handle.hidden = true;
	void controller.open("overlay", ctx);
	await drain();
	assert.equal(ctx.ui.customComponents.length, 1, "re-open reuses current overlay component");
	assert.ok(first.handle.calls.includes("setHidden:false"), "hidden overlay shown on repeated open");
	assert.ok(first.handle.calls.filter((call) => call === "focus").length >= 2, "re-open focuses overlay");
	assert.equal(refreshes, 1, "re-open requests one ambient refresh");

	controller.close("user");
	await opened;
	assert.equal(unsubscribed, 1);
	assert.ok(first.handle.calls.includes("hide"), "overlay handle hidden/cleaned on close");
	assert.equal(controller.isOpen(), false);

	const reopened = controller.open("overlay", ctx);
	await drain();
	assert.equal(ctx.ui.customComponents.length, 2, "fresh component created after close");
	const second = ctx.ui.customComponents[1];
	assert.notEqual(second.component, first.component, "stale component reference not reused");
	assert.notEqual(second.handle, first.handle, "stale overlay handle not reused");
	assert.ok(second.handle.calls.includes("focus"));

	controller.shutdown();
	await reopened;
	assert.equal(unsubscribed, 2);
	assert.ok(second.handle.calls.includes("hide"), "overlay handle hidden/cleaned on shutdown");
});
