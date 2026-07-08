/**
 * iroh-rooms CLI integration: argv builders, stdout/stderr parsers, secret
 * redaction, and a thin synchronous runner.
 *
 * Builders and parsers are PURE and mirror the CLI contract in SPEC.md §8/§10; the argv
 * shapes and stdout formats were confirmed against the iroh-rooms sources
 * (research-cli.md §2–§6). Builders validate their inputs against the
 * protocol limits documented in SPEC.md §10 and throw CliValidationError — fail closed,
 * never emit a partially-valid command.
 *
 * The runner (runIrohRooms) is a spawnSync wrapper returning the house
 * Captured shape ({ returncode, stdout, stderr }); it is intentionally thin
 * and is not unit-tested beyond command construction.
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { isAbsolute } from 'node:path';

// --- shared shapes -----------------------------------------------------------

/** Result shape mirroring the house exec.ts precedent (adw_sdlc/src/exec.ts). */
export interface Captured {
  returncode: number;
  stdout: string;
  stderr: string;
}

/** Per-invocation context: when dataDir is set, every command gets --data-dir. */
export interface CliContext {
  dataDir?: string;
}

/** Input validation failure — the command was never built or run. */
export class CliValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliValidationError';
  }
}

// --- validation limits (mirror iroh-rooms-core; SPEC.md §10) ------------------

export const MAX_STATUS_LABEL_BYTES = 64;
export const MAX_STATUS_MESSAGE_BYTES = 4096;
export const MAX_ARTIFACT_REFS = 16;
export const MAX_MESSAGE_BODY_BYTES = 16_384;
export const MAX_FILE_NAME_BYTES = 255;
export const MAX_MIME_TYPE_BYTES = 255;
export const MAX_TAIL_LIMIT = 500;

export const ROOM_ID_PATTERN = /^blake3:[0-9a-f]{64}$/;
export const EVENT_ID_PATTERN = /^blake3:[0-9a-f]{64}$/;
export const ARTIFACT_ID_PATTERN = /^(file_)?[0-9a-f]{32}$/;
export const PIPE_ID_PATTERN = /^[0-9a-f]{32}$/;
export const MEMBER_ID_PATTERN = /^[0-9a-f]{64}$/;
/** Stricter than the binary (127.0.0.0/8 + ::1): exactly 127.0.0.1, SPEC §10.5. */
export const LOOPBACK_TCP_PATTERN = /^127\.0\.0\.1:(\d{1,5})$/;

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function requireRoomId(roomId: string): string {
  if (!ROOM_ID_PATTERN.test(roomId)) {
    throw new CliValidationError(`room id must match blake3:<64 lowercase hex> (got "${roomId}")`);
  }
  return roomId;
}

function base(ctx: CliContext): string[] {
  if (ctx.dataDir === undefined) {
    return [];
  }
  if (!isAbsolute(ctx.dataDir)) {
    throw new CliValidationError(`--data-dir must be an absolute path (got "${ctx.dataDir}")`);
  }
  return [`--data-dir=${ctx.dataDir}`];
}

// --- argv builders (SPEC.md §8/§10; argv only, no shell, binary not included) ---
//
// Hardened argv convention (verified against iroh-rooms 0.1.0, see
// review-tmp/argv-check-worker): every option uses the equals form
// (--message=<v>) and a literal "--" terminates options before positionals,
// so untrusted values that start with "-" (a bullet-list message, a status
// label of "--help", a file named "-dash.md") can never be parsed as flags.

export interface AgentStatusInput {
  roomId: string;
  status: string;
  message?: string;
  progress?: number;
  artifactIds?: readonly string[];
}

