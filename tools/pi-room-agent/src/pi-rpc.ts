/**
 * SCAFFOLD — Pi RPC JSONL client (compiles, correct framing, NOT yet
 * exercised end-to-end; see README "next steps").
 *
 * Speaks the `pi --mode rpc` protocol (pi-coding-agent docs/rpc.md):
 *   - commands  = JSON objects written to stdin, one per line
 *   - responses = {"type":"response","command":...,"success":...,"id"?...}
 *   - events    = every other JSON line streamed on stdout
 *
 * FRAMING (protocol requirement): strict JSONL with LF as the only record
 * delimiter, tolerating a trailing '\r'. Node's readline is NOT compliant —
 * it also splits on U+2028/U+2029, which are legal inside JSON strings — so
 * this module uses StringDecoder + a manual "\n" scan, per docs/rpc.md.
 *
 * TRUST GOTCHA: non-interactive modes never show the trust prompt; without
 * `--approve` (-a) or a saved trust decision, project-local .pi/ resources
 * (the iroh-room extension, skills, prompts) are silently IGNORED. The
 * worker therefore spawns pi with `-a` by default.
 *
 * TODO(scaffold):
 *  - handle extension_ui_request/extension_ui_response round-trips (currently
 *    surfaced as ordinary events; requests with a timeout auto-resolve on the
 *    pi side, so nothing hangs, but interactive extensions are not answered)
 *  - surface post-acceptance prompt failures (they arrive via the event
 *    stream, not as a second response) to sendPrompt callers
 *  - restart/backoff policy when the pi process dies mid-run
 *  - integration test against a real `pi --mode rpc` child
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

export interface PiRpcResponse {
  type: 'response';
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface PiRpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiRpcClientOptions {
  /** Path or name of the pi binary (default: "pi" on PATH). */
  piBin?: string;
  cwd?: string;
  /** Pass -a so project .pi/ resources load headlessly (default: true). */
  approveProjectResources?: boolean;
  /** Extra CLI args, e.g. ["--provider","anthropic","--model","..."]. */
  extraArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Called for lines that are not valid JSON (protocol violation). */
  onProtocolError?: (line: string, error: unknown) => void;
}

/**
 * Protocol-compliant JSONL reader: StringDecoder + manual "\n" scan
 * (never Node readline — see module header). Exported for reuse/testing.
 */
export function attachJsonlReader(
  stream: Readable,
  onRecord: (record: unknown) => void,
  onProtocolError?: (line: string, error: unknown) => void,
): void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const consume = (line: string): void => {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (trimmed === '') {
      return;
    }
    try {
      onRecord(JSON.parse(trimmed));
    } catch (error) {
      onProtocolError?.(trimmed, error);
    }
  };
  stream.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      consume(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => {
    buffer += decoder.end();
    if (buffer !== '') {
      consume(buffer);
      buffer = '';
    }
  });
}

interface PendingRequest {
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
}

/**
 * Long-lived `pi --mode rpc` child process client.
 *
 * Lifecycle: construct -> start() -> sendPrompt()/events()/... -> stop().
 * events() is a single-consumer async iterator over all non-response records.
 */
export class PiRpcClient {
  private readonly options: PiRpcClientOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventQueue: PiRpcEvent[] = [];
  private eventWaiter: (() => void) | null = null;
  private closed = false;
  private stderrTail = '';

  constructor(options: PiRpcClientOptions = {}) {
    this.options = options;
  }

