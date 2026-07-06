/**
 * SCAFFOLD — pi-room-agent headless worker entry point (SPEC.md §15,
 * DESIGN.md §7). Compiles and runs end-to-end WITHOUT network:
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
 * What is stubbed: the actual Pi RPC drive of a claimed task. The wiring is
 * sketched below (see driveTaskWithPi) but not enabled; after claiming, the
 * worker posts `blocked` so humans in the room can see the claim is not
 * progressing. See README "next steps".
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { ConfigError, requireRoomId, resolveIrohRoomsBin, resolveWorkerConfig, type ResolvedWorkerConfig } from './config.js';
import {
  buildAgentStatusArgs,
  buildIdentityShowArgs,
  buildRoomSendArgs,
  buildRoomTailArgs,
  parseCodedError,
  parseIdentityShow,
  parseSendEventId,
  parseStatusEventId,
  parseTailRows,
  redact,
  runIrohRooms,
  type CliContext,
  type TailRow,
} from './room-cli.js';
import { parseRoomTasks, type RoomTask } from './task-parser.js';

// Imported so the intended wiring typechecks; not driven yet (see driveTaskWithPi).
import { PiRpcClient } from './pi-rpc.js';
import { INITIAL_MAPPER_STATE, mapPiEventToStatus, type PiEventLike } from './status-mapper.js';

const USAGE = `pi-room-agent — headless iroh-room worker (scaffold)

Usage: npm start -- [options]

Options:
  --room <blake3:64-hex>     Room id (else IROH_ROOM_ID / .iroh-room-pi.json)
  --data-dir <path>          iroh-rooms home (else IROH_ROOMS_HOME / config file)
  --once                     Run a single poll iteration and exit
  --dry-run                  Print planned CLI argv instead of sending anything
  --poll-interval <seconds>  Poll interval for the tail loop (default: 5)
  --help                     Show this help
`;

interface CliArgs {
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

interface WorkerContext {
  config: ResolvedWorkerConfig;
  roomId: string;
  binPath: string;
  cli: CliContext;
  dryRun: boolean;
  seenEventIds: Set<string>;
}

function cliContextFor(config: ResolvedWorkerConfig): CliContext {
  return config.dataDir !== undefined ? { dataDir: config.dataDir } : {};
}

function formatArgv(binPath: string, args: readonly string[]): string {
  return [binPath, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

/** Fail closed unless a local iroh-rooms identity exists in the data dir. */
function verifyIdentity(ctx: WorkerContext): void {
  const captured = runIrohRooms(ctx.binPath, buildIdentityShowArgs(ctx.cli));
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

/** SPEC §11.2 claim message. */
function claimMessage(task: RoomTask, agentName: string): string {
  return `Claiming task ${task.id} as ${agentName}. I will post progress through agent.status and share artifacts when ready.`;
}

/**
 * Claim one detected task: send the claim message, post `claimed` (progress
 * 5, SPEC §11.2), then hand off to the (stubbed) Pi drive. In dry-run mode
 * this only prints the argv that WOULD run.
 */
function claimAndDrive(ctx: WorkerContext, task: RoomTask): void {
  const sendArgs = buildRoomSendArgs(ctx.cli, {
    roomId: ctx.roomId,
    message: claimMessage(task, ctx.config.agentName),
  });
  const statusArgs = buildAgentStatusArgs(ctx.cli, {
    roomId: ctx.roomId,
    status: 'claimed',
    message: `claimed ${task.id}: ${task.title}`,
    progress: 5,
  });

  if (ctx.dryRun) {
    note(`[dry-run] would claim task ${task.id}:`);
    note(`[dry-run]   ${formatArgv(ctx.binPath, sendArgs)}`);
    note(`[dry-run]   ${formatArgv(ctx.binPath, statusArgs)}`);
    note(`[dry-run]   (then drive Pi over RPC — not implemented yet)`);
    return;
  }

  const sent = runIrohRooms(ctx.binPath, sendArgs);
  if (sent.returncode !== 0) {
    note(`claim message for ${task.id} failed (exit ${sent.returncode}): ${redact(sent.stderr).trim()}`);
    return; // fail closed: do not post claimed status for an unclaimed task
  }
  note(`claimed ${task.id} (event ${parseSendEventId(sent.stdout) ?? 'unknown'})`);

  const status = runIrohRooms(ctx.binPath, statusArgs);
  if (status.returncode !== 0) {
    note(`claimed status for ${task.id} failed (exit ${status.returncode}): ${redact(status.stderr).trim()}`);
  } else {
    note(`posted claimed status (event ${parseStatusEventId(status.stdout) ?? 'unknown'})`);
  }

  driveTaskWithPi(ctx, task);
}

/**
 * TODO(scaffold): drive the claimed task with Pi over RPC. The intended
 * wiring (typechecked against pi-rpc.ts and status-mapper.ts, disabled here):
 *
 *   const pi = new PiRpcClient({ cwd: ctx.config.cwd });
 *   pi.start();
 *   await pi.sendPrompt(`/room-implement ${taskBlockText}`); // .pi/prompts/room-implement.md
 *   let state = INITIAL_MAPPER_STATE;
 *   for await (const event of pi.events()) {
 *     const { state: next, transition } = mapPiEventToStatus(state, event as PiEventLike);
 *     state = next;
 *     if (transition !== null) {
 *       runIrohRooms(ctx.binPath, buildAgentStatusArgs(ctx.cli, {
 *         roomId: ctx.roomId, status: transition.to, message: transition.reason,
 *       }));
 *     }
 *     if (event.type === 'agent_end') break;   // done signal per docs/rpc.md
 *   }
 *   const summary = await pi.getLastAssistantText();
 *   // publishArtifacts(...) then post ready_for_review + final handoff message
 *   await pi.stop();
 *
 * Until that is enabled, post `blocked` so the room can see the claim is not
 * progressing (honest signaling beats a silent stall).
 */
function driveTaskWithPi(ctx: WorkerContext, task: RoomTask): void {
  // Reference the intended collaborators so the sketch above stays typechecked.
  void PiRpcClient;
  void mapPiEventToStatus;
  void INITIAL_MAPPER_STATE;
  void (null as PiEventLike | null);

  note(`TODO: pi-rpc drive for ${task.id} is not implemented; posting blocked`);
  const blockedArgs = buildAgentStatusArgs(ctx.cli, {
    roomId: ctx.roomId,
    status: 'blocked',
    message: `task ${task.id} claimed by scaffold worker; pi-rpc drive not implemented yet`,
    progress: 5,
  });
  const captured = runIrohRooms(ctx.binPath, blockedArgs);
  if (captured.returncode !== 0) {
    note(`blocked status failed (exit ${captured.returncode}): ${redact(captured.stderr).trim()}`);
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

/**
 * One poll-diff iteration: offline tail read, diff on event_id, act on new
 * rows. Returns false on a tail failure so callers can decide to abort/retry.
 */
function pollOnce(ctx: WorkerContext, actOnNewRows: boolean): boolean {
  const tailArgs = buildRoomTailArgs(ctx.cli, { roomId: ctx.roomId, limit: TAIL_LIMIT });
  const captured = runIrohRooms(ctx.binPath, tailArgs);
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
    // TODO(scaffold): claim-conflict resolution — scan the tail for an
    // existing claim of task.id by another agent before claiming (out of
    // scope for MVP per DESIGN.md §12).
    claimAndDrive(ctx, task);
  }
  return true;
}

/** Dry-run report: resolved config + planned argv; offline tail if possible. */
function dryRunReport(ctx: WorkerContext | null, config: ResolvedWorkerConfig, binError?: string): void {
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
  pollOnce(ctx, true);
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
            }
          : null;
      dryRunReport(ctx, config, binError);
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
  };

  verifyIdentity(ctx);

  if (args.once) {
    // --once acts on the current backlog (that is its purpose).
    const ok = pollOnce(ctx, true);
    if (!ok) {
      process.exit(1);
    }
    return;
  }

  // Continuous mode: prime the seen-set from the current tail WITHOUT acting
  // (do not claim historical tasks on startup), then act on new events only.
  note(`polling every ${args.pollIntervalSeconds}s (Ctrl-C to stop)`);
  let running = true;
  process.on('SIGINT', () => {
    running = false;
    note('stopping after the current iteration…');
  });
  pollOnce(ctx, false);
  while (running) {
    await sleep(args.pollIntervalSeconds * 1000);
    if (!running) break;
    pollOnce(ctx, true);
  }
  note('stopped');
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