export function buildAgentStatusArgs(ctx: CliContext, input: AgentStatusInput): string[] {
  requireRoomId(input.roomId);
  const status = input.status;
  if (status.trim() === '') {
    throw new CliValidationError('status label must be non-empty');
  }
  if (byteLength(status) > MAX_STATUS_LABEL_BYTES) {
    throw new CliValidationError(`status label must be at most ${MAX_STATUS_LABEL_BYTES} bytes`);
  }
  if (CONTROL_CHARS.test(status)) {
    throw new CliValidationError('status label must not contain control characters');
  }
  const args = [...base(ctx), 'agent', 'status'];
  if (input.message !== undefined) {
    if (byteLength(input.message) > MAX_STATUS_MESSAGE_BYTES) {
      throw new CliValidationError(`status message must be at most ${MAX_STATUS_MESSAGE_BYTES} bytes`);
    }
    args.push(`--message=${input.message}`);
  }
  if (input.progress !== undefined) {
    if (!Number.isInteger(input.progress) || input.progress < 0 || input.progress > 100) {
      throw new CliValidationError(`progress must be an integer 0..=100 (got ${input.progress})`);
    }
    args.push(`--progress=${input.progress}`);
  }
  if (input.artifactIds !== undefined) {
    if (input.artifactIds.length > MAX_ARTIFACT_REFS) {
      throw new CliValidationError(`at most ${MAX_ARTIFACT_REFS} artifact ids are allowed`);
    }
    for (const id of input.artifactIds) {
      if (!ARTIFACT_ID_PATTERN.test(id)) {
        throw new CliValidationError(`artifact id must be file_<32-hex> or bare 32-hex (got "${id}")`);
      }
      args.push(`--artifact=${id}`);
    }
  }
  args.push('--', input.roomId, status);
  return args;
}

export function buildRoomSendArgs(ctx: CliContext, input: { roomId: string; message: string }): string[] {
  requireRoomId(input.roomId);
  const bytes = byteLength(input.message);
  if (bytes < 1 || bytes > MAX_MESSAGE_BODY_BYTES) {
    throw new CliValidationError(
      `message body must be 1..=${MAX_MESSAGE_BODY_BYTES} bytes (got ${bytes})`,
    );
  }
  return [...base(ctx), 'room', 'send', '--', input.roomId, input.message];
}

export function buildRoomTailArgs(ctx: CliContext, input: { roomId: string; limit?: number }): string[] {
  requireRoomId(input.roomId);
  const requested = input.limit ?? 50;
  if (!Number.isInteger(requested)) {
    throw new CliValidationError(`tail limit must be an integer (got ${requested})`);
  }
  const limit = Math.min(Math.max(requested, 1), MAX_TAIL_LIMIT);
  return [...base(ctx), 'room', 'tail', '--offline', '--json', `--limit=${limit}`, '--', input.roomId];
}

export function buildFileShareArgs(
  ctx: CliContext,
  input: { roomId: string; path: string; name?: string; mime?: string },
): string[] {
  requireRoomId(input.roomId);
  if (!isAbsolute(input.path)) {
    throw new CliValidationError(`file share path must be absolute (got "${input.path}")`);
  }
  const args = [...base(ctx), 'file', 'share'];
  if (input.name !== undefined) {
    if (input.name === '' || byteLength(input.name) > MAX_FILE_NAME_BYTES) {
      throw new CliValidationError(`file name override must be 1..=${MAX_FILE_NAME_BYTES} bytes`);
    }
    args.push(`--name=${input.name}`);
  }
  if (input.mime !== undefined) {
    if (input.mime === '' || byteLength(input.mime) > MAX_MIME_TYPE_BYTES) {
      throw new CliValidationError(`mime override must be 1..=${MAX_MIME_TYPE_BYTES} bytes`);
    }
    args.push(`--mime=${input.mime}`);
  }
  args.push('--', input.roomId, input.path);
  return args;
}

export interface PipeExposeInput {
  roomId: string;
  tcp: string;
  allow: readonly string[];
  label?: string;
  ttlSeconds?: number;
}

