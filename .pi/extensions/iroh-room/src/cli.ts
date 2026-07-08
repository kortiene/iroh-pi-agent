/**
 * iroh-rooms CLI integration (SPEC.md §8/§10):
 * - pure argv builders (no shell, ever),
 * - pure stdout/stderr parsers pinned to the CLI's labeled `key: value`
 *   formats and single-line JSON outputs (see research-cli §3),
 * - a thin runner that takes an injected exec function (pi.exec-compatible),
 *   so tools pass pi.exec and tests pass a stub.
 *
 * The pure parts of this module must stay free of pi imports so tests can
 * load it directly.
 */

import { DEFAULT_TAIL_LIMIT, EXEC_TIMEOUT_MS } from "./constants.js";

/* ------------------------------------------------------------------ */
/* argv builders                                                       */
/*                                                                     */
/* Uniform convention (verified against the real binary): subcommand   */
/* words first, every option in EQUALS form (--message=<m>), then a    */
/* literal "--", then all positionals (ROOM, STATUS, MESSAGE, PATH,    */
/* PIPE_ID). The "--" end-of-options separator makes clap treat        */
/* leading-hyphen values ("- bullet list", "--help") as literal        */
/* positionals instead of flags; equals form does the same for option  */
/* values.                                                             */
/* ------------------------------------------------------------------ */

export function buildStatusArgs(input: {
	room: string;
	status: string;
	message?: string;
	progress?: number;
	artifactIds?: string[];
}): string[] {
	const args = ["agent", "status"];
	if (input.message !== undefined) {
		args.push(`--message=${input.message}`);
	}
	if (input.progress !== undefined) {
		args.push(`--progress=${String(input.progress)}`);
	}
	for (const id of input.artifactIds ?? []) {
		args.push(`--artifact=${id}`);
	}
	args.push("--", input.room, input.status);
	return args;
}

export function buildSendArgs(input: { room: string; message: string }): string[] {
	return ["room", "send", "--", input.room, input.message];
}

export function buildTailArgs(input: { room: string; limit?: number }): string[] {
	return [
		"room",
		"tail",
		"--offline",
		"--json",
		`--limit=${String(input.limit ?? DEFAULT_TAIL_LIMIT)}`,
		"--",
		input.room,
	];
}

export function buildShareArgs(input: {
	room: string;
	path: string;
	name?: string;
	mime?: string;
}): string[] {
	const args = ["file", "share"];
	if (input.name !== undefined) {
		args.push(`--name=${input.name}`);
	}
	if (input.mime !== undefined) {
		args.push(`--mime=${input.mime}`);
	}
	args.push("--", input.room, input.path);
	return args;
}

export function buildExposeArgs(input: {
	room: string;
	tcp: string;
	allow: string[];
	label?: string;
	ttlSeconds?: number;
}): string[] {
	const args = ["pipe", "expose", `--tcp=${input.tcp}`];
	for (const id of input.allow) {
		args.push(`--allow=${id}`);
	}
	if (input.label !== undefined) {
		args.push(`--label=${input.label}`);
	}
	if (input.ttlSeconds !== undefined) {
		args.push(`--expires=${input.ttlSeconds}s`);
	}
	args.push("--", input.room);
	return args;
}

export function buildCloseArgs(input: { pipeId: string }): string[] {
	return ["pipe", "close", "--", input.pipeId];
}

export function buildMembersArgs(input: { room: string }): string[] {
	return ["room", "members", "--json", "--", input.room];
}

export function buildFileListArgs(input: { room: string }): string[] {
	return ["file", "list", "--json", "--", input.room];
}

export function buildPipeListArgs(input: { room: string }): string[] {
	return ["pipe", "list", "--", input.room];
}

export function buildWhoamiArgs(): string[] {
	// No positionals, so no "--" separator is needed.
	return ["identity", "show", "--json"];
}

/**
 * Prepend the global --data-dir flag (equals form, before the subcommand;
 * verified against the real binary) when a home dir is configured.
 */
export function withDataDir(home: string | undefined, args: string[]): string[] {
	return home === undefined ? args : [`--data-dir=${home}`, ...args];
}

/* ------------------------------------------------------------------ */
/* stdout / stderr parsers                                             */
/* ------------------------------------------------------------------ */

const STATUS_EVENT_RE = /^status:\s*(blake3:[0-9a-f]{64})/m;
const SENT_EVENT_RE = /^sent:\s*(blake3:[0-9a-f]{64})/m;
const FILE_ID_RE = /^file_id:\s*(file_[0-9a-f]{32})/m;
const SHARE_EVENT_RE = /^event:\s*(blake3:[0-9a-f]{64})/m;
const PIPE_ID_LINE_RE = /^pipe_id:\s*([0-9a-f]{32})/m;
const CONNECT_HINT_RE = /^connectors run:\s*(.+)$/m;
const CODED_ERROR_RE = /^error\[([a-z_]+)\]:\s*(.*)$/m;

