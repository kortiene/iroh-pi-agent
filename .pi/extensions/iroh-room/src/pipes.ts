/**
 * PipeManager — supervises background `iroh-rooms pipe expose` children.
 *
 * `pipe expose` BLOCKS while serving (until Ctrl-C), so it cannot go through
 * pi.exec. We spawn it detached:false, watch stdout until the `pipe_id:` line
 * appears (deadline 20s), keep the child in a registry, and close it with
 * SIGINT (the CLI's Ctrl-C path publishes pipe.closed) escalating to SIGKILL
 * after 5s. closeAll() is idempotent and wired to session_shutdown.
 *
 * No pi imports — node:child_process only — so tests can drive it directly.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { PIPE_CLOSE_GRACE_MS, PIPE_ID_PARSE_TIMEOUT_MS } from "./constants.js";
import { redact } from "./redact.js";

const PIPE_ID_LINE_RE = /^pipe_id:\s*([0-9a-f]{32})\s*$/m;
const CONNECT_HINT_RE = /^connectors run:\s*(.+)$/m;
/** Stop buffering child output past this point (pipes can run for hours). */
const MAX_CAPTURE_BYTES = 65_536;

export interface PipeRecord {
	pipeId: string;
	roomId: string;
	target: string;
	label?: string;
	startedAt: number;
	connectHint?: string;
}

interface PipeEntry {
	record: PipeRecord;
	child: ChildProcess;
}

export interface ExposeOptions {
	bin: string;
	args: string[];
	roomId: string;
	target: string;
	label?: string;
	cwd?: string;
	/** Override for tests; defaults to the 20s pipe_id parse deadline. */
	parseTimeoutMs?: number;
}

export class PipeManager {
	private readonly pipes = new Map<string, PipeEntry>();

	/**
	 * Spawn `pipe expose` and resolve once the pipe_id line appears on stdout.
	 * Throws (local error) if the child exits early, cannot spawn, or does not
	 * print a pipe_id within the deadline — with redacted stderr attached.
	 */
	async expose(options: ExposeOptions): Promise<{ record: PipeRecord; stdout: string }> {
		const timeoutMs = options.parseTimeoutMs ?? PIPE_ID_PARSE_TIMEOUT_MS;
		const spawnOptions: { cwd?: string; stdio: ["ignore", "pipe", "pipe"]; detached: false } = {
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		};
		if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
		const child = spawn(options.bin, options.args, spawnOptions);

		let stdout = "";
		let stderr = "";
		return await new Promise((resolve, reject) => {
			let settled = false;
			let record: PipeRecord | undefined;

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				child.kill("SIGKILL");
				reject(
					new Error(
						`pipe expose did not print a pipe_id within ${timeoutMs}ms; killed it. stderr: ${redact(stderr).trim() || "(empty)"}`,
					),
				);
			}, timeoutMs);
			timer.unref?.();

			child.stdout?.on("data", (chunk: Buffer) => {
				if (stdout.length < MAX_CAPTURE_BYTES) {
					stdout += chunk.toString("utf8");
				}
				if (record !== undefined) {
					// The `connectors run:` hint prints after pipe_id; backfill it.
					if (record.connectHint === undefined) {
						const hint = CONNECT_HINT_RE.exec(stdout)?.[1];
						if (hint !== undefined) record.connectHint = hint.trim();
					}
					return;
				}
				if (settled) return;
				const match = PIPE_ID_LINE_RE.exec(stdout);
				if (!match || match[1] === undefined) return;
				settled = true;
				clearTimeout(timer);
				record = {
					pipeId: match[1],
					roomId: options.roomId,
					target: options.target,
					startedAt: Date.now(),
				};
				if (options.label !== undefined) record.label = options.label;
				const hint = CONNECT_HINT_RE.exec(stdout)?.[1];
				if (hint !== undefined) record.connectHint = hint.trim();
				const pipeId = record.pipeId;
				this.pipes.set(pipeId, { record, child });
				child.once("exit", () => {
					this.pipes.delete(pipeId);
				});
				resolve({ record, stdout });
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				if (stderr.length < MAX_CAPTURE_BYTES) {
					stderr += chunk.toString("utf8");
				}
			});
			child.once("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(new Error(`failed to spawn ${options.bin}: ${err.message}`));
			});
			child.once("exit", (code, signal) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(
					new Error(
						`pipe expose exited (${signal ?? `code ${code}`}) before printing a pipe_id. stderr: ${redact(stderr).trim() || "(empty)"}`,
					),
				);
			});
		});
	}

	/** Records of the pipes this session owns (registry only, no CLI call). */
	list(): PipeRecord[] {
		return [...this.pipes.values()].map((entry) => entry.record);
	}

	has(pipeId: string): boolean {
		return this.pipes.has(pipeId);
	}

	/**
	 * Close one of our pipes: SIGINT, wait up to 5s for a clean exit (the CLI
	 * publishes pipe.closed on Ctrl-C), then SIGKILL. Returns false when the
	 * pipe is not in the registry (safe to call twice).
	 */
	async close(pipeId: string): Promise<boolean> {
		const entry = this.pipes.get(pipeId);
		if (entry === undefined) {
			return false;
		}
		this.pipes.delete(pipeId);
		const { child } = entry;
		if (child.exitCode !== null || child.signalCode !== null) {
			return true;
		}
		await new Promise<void>((resolve) => {
			let done = false;
			const finish = (): void => {
				if (done) return;
				done = true;
				clearTimeout(killTimer);
				clearTimeout(hardTimer);
				resolve();
			};
			const killTimer = setTimeout(() => {
				child.kill("SIGKILL");
			}, PIPE_CLOSE_GRACE_MS);
			killTimer.unref?.();
			// Absolute fallback so close() can never hang the caller.
			const hardTimer = setTimeout(finish, PIPE_CLOSE_GRACE_MS + 2_000);
			hardTimer.unref?.();
			child.once("exit", finish);
			child.kill("SIGINT");
			if (child.exitCode !== null || child.signalCode !== null) {
				finish();
			}
		});
		return true;
	}

	/** Close every registered pipe. Idempotent; used by session_shutdown. */
	async closeAll(): Promise<string[]> {
		const ids = [...this.pipes.keys()];
		await Promise.all(ids.map((id) => this.close(id)));
		return ids;
	}
}
