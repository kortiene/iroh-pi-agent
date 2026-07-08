/**
 * Worker orchestration tests: the pollOnce decision tree, mandatory priming,
 * and untrusted-input hardening — all through an injected runner, so no real
 * binary is ever spawned. Importing src/main.ts must be side-effect free
 * (entry-point guard); the fact this file runs at all proves it.
 */

import { describe, expect, it } from 'vitest';

import type { ResolvedWorkerConfig } from '../src/config.js';
import { MAX_STATUS_MESSAGE_BYTES, type Captured } from '../src/room-cli.js';
import {
  claimMessage,
  claimStatusMessage,
  parseCliArgs,
  pollOnce,
  primeSeenEvents,
  truncateBytes,
  type PiTaskDriver,
  type RunFn,
  type WorkerContext,
} from '../src/main.js';
import type { PiEventLike } from '../src/status-mapper.js';
import { AGENT_STATUS_STDOUT, ROOM_ID, ROOM_SEND_STDOUT } from './fixtures.js';

const OK = { returncode: 0, stderr: '' };

function tailStdout(rows: unknown[]): string {
  return `${JSON.stringify(rows)}\n`;
}

function taskRow(eventId: string, body: string): Record<string, unknown> {
  return { event_id: eventId, event_type: 'message.text', body, format: 'plain' };
}

function taskBlock(id: string, title = 'a task'): string {
  return `\`\`\`room-task\nid: ${id}\ntype: implement\ntitle: ${title}\n\`\`\``;
}

const EVENT_A = `blake3:${'a1'.repeat(32)}`;
const EVENT_B = `blake3:${'b2'.repeat(32)}`;

/** Categorize an argv for assertions: tail | send | status. */
function kindOf(args: readonly string[]): string {
  if (args.includes('tail')) return 'tail';
  if (args.includes('send')) return 'send';
  if (args.includes('status')) return 'status';
  return args.join(' ');
}

interface RecordingRunner {
  run: RunFn;
  calls: string[][];
  kinds: () => string[];
}

/**
 * Runner returning canned results: `tails` are consumed one per tail call
 * (the last one repeats); send/status succeed with realistic stdout. Pass
 * `onSend` to inject a failure mid-batch.
 */
function makeRunner(
  tails: Captured[],
  options: { onSend?: (call: number) => Captured } = {},
): RecordingRunner {
  const calls: string[][] = [];
  let tailCalls = 0;
  let sendCalls = 0;
  const run: RunFn = (_binPath, args) => {
    calls.push([...args]);
    const kind = kindOf(args);
    if (kind === 'tail') {
      const result = tails[Math.min(tailCalls, tails.length - 1)] as Captured;
      tailCalls += 1;
      return result;
    }
    if (kind === 'send') {
      sendCalls += 1;
      if (options.onSend !== undefined) {
        return options.onSend(sendCalls);
      }
      return { ...OK, stdout: ROOM_SEND_STDOUT };
    }
    return { ...OK, stdout: AGENT_STATUS_STDOUT };
  };
  return { run, calls, kinds: () => calls.map(kindOf) };
}

function fakePiDriver(events: PiEventLike[] = [
  { type: 'agent_start' },
  { type: 'tool_execution_start', toolName: 'edit' },
  { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] },
]): PiTaskDriver & { prompts: string[]; stopped: boolean } {
  const prompts: string[] = [];
  const driver: PiTaskDriver & { prompts: string[]; stopped: boolean } = {
    prompts,
    stopped: false,
    start: () => {},
    sendPrompt: async (message) => {
      prompts.push(message);
    },
    events: async function* () {
      for (const event of events) {
        yield event;
      }
    },
    getLastAssistantText: async () => 'implemented the requested task',
    stop: async () => {
      driver.stopped = true;
    },
  };
  return driver;
}

