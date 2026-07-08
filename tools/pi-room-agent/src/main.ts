/**
 * pi-room-agent headless worker entry point (SPEC.md §15 / §20, docs/pi-harness.md §Headless worker).
 * Compiles and runs end-to-end WITHOUT network:
 *
 *   npm start -- --once --dry-run     # print planned CLI argv, no sends
 *   npm start -- --once               # one real poll iteration
 *   npm start                         # continuous poll-diff loop (Ctrl-C stops)
 *
 * What is real here: arg parsing, config resolution (fail closed), identity
 * verification via `identity show --json`, the poll-diff tail loop keyed on
 * seen event_ids, room-task detection in message.text bodies, and the
 * claim-message + agent.status transition plumbing.
 *
 * What is real-but-young: the Pi RPC drive is wired through an injectable
 * driver factory and unit-tested without spawning Pi. It still needs an
 * integration test against a real `pi --mode rpc` child and a real room.
 *
 * The module is import-safe: main() only runs when the file is executed
 * directly (entry-point guard below), so tests can import pollOnce/
 * primeSeenEvents/parseCliArgs without side effects.
 */

import { realpathSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { ConfigError, requireRoomId, resolveIrohRoomsBin, resolveWorkerConfig, type ResolvedWorkerConfig } from './config.js';
import {
  buildAgentStatusArgs,
  buildIdentityShowArgs,
  buildRoomSendArgs,
  buildRoomTailArgs,
  MAX_MESSAGE_BODY_BYTES,
  MAX_STATUS_MESSAGE_BYTES,
  parseCodedError,
  parseIdentityShow,
  parseSendEventId,
  parseStatusEventId,
  parseTailRows,
  redact,
  runIrohRooms,
  type Captured,
  type CliContext,
  type TailRow,
} from './room-cli.js';
import { parseRoomTasks, type RoomTask } from './task-parser.js';

// Imported so the intended wiring typechecks; not driven yet (see driveTaskWithPi).
import { PiRpcClient, type PiRpcEvent } from './pi-rpc.js';
import { INITIAL_MAPPER_STATE, mapPiEventToStatus, type PiEventLike } from './status-mapper.js';

const USAGE = `pi-room-agent — headless iroh-room worker

Usage: npm start -- [options]

Options:
  --room <blake3:64-hex>     Room id (else IROH_ROOM_ID / .iroh-room-pi.json)
  --data-dir <path>          iroh-rooms home (else IROH_ROOMS_HOME / config file)
  --once                     Run a single poll iteration and exit
  --dry-run                  Print planned CLI argv instead of sending anything
  --poll-interval <seconds>  Poll interval for the tail loop (default: 5)
  --help                     Show this help
`;

export interface CliArgs {
  room?: string;
  dataDir?: string;
  once: boolean;
  dryRun: boolean;
  pollIntervalSeconds: number;
  help: boolean;
}

/** Progress note to stderr (stdout stays clean for machine-readable output). */
function note(message: string): void {
  process.stderr.write(`>> ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { once: false, dryRun: false, pollIntervalSeconds: 5, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    const takeValue = (): string => {
      const value = argv[++i];
      if (value === undefined) {
        throw new ConfigError(`${flag} requires a value`);
      }
      return value;
    };
    switch (flag) {
      case '--room':
        args.room = takeValue();
        break;
      case '--data-dir':
        args.dataDir = takeValue();
        break;
      case '--once':
        args.once = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--poll-interval': {
        const raw = takeValue();
        if (!/^\d+$/.test(raw) || Number(raw) < 1) {
          throw new ConfigError(`--poll-interval must be a positive integer number of seconds (got "${raw}")`);
        }
        args.pollIntervalSeconds = Number(raw);
        break;
      }
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new ConfigError(`unknown flag "${flag}" (see --help)`);
    }
  }
  return args;
}

const TAIL_LIMIT = 200;

/** Bounded startup priming: refuse to act until one tail read succeeds. */
export const PRIME_MAX_ATTEMPTS = 10;

/** Injectable CLI runner so tests never spawn a real binary. */
export type RunFn = (binPath: string, args: readonly string[]) => Captured;

export interface WorkerContext {
  config: ResolvedWorkerConfig;
  roomId: string;
  binPath: string;
  cli: CliContext;
  dryRun: boolean;
  seenEventIds: Set<string>;
  run: RunFn;
  piDriverFactory?: PiDriverFactory;
}

export interface PiTaskDriver {
  start(): void | Promise<void>;
  sendPrompt(message: string): Promise<void>;
  events(): AsyncIterable<PiEventLike>;
  getLastAssistantText(): Promise<string>;
  stop(): Promise<void>;
}

export type PiDriverFactory = (ctx: WorkerContext, task: RoomTask) => PiTaskDriver;

function cliContextFor(config: ResolvedWorkerConfig): CliContext {
  return config.dataDir !== undefined ? { dataDir: config.dataDir } : {};
}

function formatArgv(binPath: string, args: readonly string[]): string {
  return [binPath, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

/**
 * Truncate untrusted text to a UTF-8 byte budget without splitting a code
 * point, appending "…" when something was cut. Room-task fields are untrusted
 * room content; a verbose-but-honest task must still fit the protocol limits
 * instead of crashing the worker.
 */
export function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return text;
  }
  const marker = '…'; // 3 bytes in UTF-8
  const cut = buf.subarray(0, Math.max(maxBytes - 3, 0)).toString('utf8').replace(/�+$/, '');
  return `${cut}${marker}`;
}

/** Fail closed unless a local iroh-rooms identity exists in the data dir. */
function verifyIdentity(ctx: WorkerContext): void {
  const captured = ctx.run(ctx.binPath, buildIdentityShowArgs(ctx.cli));
  if (captured.returncode !== 0) {
    const coded = parseCodedError(captured.stderr);
    fail(
      `no usable iroh-rooms identity (exit ${captured.returncode}` +
        (coded !== undefined ? `, ${coded.code}: ${coded.detail}` : '') +
        '). Create one with `iroh-rooms identity create --name <agent-name>` using the ' +
        'AGENT home (--data-dir / IROH_ROOMS_HOME) — never a human or admin identity.',
    );
  }
  const identity = parseIdentityShow(captured.stdout);
  if (identity?.identityId === undefined) {
    fail('could not parse `identity show --json` output; is the iroh-rooms binary current?');
  }
  note(`identity: ${identity.identityId.slice(0, 8)}… (${identity.name ?? 'unnamed'})`);
}

/** SPEC §11.2 claim message, capped to the message-body byte limit. */
export function claimMessage(task: RoomTask, agentName: string): string {
  const message = `Claiming task ${task.id} as ${agentName}. I will post progress through agent.status and share artifacts when ready.`;
  return truncateBytes(message, MAX_MESSAGE_BODY_BYTES);
}

/** `claimed <id>: <title>` status message, capped to the status-message limit. */
export function claimStatusMessage(task: RoomTask): string {
  return truncateBytes(`claimed ${task.id}: ${task.title}`, MAX_STATUS_MESSAGE_BYTES);
}

/**
 * Claim one detected task: send the claim message, post `claimed` (progress
 * 5, SPEC §11.2), then hand off to the Pi drive. In dry-run mode this only
 * prints the argv that WOULD run.
 */
async function claimAndDrive(ctx: WorkerContext, task: RoomTask): Promise<void> {
  const sendArgs = buildRoomSendArgs(ctx.cli, {
    roomId: ctx.roomId,
    message: claimMessage(task, ctx.config.agentName),
  });
  const statusArgs = buildAgentStatusArgs(ctx.cli, {
    roomId: ctx.roomId,
    status: 'claimed',
    message: claimStatusMessage(task),
    progress: 5,
  });

  if (ctx.dryRun) {
    note(`[dry-run] would claim task ${task.id}:`);
    note(`[dry-run]   ${formatArgv(ctx.binPath, sendArgs)}`);
    note(`[dry-run]   ${formatArgv(ctx.binPath, statusArgs)}`);
    note(`[dry-run]   (then drive Pi over RPC, mirror lifecycle status, send handoff)`);
    return;
  }

  const sent = ctx.run(ctx.binPath, sendArgs);
  if (sent.returncode !== 0) {
    note(`claim message for ${task.id} failed (exit ${sent.returncode}): ${redact(sent.stderr).trim()}`);
    return; // fail closed: do not post claimed status for an unclaimed task
  }
  note(`claimed ${task.id} (event ${parseSendEventId(sent.stdout) ?? 'unknown'})`);

  const status = ctx.run(ctx.binPath, statusArgs);
  if (status.returncode !== 0) {
    note(`claimed status for ${task.id} failed (exit ${status.returncode}): ${redact(status.stderr).trim()}`);
  } else {
    note(`posted claimed status (event ${parseStatusEventId(status.stdout) ?? 'unknown'})`);
  }

  await driveTaskWithPi(ctx, task);
}

function taskPrompt(task: RoomTask): string {
  const lines = ['```room-task', `id: ${task.id}`, `type: ${task.type}`, `title: ${task.title}`];
  if (task.repo !== undefined) lines.push(`repo: ${task.repo}`);
  if (task.branch !== undefined) lines.push(`branch: ${task.branch}`);
  if (task.goal !== undefined) lines.push(`goal: ${task.goal}`);
  if (task.acceptance.length > 0) {
    lines.push('acceptance:');
    for (const item of task.acceptance) {
      lines.push(`  - ${item}`);
    }
  }
  if (task.budget !== undefined) {
    lines.push('budget:');
    if (task.budget.maxUsd !== undefined) lines.push(`  max_usd: ${task.budget.maxUsd}`);
    if (task.budget.maxMinutes !== undefined) lines.push(`  max_minutes: ${task.budget.maxMinutes}`);
  }
  for (const [key, value] of Object.entries(task.extra)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('```');
  return `/room-implement ${task.id}\n\n${lines.join('\n')}`;
}

function createDefaultPiDriver(ctx: WorkerContext): PiTaskDriver {
  const client = new PiRpcClient({ cwd: ctx.config.cwd });
  return {
    start: () => client.start(),
    sendPrompt: (message) => client.sendPrompt(message),
    events: () => client.events() as AsyncGenerator<PiRpcEvent, void, void>,
    getLastAssistantText: () => client.getLastAssistantText(),
    stop: () => client.stop(),
  };
}

function postStatus(
  ctx: WorkerContext,
  input: { status: string; message?: string; progress?: number; artifactIds?: string[] },
): boolean {
  const args = buildAgentStatusArgs(ctx.cli, {
    roomId: ctx.roomId,
    status: input.status,
    message: input.message === undefined ? undefined : truncateBytes(input.message, MAX_STATUS_MESSAGE_BYTES),
    progress: input.progress,
    artifactIds: input.artifactIds,
  });
  const captured = ctx.run(ctx.binPath, args);
  if (captured.returncode !== 0) {
    note(`${input.status} status failed (exit ${captured.returncode}): ${redact(captured.stderr).trim()}`);
    return false;
  }
  note(`posted ${input.status} status (event ${parseStatusEventId(captured.stdout) ?? 'unknown'})`);
  return true;
}

function eventString(event: PiEventLike, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return undefined;
}

function eventBool(event: PiEventLike, key: string): boolean | undefined {
  return typeof event[key] === 'boolean' ? event[key] : undefined;
}

function toolCommand(event: PiEventLike): string | undefined {
  const args = event.args;
  if (args !== undefined) {
    const command = args['command'];
    if (typeof command === 'string' && command.trim() !== '') {
      return command.trim();
    }
  }
  return undefined;
}

function assistantStopReason(event: PiEventLike): string | undefined {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (typeof message !== 'object' || message === null) continue;
    const record = message as Record<string, unknown>;
    if (record['role'] !== 'assistant') continue;
    const stopReason = record['stopReason'];
    return typeof stopReason === 'string' ? stopReason : undefined;
  }
  return undefined;
}

function diagnosticLine(event: PiEventLike): string | undefined {
  switch (event.type) {
    case 'tool_execution_start': {
      const tool = typeof event.toolName === 'string' ? event.toolName : 'tool';
      const command = toolCommand(event);
      return command === undefined ? `tool started: ${tool}` : `tool started: ${tool} (${command.slice(0, 160)})`;
    }
    case 'tool_execution_end': {
      const tool = typeof event.toolName === 'string' ? event.toolName : 'tool';
      const failed = eventBool(event, 'isError') === true ? ' failed' : '';
      const detail = eventString(event, ['error', 'message']);
      return detail === undefined ? `tool ended${failed}: ${tool}` : `tool ended${failed}: ${tool}: ${detail.slice(0, 160)}`;
    }
    case 'extension_error':
      return `extension error: ${(eventString(event, ['message', 'error', 'detail']) ?? 'unknown').slice(0, 180)}`;
    case 'agent_end': {
      const stopReason = assistantStopReason(event) ?? eventString(event, ['stopReason', 'reason']);
      return stopReason === undefined ? 'agent ended' : `agent ended: stopReason=${stopReason}`;
    }
    default:
      return undefined;
  }
}

function diagnosticsBlock(lines: readonly string[]): string[] {
  if (lines.length === 0) {
    return ['Diagnostics:', '- No diagnostic Pi events were captured before agent_end.'];
  }
  return ['Diagnostics:', ...lines.slice(-8).map((line) => `- ${truncateBytes(redact(line), 400)}`)];
}

/**
 * Drive the claimed task through Pi RPC and mirror lifecycle transitions into
 * agent.status. Artifact publication is still the next slice; for now the
 * final handoff message carries the assistant summary and no artifact ids.
 */
export async function driveTaskWithPi(ctx: WorkerContext, task: RoomTask): Promise<void> {
  const driver = ctx.piDriverFactory?.(ctx, task) ?? createDefaultPiDriver(ctx);
  let stopped = false;
  try {
    await driver.start();
    await driver.sendPrompt(taskPrompt(task));
    let state = INITIAL_MAPPER_STATE;
    const diagnostics: string[] = [];
    for await (const event of driver.events()) {
      const line = diagnosticLine(event);
      if (line !== undefined) {
        diagnostics.push(line);
      }
      const mapped = mapPiEventToStatus(state, event);
      state = mapped.state;
      if (mapped.transition !== null) {
        postStatus(ctx, { status: mapped.transition.to, message: mapped.transition.reason });
      }
      if (event.type === 'agent_end') {
        break;
      }
    }

    const summary = truncateBytes(await driver.getLastAssistantText(), MAX_MESSAGE_BODY_BYTES - 512);
    const reviewable = state.status === 'ready_for_review';
    const handoff = [
      reviewable ? `Task ${task.id} is ready for review.` : `Task ${task.id} is not ready for review.`,
      '',
      'Outcome:',
      reviewable ? 'Pi completed successfully.' : `Pi ended with status "${state.status}".`,
      '',
      'Summary:',
      summary.trim() === '' ? '(Pi completed without a final assistant summary.)' : summary.trim(),
      '',
      ...(reviewable ? [] : [...diagnosticsBlock(diagnostics), '']),
      'Artifacts: none published by the worker yet.',
      reviewable
        ? 'Next steps: review the room status trail and repository diff.'
        : 'Next steps: inspect the failed/blocked status trail and rerun after fixing the cause.',
    ].join('\n');
    const sent = ctx.run(ctx.binPath, buildRoomSendArgs(ctx.cli, { roomId: ctx.roomId, message: handoff }));
    if (sent.returncode !== 0) {
      note(`handoff message for ${task.id} failed (exit ${sent.returncode}): ${redact(sent.stderr).trim()}`);
    } else {
      note(`sent handoff for ${task.id} (event ${parseSendEventId(sent.stdout) ?? 'unknown'})`);
    }
  } catch (error) {
    const detail = redact(error instanceof Error ? error.message : String(error)).trim();
    note(`pi drive for ${task.id} failed: ${detail}`);
    postStatus(ctx, {
      status: 'blocked',
      message: `task ${truncateBytes(task.id, 256)} blocked while driving Pi RPC: ${detail}`,
      progress: 5,
    });
  } finally {
    try {
      await driver.stop();
      stopped = true;
    } catch (error) {
      note(`pi driver stop failed for ${task.id}: ${redact(error instanceof Error ? error.message : String(error)).trim()}`);
    }
    if (stopped) {
      note(`pi driver stopped for ${task.id}`);
    }
  }
}

/** Extract room-task blocks from new message.text rows. */
function detectTasks(rows: readonly TailRow[]): RoomTask[] {
  const tasks: RoomTask[] = [];
  for (const row of rows) {
    if (row.event_type !== 'message.text' || typeof row['body'] !== 'string') {
      continue;
    }
    const parsed = parseRoomTasks(row['body']);
    for (const error of parsed.errors) {
      note(`task parse warning in ${row.event_id.slice(0, 16)}…: ${error}`);
    }
    tasks.push(...parsed.tasks);
  }
  return tasks;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rowMentionsTask(row: TailRow, taskId: string): boolean {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(taskId)}([^A-Za-z0-9_.-]|$)`);
  for (const key of ['body', 'message', 'summary']) {
    const value = row[key];
    if (typeof value === 'string' && pattern.test(value)) {
      return true;
    }
  }
  return false;
}

function isPriorTaskActivity(row: TailRow, taskId: string): boolean {
  if (row.event_type === 'message.text') {
    const body = row['body'];
    if (typeof body !== 'string') return false;
    return (
      new RegExp(`\\bClaiming task\\s+${escapeRegExp(taskId)}\\b`).test(body) ||
      new RegExp(`\\bTask\\s+${escapeRegExp(taskId)}\\s+is\\s+(?:ready|not ready)\\s+for review\\b`).test(body)
    );
  }
  if (row.event_type !== 'agent.status') {
    return false;
  }
  const state = typeof row['state'] === 'string' ? row['state'] : undefined;
  if (!['claimed', 'planning', 'implementing', 'testing', 'blocked', 'ready_for_review', 'done', 'failed', 'cancelled'].includes(state ?? '')) {
    return false;
  }
  return rowMentionsTask(row, taskId);
}

function hasPriorTaskActivity(task: RoomTask, rows: readonly TailRow[]): boolean {
  return rows.some((row) => isPriorTaskActivity(row, task.id));
}

/**
 * One poll-diff iteration: offline tail read, diff on event_id, act on new
 * rows. Returns false on a tail failure so callers can decide to abort/retry.
 *
 * Room content is untrusted: a single malformed or oversized task must never
 * crash the worker or abandon the rest of the batch, so each claim is
 * individually guarded. Events are marked seen before acting, so a poison
 * message is not retried forever.
 */
export async function pollOnce(ctx: WorkerContext, actOnNewRows: boolean): Promise<boolean> {
  const tailArgs = buildRoomTailArgs(ctx.cli, { roomId: ctx.roomId, limit: TAIL_LIMIT });
  const captured = ctx.run(ctx.binPath, tailArgs);
  if (captured.returncode !== 0) {
    const coded = parseCodedError(captured.stderr);
    note(
      `tail failed (exit ${captured.returncode}${coded !== undefined ? `, ${coded.code}` : ''}): ` +
        redact(coded?.detail ?? captured.stderr).trim(),
    );
    return false;
  }
  let rows: TailRow[];
  try {
    rows = parseTailRows(captured.stdout);
  } catch (error) {
    note(String(error));
    return false;
  }
  const newRows = rows.filter((row) => !ctx.seenEventIds.has(row.event_id));
  for (const row of newRows) {
    ctx.seenEventIds.add(row.event_id);
  }
  note(`tail: ${rows.length} rows, ${newRows.length} new`);
  if (!actOnNewRows) {
    return true;
  }
  const tasks = detectTasks(newRows);
  if (tasks.length === 0) {
    return true;
  }
  note(`detected ${tasks.length} room-task block(s)`);
  for (const task of tasks) {
    if (hasPriorTaskActivity(task, rows)) {
      note(`skipping task ${truncateBytes(task.id, 256)}: existing claim/status/handoff found in room tail`);
      continue;
    }
    try {
      await claimAndDrive(ctx, task);
    } catch (error) {
      // Untrusted room content must never kill the worker (or its batch):
      // log, skip this task, keep going. The event is already marked seen.
      note(`skipping task ${truncateBytes(task.id, 256)}: ${redact(error instanceof Error ? error.message : String(error)).trim()}`);
    }
  }
  return true;
}

/**
 * Continuous-mode startup priming: read the current tail WITHOUT acting so
 * historical tasks are never claimed. A failed priming read must NOT fail
 * open (an empty seen-set would make the next acting poll claim the entire
 * backlog), so this retries with backoff and reports false when priming never
 * succeeded — the caller must refuse to act in that case.
 */
export async function primeSeenEvents(
  ctx: WorkerContext,
  options: { maxAttempts?: number; initialDelayMs?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const maxAttempts = options.maxAttempts ?? PRIME_MAX_ATTEMPTS;
  const sleepFn = options.sleepFn ?? ((ms: number) => sleep(ms));
  let delayMs = options.initialDelayMs ?? 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await pollOnce(ctx, false)) {
      return true;
    }
    if (attempt < maxAttempts) {
      note(`priming tail read failed (attempt ${attempt}/${maxAttempts}); retrying in ${Math.round(delayMs / 1000)}s`);
      await sleepFn(delayMs);
      delayMs = Math.min(delayMs * 2, 60_000);
    }
  }
  return false;
}

/** Dry-run report: resolved config + planned argv; offline tail if possible. */
async function dryRunReport(ctx: WorkerContext | null, config: ResolvedWorkerConfig, binError?: string): Promise<void> {
  const cli = cliContextFor(config);
  note('dry-run: nothing will be sent');
  note(`  room:         ${config.roomId ?? '(not set)'}`);
  note(`  data dir:     ${config.dataDir ?? '(platform default)'}`);
  note(`  agent name:   ${config.agentName}`);
  note(`  artifact dir: ${config.artifactDir}`);
  note(`  config file:  ${config.configFilePath ?? '(none)'}`);
  note(`  binary:       ${ctx?.binPath ?? `(unresolved: ${binError ?? 'unknown'})`}`);

  const roomId = requireRoomId(config); // fail closed even in dry-run: a room id is cheap and mandatory
  const bin = ctx?.binPath ?? 'iroh-rooms';
  note('planned commands:');
  note(`  ${formatArgv(bin, buildIdentityShowArgs(cli))}`);
  note(`  ${formatArgv(bin, buildRoomTailArgs(cli, { roomId, limit: TAIL_LIMIT }))}`);
  note(
    `  ${formatArgv(bin, buildAgentStatusArgs(cli, { roomId, status: 'observing', message: 'watching for room-task blocks', progress: config.defaultProgress ?? 0 }))}`,
  );

  if (ctx === null) {
    note('skipping offline tail read: no iroh-rooms binary available');
    note(binError ?? '');
    return;
  }
  // The offline tail is network-free and read-only, so a dry run may execute it.
  await pollOnce(ctx, true);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(USAGE);
    fail(error instanceof Error ? error.message : String(error));
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  let config: ResolvedWorkerConfig;
  try {
    const overrides: Parameters<typeof resolveWorkerConfig>[0] = {};
    if (args.room !== undefined) overrides.roomId = args.room;
    if (args.dataDir !== undefined) overrides.dataDir = args.dataDir;
    config = resolveWorkerConfig(overrides);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // Binary resolution: hard requirement in real mode; a dry run degrades to a
  // clear note (planned argv still prints).
  let binPath: string | undefined;
  let binError: string | undefined;
  try {
    binPath = resolveIrohRoomsBin(config);
  } catch (error) {
    binError = error instanceof Error ? error.message : String(error);
  }

  if (args.dryRun) {
    try {
      const ctx: WorkerContext | null =
        binPath !== undefined
          ? {
              config,
              roomId: requireRoomId(config),
              binPath,
              cli: cliContextFor(config),
              dryRun: true,
              seenEventIds: new Set<string>(),
              run: runIrohRooms,
            }
          : null;
      await dryRunReport(ctx, config, binError);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (binPath === undefined) {
    fail(binError ?? 'iroh-rooms binary not found');
  }
  let roomId: string;
  try {
    roomId = requireRoomId(config);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const ctx: WorkerContext = {
    config,
    roomId,
    binPath,
    cli: cliContextFor(config),
    dryRun: false,
    seenEventIds: new Set<string>(),
    run: runIrohRooms,
  };

  verifyIdentity(ctx);

  if (args.once) {
    // --once acts on the current backlog (that is its purpose).
    const ok = await pollOnce(ctx, true);
    if (!ok) {
      process.exit(1);
    }
    return;
  }

  // Continuous mode: prime the seen-set from the current tail WITHOUT acting
  // (do not claim historical tasks on startup), then act on new events only.
  // Priming is mandatory — never act on an unprimed (empty) seen-set.
  note(`polling every ${args.pollIntervalSeconds}s (Ctrl-C to stop)`);
  let running = true;
  process.on('SIGINT', () => {
    running = false;
    note('stopping after the current iteration…');
  });
  const primed = await primeSeenEvents(ctx, { initialDelayMs: args.pollIntervalSeconds * 1000 });
  if (!primed) {
    fail(`could not prime the seen-event set after ${PRIME_MAX_ATTEMPTS} tail attempts; refusing to claim`);
  }
  while (running) {
    await sleep(args.pollIntervalSeconds * 1000);
    if (!running) break;
    await pollOnce(ctx, true);
  }
  note('stopped');
}

/** True when this module is the executed entry point (not an import). */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
