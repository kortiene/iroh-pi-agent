import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension, stubCtx, stubExec, stubPi } from "./helpers.mjs";
import { HOSTILE_TICKET, IDENTITY_AGENT, ROOM_ID } from "./fixtures.mjs";

const ext = await loadExtension();
const { CockpitComponent } = await ext.importModule("tui/cockpit/component");
const { CockpitController } = await ext.importModule("tui/cockpit/controller");
const { registerIrohCommands } = await ext.importModule("commands");
const { COMMAND_NAMES } = await ext.importModule("constants");
const { identityStyler, naiveFit } = await ext.importModule("tui/style");

after(async () => {
	await ext.cleanup();
});

function snapshot(overrides = {}) {
	return {
		config: {
			roomId: ROOM_ID,
			roomLabel: `engineering ${HOSTILE_TICKET}`,
			binary: "/tmp/fake-iroh-rooms",
			dataDir: "/tmp/iroh-home",
			agentName: "pi-agent",
			cwd: "/tmp/work",
		},
		identity: {
			name: "pi-agent",
			identityId: IDENTITY_AGENT,
			from8: IDENTITY_AGENT.slice(0, 8),
		},
		feed: { state: "ok", lastOkAt: Date.now() - 2_000, gap: false, rowCount: 3, seenCount: 3 },
		latest: {
			status: { label: "implementing", progress: 42, message: `working ${HOSTILE_TICKET}` },
			event: { eventId: "blake3:" + "a".repeat(64), type: "message.text", author: "mallory", timestamp: "2026-07-07T12:34:00Z", lamport: 3, summary: `hello \u001b[31mred\u001b[0m ${HOSTILE_TICKET}` },
		},
		tasks: {
			all: [{ id: "IR-PI-014", type: "implement", title: `Do thing ${HOSTILE_TICKET}`, state: "backlog" }],
			unclaimed: [{ id: "IR-PI-014", type: "implement", title: `Do thing ${HOSTILE_TICKET}`, state: "backlog" }],
			claimed: [],
			readyForReview: [],
			done: [],
		},
		members: [],
		files: [],
		pipes: [],
		events: [
			{ eventId: "blake3:" + "a".repeat(64), type: "message.text", author: "mallory", timestamp: "2026-07-07T12:34:00Z", lamport: 3, summary: `hello \u001b[31mred\u001b[0m ${HOSTILE_TICKET}` },
		],
		...overrides,
	};
}

const keys = {
	isClose: (data) => data === "esc",
	isHelp: (data) => data === "?",
	isNextTab: (data) => data === "tab",
	isPrevTab: () => false,
	isUp: (data) => data === "up",
	isDown: (data) => data === "down",
	isRefresh: (data) => data === "r",
	isEnter: (data) => data === "enter",
	isReadOnlyAction: (data) => data === "c",
	tabFor: (data) => ({ "1": "overview", "2": "timeline", "3": "tasks", "4": "health" })[data],
};

test("cockpit component renders every Phase 1 tab within width and sanitizes tickets/control codes", () => {
	let renders = 0;
	const component = new CockpitComponent({
		snapshot: snapshot(),
		styler: identityStyler,
		fit: naiveFit,
		keys,
		getHeight: () => 22,
		onClose: () => {},
		onRefresh: async () => {},
		requestRender: () => { renders++; },
	});
	for (const tab of ["1", "2", "3", "4"]) {
		component.handleInput(tab);
		for (const width of [100, 60, 24, 8]) {
			const lines = component.render(width);
			assert.equal(lines.length, 22);
			for (const line of lines) assert.ok(line.length <= width, `${tab}/${width}: ${line}`);
			const joined = lines.join("\n");
			assert.ok(!joined.includes("\u001b"));
			assert.ok(!joined.includes(HOSTILE_TICKET));
			assert.ok(!/roomtkt1[0-9a-z]{8}/i.test(joined), joined);
		}
	}
	component.handleInput("?");
	assert.ok(component.render(80).join("\n").includes("Help"));
	component.handleInput("enter");
	assert.ok(renders > 0);
});