export function parseStatusEventId(stdout: string): string | undefined {
	return STATUS_EVENT_RE.exec(stdout)?.[1];
}

export function parseSendEventId(stdout: string): string | undefined {
	return SENT_EVENT_RE.exec(stdout)?.[1];
}

export function parseShareOutput(stdout: string): { fileId?: string; eventId?: string } {
	const result: { fileId?: string; eventId?: string } = {};
	const fileId = FILE_ID_RE.exec(stdout)?.[1];
	const eventId = SHARE_EVENT_RE.exec(stdout)?.[1];
	if (fileId !== undefined) result.fileId = fileId;
	if (eventId !== undefined) result.eventId = eventId;
	return result;
}

export function parsePipeId(stdout: string): string | undefined {
	return PIPE_ID_LINE_RE.exec(stdout)?.[1];
}

export function parseConnectHint(stdout: string): string | undefined {
	return CONNECT_HINT_RE.exec(stdout)?.[1]?.trim();
}

/** `error[<code>]: <detail>` lines on stderr (exit codes 1..6, see docs). */
export function parseCodedError(stderr: string): { code: string; detail: string } | undefined {
	const match = CODED_ERROR_RE.exec(stderr);
	if (!match || match[1] === undefined) {
		return undefined;
	}
	return { code: match[1], detail: (match[2] ?? "").trim() };
}

