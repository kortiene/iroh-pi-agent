/**
 * Input validation for every iroh-room tool/command (SPEC §10, DESIGN §3).
 *
 * All limits are BYTE limits (Buffer.byteLength), mirroring
 * iroh-rooms-core/src/event/constants.rs. Every validator either returns the
 * (possibly normalized) value or throws an Error with the exact reason —
 * fail closed, no partial sends.
 *
 * This module must stay free of pi imports so tests can load it directly.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	ARTIFACT_ID_RE,
	CONTROL_CHARS_RE,
	DEFAULT_TAIL_LIMIT,
	IDENTITY_ID_RE,
	LOOPBACK_TCP_RE,
	MAX_ARTIFACT_REFS,
	MAX_FILE_NAME_BYTES,
	MAX_LABEL_BYTES,
	MAX_MESSAGE_BODY_BYTES,
	MAX_MIME_TYPE_BYTES,
	MAX_SHARED_FILE_BYTES,
	MAX_STATUS_LABEL_BYTES,
	MAX_STATUS_MESSAGE_BYTES,
	MAX_TAIL_LIMIT,
	MIN_TAIL_LIMIT,
	PIPE_ID_RE,
} from "./constants.js";

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** agent.status label: required, 1..=64 bytes, no control chars, non-empty after trim. */
export function validateStatusLabel(label: unknown): string {
	if (typeof label !== "string") {
		throw new Error("status is required and must be a string");
	}
	if (label.trim().length === 0) {
		throw new Error("status must be non-empty (after trimming whitespace)");
	}
	if (byteLength(label) > MAX_STATUS_LABEL_BYTES) {
		throw new Error(
			`status label is ${byteLength(label)} bytes; the limit is ${MAX_STATUS_LABEL_BYTES} bytes (UTF-8)`,
		);
	}
	if (CONTROL_CHARS_RE.test(label)) {
		throw new Error("status label must not contain control characters");
	}
	return label;
}

/** agent.status message: optional, <=4096 bytes. */
export function validateStatusMessage(message: unknown): string | undefined {
	if (message === undefined) {
		return undefined;
	}
	if (typeof message !== "string") {
		throw new Error("message must be a string");
	}
	if (byteLength(message) > MAX_STATUS_MESSAGE_BYTES) {
		throw new Error(
			`message is ${byteLength(message)} bytes; the limit is ${MAX_STATUS_MESSAGE_BYTES} bytes (UTF-8)`,
		);
	}
	return message;
}

/** progress: optional integer 0..=100 (floats and NaN rejected). */
export function validateProgress(progress: unknown): number | undefined {
	if (progress === undefined) {
		return undefined;
	}
	if (typeof progress !== "number" || !Number.isInteger(progress)) {
		throw new Error(`progress must be an integer 0..=100 (got ${String(progress)})`);
	}
	if (progress < 0 || progress > 100) {
		throw new Error(`progress must be between 0 and 100 (got ${progress})`);
	}
	return progress;
}

/** artifact_ids: optional, <=16 entries, each file_<32-hex> or bare 32-hex (passed through as given). */
export function validateArtifactIds(ids: unknown): string[] | undefined {
	if (ids === undefined) {
		return undefined;
	}
	if (!Array.isArray(ids)) {
		throw new Error("artifact_ids must be an array of file ids");
	}
	if (ids.length > MAX_ARTIFACT_REFS) {
		throw new Error(`artifact_ids has ${ids.length} entries; the limit is ${MAX_ARTIFACT_REFS}`);
	}
	for (const id of ids) {
		if (typeof id !== "string" || !ARTIFACT_ID_RE.test(id)) {
			throw new Error(
				`invalid artifact id ${JSON.stringify(id)}: expected file_<32-hex> or bare 32-hex`,
			);
		}
	}
	return ids as string[];
}

/** room message body: required, 1..=16384 bytes. */
export function validateMessageBody(body: unknown): string {
	if (typeof body !== "string") {
		throw new Error("message is required and must be a string");
	}
	if (body.length === 0) {
		throw new Error("message must be non-empty");
	}
	if (byteLength(body) > MAX_MESSAGE_BODY_BYTES) {
		throw new Error(
			`message is ${byteLength(body)} bytes; the limit is ${MAX_MESSAGE_BODY_BYTES} bytes (UTF-8)`,
		);
	}
	return body;
}

/**
 * pipe tcp target: exactly 127.0.0.1:<port> with port 1..=65535.
 * Stricter than the binary (which allows all of 127.0.0.0/8 + ::1) per SPEC §10.5.
 */
export function validateTcpTarget(tcp: unknown): string {
	if (typeof tcp !== "string" || tcp.length === 0) {
		throw new Error("tcp target is required, e.g. 127.0.0.1:3000");
	}
	const match = LOOPBACK_TCP_RE.exec(tcp);
	if (!match || match[1] === undefined) {
		throw new Error(
			`refusing pipe target ${JSON.stringify(tcp)}: only 127.0.0.1:<port> is allowed — ` +
				"no 0.0.0.0, no [::1], no LAN or public IPs, no hostnames, no unix sockets",
		);
	}
	const port = Number(match[1]);
	if (port < 1 || port > 65535) {
		throw new Error(`invalid tcp port ${match[1]}: must be 1..=65535`);
	}
	return tcp;
}

