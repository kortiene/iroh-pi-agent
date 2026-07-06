/**
 * Configuration loading + resolution (SPEC §9, DESIGN §2).
 *
 * Resolution order per value: explicit argument > environment variable >
 * .iroh-room-pi.json (in cwd) > safe default. Everything fails closed with a
 * clear error: malformed JSON, wrong types, bad room ids, missing binary.
 *
 * This module must stay free of pi imports so tests can load it directly.
 * `env` and `cwd` are always injected for testability.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CONFIG_FILE_NAME, IDENTITY_ID_RE, ROOM_ID_RE } from "./constants.js";

export type Env = Record<string, string | undefined>;

export interface ResolvedConfig {
	/** The cwd the config was resolved against (usually ctx.cwd). */
	cwd: string;
	/** Room id (blake3:<64-hex>) if configured. */
	roomId?: string;
	/** Absolute iroh-rooms home; when set, every CLI call passes --data-dir. */
	home?: string;
	/** Raw binary override (IROH_ROOMS_BIN / iroh_rooms_bin), unresolved. */
	binOverride?: string;
	/** Display name for this agent. */
	agentName?: string;
	/** Absolute artifact dir (extra containment root for iroh_file_share). */
	artifactDir?: string;
	/** Default --progress for agent.status when the caller passes none. */
	defaultProgress?: number;
	defaultPreviewHost: string;
	defaultPreviewPort: number;
	allowedPreviewMembers: string[];
	allowArtifactPathsOutsideWorkspace: boolean;
	/** Path of the config file actually read, if one was found. */
	configFilePath?: string;
}

interface RawConfigFile {
	room_id?: string;
	iroh_rooms_home?: string;
	iroh_rooms_bin?: string;
	agent_name?: string;
	artifact_dir?: string;
	default_progress?: number;
	default_preview_host?: string;
	default_preview_port?: number;
	allowed_preview_members?: string[];
	allow_artifact_paths_outside_workspace?: boolean;
}

function expectString(obj: Record<string, unknown>, key: string, file: string): string | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`${file}: "${key}" must be a string`);
	}
	return value;
}

function expectInteger(
	obj: Record<string, unknown>,
	key: string,
	file: string,
	min: number,
	max: number,
): number | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${file}: "${key}" must be an integer ${min}..=${max}`);
	}
	return value;
}

function expectBoolean(obj: Record<string, unknown>, key: string, file: string): boolean | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw new Error(`${file}: "${key}" must be a boolean`);
	}
	return value;
}

function expectStringArray(
	obj: Record<string, unknown>,
	key: string,
	file: string,
): string[] | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`${file}: "${key}" must be an array of strings`);
	}
	return value as string[];
}

/**
 * Read + type-validate .iroh-room-pi.json from cwd. A missing file is fine
 * (empty config); malformed JSON or wrong value types fail closed. Unknown
 * keys are ignored for forward compatibility.
 */
export function readConfigFile(cwd: string): { raw: RawConfigFile; filePath?: string } {
	const filePath = path.join(cwd, CONFIG_FILE_NAME);
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		// Only a genuinely absent file means "no config". Anything else
		// (EACCES, EISDIR, EIO, …) must fail closed, not silently drop the
		// project's room/home settings.
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return { raw: {} };
		}
		throw new Error(
			`${filePath} exists but could not be read (${code ?? (err instanceof Error ? err.message : String(err))}) — fix permissions or remove it`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(
			`${filePath} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — fix or remove it`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${filePath} must contain a JSON object`);
	}
	const obj = parsed as Record<string, unknown>;
	const raw: RawConfigFile = {
		room_id: expectString(obj, "room_id", filePath),
		iroh_rooms_home: expectString(obj, "iroh_rooms_home", filePath),
		iroh_rooms_bin: expectString(obj, "iroh_rooms_bin", filePath),
		agent_name: expectString(obj, "agent_name", filePath),
		artifact_dir: expectString(obj, "artifact_dir", filePath),
		default_progress: expectInteger(obj, "default_progress", filePath, 0, 100),
		default_preview_host: expectString(obj, "default_preview_host", filePath),
		default_preview_port: expectInteger(obj, "default_preview_port", filePath, 1, 65535),
		allowed_preview_members: expectStringArray(obj, "allowed_preview_members", filePath),
		allow_artifact_paths_outside_workspace: expectBoolean(
			obj,
			"allow_artifact_paths_outside_workspace",
			filePath,
		),
	};
	if (raw.room_id !== undefined && !ROOM_ID_RE.test(raw.room_id)) {
		throw new Error(`${filePath}: "room_id" must match blake3:<64-hex> (got ${JSON.stringify(raw.room_id)})`);
	}
	for (const member of raw.allowed_preview_members ?? []) {
		if (!IDENTITY_ID_RE.test(member)) {
			throw new Error(
				`${filePath}: "allowed_preview_members" entries must be 64-char lowercase hex identity ids (got ${JSON.stringify(member)})`,
			);
		}
	}
	return { raw, filePath };
}

/** Read an env var, treating empty strings as unset (mirrors the binary's IROH_ROOMS_HOME handling). */
function envValue(env: Env, name: string): string | undefined {
	const value = env[name];
	return value === undefined || value === "" ? undefined : value;
}

/**
 * Expand a leading `~`/`~/` to the home directory (JSON has no shell, so the
 * harness does it for iroh_rooms_home / iroh_rooms_bin / artifact_dir; mirrors
 * the worker's config semantics). Mid-path tildes are left alone.
 */
function expandTilde(value: string): string {
	if (value === "~") {
		return os.homedir();
	}
	if (value.startsWith("~/")) {
		return path.join(os.homedir(), value.slice(2));
	}
	return value;
}