/** Parse a single-line JSON payload (identity show --json, room members --json, file list --json). */
export function parseJsonLine<T>(stdout: string, what: string): T {
	try {
		return JSON.parse(stdout.trim()) as T;
	} catch (err) {
		throw new Error(
			`could not parse ${what} JSON output: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * A row of `room tail --offline --json`. Stable fields are typed; all
 * type-specific content fields are flattened onto the row and passed through
 * verbatim — never throw on unknown event types or missing fields.
 */
export interface TailRow {
	event_id?: string;
	event_type?: string;
	lamport?: number;
	admin_seq?: number;
	created_at?: number;
	at?: string;
	from?: string;
	display_name?: string;
	role?: string;
	status?: string;
	[key: string]: unknown;
}

export function parseTailJson(stdout: string): TailRow[] {
	const trimmed = stdout.trim();
	const start = trimmed.indexOf("[");
	if (start === -1) {
		throw new Error("could not parse `room tail --offline --json` output: no JSON array found");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed.slice(start));
	} catch (err) {
		throw new Error(
			`could not parse \`room tail --offline --json\` output: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!Array.isArray(parsed)) {
		throw new Error("could not parse `room tail --offline --json` output: expected a JSON array");
	}
	return parsed.filter((row): row is TailRow => row !== null && typeof row === "object");
}

/* ------------------------------------------------------------------ */
/* tail snapshot mapping                                               */
/* ------------------------------------------------------------------ */

export interface SnapshotEvent {
	event_id: string;
	type: string;
	/** Protocol currency (logical clock); carried for ordering (M2 divider). */
	lamport?: number;
	author?: string;
	timestamp?: string;
	summary: string;
}

export interface TailSnapshot {
	events: SnapshotEvent[];
	summary: string;
}

const MAX_BODY_SUMMARY_CHARS = 160;

function truncateChars(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function shortId(value: unknown): string {
	const s = asString(value);
	return s === undefined ? "?" : s.slice(0, 8);
}

/** One human line per event row (per-type rules from docs/pi-harness.md). */
export function summarizeTailRow(row: TailRow): string {
	const type = row.event_type ?? "unknown";
	switch (type) {
		case "message.text": {
			const body = asString(row.body) ?? "";
			return truncateChars(body.replace(/\s+/g, " ").trim(), MAX_BODY_SUMMARY_CHARS);
		}
		case "agent.status": {
			const parts = [`state=${asString(row.state) ?? "?"}`];
			if (typeof row.progress === "number") {
				parts.push(`progress=${row.progress}%`);
			}
			const message = asString(row.message);
			if (message !== undefined && message !== "") {
				parts.push(truncateChars(message, MAX_BODY_SUMMARY_CHARS));
			}
			return parts.join(" ");
		}
		case "file.shared": {
			const name = asString(row.file_name) ?? "?";
			const size = typeof row.size_bytes === "number" ? row.size_bytes : "?";
			return `shared ${name} (${size} bytes)`;
		}
		case "pipe.opened": {
			const label = asString(row.label);
			return `pipe ${asString(row.pipe_id) ?? "?"} opened${label !== undefined ? ` (${label})` : ""}`;
		}
		case "pipe.closed": {
			const reason = asString(row.reason);
			return `pipe ${asString(row.pipe_id) ?? "?"} closed${reason !== undefined ? ` (${reason})` : ""}`;
		}
		case "member.invited":
			return `invited ${shortId(row.invitee)} as ${asString(row.invited_role) ?? "member"}`;
		case "member.joined":
			return `joined as ${asString(row.joined_role) ?? "member"}`;
		case "member.left":
			return "left the room";
		case "member.removed":
			return `removed ${shortId(row.subject)}`;
		case "room.created":
			return "room created";
		default:
			return type;
	}
}

/**
 * Map tail rows into the compact snapshot the model sees: filtered events
 * plus one overall summary line (counts by type, last activity, latest
 * agent.status).
 */
export function snapshotFromRows(
	rows: TailRow[],
	options: { includeAgentStatus?: boolean; includeFiles?: boolean } = {},
): TailSnapshot {
	const includeAgentStatus = options.includeAgentStatus ?? true;
	const includeFiles = options.includeFiles ?? true;

	const filtered = rows.filter((row) => {
		if (!includeAgentStatus && row.event_type === "agent.status") return false;
		if (!includeFiles && row.event_type === "file.shared") return false;
		return true;
	});

	const events: SnapshotEvent[] = filtered.map((row) => {
		const event: SnapshotEvent = {
			event_id: row.event_id ?? "?",
			type: row.event_type ?? "unknown",
			summary: summarizeTailRow(row),
		};
		if (typeof row.lamport === "number") event.lamport = row.lamport;
		const author = row.display_name ?? row.from;
		if (author !== undefined) event.author = author;
		if (row.at !== undefined) event.timestamp = row.at;
		return event;
	});

	const counts = new Map<string, number>();
	for (const row of rows) {
		const type = row.event_type ?? "unknown";
		counts.set(type, (counts.get(type) ?? 0) + 1);
	}
	const countText = [...counts.entries()].map(([type, n]) => `${type}×${n}`).join(", ");

	const parts: string[] = [`${rows.length} events${countText === "" ? "" : ` (${countText})`}`];
	const lastRow = rows[rows.length - 1];
	if (lastRow?.at !== undefined) {
		parts.push(`last activity ${lastRow.at}`);
	}
	const latestStatus = [...rows].reverse().find((row) => row.event_type === "agent.status");
	if (latestStatus !== undefined) {
		const author = latestStatus.display_name ?? latestStatus.from ?? "?";
		parts.push(`latest status: ${summarizeTailRow(latestStatus)} by ${author}`);
	}
	return { events, summary: parts.join(" · ") };
}

/* ------------------------------------------------------------------ */
/* command tokenizing (slash-command args)                             */
/* ------------------------------------------------------------------ */

/** Split a raw slash-command args string into tokens; "double quotes" group words. */
export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuotes = false;
	let started = false;
	for (const ch of input) {
		if (ch === '"') {
			inQuotes = !inQuotes;
			started = true;
			continue;
		}
		if (!inQuotes && /\s/.test(ch)) {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += ch;
		started = true;
	}
	if (started) {
		tokens.push(current);
	}
	return tokens;
}

/* ------------------------------------------------------------------ */
/* runner                                                              */
/* ------------------------------------------------------------------ */

export interface ExecResultLike {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/** Signature-compatible with pi.exec(command, args, options). */
export type ExecFn = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<ExecResultLike>;

export interface CliRunResult {
	ok: boolean;
	code: number;
	stdout: string;
	stderr: string;
	errorCode?: string;
	errorDetail?: string;
}

/**
 * Run one iroh-rooms invocation. Nonzero exit is NOT an exception — it comes
 * back as { ok: false } with any coded error decoded, so tools can return the
 * structured failure envelope. Local failures (spawn errors, timeouts) throw.
 */
export async function runCli(
	exec: ExecFn,
	bin: string,
	args: string[],
	options: { home?: string; signal?: AbortSignal; timeoutMs?: number; cwd?: string } = {},
): Promise<CliRunResult> {
	const fullArgs = withDataDir(options.home, args);
	const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_MS;
	let result: ExecResultLike;
	try {
		const execOptions: { signal?: AbortSignal; timeout?: number; cwd?: string } = { timeout: timeoutMs };
		if (options.signal !== undefined) execOptions.signal = options.signal;
		if (options.cwd !== undefined) execOptions.cwd = options.cwd;
		result = await exec(bin, fullArgs, execOptions);
	} catch (err) {
		throw new Error(
			`failed to run ${bin} ${fullArgs.join(" ")}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (result.killed) {
		throw new Error(
			`iroh-rooms did not finish within ${timeoutMs}ms (killed): ${bin} ${fullArgs.join(" ")}`,
		);
	}
	const run: CliRunResult = {
		ok: result.code === 0,
		code: result.code,
		stdout: result.stdout,
		stderr: result.stderr,
	};
	if (!run.ok) {
		const coded = parseCodedError(result.stderr);
		if (coded !== undefined) {
			run.errorCode = coded.code;
			run.errorDetail = coded.detail;
		}
	}
	return run;
}
