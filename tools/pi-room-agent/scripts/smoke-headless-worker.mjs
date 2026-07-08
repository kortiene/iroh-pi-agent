#!/usr/bin/env node
/**
 * Local-only headless worker smoke helper.
 *
 * Safe default: dry-run only, no room mutation. Add --post-task to publish a
 * new room-task and --run-worker to claim/drive it. This script intentionally
 * stays out of CI because it requires a real iroh-rooms room, agent identity,
 * and Pi RPC child.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(scriptPath), '..');
const repoRoot = resolve(packageRoot, '..', '..');

function usage() {
  return `Usage: npm --prefix tools/pi-room-agent run smoke:headless -- [options]

Required (or env):
  --room <blake3:...>       Room id (or IROH_ROOM_ID)
  --data-dir <path>         Agent iroh-rooms home (or IROH_ROOMS_HOME)
  --bin <path>              iroh-rooms binary (or IROH_ROOMS_BIN)

Modes:
  (default)                 Non-mutating dry-run preflight only
  --post-task               Post a fresh smoke room-task
  --run-worker              Run the worker after posting the task (requires --post-task)

Options:
  --task-id <id>            Override generated task id
  --timeout-seconds <n>     Worker timeout, default 300
  --tail-limit <n>          Tail rows to inspect, default 220
  --help                    Show this help
`;
}

function parseArgs(argv) {
  const args = { postTask: false, runWorker: false, timeoutSeconds: 300, tailLimit: 220 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case '--room': args.room = value(); break;
      case '--data-dir': args.dataDir = value(); break;
      case '--bin': args.bin = value(); break;
      case '--task-id': args.taskId = value(); break;
      case '--timeout-seconds': args.timeoutSeconds = Number(value()); break;
      case '--tail-limit': args.tailLimit = Number(value()); break;
      case '--post-task': args.postTask = true; break;
      case '--run-worker': args.runWorker = true; break;
      case '--help': args.help = true; break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  args.room ??= process.env.IROH_ROOM_ID;
  args.dataDir ??= process.env.IROH_ROOMS_HOME;
  args.bin ??= process.env.IROH_ROOMS_BIN;
  if (!Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds < 1) {
    throw new Error('--timeout-seconds must be a positive integer');
  }
  if (!Number.isInteger(args.tailLimit) || args.tailLimit < 1) {
    throw new Error('--tail-limit must be a positive integer');
  }
  if (args.runWorker && !args.postTask) {
    throw new Error('--run-worker requires --post-task so the smoke cannot accidentally claim backlog');
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function mustRun(label, command, args, options = {}) {
  console.error(`\n== ${label} ==`);
  console.error([command, ...args].join(' '));
  const result = run(command, args, options);
  if (options.printStdout !== false && result.stdout.trim() !== '') process.stdout.write(result.stdout);
  if (result.stderr.trim() !== '') process.stderr.write(result.stderr);
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${label} failed (status=${result.status} signal=${result.signal} error=${result.error?.message ?? 'none'})`);
  }
  return result;
}

function workerArgs({ room, dataDir, dryRun }) {
  return [
    resolve(packageRoot, 'src/main.ts'),
    '--once',
    ...(dryRun ? ['--dry-run'] : []),
    '--room', room,
    '--data-dir', dataDir,
  ];
}

function taskBody(taskId) {
  return `\`\`\`room-task
id: ${taskId}
type: document
title: Headless worker automated smoke test
goal: Verify that the headless worker can claim, drive Pi RPC, and publish task-named artifacts. Create a tiny markdown report under artifacts/worker-smoke/ and do not edit source files.
acceptance:
  - Create artifacts/worker-smoke/${taskId}.md with a one-paragraph smoke-test note.
  - Do not modify source files for this smoke task.
budget:
  max_minutes: 5
\`\`\``;
}

function inspectTail(bin, dataDir, room, tailLimit) {
  const result = mustRun('read offline tail', bin, [
    `--data-dir=${dataDir}`,
    'room', 'tail', '--offline', '--json', `--limit=${tailLimit}`, '--', room,
  ], { printStdout: false });
  return JSON.parse(result.stdout);
}

function printTaskRows(rows, taskId) {
  console.error(`\n== rows mentioning ${taskId} ==`);
  for (const row of rows) {
    const text = JSON.stringify(row);
    if (!text.includes(taskId)) continue;
    const label = [row.event_type, row.state].filter(Boolean).join(' ');
    console.error(`- ${label || row.event_type}: ${row.event_id}`);
    const body = row.message ?? row.body;
    if (typeof body === 'string') console.error(body.slice(0, 1200));
  }
}

function smokeSucceeded(rows, taskId) {
  const taskRows = rows.filter((row) => JSON.stringify(row).includes(taskId));
  const handoff = taskRows.some((row) => row.event_type === 'message.text' && typeof row.body === 'string' && row.body.includes(`Task ${taskId} is ready for review.`) && row.body.includes('Artifacts:\n- file_'));
  const shared = rows.some((row) => row.event_type === 'file.shared' && typeof row.file_name === 'string' && row.file_name.includes(taskId));
  const readyWithArtifact = rows.some((row) => row.event_type === 'agent.status' && row.state === 'ready_for_review' && Array.isArray(row.artifacts) && row.artifacts.length > 0);
  return handoff && shared && readyWithArtifact;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  for (const [name, value] of [['--room/IROH_ROOM_ID', args.room], ['--data-dir/IROH_ROOMS_HOME', args.dataDir], ['--bin/IROH_ROOMS_BIN', args.bin]]) {
    if (value === undefined || value === '') throw new Error(`${name} is required`);
  }

  const tsx = resolve(packageRoot, 'node_modules/.bin/tsx');
  mustRun('worker dry-run preflight', tsx, workerArgs({ room: args.room, dataDir: args.dataDir, dryRun: true }), {
    cwd: repoRoot,
    env: { ...process.env, IROH_ROOMS_BIN: args.bin },
  });

  let taskId = args.taskId;
  if (args.postTask) {
    taskId ??= `IR-PI-SMOKE-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
    mustRun('post smoke room-task', args.bin, [
      `--data-dir=${args.dataDir}`,
      'room', 'send', '--', args.room, taskBody(taskId),
    ]);
    console.error(`posted smoke task: ${taskId}`);
  }

  if (args.runWorker) {
    mustRun('run real headless worker', tsx, workerArgs({ room: args.room, dataDir: args.dataDir, dryRun: false }), {
      cwd: repoRoot,
      env: { ...process.env, IROH_ROOMS_BIN: args.bin },
      timeoutMs: args.timeoutSeconds * 1000,
    });
  }

  const rows = inspectTail(args.bin, args.dataDir, args.room, args.tailLimit);
  if (taskId !== undefined) {
    printTaskRows(rows, taskId);
    if (args.runWorker && !smokeSucceeded(rows, taskId)) {
      throw new Error(`smoke task ${taskId} did not reach ready_for_review with a shared artifact`);
    }
  }
  console.error('\nsmoke helper completed');
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.stderr.write(usage());
  process.exit(1);
}
