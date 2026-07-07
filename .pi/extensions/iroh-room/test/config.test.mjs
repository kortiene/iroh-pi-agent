import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import { loadExtension } from "./helpers.mjs";
import { IDENTITY_AGENT, ROOM_HEX, ROOM_ID } from "./fixtures.mjs";

const ext = await loadExtension();
const { resolveBinary, resolveConfig, resolveRoomId } = await ext.importModule("config");

const OTHER_ROOM_ID = `blake3:${"f".repeat(64)}`;
const cleanups = [ext.cleanup];
after(async () => {
	for (const cleanup of cleanups) await cleanup();
});

async function makeCwd(configJson) {
	const cwd = await mkdtemp(join(tmpdir(), "iroh-room-config-"));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	if (configJson !== undefined) {
		const text = typeof configJson === "string" ? configJson : JSON.stringify(configJson);
		await writeFile(join(cwd, ".iroh-room-pi.json"), text);
	}
	return cwd;
}

test("resolveConfig reads .iroh-room-pi.json and resolves relative paths against cwd", async () => {
	const cwd = await makeCwd({
		room_id: ROOM_ID,
		iroh_rooms_home: ".iroh/agent",
		agent_name: "pi-agent",
		artifact_dir: "artifacts",
		default_progress: 10,
		default_preview_host: "127.0.0.1",
		default_preview_port: 4000,
		allowed_preview_members: [IDENTITY_AGENT],
		allow_artifact_paths_outside_workspace: true,
		some_future_key: "ignored",
	});
	const cfg = resolveConfig({ cwd, env: {} });
	assert.equal(cfg.roomId, ROOM_ID);
	assert.equal(cfg.home, resolve(cwd, ".iroh/agent"));
	assert.equal(cfg.agentName, "pi-agent");
	assert.equal(cfg.artifactDir, resolve(cwd, "artifacts"));
	assert.equal(cfg.defaultProgress, 10);
	assert.equal(cfg.defaultPreviewHost, "127.0.0.1");
	assert.equal(cfg.defaultPreviewPort, 4000);
	assert.deepEqual(cfg.allowedPreviewMembers, [IDENTITY_AGENT]);
	assert.equal(cfg.allowArtifactPathsOutsideWorkspace, true);
	assert.equal(cfg.configFilePath, join(cwd, ".iroh-room-pi.json"));
});

test("resolveConfig defaults when no config file exists", async () => {
	const cwd = await makeCwd();
	const cfg = resolveConfig({ cwd, env: {} });
	assert.equal(cfg.roomId, undefined);
	assert.equal(cfg.home, undefined);
	assert.equal(cfg.defaultPreviewHost, "127.0.0.1");
	assert.equal(cfg.defaultPreviewPort, 3000);
	assert.deepEqual(cfg.allowedPreviewMembers, []);
	assert.equal(cfg.allowArtifactPathsOutsideWorkspace, false);
	assert.equal(cfg.configFilePath, undefined);
});

test("env vars override the config file", async () => {
	const cwd = await makeCwd({
		room_id: ROOM_ID,
		iroh_rooms_home: ".iroh/agent",
		agent_name: "from-file",
		default_progress: 10,
		allowed_preview_members: [IDENTITY_AGENT],
	});
	const envMember = "b".repeat(64);
	const cfg = resolveConfig({
		cwd,
		env: {
			IROH_ROOM_ID: OTHER_ROOM_ID,
			IROH_ROOMS_HOME: "/abs/home",
			IROH_ROOM_AGENT_NAME: "from-env",
			IROH_ROOM_DEFAULT_PROGRESS: "55",
			IROH_ROOM_ALLOWED_PREVIEW_MEMBER: envMember,
			IROH_ROOM_ARTIFACT_DIR: "out",
			IROH_ROOMS_BIN: "/somewhere/iroh-rooms",
		},
	});
	assert.equal(cfg.roomId, OTHER_ROOM_ID);
	assert.equal(cfg.home, "/abs/home");
	assert.equal(cfg.agentName, "from-env");
	assert.equal(cfg.defaultProgress, 55);
	assert.deepEqual(cfg.allowedPreviewMembers, [envMember]);
	assert.equal(cfg.artifactDir, resolve(cwd, "out"));
	assert.equal(cfg.binOverride, "/somewhere/iroh-rooms");
});