function makeCtx(runner: RecordingRunner, opts: { dryRun?: boolean; driver?: PiTaskDriver } = {}): WorkerContext {
  const config: ResolvedWorkerConfig = {
    roomId: ROOM_ID,
    agentName: 'pi-agent',
    artifactDir: '/w/artifacts',
    defaultPreviewHost: '127.0.0.1',
    defaultPreviewPort: 3000,
    allowedPreviewMembers: [],
    allowArtifactPathsOutsideWorkspace: false,
    cwd: '/w',
  };
  return {
    config,
    roomId: ROOM_ID,
    binPath: '/fake/iroh-rooms',
    cli: { dataDir: '/agent/home' },
    dryRun: opts.dryRun ?? false,
    seenEventIds: new Set<string>(),
    run: runner.run,
    piDriverFactory: () => opts.driver ?? fakePiDriver(),
  };
}

describe('pollOnce decision tree', () => {
  it('detects a new room-task and claims it through Pi RPC', async () => {
    const driver = fakePiDriver();
    const runner = makeRunner([{ ...OK, stdout: tailStdout([taskRow(EVENT_A, taskBlock('IR-PI-001'))]) }]);
    const ctx = makeCtx(runner, { driver });

    expect(await pollOnce(ctx, true)).toBe(true);

    // tail → claim send → claimed status → Pi status transitions → handoff send
    expect(runner.kinds()).toEqual(['tail', 'send', 'status', 'status', 'status', 'status', 'send']);
    const send = runner.calls[1]!;
    expect(send).toContain('Claiming task IR-PI-001 as pi-agent. I will post progress through agent.status and share artifacts when ready.');
    expect(send).toContain(ROOM_ID);
    const status = runner.calls[2]!;
    expect(status).toContain('--message=claimed IR-PI-001: a task');
    expect(status).toContain('--progress=5');
    expect(status).toContain('claimed');
    expect(ctx.seenEventIds.has(EVENT_A)).toBe(true);
    expect(driver.prompts[0]).toContain('/room-implement IR-PI-001');
    expect(driver.prompts[0]).toContain('```room-task');
    expect(driver.stopped).toBe(true);
    expect(runner.calls.filter((args) => args.includes('planning'))).toHaveLength(1);
    expect(runner.calls.filter((args) => args.includes('implementing'))).toHaveLength(1);
    expect(runner.calls.filter((args) => args.includes('ready_for_review'))).toHaveLength(1);
    expect(runner.calls.at(-1)).toContain('Task IR-PI-001 is ready for review.\n\nOutcome:\nPi completed successfully.\n\nSummary:\nimplemented the requested task\n\nArtifacts: none published by the worker yet.\nNext steps: review the room status trail and repository diff.');
  });

  it('does not send a ready-for-review handoff when Pi ends failed', async () => {
    const syntheticSecret = ['SEC', 'RET'].join('') + '=' + ['abc123', '456789'].join('');
    const driver = fakePiDriver([
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolName: 'bash', args: { command: 'npm run typecheck' } },
      { type: 'tool_execution_end', toolName: 'bash', isError: true, error: 'tsc exited 2' },
      { type: 'extension_error', message: `tool renderer failed with ${syntheticSecret}` },
      { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error' }] },
    ]);
    const runner = makeRunner([{ ...OK, stdout: tailStdout([taskRow(EVENT_A, taskBlock('IR-PI-FAIL'))]) }]);
    const ctx = makeCtx(runner, { driver });

    expect(await pollOnce(ctx, true)).toBe(true);

    expect(runner.calls.filter((args) => args.includes('failed'))).toHaveLength(1);
    const handoff = runner.calls.at(-1);
    expect(handoff?.some((arg) => arg.includes('Task IR-PI-FAIL is not ready for review.\n\nOutcome:\nPi ended with status "failed".'))).toBe(true);
    expect(handoff?.some((arg) => arg.includes('Diagnostics:\n- tool started: bash (npm run typecheck)\n- tool ended failed: bash: tsc exited 2'))).toBe(true);
    expect(handoff?.some((arg) => arg.includes('agent ended: stopReason=error'))).toBe(true);
    expect(handoff?.some((arg) => arg.includes(syntheticSecret))).toBe(false);
    expect(handoff?.some((arg) => arg.includes('SECRET=[REDACTED]'))).toBe(true);
    expect(handoff?.some((arg) => arg.includes('Next steps: inspect the failed/blocked status trail and rerun after fixing the cause.'))).toBe(true);
  });

  it('posts blocked when the Pi RPC drive fails after claim', async () => {
    const driver: PiTaskDriver = {
      start: () => {},
      sendPrompt: async () => {
        throw new Error('rpc unavailable');
      },
      events: async function* () {},
      getLastAssistantText: async () => '',
      stop: async () => {},
    };
    const runner = makeRunner([{ ...OK, stdout: tailStdout([taskRow(EVENT_A, taskBlock('IR-PI-ERR'))]) }]);
    const ctx = makeCtx(runner, { driver });

    expect(await pollOnce(ctx, true)).toBe(true);

    const blocked = runner.calls.find((args) => args.includes('blocked'));
    expect(blocked).toBeDefined();
    expect(blocked?.some((arg) => arg.includes('rpc unavailable'))).toBe(true);
  });

  it('skips already-seen events on the next poll (no duplicate claims)', async () => {
    const stdout = tailStdout([taskRow(EVENT_A, taskBlock('IR-PI-001'))]);
    const runner = makeRunner([{ ...OK, stdout }]);
    const ctx = makeCtx(runner);

    expect(await pollOnce(ctx, true)).toBe(true);
    const writesAfterFirst = runner.kinds().filter((k) => k !== 'tail').length;
    expect(await pollOnce(ctx, true)).toBe(true);
    const writesAfterSecond = runner.kinds().filter((k) => k !== 'tail').length;
    expect(writesAfterSecond).toBe(writesAfterFirst); // second poll: tail only
  });

  it('returns false on a tail failure and performs no writes', async () => {
    const runner = makeRunner([
      { returncode: 2, stdout: '', stderr: 'error[room_not_found]: no local room state\n' },
    ]);
    const ctx = makeCtx(runner);
    expect(await pollOnce(ctx, true)).toBe(false);
    expect(runner.kinds()).toEqual(['tail']);
    expect(ctx.seenEventIds.size).toBe(0);
  });

  it('returns false on corrupt tail JSON and performs no writes', async () => {
    const runner = makeRunner([{ ...OK, stdout: 'not json at all' }]);
    const ctx = makeCtx(runner);
    expect(await pollOnce(ctx, true)).toBe(false);
    expect(runner.kinds()).toEqual(['tail']);
  });

  it('dry-run never executes send/status — only the read-only tail', async () => {
    const runner = makeRunner([{ ...OK, stdout: tailStdout([taskRow(EVENT_A, taskBlock('IR-PI-001'))]) }]);
    const ctx = makeCtx(runner, { dryRun: true });
    expect(await pollOnce(ctx, true)).toBe(true);
    expect(runner.kinds()).toEqual(['tail']);
  });
});