export function buildPipeExposeArgs(ctx: CliContext, input: PipeExposeInput): string[] {
  requireRoomId(input.roomId);
  const match = LOOPBACK_TCP_PATTERN.exec(input.tcp);
  if (match === null) {
    throw new CliValidationError(
      `refusing pipe target "${input.tcp}": only 127.0.0.1:<port> is allowed ` +
        '(no 0.0.0.0, no [::1], no LAN/public IPs, no hostnames, no unix sockets)',
    );
  }
  const port = Number(match[1]);
  if (port < 1 || port > 65535) {
    throw new CliValidationError(`refusing pipe target "${input.tcp}": port must be 1..=65535`);
  }
  if (input.allow.length === 0) {
    throw new CliValidationError('pipe expose requires a non-empty allow list (no default-all)');
  }
  const args = [...base(ctx), 'pipe', 'expose', `--tcp=${input.tcp}`];
  for (const member of input.allow) {
    if (!MEMBER_ID_PATTERN.test(member)) {
      throw new CliValidationError(
        `allow entry must be a 64-char lowercase hex identity id (got "${member}")`,
      );
    }
    args.push(`--allow=${member}`);
  }
  if (input.label !== undefined) {
    args.push(`--label=${input.label}`);
  }
  if (input.ttlSeconds !== undefined) {
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
      throw new CliValidationError(`ttl_seconds must be a positive integer (got ${input.ttlSeconds})`);
    }
    args.push(`--expires=${input.ttlSeconds}s`);
  }
  args.push('--', input.roomId);
  return args;
}

export function buildPipeCloseArgs(ctx: CliContext, input: { pipeId: string }): string[] {
  if (!PIPE_ID_PATTERN.test(input.pipeId)) {
    throw new CliValidationError(`pipe id must be 32 lowercase hex chars (got "${input.pipeId}")`);
  }
  return [...base(ctx), 'pipe', 'close', '--', input.pipeId];
}

export function buildRoomMembersArgs(ctx: CliContext, input: { roomId: string }): string[] {
  requireRoomId(input.roomId);
  return [...base(ctx), 'room', 'members', '--json', '--', input.roomId];
}

export function buildFileListArgs(ctx: CliContext, input: { roomId: string }): string[] {
  requireRoomId(input.roomId);
  return [...base(ctx), 'file', 'list', '--json', '--', input.roomId];
}

export function buildPipeListArgs(ctx: CliContext, input: { roomId: string }): string[] {
  requireRoomId(input.roomId);
  return [...base(ctx), 'pipe', 'list', '--', input.roomId];
}

export function buildIdentityShowArgs(ctx: CliContext): string[] {
  return [...base(ctx), 'identity', 'show', '--json'];
}

// --- stdout parsers (pure, fixture-tested against research-cli.md §3) ---------

/** Event id from `agent status` stdout (the `status:` line). */
export function parseStatusEventId(stdout: string): string | undefined {
  return /^status:\s*(blake3:[0-9a-f]{64})/m.exec(stdout)?.[1];
}

/** Event id from `room send` stdout (the `sent:` line). */
export function parseSendEventId(stdout: string): string | undefined {
  return /^sent:\s*(blake3:[0-9a-f]{64})/m.exec(stdout)?.[1];
}

/** file_id + event id from `file share` stdout. */
export function parseFileShareOutput(stdout: string): { fileId?: string; eventId?: string } {
  const result: { fileId?: string; eventId?: string } = {};
  const fileId = /^file_id:\s*(file_[0-9a-f]{32})/m.exec(stdout)?.[1];
  const eventId = /^event:\s*(blake3:[0-9a-f]{64})/m.exec(stdout)?.[1];
  if (fileId !== undefined) result.fileId = fileId;
  if (eventId !== undefined) result.eventId = eventId;
  return result;
}

/** pipe_id (+ connect hint) from `pipe expose` startup stdout. */
export function parsePipeExposeOutput(stdout: string): { pipeId?: string; connectHint?: string } {
  const result: { pipeId?: string; connectHint?: string } = {};
  const pipeId = /^pipe_id:\s*([0-9a-f]{32})/m.exec(stdout)?.[1];
  const connectHint = /^connectors run:\s*(.+)$/m.exec(stdout)?.[1];
  if (pipeId !== undefined) result.pipeId = pipeId;
  if (connectHint !== undefined) result.connectHint = connectHint.trim();
  return result;
}

/**
 * One row of `room tail --offline --json`. Stable fields are typed; the
 * flattened type-specific content fields (body, state, file_name, pipe_id,
 * invitee, ...) pass through verbatim via the index signature — the parser
 * must never drop unknown fields or throw on unknown event types.
 */