test("empty env strings are treated as unset", async () => {
	const cwd = await makeCwd({ room_id: ROOM_ID });
	const cfg = resolveConfig({ cwd, env: { IROH_ROOM_ID: "", IROH_ROOMS_HOME: "" } });
	assert.equal(cfg.roomId, ROOM_ID);
	assert.equal(cfg.home, undefined);
});

test("existing but unreadable config file fails closed (only ENOENT means absent)", async (t) => {
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		t.skip("running as root — chmod 000 does not block reads");
		return;
	}
	const cwd = await makeCwd({ room_id: ROOM_ID });
	const filePath = join(cwd, ".iroh-room-pi.json");
	await chmod(filePath, 0o000);
	try {
		assert.throws(
			() => resolveConfig({ cwd, env: {} }),
			/\.iroh-room-pi\.json exists but could not be read \(EACCES\) — fix permissions or remove it/,
		);
	} finally {
		await chmod(filePath, 0o644);
	}
});

test("malformed JSON fails closed, naming the file", async () => {
	const cwd = await makeCwd("{ not json ");
	assert.throws(() => resolveConfig({ cwd, env: {} }), /\.iroh-room-pi\.json.*not valid JSON/s);
});

test("non-object JSON fails closed", async () => {
	const cwd = await makeCwd("[1,2,3]");
	assert.throws(() => resolveConfig({ cwd, env: {} }), /must contain a JSON object/);
});

test("wrong value types fail closed, naming the key", async () => {
	const cwd = await makeCwd({ room_id: 42 });
	assert.throws(() => resolveConfig({ cwd, env: {} }), /"room_id" must be a string/);
	const cwd2 = await makeCwd({ default_progress: "10" });
	assert.throws(() => resolveConfig({ cwd: cwd2, env: {} }), /"default_progress" must be an integer/);
	const cwd3 = await makeCwd({ allowed_preview_members: "not-an-array" });
	assert.throws(() => resolveConfig({ cwd: cwd3, env: {} }), /"allowed_preview_members" must be an array/);
	const cwd4 = await makeCwd({ allow_artifact_paths_outside_workspace: "yes" });
	assert.throws(
		() => resolveConfig({ cwd: cwd4, env: {} }),
		/"allow_artifact_paths_outside_workspace" must be a boolean/,
	);
});

test("bad room ids fail closed (file and env)", async () => {
	const cwd = await makeCwd({ room_id: "room_123" });
	assert.throws(() => resolveConfig({ cwd, env: {} }), /room_id.*blake3/);
	const cwd2 = await makeCwd();
	assert.throws(
		() => resolveConfig({ cwd: cwd2, env: { IROH_ROOM_ID: ROOM_HEX } }),
		/IROH_ROOM_ID must match blake3/,
	);
});

test("bad IROH_ROOM_DEFAULT_PROGRESS fails closed", async () => {
	const cwd = await makeCwd();
	assert.throws(
		() => resolveConfig({ cwd, env: { IROH_ROOM_DEFAULT_PROGRESS: "150" } }),
		/IROH_ROOM_DEFAULT_PROGRESS/,
	);
	assert.throws(
		() => resolveConfig({ cwd, env: { IROH_ROOM_DEFAULT_PROGRESS: "abc" } }),
		/IROH_ROOM_DEFAULT_PROGRESS/,
	);
});

test("bad IROH_ROOM_ALLOWED_PREVIEW_MEMBER fails closed", async () => {
	const cwd = await makeCwd();
	assert.throws(
		() => resolveConfig({ cwd, env: { IROH_ROOM_ALLOWED_PREVIEW_MEMBER: "not-hex" } }),
		/IROH_ROOM_ALLOWED_PREVIEW_MEMBER/,
	);
});

