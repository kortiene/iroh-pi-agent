/**
 * SCAFFOLD — background `iroh-rooms pipe expose` supervisor (compiles, same
 * contract as the extension's PipeManager; NOT yet exercised end-to-end).
 *
 * `pipe expose` is a LONG-RUNNING command: it prints a startup block ending
 * in `pipe_id: <32-hex>` and then serves until Ctrl-C (research-cli.md §3).
 * So the worker must spawn it as a background child:
 *   - resolve once `pipe_id:` appears on stdout (timeout -> kill + reject)
 *   - reject with redacted stderr if the child exits before printing pipe_id
 *   - close via SIGINT (lets the binary publish pipe.closed), escalate to
 *     SIGKILL after 5s
 *
 * Input validation (loopback-only target, non-empty allow list) happens in
 * buildPipeExposeArgs — fail closed before any process is spawned.
 *
 * TODO(scaffold):
 *  - integration test against the real binary (needs identity + room + member)
 *  - post a `preview_available` agent.status with the connect hint (main.ts)
 *  - watch for unexpected mid-life exits and surface them to the caller
 */

import { spawn } from 'node:child_process';

import { buildPipeExposeArgs, parsePipeExposeOutput, redact, type PipeExposeInput } from './room-cli.js';

export const DEFAULT_PIPE_START_TIMEOUT_MS = 20_000;
const CLOSE_ESCALATION_MS = 5_000;

export interface PreviewPipeOptions extends PipeExposeInput {
  /** Absolute path to the iroh-rooms binary. */
  binPath: string;
  /** Passed as --data-dir on the child when set. */
  dataDir?: string;
  cwd?: string;
  startTimeoutMs?: number;
}

export interface PreviewPipe {
  pipeId: string;
  roomId: string;
  target: string;
  label?: string;
  startedAt: Date;
  /** The `connectors run: ...` line from the startup block, when captured. */
  connectHint?: string;
  /** SIGINT the child (idempotent); resolves when it has exited. */
  close(): Promise<void>;
}

/** Registry of pipes opened by this process, for shutdown cleanup. */
const activePipes = new Set<PreviewPipe>();

export function listActivePreviewPipes(): PreviewPipe[] {
  return [...activePipes];
}

/** Close every pipe this process opened (idempotent, best-effort). */
export async function closeAllPreviewPipes(): Promise<void> {
  await Promise.all([...activePipes].map((pipe) => pipe.close()));
}

/**
 * Spawn `pipe expose` in the background and resolve once it is serving.
 * Rejects (fail closed) on invalid input, startup timeout, or early exit.
 */
export function openPreviewPipe(options: PreviewPipeOptions): Promise<PreviewPipe> {
  const ctx = options.dataDir !== undefined ? { dataDir: options.dataDir } : {};
  const exposeInput: PipeExposeInput = {
    roomId: options.roomId,
    tcp: options.tcp,
    allow: options.allow,
  };
  if (options.label !== undefined) exposeInput.label = options.label;
  if (options.ttlSeconds !== undefined) exposeInput.ttlSeconds = options.ttlSeconds;
  const args = buildPipeExposeArgs(ctx, exposeInput);

  return new Promise<PreviewPipe>((resolvePipe, rejectPipe) => {
    const spawnOptions: Parameters<typeof spawn>[2] = { detached: false };
    if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
    const child = spawn(options.binPath, args, spawnOptions);

    let stdoutText = '';
    let stderrText = '';
    let settled = false;

    const startTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectPipe(
        new Error(
          `pipe expose did not print a pipe_id within ${options.startTimeoutMs ?? DEFAULT_PIPE_START_TIMEOUT_MS}ms`,
        ),
      );
    }, options.startTimeoutMs ?? DEFAULT_PIPE_START_TIMEOUT_MS);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrText = (stderrText + chunk.toString('utf8')).slice(-8192);
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutText += chunk.toString('utf8');
      const { pipeId, connectHint } = parsePipeExposeOutput(stdoutText);
      if (pipeId === undefined) {
        return;
      }
      settled = true;
      clearTimeout(startTimer);

      const pipe: PreviewPipe = {
        pipeId,
        roomId: options.roomId,
        target: options.tcp,
        startedAt: new Date(),
        close(): Promise<void> {
          if (!activePipes.has(pipe)) {
            return Promise.resolve();
          }
          activePipes.delete(pipe);
          return new Promise<void>((resolveClose) => {
            const killTimer = setTimeout(() => child.kill('SIGKILL'), CLOSE_ESCALATION_MS);
            child.once('exit', () => {
              clearTimeout(killTimer);
              resolveClose();
            });
            child.kill('SIGINT');
          });
        },
      };
      if (options.label !== undefined) pipe.label = options.label;
      if (connectHint !== undefined) pipe.connectHint = connectHint;
      activePipes.add(pipe);
      child.on('exit', () => {
        // Owner exit (crash, expiry, remote close): drop from the registry.
        activePipes.delete(pipe);
      });
      resolvePipe(pipe);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      rejectPipe(new Error(`pipe expose spawn failed: ${String(error)}`));
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      rejectPipe(
        new Error(
          `pipe expose exited before printing a pipe_id (code=${code} signal=${signal}): ${redact(stderrText).trim()}`,
        ),
      );
    });
  });
}