function expandTildeOpt(value: string | undefined): string | undefined {
	return value === undefined ? undefined : expandTilde(value);
}

/** Resolve the full config from env + config file. Throws on any invalid value. */
export function resolveConfig(options: { cwd: string; env: Env }): ResolvedConfig {
	const { cwd, env } = options;
	const { raw, filePath } = readConfigFile(cwd);

	const envRoomId = envValue(env, "IROH_ROOM_ID");
	if (envRoomId !== undefined && !ROOM_ID_RE.test(envRoomId)) {
		throw new Error(`IROH_ROOM_ID must match blake3:<64-hex> (got ${JSON.stringify(envRoomId)})`);
	}
	const roomId = envRoomId ?? raw.room_id;

	const homeRaw = expandTildeOpt(envValue(env, "IROH_ROOMS_HOME") ?? raw.iroh_rooms_home);
	const home = homeRaw === undefined ? undefined : path.resolve(cwd, homeRaw);

	const binOverride = expandTildeOpt(envValue(env, "IROH_ROOMS_BIN") ?? raw.iroh_rooms_bin);
	const agentName = envValue(env, "IROH_ROOM_AGENT_NAME") ?? raw.agent_name;

	const artifactDirRaw = expandTildeOpt(envValue(env, "IROH_ROOM_ARTIFACT_DIR") ?? raw.artifact_dir);
	const artifactDir = artifactDirRaw === undefined ? undefined : path.resolve(cwd, artifactDirRaw);

	let defaultProgress = raw.default_progress;
	const envProgress = envValue(env, "IROH_ROOM_DEFAULT_PROGRESS");
	if (envProgress !== undefined) {
		if (!/^\d+$/.test(envProgress) || Number(envProgress) > 100) {
			throw new Error(
				`IROH_ROOM_DEFAULT_PROGRESS must be an integer 0..=100 (got ${JSON.stringify(envProgress)})`,
			);
		}
		defaultProgress = Number(envProgress);
	}

	let allowedPreviewMembers = raw.allowed_preview_members ?? [];
	const envMember = envValue(env, "IROH_ROOM_ALLOWED_PREVIEW_MEMBER");
	if (envMember !== undefined) {
		if (!IDENTITY_ID_RE.test(envMember)) {
			throw new Error(
				`IROH_ROOM_ALLOWED_PREVIEW_MEMBER must be a 64-char lowercase hex identity id (got ${JSON.stringify(envMember)})`,
			);
		}
		allowedPreviewMembers = [envMember];
	}

	const resolved: ResolvedConfig = {
		cwd,
		defaultPreviewHost: raw.default_preview_host ?? "127.0.0.1",
		defaultPreviewPort: raw.default_preview_port ?? 3000,
		allowedPreviewMembers,
		allowArtifactPathsOutsideWorkspace: raw.allow_artifact_paths_outside_workspace ?? false,
	};
	if (roomId !== undefined) resolved.roomId = roomId;
	if (home !== undefined) resolved.home = home;
	if (binOverride !== undefined) resolved.binOverride = binOverride;
	if (agentName !== undefined) resolved.agentName = agentName;
	if (artifactDir !== undefined) resolved.artifactDir = artifactDir;
	if (defaultProgress !== undefined) resolved.defaultProgress = defaultProgress;
	if (filePath !== undefined) resolved.configFilePath = filePath;
	return resolved;
}

/**
 * Resolve the room id for a call: explicit argument > configured value.
 * Fails closed when neither is present or the explicit value is malformed.
 */
export function resolveRoomId(config: ResolvedConfig, explicit?: string): string {
	if (explicit !== undefined && explicit !== "") {
		if (!ROOM_ID_RE.test(explicit)) {
			throw new Error(`room_id must match blake3:<64-hex> (got ${JSON.stringify(explicit)})`);
		}
		return explicit;
	}
	if (config.roomId !== undefined) {
		return config.roomId;
	}
	throw new Error(
		"no room_id configured — pass room_id explicitly, set IROH_ROOM_ID, or add \"room_id\" to .iroh-room-pi.json",
	);
}

/**
 * Resolve the iroh-rooms binary:
 * 1. IROH_ROOMS_BIN env / iroh_rooms_bin config (must exist and be a file;
 *    relative paths resolve against cwd),
 * 2. `iroh-rooms` found on PATH,
 * else fail closed with a message explaining all three options.
 */
export function resolveBinary(config: ResolvedConfig, env: Env): string {
	if (config.binOverride !== undefined) {
		const abs = path.resolve(config.cwd, config.binOverride);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(abs);
		} catch {
			throw new Error(`configured iroh-rooms binary does not exist: ${abs}`);
		}
		if (!stat.isFile()) {
			throw new Error(`configured iroh-rooms binary is not a file: ${abs}`);
		}
		return abs;
	}
	const pathVar = env.PATH ?? "";
	for (const dir of pathVar.split(path.delimiter)) {
		if (dir === "") {
			continue;
		}
		const candidate = path.join(dir, "iroh-rooms");
		try {
			if (fs.statSync(candidate).isFile()) {
				fs.accessSync(candidate, fs.constants.X_OK);
				return candidate;
			}
		} catch {
			// keep scanning
		}
	}
	throw new Error(
		"iroh-rooms binary not found — fix one of: " +
			"(1) set IROH_ROOMS_BIN=/path/to/iroh-rooms, " +
			'(2) set "iroh_rooms_bin" in .iroh-room-pi.json, ' +
			"(3) put iroh-rooms on your PATH",
	);
}
