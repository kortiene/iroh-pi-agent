/** Room Cockpit — Artifacts tab (read-only). */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension, stubCtx, stubExec, stubPi, stubTimers } from "./helpers.mjs";
import { BLOB_HASH, FILE_ID, FILE_LIST_JSON, IDENTITY_JSON, MEMBERS_JSON, ROOM_ID, TAIL_JSON, ok } from "./fixtures.mjs";

const ext = await loadExtension();
const { AmbientController } = await ext.importModule("tui/ambient");
const { CockpitComponent } = await ext.importModule("tui/cockpit/component");
const { registerIrohCommands } = await ext.importModule("commands");
const { COMMAND_NAMES } = await ext.importModule("constants");
const { renderArtifacts, orderedArtifacts } = await ext.importModule("tui/cockpit/artifacts");
const { COCKPIT_TABS } = await ext.importModule("tui/cockpit/model");
const { cockpitKeys } = await ext.importModule("tui/cockpit/wire");
const { identityStyler, naiveFit } = await ext.importModule("tui/style");

after(async () => {
	await ext.cleanup();
});

function snapshot(overrides = {}) {
	return {
		config: { roomId: ROOM_ID, agentName: "pi-agent" },
		identity: { name: "pi-agent", identityId: "1".repeat(64), from8: "11111111" },
		feed: { state: "ok", lastOkAt: Date.now() - 1_000, gap: false, rowCount: 0, seenCount: 0 },
		latest: {},
		tasks: { all: [], unclaimed: [], claimed: [], readyForReview: [], done: [] },
		members: [],
		files: [
			{ id: FILE_ID, blobHash: BLOB_HASH, name: "report.md", sizeBytes: 1834, mime: "text/markdown", provider: "local" },
		],
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

test("artifacts is a registered tab reachable by hotkey 5 (pipes 6, health 7)", () => {
	assert.deepEqual([...COCKPIT_TABS], ["overview", "timeline", "tasks", "members", "artifacts", "pipes", "health"]);
	assert.equal(cockpitKeys.tabFor("5"), "artifacts");
	assert.equal(cockpitKeys.tabFor("6"), "pipes");
	assert.equal(cockpitKeys.tabFor("7"), "health");
	const component = makeComponent(snapshot());
	component.handleInput("5");
	const body = component.render(100).join("\n");
	assert.ok(body.includes("Artifacts"), "artifacts section title renders on tab 5");
	assert.ok(body.includes("ARTIFACTS"), "artifacts header renders");
});

test("/room-cockpit accepts tab artifacts and exposes artifacts in completions/usage", async () => {
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
	assert.ok(command.getArgumentCompletions("art").some((item) => item.value === "artifacts"));
	await command.handler("tab artifacts", stubCtx({ mode: "tui", hasUI: true }));
	assert.deepEqual(events, ["tab:artifacts", "boost"]);
	const badCtx = stubCtx({ mode: "tui", hasUI: true });
	await command.handler("tab nope", badCtx);
	assert.ok(badCtx.ui.notifications[0].message.includes("tab artifacts"), "usage lists artifacts");
});

test("orderedArtifacts sorts by name/id for stable selection", () => {
	const ordered = orderedArtifacts([
		{ id: "file_" + "b".repeat(32), name: "z.md" },
		{ id: "file_" + "a".repeat(32), name: "a.md" },
	]);
	assert.deepEqual(ordered.map((file) => file.name), ["a.md", "z.md"]);
});

test("empty artifact list shows a no-fetch empty state", () => {
	const body = renderArtifacts(snapshot({ files: [] }), kit, 0).join("\n");
	assert.ok(body.includes("No shared files in the current ambient snapshot."));
	assert.ok(body.includes("never fetches files"));
	assert.ok(!body.includes("INSPECTOR"), "no inspector when there are no artifacts");
});

test("artifacts renderer shows columns, file id mapping count, and selected inspector", () => {
	const body = renderArtifacts(snapshot(), kit, 0).join("\n");
	assert.ok(body.includes("artifact"));
	assert.ok(body.includes("name"));
	assert.ok(body.includes("size"));
	assert.ok(body.includes("provider"));
	assert.ok(body.includes("1 file ids mapped"));
	assert.ok(body.includes("INSPECTOR"));
	assert.ok(body.includes(FILE_ID));
	assert.ok(body.includes(BLOB_HASH));
});

test("selection is clamped and never throws at degenerate widths", () => {
	const component = makeComponent(snapshot());
	component.handleInput("5");
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

test("manual cockpit refresh maps tail blob_hash to file_id through file list", async () => {
	const shim = stubTimers();
	const { calls, exec } = stubExec([ok(IDENTITY_JSON), ok(TAIL_JSON), ok(TAIL_JSON), ok(MEMBERS_JSON), ok(FILE_LIST_JSON)]);
	const controller = new AmbientController({ env: { IROH_ROOM_ID: ROOM_ID, IROH_ROOMS_BIN: process.execPath }, exec, now: shim.now, timers: shim.timers });
	await controller.onSessionStart({ type: "session_start", reason: "startup" }, stubCtx({ cwd: "/tmp", mode: "tui", hasUI: true }));
	await shim.advance(0);
	const before = controller.getSnapshot().files.find((file) => file.blobHash === BLOB_HASH);
	assert.equal(before?.id, BLOB_HASH, "tail-only row uses blob hash before mapping");
	await controller.requestRefresh();
	assert.equal(calls.filter((call) => call.args[0] === "file" && call.args[1] === "list").length, 1, "manual refresh performs one file list call");
	const after = controller.getSnapshot().files.find((file) => file.blobHash === BLOB_HASH);
	assert.equal(after?.id, FILE_ID, "file list maps blob hash to file_id");
	assert.equal(after?.provider, "local");
});