  /** Spawn the pi child and wire up the protocol reader. */
  start(): void {
    if (this.child !== null) {
      throw new Error('PiRpcClient already started');
    }
    const args = ['--mode', 'rpc', '--no-session'];
    if (this.options.approveProjectResources !== false) {
      args.push('-a');
    }
    if (this.options.extraArgs !== undefined) {
      args.push(...this.options.extraArgs);
    }
    const spawnOptions: Parameters<typeof spawn>[2] = {};
    if (this.options.cwd !== undefined) spawnOptions.cwd = this.options.cwd;
    if (this.options.env !== undefined) spawnOptions.env = this.options.env;
    const child = spawn(this.options.piBin ?? 'pi', args, spawnOptions) as ChildProcessWithoutNullStreams;
    this.child = child;

    attachJsonlReader(
      child.stdout,
      (record) => this.route(record),
      this.options.onProtocolError,
    );
    // Keep a bounded stderr tail for diagnostics on unexpected exit.
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4096);
    });
    child.on('error', (error) => this.teardown(new Error(`pi rpc spawn failed: ${String(error)}`)));
    child.on('exit', (code, signal) => {
      this.teardown(
        new Error(`pi rpc process exited (code=${code} signal=${signal}) stderr: ${this.stderrTail}`),
      );
    });
  }

  private route(record: unknown): void {
    if (typeof record !== 'object' || record === null) {
      return;
    }
    const value = record as Record<string, unknown>;
    if (value['type'] === 'response') {
      const response = value as unknown as PiRpcResponse;
      const id = typeof response.id === 'string' ? response.id : undefined;
      if (id !== undefined && this.pending.has(id)) {
        const request = this.pending.get(id) as PendingRequest;
        this.pending.delete(id);
        if (response.success) {
          request.resolve(response);
        } else {
          request.reject(new Error(`pi rpc ${response.command} failed: ${response.error ?? 'unknown error'}`));
        }
      }
      return;
    }
    if (typeof value['type'] === 'string') {
      this.eventQueue.push(value as PiRpcEvent);
      this.wakeEventWaiter();
    }
  }

  private wakeEventWaiter(): void {
    if (this.eventWaiter !== null) {
      const waiter = this.eventWaiter;
      this.eventWaiter = null;
      waiter();
    }
  }

  private teardown(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
    this.wakeEventWaiter();
  }

  /** Send one raw RPC command and await its response (fails closed on error). */
  sendCommand(command: Record<string, unknown>): Promise<PiRpcResponse> {
    const child = this.child;
    if (child === null || this.closed) {
      return Promise.reject(new Error('PiRpcClient is not running (call start() first)'));
    }
    const id = `req-${this.nextRequestId++}`;
    const payload = JSON.stringify({ ...command, id });
    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(payload + '\n', (error) => {
        if (error) {
          this.pending.delete(id);
          reject(new Error(`pi rpc stdin write failed: ${String(error)}`));
        }
      });
    });
  }

  /**
   * Send a user prompt. Resolution means ACCEPTED/queued — completion is
   * signaled by the `agent_end` event on events().
   */
  async sendPrompt(message: string): Promise<void> {
    await this.sendCommand({ type: 'prompt', message });
  }

  /**
   * Async iterator over all streamed events (agent_start, message_*,
   * tool_execution_*, agent_end, ...). Single consumer. Ends when the pi
   * process exits or stop() is called.
   */
  async *events(): AsyncGenerator<PiRpcEvent, void, void> {
    for (;;) {
      const next = this.eventQueue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.eventWaiter = resolve;
      });
    }
  }

  /** Fetch the final assistant text (RPC get_last_assistant_text). */
  async getLastAssistantText(): Promise<string> {
    const response = await this.sendCommand({ type: 'get_last_assistant_text' });
    if (typeof response.data === 'object' && response.data !== null) {
      const text = (response.data as Record<string, unknown>)['text'];
      if (typeof text === 'string') {
        return text;
      }
    }
    return '';
  }

  /**
   * Stop the child: close stdin (pi exits on EOF), escalate to SIGTERM after
   * 3s and SIGKILL after 5s. Idempotent.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (child === null) {
      return;
    }
    if (this.closed) {
      this.child = null;
      return;
    }
    await new Promise<void>((resolve) => {
      const timers: NodeJS.Timeout[] = [];
      const finish = (): void => {
        for (const timer of timers) clearTimeout(timer);
        resolve();
      };
      child.once('exit', finish);
      child.once('error', finish);
      child.stdin.end();
      timers.push(setTimeout(() => child.kill('SIGTERM'), 3000));
      timers.push(setTimeout(() => child.kill('SIGKILL'), 5000));
    });
    this.child = null;
  }
}
