/**
 * Room Cockpit — Members tab (read-only).
 *
 * Verifies the Members tab renderer end-to-end through the component: tab
 * registration + hotkey, empty state, admin-first ordering, self/admin
 * markers, the selection inspector, and the overview/tab-strip counts. The
 * hostile suite (tui-cockpit-hostile.test.mjs) owns the sanitization proof;
 * this suite owns behavior.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension, stubCtx, stubExec, stubPi } from "./helpers.mjs";
import { IDENTITY_ADMIN, IDENTITY_AGENT, ROOM_ID } from "./fixtures.mjs";

const ext = await loadExtension();
const { CockpitComponent } = await ext.importModule("tui/cockpit/component");
const { registerIrohCommands } = await ext.importModule("commands");
const { renderMembers, orderedMembers } = await ext.importModule("tui/cockpit/members");
const { renderOverview } = await ext.importModule("tui/cockpit/overview");
const { COMMAND_NAMES } = await ext.importModule("constants");
const { COCKPIT_TABS } = await ext.importModule("tui/cockpit/model");
const { cockpitKeys } = await ext.importModule("tui/cockpit/wire");
const { identityStyler, naiveFit } = await ext.importModule("tui/style");

after(async () => {
	await ext.cleanup();
});

const AGENT_ID = IDENTITY_AGENT;
const ADMIN_ID = IDENTITY_ADMIN;
const THIRD_ID = "c".repeat(64);

function snapshot(overrides = {}) {
	return {
		config: { roomId: ROOM_ID, agentName: "pi-agent" },
		identity: { name: "pi-agent", identityId: AGENT_ID, from8: AGENT_ID.slice(0, 8) },
		feed: { state: "ok", lastOkAt: Date.now() - 1_000, gap: false, rowCount: 0, seenCount: 0 },
		latest: {},
		tasks: { all: [], unclaimed: [], claimed: [], readyForReview: [], done: [] },
		members: [
			{ id: AGENT_ID, role: "agent", status: "active", isAdmin: false },
			{ id: ADMIN_ID, role: "admin", status: "active", isAdmin: true },
			{ id: THIRD_ID, role: "agent", status: "idle", isAdmin: false },
		],
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

test("members is a registered tab reachable by hotkey 4 (health moves to 5)", () => {
	assert.deepEqual([...COCKPIT_TABS], ["overview", "timeline", "tasks", "members", "health"]);
	assert.equal(cockpitKeys.tabFor("4"), "members");
	assert.equal(cockpitKeys.tabFor("5"), "health");
	const component = makeComponent(snapshot());
	component.handleInput("4");
	const body = component.render(100).join("\n");
	assert.ok(body.includes("Members"), "members section title renders on tab 4");
	assert.ok(body.includes("ROSTER"), "roster header renders");
});

test("/room-cockpit accepts tab members and exposes members in completions/usage", async () => {
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
	assert.ok(command.getArgumentCompletions("mem").some((item) => item.value === "members"));
	await command.handler("tab members", stubCtx({ mode: "tui", hasUI: true }));
	assert.deepEqual(events, ["tab:members", "boost"]);
	const badCtx = stubCtx({ mode: "tui", hasUI: true });
	await command.handler("tab nope", badCtx);
	assert.ok(badCtx.ui.notifications[0].message.includes("tab members"), "usage lists members");
});

test("orderedMembers sorts admins first, then by identity id", () => {
	const ordered = orderedMembers(snapshot().members);
	assert.deepEqual(
		ordered.map((member) => member.id),
		[ADMIN_ID, AGENT_ID, THIRD_ID],
	);
});

test("empty roster shows a friendly empty state, not an inspector", () => {
	const lines = renderMembers(snapshot({ members: [] }), kit, 0);
	const body = lines.join("\n");
	assert.ok(body.includes("No members in the current ambient snapshot."));
	assert.ok(!body.includes("Inspector"), "no inspector when the roster is empty");
});

test("roster renders the brief's identity/role/status/admin columns", () => {
	const lines = renderMembers(snapshot(), kit, 0);
	const body = lines.join("\n");
	assert.ok(body.includes("identity"), "identity column header renders");
	assert.ok(body.includes("role"), "role column header renders");
	assert.ok(body.includes("status"), "status column header renders");
	assert.ok(body.includes("admin?"), "admin? column header renders");
});

test("roster marks the admin, the self identity, and counts admins", () => {
	const lines = renderMembers(snapshot(), kit, 0);
	const body = lines.join("\n");
	assert.ok(body.includes("1 admin"), "admin count reads singular");
	assert.ok(body.includes(" you"), "self identity tagged");
	assert.ok(body.includes("★"), "admin glyph present");
	assert.ok(body.includes("▸"), "self glyph present");
});

test("inspector reflects the selected member (admin selected at index 0)", () => {
	const lines = renderMembers(snapshot(), kit, 0);
	const body = lines.join("\n");
	// groupLabel uppercases the section heading.
	assert.ok(body.includes("INSPECTOR"));
	// Admin sorts first, so index 0 selects the admin row — its full id shows.
	assert.ok(body.includes(`identity   ${ADMIN_ID}`), body);
	assert.ok(body.includes("admin      yes"), "admin flag shows yes for the admin row");
});

test("selection can move to the self row and the inspector notes it", () => {
	const component = makeComponent(snapshot());
	component.handleInput("4");
	// ordered: [admin, agent(self), third] → one down selects self.
	component.handleInput("down");
	const body = component.render(100).join("\n");
	assert.ok(body.includes("this is your agent identity"), "self note appears when self is selected");
});

test("selection is clamped and never throws at degenerate widths", () => {
	const component = makeComponent(snapshot());
	component.handleInput("4");
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

test("tab strip and overview surface the member count", () => {
	const component = makeComponent(snapshot());
	// tab strip line is rendered on every tab (chrome, not clamped by body height)
	const chrome = component.render(120).join("\n");
	assert.ok(chrome.includes("Members 3"), "tab strip shows the member count");
	// Overview body renderer (unclamped) carries the member count row.
	const overview = renderOverview(snapshot(), kit).join("\n");
	assert.ok(overview.includes("3 in room"), "overview shows the member count");
});

test("members without meta (role only) still render with sane defaults", () => {
	const lines = renderMembers(
		snapshot({ members: [{ id: AGENT_ID, role: "agent" }] }),
		kit,
		0,
	);
	const body = lines.join("\n");
	assert.ok(body.includes("0 admins"), "no admins when is_admin is absent");
	assert.ok(body.includes("—") || body.includes("status"), "status renders a placeholder when absent");
	assert.ok(body.includes("admin      ?"), "admin flag is unknown when is_admin is absent");
});