describe('untrusted room content never crashes the worker', () => {
  it('a task with an oversized title is still claimed (truncated), not a crash', async () => {
    const hugeTitle = 'x'.repeat(5000);
    const runner = makeRunner([{ ...OK, stdout: tailStdout([taskRow(EVENT_A, taskBlock('IR-PI-666', hugeTitle))]) }]);
    const ctx = makeCtx(runner);

    // Old behavior: CliValidationError ("status message must be at most 4096
    // bytes") escaped pollOnce and killed the worker.
    let ok = false;
    ok = await pollOnce(ctx, true);
    expect(ok).toBe(true);
    expect(ctx.seenEventIds.has(EVENT_A)).toBe(true);

    // The claim went out, with the status message truncated under the limit.
    expect(runner.kinds()).toContain('send');
    const status = runner.calls.find((args) => kindOf(args) === 'status')!;
    const message = status.find((arg) => arg.startsWith('--message='))!;
    expect(Buffer.byteLength(message.slice('--message='.length), 'utf8')).toBeLessThanOrEqual(
      MAX_STATUS_MESSAGE_BYTES,
    );
    expect(message).toContain('claimed IR-PI-666:');
  });

  it('a failing claim does not abandon sibling tasks in the same batch', async () => {
    const body = `${taskBlock('IR-PI-001')}\n\n${taskBlock('IR-PI-002')}`;
    const runner = makeRunner([{ ...OK, stdout: tailStdout([taskRow(EVENT_A, body)]) }], {
      onSend: (call) => {
        if (call === 1) {
          throw new Error('synthetic validation failure for the first claim');
        }
        return { ...OK, stdout: ROOM_SEND_STDOUT };
      },
    });
    const ctx = makeCtx(runner);

    expect(await pollOnce(ctx, true)).toBe(true);
    const sends = runner.calls.filter((args) => kindOf(args) === 'send');
    expect(sends.length).toBeGreaterThanOrEqual(2); // second task still attempted
    expect(sends[1]!.some((arg) => arg.includes('IR-PI-002'))).toBe(true);
  });
});