test("bad allowed_preview_members entries fail closed", async () => {
	const cwd = await makeCwd({ allowed_preview_members: ["nope"] });
	assert.throws(() => resolveConfig({ cwd, env: {} }), /allowed_preview_members/);
});

test("resolveRoomId: explicit beats config; malformed explicit rejected; neither fails closed", async () => {
	const cwd = await makeCwd({ room_id: ROOM_ID });
	const cfg = resolveConfig({ cwd, env: {} });
	assert.equal(resolveRoomId(cfg, OTHER_ROOM_ID), OTHER_ROOM_ID);
	assert.equal(resolveRoomId(cfg), ROOM_ID);
	assert.throws(() => resolveRoomId(cfg, "blake3:short"), /room_id must match blake3/);
	const emptyCfg = resolveConfig({ cwd: await makeCwd(), env: {} });
	assert.throws(() => resolveRoomId(emptyCfg), /no room_id configured.*IROH_ROOM_ID/s);
});

test("resolveBinary: override must exist and be a file; relative resolves against cwd", async () => {
	const cwd = await makeCwd();
	await writeFile(join(cwd, "fake-bin"), "#!/bin/sh\n");
	await chmod(join(cwd, "fake-bin"), 0o755);
	const cfg = resolveConfig({ cwd, env: { IROH_ROOMS_BIN: "fake-bin" } });
	assert.equal(resolveBinary(cfg, {}), join(cwd, "fake-bin"));

	const missing = resolveConfig({ cwd, env: { IROH_ROOMS_BIN: "no-such-bin" } });
	assert.throws(() => resolveBinary(missing, {}), /does not exist/);

	await mkdir(join(cwd, "a-dir"));
	const dir = resolveConfig({ cwd, env: { IROH_ROOMS_BIN: "a-dir" } });
	assert.throws(() => resolveBinary(dir, {}), /not a file/);
});

test("resolveBinary: falls back to PATH scan, else fails closed with all three options", async () => {
	const cwd = await makeCwd();
	const binDir = await mkdtemp(join(tmpdir(), "iroh-room-bin-"));
	cleanups.push(() => rm(binDir, { recursive: true, force: true }));
	await writeFile(join(binDir, "iroh-rooms"), "#!/bin/sh\necho iroh-rooms 0.1.0\n");
	await chmod(join(binDir, "iroh-rooms"), 0o755);
	const cfg = resolveConfig({ cwd, env: {} });
	assert.equal(resolveBinary(cfg, { PATH: `/nonexistent:${binDir}` }), join(binDir, "iroh-rooms"));
	assert.throws(
		() => resolveBinary(cfg, { PATH: "/nonexistent" }),
		/IROH_ROOMS_BIN.*iroh_rooms_bin.*PATH/s,
	);
});

test("room_label: file + env precedence, trimming, empty means unset", async () => {
	const cwd = await makeCwd({ room_id: ROOM_ID, room_label: "  demo room  " });
	assert.equal(resolveConfig({ cwd, env: {} }).roomLabel, "demo room");
	// env beats file
	assert.equal(resolveConfig({ cwd, env: { IROH_ROOM_LABEL: "env-label" } }).roomLabel, "env-label");
	// empty env string means unset (falls back to the file value)
	assert.equal(resolveConfig({ cwd, env: { IROH_ROOM_LABEL: "" } }).roomLabel, "demo room");
	// whitespace-only file value means unset
	const blank = await makeCwd({ room_label: "   " });
	assert.equal(resolveConfig({ cwd: blank, env: {} }).roomLabel, undefined);
	// absent everywhere means unset
	const none = await makeCwd({ room_id: ROOM_ID });
	assert.equal(resolveConfig({ cwd: none, env: {} }).roomLabel, undefined);
});