export interface TailRow {
  event_id: string;
  event_type: string;
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

/**
 * Parse `room tail --offline --json` stdout (a single-line JSON array).
 * Throws on non-JSON / non-array output (corrupt CLI output is a hard error);
 * tolerates rows with missing fields and unknown event types. Rows without a
 * string event_id are skipped — the poll-diff loop keys on the event_id set.
 */
export function parseTailRows(stdout: string): TailRow[] {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed === '' ? '[]' : trimmed);
  } catch {
    throw new Error('room tail --offline --json output was not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('room tail --offline --json output was not a JSON array');
  }
  const rows: TailRow[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record['event_id'] !== 'string') {
      continue;
    }
    const eventType = typeof record['event_type'] === 'string' ? record['event_type'] : 'unknown';
    rows.push({ ...record, event_id: record['event_id'], event_type: eventType });
  }
  return rows;
}

/** Coded CLI error from stderr: `error[<code>]: <detail>`. */
export function parseCodedError(stderr: string): { code: string; detail: string } | undefined {
  const match = /^error\[([a-z_]+)\]:\s*(.*)$/m.exec(stderr);
  if (match === null) {
    return undefined;
  }
  return { code: match[1] as string, detail: match[2] as string };
}

export interface IdentityInfo {
  name?: string;
  identityId?: string;
  deviceId?: string;
}

/** Parse `identity show --json` (single-line JSON object); undefined on failure. */
export function parseIdentityShow(stdout: string): IdentityInfo | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const info: IdentityInfo = {};
  if (typeof record['name'] === 'string') info.name = record['name'];
  if (typeof record['identity_id'] === 'string') info.identityId = record['identity_id'];
  if (typeof record['device_id'] === 'string') info.deviceId = record['device_id'];
  return info;
}

// --- secret redaction (SPEC.md §16.2; same pattern set as the extension) ------

/**
 * Conservative secret patterns replaced with [REDACTED]. The pattern set is
 * ported EXACTLY from the extension's redact.ts (SPEC.md §16.2: same set in
 * both components). Deliberately does NOT touch the protocol's public
 * currency: bare 64-hex identity ids, blake3: ids, file_<32-hex> ids, 32-hex
 * pipe ids, and roomtkt1 tickets.
 */
const REDACTION_PATTERNS: RegExp[] = [
  /** PEM private key blocks (RSA/EC/OPENSSH/PGP/plain). */
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /** AWS access key ids. */
  /\bAKIA[0-9A-Z]{16}\b/g,
  /** GitHub tokens (classic + fine-grained). */
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /** Slack tokens. */
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /** OpenAI/Anthropic-style secret keys. */
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /** Bearer JWTs. */
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

/**
 * Generic KEY/TOKEN/SECRET/PASSWORD = value pairs (case-insensitive; allows a
 * prefix such as GITHUB_TOKEN or my-api-key, and JSON-style quoting). The key
 * name and separator are kept; only the value is redacted. Values shorter
 * than 8 characters are left alone to limit false positives.
 */
const KEY_VALUE_PATTERN = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password))(["']?\s*[=:]\s*["']?)([^\s"']{8,})/gi;

export function redact(text: string): string {
  let output = text;
  for (const pattern of REDACTION_PATTERNS) {
    output = output.replace(pattern, '[REDACTED]');
  }
  output = output.replace(KEY_VALUE_PATTERN, '$1$2[REDACTED]');
  return output;
}

// --- runner (thin spawnSync wrapper; untested beyond construction) ------------

export const DEFAULT_CLI_TIMEOUT_MS = 60_000;

/**
 * Run the iroh-rooms binary synchronously, capturing text output. Never
 * throws: a spawn failure (missing binary etc.) maps to a synthetic exit code
 * 127 with the error text on stderr, so "command failed" and "command absent"
 * are uniform for callers.
 */
export function runIrohRooms(
  binPath: string,
  args: readonly string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Captured {
  const spawnOpts: SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    timeout: opts?.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
  };
  if (opts?.cwd !== undefined) {
    spawnOpts.cwd = opts.cwd;
  }
  const result = spawnSync(binPath, args as string[], spawnOpts);
  if (result.error) {
    return { returncode: 127, stdout: result.stdout ?? '', stderr: String(result.error) };
  }
  return {
    returncode: result.status ?? 127,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