/** pipe allow list: required, non-empty, each a 64-hex identity id (no default-all). */
export function validateAllowList(allow: unknown): string[] {
	if (!Array.isArray(allow) || allow.length === 0) {
		throw new Error(
			"allow must be a non-empty array of member identity ids (64-hex) — pipes have no default-all",
		);
	}
	for (const id of allow) {
		if (typeof id !== "string" || !IDENTITY_ID_RE.test(id)) {
			throw new Error(
				`invalid allow entry ${JSON.stringify(id)}: expected a 64-char lowercase hex identity id`,
			);
		}
	}
	return allow as string[];
}

/** ttl_seconds: optional positive integer (becomes `--expires <n>s`). */
export function validateTtlSeconds(ttl: unknown): number | undefined {
	if (ttl === undefined) {
		return undefined;
	}
	if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl <= 0) {
		throw new Error(`ttl_seconds must be a positive integer (got ${String(ttl)})`);
	}
	return ttl;
}

/** pipe id: bare 32-hex. */
export function validatePipeId(pipeId: unknown): string {
	if (typeof pipeId !== "string" || !PIPE_ID_RE.test(pipeId)) {
		throw new Error(`invalid pipe_id ${JSON.stringify(pipeId)}: expected 32 lowercase hex chars`);
	}
	return pipeId;
}

/** file name override: optional, <=255 bytes, no control chars. */
export function validateFileName(name: unknown): string | undefined {
	return validateShortText(name, "name", MAX_FILE_NAME_BYTES);
}

/** mime override: optional, <=255 bytes, no control chars. */
export function validateMime(mime: unknown): string | undefined {
	return validateShortText(mime, "mime", MAX_MIME_TYPE_BYTES);
}

/** pipe label: optional, <=255 bytes, no control chars. */
export function validateLabel(label: unknown): string | undefined {
	return validateShortText(label, "label", MAX_LABEL_BYTES);
}

function validateShortText(value: unknown, what: string, maxBytes: number): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${what} must be a non-empty string when provided`);
	}
	if (byteLength(value) > maxBytes) {
		throw new Error(`${what} is ${byteLength(value)} bytes; the limit is ${maxBytes} bytes (UTF-8)`);
	}
	if (CONTROL_CHARS_RE.test(value)) {
		throw new Error(`${what} must not contain control characters`);
	}
	return value;
}

/** tail limit: default 50, clamped into 1..=500; non-numbers rejected. */
export function clampTailLimit(limit: unknown): number {
	if (limit === undefined) {
		return DEFAULT_TAIL_LIMIT;
	}
	if (typeof limit !== "number" || !Number.isFinite(limit)) {
		throw new Error(`limit must be a number (got ${String(limit)})`);
	}
	const n = Math.trunc(limit);
	return Math.min(MAX_TAIL_LIMIT, Math.max(MIN_TAIL_LIMIT, n));
}

export interface ArtifactPathOptions {
	/** Workspace root (the Pi session cwd). */
	cwd: string;
	/** Optional configured artifact dir (absolute); also allowed as a containment root. */
	artifactDir?: string;
	/** Config escape hatch: allow_artifact_paths_outside_workspace. */
	allowOutside?: boolean;
	/** Override for tests; defaults to the 100 MiB protocol cap. */
	maxBytes?: number;
}

/**
 * Artifact path: must exist, be a regular file, be <=100 MiB, and (unless
 * allowOutside) resolve — through symlinks — to inside the workspace cwd or
 * the configured artifact dir. Returns the real (symlink-resolved) absolute
 * path, which is what gets passed to the CLI.
 */
export function validateArtifactPath(filePath: unknown, options: ArtifactPathOptions): string {
	if (typeof filePath !== "string" || filePath.length === 0) {
		throw new Error("path is required and must be a non-empty string");
	}
	const abs = path.resolve(options.cwd, filePath);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(abs);
	} catch {
		throw new Error(`artifact path does not exist: ${abs}`);
	}
	if (!stat.isFile()) {
		throw new Error(`artifact path is not a regular file: ${abs}`);
	}
	const maxBytes = options.maxBytes ?? MAX_SHARED_FILE_BYTES;
	if (stat.size > maxBytes) {
		throw new Error(
			`artifact file is ${stat.size} bytes; the share limit is ${maxBytes} bytes (100 MiB by default)`,
		);
	}
	const real = fs.realpathSync(abs);
	if (!options.allowOutside) {
		const roots: string[] = [fs.realpathSync(options.cwd)];
		if (options.artifactDir !== undefined) {
			try {
				roots.push(fs.realpathSync(path.resolve(options.cwd, options.artifactDir)));
			} catch {
				// artifact dir does not exist — it grants no extra containment root
			}
		}
		const contained = roots.some((root) => real === root || real.startsWith(root + path.sep));
		if (!contained) {
			throw new Error(
				`artifact path resolves outside the workspace: ${real} — set ` +
					`"allow_artifact_paths_outside_workspace": true in .iroh-room-pi.json to permit this`,
			);
		}
	}
	return real;
}