test("room_label longer than 32 chars (after trim) fails closed, file and env", async () => {
	const long = "x".repeat(33);
	const cwd = await makeCwd({ room_label: long });
	assert.throws(() => resolveConfig({ cwd, env: {} }), /"room_label".*32 characters/s);
	const cwd2 = await makeCwd();
	assert.throws(
		() => resolveConfig({ cwd: cwd2, env: { IROH_ROOM_LABEL: long } }),
		/IROH_ROOM_LABEL.*32 characters/s,
	);
	// a bad FILE value fails closed even when env overrides it (room_id semantics)
	assert.throws(() => resolveConfig({ cwd, env: { IROH_ROOM_LABEL: "fine" } }), /"room_label"/);
	// wrong type names the key
	const cwd3 = await makeCwd({ room_label: 42 });
	assert.throws(() => resolveConfig({ cwd: cwd3, env: {} }), /"room_label" must be a string/);
	// exactly 32 chars is accepted
	const cwd4 = await makeCwd({ room_label: "y".repeat(32) });
	assert.equal(resolveConfig({ cwd: cwd4, env: {} }).roomLabel, "y".repeat(32));
});

test("pulse_density: file + env precedence over the four valid values; empty env means unset", async () => {
	const cwd = await makeCwd({ pulse_density: "pill" });
	assert.equal(resolveConfig({ cwd, env: {} }).pulseDensity, "pill");
	assert.equal(
		resolveConfig({ cwd, env: { IROH_ROOM_PULSE_DENSITY: "off" } }).pulseDensity,
		"off",
	);
	assert.equal(resolveConfig({ cwd, env: { IROH_ROOM_PULSE_DENSITY: "" } }).pulseDensity, "pill");
	for (const density of ["off", "pill", "1", "2"]) {
		const each = await makeCwd({ pulse_density: density });
		assert.equal(resolveConfig({ cwd: each, env: {} }).pulseDensity, density);
	}
	const none = await makeCwd();
	assert.equal(resolveConfig({ cwd: none, env: {} }).pulseDensity, undefined);
});

test("invalid pulse_density fails closed, file and env, naming the valid values", async () => {
	const cwd = await makeCwd({ pulse_density: "3" });
	assert.throws(() => resolveConfig({ cwd, env: {} }), /"pulse_density" must be one of off, pill, 1, 2/);
	const cwd2 = await makeCwd();
	assert.throws(
		() => resolveConfig({ cwd: cwd2, env: { IROH_ROOM_PULSE_DENSITY: "dense" } }),
		/IROH_ROOM_PULSE_DENSITY must be one of off, pill, 1, 2/,
	);
	// a bad FILE value fails closed even when env overrides it
	assert.throws(() => resolveConfig({ cwd, env: { IROH_ROOM_PULSE_DENSITY: "2" } }), /"pulse_density"/);
	const cwd3 = await makeCwd({ pulse_density: 2 });
	assert.throws(() => resolveConfig({ cwd: cwd3, env: {} }), /"pulse_density" must be a string/);
});

test("leading ~ is expanded for home, bin, and artifact dir (env and file), not mid-path", async () => {
	const { homedir } = await import("node:os");
	const home = homedir();

	// file values
	const cwd = await makeCwd({
		iroh_rooms_home: "~/rooms-home",
		iroh_rooms_bin: "~/bin/iroh-rooms",
		artifact_dir: "~",
	});
	const cfg = resolveConfig({ cwd, env: {} });
	assert.equal(cfg.home, join(home, "rooms-home"));
	assert.equal(cfg.binOverride, join(home, "bin", "iroh-rooms"));
	assert.equal(cfg.artifactDir, home);

	// env values beat file values and expand too
	const cfg2 = resolveConfig({
		cwd,
		env: { IROH_ROOMS_HOME: "~/env-home", IROH_ROOMS_BIN: "~/env-bin", IROH_ROOM_ARTIFACT_DIR: "~/env-artifacts" },
	});
	assert.equal(cfg2.home, join(home, "env-home"));
	assert.equal(cfg2.binOverride, join(home, "env-bin"));
	assert.equal(cfg2.artifactDir, join(home, "env-artifacts"));

	// a tilde that is not a leading ~/ segment is NOT expanded
	const cwd3 = await makeCwd({ iroh_rooms_home: "a/~b" });
	const cfg3 = resolveConfig({ cwd: cwd3, env: {} });
	assert.equal(cfg3.home, resolve(cwd3, "a/~b"));
});