describe('primeSeenEvents (mandatory priming, never fail open)', () => {
  const historicalTail = { ...OK, stdout: tailStdout([taskRow(EVENT_B, taskBlock('OLD-HISTORICAL-1'))]) };
  const failedTail = { returncode: 2, stdout: '', stderr: 'error[room_not_found]: transient local lock\n' };

  it('retries after a failed priming read and never claims historical tasks', async () => {
    const runner = makeRunner([failedTail, historicalTail]);
    const ctx = makeCtx(runner);
    const sleeps: number[] = [];

    const primed = await primeSeenEvents(ctx, {
      maxAttempts: 5,
      initialDelayMs: 10,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(primed).toBe(true);
    expect(sleeps).toEqual([10]); // one retry
    expect(ctx.seenEventIds.has(EVENT_B)).toBe(true);
    // Priming must never write — old behavior claimed OLD-HISTORICAL-1 here.
    expect(runner.kinds()).toEqual(['tail', 'tail']);

    // And the first acting poll treats the backlog as seen: still no writes.
    expect(await pollOnce(ctx, true)).toBe(true);
    expect(runner.kinds()).toEqual(['tail', 'tail', 'tail']);
  });

  it('reports failure after bounded attempts so the caller can refuse to act', async () => {
    const runner = makeRunner([failedTail]);
    const ctx = makeCtx(runner);
    let slept = 0;

    const primed = await primeSeenEvents(ctx, {
      maxAttempts: 3,
      initialDelayMs: 1,
      sleepFn: async () => {
        slept += 1;
      },
    });

    expect(primed).toBe(false);
    expect(slept).toBe(2); // sleeps between attempts only
    expect(runner.kinds()).toEqual(['tail', 'tail', 'tail']);
    expect(ctx.seenEventIds.size).toBe(0);
  });
});

describe('parseCliArgs', () => {
  it('parses the documented flags', () => {
    expect(parseCliArgs(['--once', '--dry-run', '--poll-interval', '9'])).toEqual({
      once: true,
      dryRun: true,
      pollIntervalSeconds: 9,
      help: false,
    });
    expect(parseCliArgs(['--room', ROOM_ID, '--data-dir', '/agent/home'])).toMatchObject({
      room: ROOM_ID,
      dataDir: '/agent/home',
    });
  });

  it('fails closed on unknown flags, missing values, and bad intervals', () => {
    expect(() => parseCliArgs(['--wat'])).toThrowError(/unknown flag/);
    expect(() => parseCliArgs(['--room'])).toThrowError(/requires a value/);
    expect(() => parseCliArgs(['--poll-interval', '0'])).toThrowError(/positive integer/);
    expect(() => parseCliArgs(['--poll-interval', 'abc'])).toThrowError(/positive integer/);
  });
});

describe('untrusted-field truncation helpers', () => {
  it('truncateBytes cuts on UTF-8 boundaries and marks the cut', () => {
    expect(truncateBytes('short', 100)).toBe('short');
    const cut = truncateBytes('é'.repeat(3000), 4096); // 6000 bytes in
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(4096);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toContain('�');
  });

  it('claim/status messages always fit the protocol limits', () => {
    const monster = {
      id: 'I'.repeat(20_000),
      type: 'implement' as const,
      title: 'T'.repeat(20_000),
      acceptance: [],
      extra: {},
    };
    expect(Buffer.byteLength(claimStatusMessage(monster), 'utf8')).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(claimMessage(monster, 'pi-agent'), 'utf8')).toBeLessThanOrEqual(16_384);
  });
});