test("/room-cockpit respects the TUI/RPC/JSON/print mode matrix", async () => {
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

	await command.handler("", stubCtx({ mode: "json", hasUI: false }));
	await command.handler("", stubCtx({ mode: "print", hasUI: false }));
	assert.deepEqual(events, []);

	const rpc = stubCtx({ mode: "rpc", hasUI: true });
	await command.handler("", rpc);
	assert.equal(rpc.ui.notifications[0].type, "warning");
	assert.deepEqual(events, []);

	await command.handler("", stubCtx({ mode: "tui", hasUI: true }));
	await command.handler("tab tasks", stubCtx({ mode: "tui", hasUI: true }));
	await command.handler("refresh", stubCtx({ mode: "tui", hasUI: true }));
	await command.handler("close", stubCtx({ mode: "tui", hasUI: true }));
	assert.deepEqual(events, ["boost", "open:full", "tab:tasks", "boost", "boost", "refresh", "close:user", "boost"]);
});

test("CockpitController opens once, subscribes to snapshots, closes, and cleans up idempotently", async () => {
	let current = snapshot();
	let listener;
	let unsubscribed = 0;
	let refreshes = 0;
	const source = {
		getSnapshot: () => current,
		requestRefresh: async () => { refreshes++; },
		subscribe: (next) => {
			listener = next;
			return () => { unsubscribed++; };
		},
	};
	const controller = new CockpitController({ dataSource: source });
	const ctx = stubCtx({ mode: "tui", hasUI: true });
	const opened = controller.open("full", ctx);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(controller.isOpen(), true);
	assert.equal(ctx.ui.customComponents.length, 1);
	const component = ctx.ui.customComponents[0].component;
	assert.ok(component.render(80).join("\n").includes("iroh-room cockpit"));

	current = snapshot({ feed: { state: "stale", lastOkAt: Date.now() - 60_000, gap: false } });
	listener();
	assert.ok(component.render(80)[1].includes("stale"));
	component.handleInput("r");
	await Promise.resolve();
	assert.equal(refreshes, 1);

	controller.close("user");
	await opened;
	assert.equal(controller.isOpen(), false);
	assert.equal(unsubscribed, 1);
	controller.shutdown();
	controller.shutdown();
	assert.equal(unsubscribed, 1);
});

test("CockpitController: repeated open focuses/refreshes the SAME cockpit (one open per session)", async () => {
	let refreshes = 0;
	const source = {
		getSnapshot: () => snapshot(),
		requestRefresh: async () => { refreshes++; },
		subscribe: () => () => {},
	};
	const controller = new CockpitController({ dataSource: source });
	const ctx = stubCtx({ mode: "tui", hasUI: true });
	const opened = controller.open("full", ctx);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(ctx.ui.customComponents.length, 1, "one custom component");

	// Second open must NOT spawn a second custom UI — it re-focuses + refreshes.
	// (By contract it returns the still-pending first openPromise, so we do NOT
	// await it — awaiting would block until close.)
	void controller.open("full", ctx);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(ctx.ui.customComponents.length, 1, "still exactly one cockpit");
	assert.equal(refreshes, 1, "re-open routes a single-flight refresh through the ambient path");
	assert.equal(controller.isOpen(), true);

	controller.close("user");
	await opened;
	assert.equal(controller.isOpen(), false);
});

test("CockpitController.shutdown() while OPEN resolves the custom promise and unsubscribes", async () => {
	let unsubscribed = 0;
	const source = {
		getSnapshot: () => snapshot(),
		requestRefresh: async () => {},
		subscribe: () => () => { unsubscribed++; },
	};
	const controller = new CockpitController({ dataSource: source });
	const ctx = stubCtx({ mode: "tui", hasUI: true });
	let openResolved = false;
	const opened = controller.open("full", ctx).then(() => { openResolved = true; });
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(controller.isOpen(), true);

	// session_shutdown while the cockpit is still on screen: must close cleanly.
	controller.shutdown();
	for (let i = 0; i < 10; i++) await Promise.resolve(); // drain the custom() + finally chain
	assert.equal(openResolved, true, "shutdown resolved the ctx.ui.custom() promise");
	assert.equal(controller.isOpen(), false, "shutdown closed the open cockpit");
	assert.equal(unsubscribed, 1, "subscription released on shutdown-while-open");
	await opened;
});
