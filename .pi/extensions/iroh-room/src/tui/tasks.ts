/**
 * Room-task detector + tracker for the pulse/card task slots (brief §3.5, §4 M2).
 *
 * THREE-WAY GRAMMAR LOCKSTEP (do not edit casually):
 * - tools/pi-room-agent/src/task-parser.ts is the CANONICAL ```room-task
 *   grammar (fence rules + required-field gate);
 * - .pi/skills/iroh-room-agent/scripts/parse-room-task.ts is its standalone
 *   line-for-line port (the worker's conformance suite diffs the two);
 * - THIS detector duplicates the same grammar for the TUI: the four fence
 *   regexes below are copied VERBATIM from task-parser.ts:71–74, and the
 *   required-field gate (id/type/title present and non-empty after KEY_VALUE
 *   parsing of top-level lines, stripInlineQuotes one matching layer,
 *   duplicate keys last-wins, type ∈ implement|debug|review|document|test)
 *   matches its parseBlock validation. Without the gate the pulse would
 *   permanently over-count vs what the worker will claim.
 *   test/tui-task-conformance.test.mjs spawns the skill script over a shared
 *   hostile corpus and asserts EXACT id-set equality with this detector —
 *   a grammar change must land in all three files or CI fails.
 *
 * Tracker semantics (brief §4 M2):
 * - only message.text bodies are scanned for tasks;
 * - a task counts as CLAIMED when a message.text body starts with
 *   "Claiming task <id>" (the worker's claim message — sufficient alone,
 *   the claimed agent.status can legitimately never arrive) OR an
 *   agent.status row with row.state === "claimed" whose message mentions the
 *   id. row.state carries the status label; row.STATUS is MEMBERSHIP state
 *   ("active"…) on every row and must never be read here (brief §2.5).
 *   Claim signals are matched order-insensitively: gossip backfill can
 *   surface the claim row before the task row within one poll window.
 * - unclaimed = extracted − claimed, capped at UNCLAIMED_TASK_CAP; the count
 *   is a heuristic and every rendered surface must keep it ~-marked.
 *
 * PURE module: no pi/pi-tui imports, no timers, no IO. Room content is
 * untrusted — nothing here throws on hostile input.
 */

import { UNCLAIMED_TASK_CAP } from "../constants.js";

/* ------------------------------------------------------------------ */
/* detector (grammar lockstep — see module header)                     */
/* ------------------------------------------------------------------ */

/*
 * Fence rules follow CommonMark: fences may be indented at most 3 spaces.
 * A room-task block opens with EXACTLY three backticks. Any other
 * 3+-backtick fence line opens a "foreign" fence (```js, ```markdown,
 * ````…), and everything inside it — including ```room-task openers — is
 * quoted content, not a claimable task. A foreign fence closes on a
 * backtick-only line with at least as many backticks as its opener.
 * Copied VERBATIM from tools/pi-room-agent/src/task-parser.ts:71–74.
 */
const FENCE_OPEN = /^ {0,3}```room-task\s*$/;
const FENCE_CLOSE = /^ {0,3}```\s*$/;
const FOREIGN_FENCE_OPEN = /^ {0,3}(`{3,})/;
const FOREIGN_FENCE_CLOSE = /^ {0,3}(`{3,})\s*$/;
/** `key: value` (value optional). Key charset excludes ':' so values may contain colons. */
const KEY_VALUE = /^([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/;

const ROOM_TASK_TYPES = ["implement", "debug", "review", "document", "test"] as const;

/** The valid-task projection the TUI needs (canonical parser keeps more). */
export interface DetectedTask {
	id: string;
	type: string;
	/** Room-authored — every rendered use must pass roomText. */
	title: string;
}

/** Strip one layer of matching surrounding single or double quotes. */
function stripInlineQuotes(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

/**
 * Extract the line-arrays of every properly fenced room-task block, tracking
 * enclosing foreign fences so a quoted example is never treated as a real
 * task. Mirrors the canonical extractBlocks (errors dropped, not reported);
 * an unterminated block is ignored, exactly like the canonical parser.
 */
function extractBlocks(text: string): string[][] {
	const lines = text.split(/\r?\n/);
	const blocks: string[][] = [];
	let current: string[] | null = null;
	/** Backtick count of the open foreign fence, or null when outside one. */
	let foreignFenceLen: number | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (current === null) {
			if (foreignFenceLen !== null) {
				const close = FOREIGN_FENCE_CLOSE.exec(line);
				if (close !== null && (close[1] as string).length >= foreignFenceLen) {
					foreignFenceLen = null;
				}
				continue; // quoted content, including any ```room-task opener
			}
			if (FENCE_OPEN.test(line)) {
				current = [];
				continue;
			}
			const foreign = FOREIGN_FENCE_OPEN.exec(line);
			if (foreign !== null) {
				foreignFenceLen = (foreign[1] as string).length;
			}
			continue;
		}
		if (FENCE_CLOSE.test(line)) {
			blocks.push(current);
			current = null;
			continue;
		}
		current.push(line);
	}
	return blocks;
}

/**
 * The canonical required-field gate over one block's TOP-LEVEL lines only:
 * indented lines belong to list/map contexts and never define scalars.
 * Duplicate keys: last wins (object-assignment semantics, like the
 * canonical parser). Returns null when id/type/title are missing/empty or
 * the type is outside the vocabulary.
 */
function parseBlockTask(lines: string[]): DetectedTask | null {
	const scalars: Record<string, string> = {};
	for (const line of lines) {
		if (line.trim() === "") {
			continue;
		}
		if (/^\s/.test(line)) {
			continue; // indented: acceptance/budget content, never a scalar
		}
		const match = KEY_VALUE.exec(line);
		if (match === null) {
			continue;
		}
		const key = match[1] as string;
		if (key !== "id" && key !== "type" && key !== "title") {
			continue;
		}
		scalars[key] = stripInlineQuotes((match[2] as string).trim());
	}
	const id = scalars["id"];
	const type = scalars["type"];
	const title = scalars["title"];
	if (id === undefined || id === "" || title === undefined || title === "") {
		return null;
	}
	if (type === undefined || type === "" || !(ROOM_TASK_TYPES as readonly string[]).includes(type)) {
		return null;
	}
	return { id, type, title };
}

/**
 * Detect every VALID ```room-task block in a message body. Never throws.
 * Accepts exactly the id set the canonical grammar accepts (conformance-tested).
 */
export function detectTasks(text: string): DetectedTask[] {
	const tasks: DetectedTask[] = [];
	for (const block of extractBlocks(text)) {
		const task = parseBlockTask(block);
		if (task !== null) {
			tasks.push(task);
		}
	}
	return tasks;
}

/* ------------------------------------------------------------------ */
/* tracker                                                             */
/* ------------------------------------------------------------------ */

/** The worker's claim message: `Claiming task ${id} as ${agentName}. …` */
const CLAIM_PREFIX = "Claiming task ";
/** Memory bounds on hostile floods (FIFO eviction; heuristic counts only). */
const MAX_TRACKED_TASKS = 200;
const MAX_CLAIM_SIGNALS = 200;
/** Claim signals are compared as prefixes/substrings; cap their length. */
const MAX_SIGNAL_CHARS = 512;

/** Id-ish charset for claim boundaries (avoids IR-1 matching a claim of IR-10). */
const ID_CHAR_RE = /[A-Za-z0-9_.-]/;

function startsAtBoundary(rest: string, id: string): boolean {
	if (!rest.startsWith(id)) {
		return false;
	}
	const next = rest[id.length];
	return next === undefined || !ID_CHAR_RE.test(next);
}

function mentionsId(text: string, id: string): boolean {
	let from = 0;
	for (;;) {
		const index = text.indexOf(id, from);
		if (index === -1) {
			return false;
		}
		const before = text[index - 1];
		const after = text[index + id.length];
		if (
			(before === undefined || !ID_CHAR_RE.test(before)) &&
			(after === undefined || !ID_CHAR_RE.test(after))
		) {
			return true;
		}
		from = index + 1;
	}
}

/** Structural tail-row slice the tracker reads (TailRow-compatible). */
export interface TaskRowLike {
	event_type?: unknown;
	body?: unknown;
	state?: unknown;
	message?: unknown;
	[key: string]: unknown;
}

export interface TaskTrackerOptions {
	unclaimedCap?: number;
	maxTracked?: number;
	maxSignals?: number;
}

export class TaskTracker {
	private readonly unclaimedCap: number;
	private readonly maxTracked: number;
	private readonly maxSignals: number;
	/** id -> latest task (insertion order = tracking age; last-wins refresh). */
	private tasks = new Map<string, DetectedTask>();
	/** Body remainders after "Claiming task " (prefix-matched per id). */
	private claimRests: string[] = [];
	/** agent.status messages with state === "claimed" (id mention-matched). */
	private claimStatusMessages: string[] = [];
	/**
	 * Memoized unclaimed() result. The pulse widget reads unclaimedCount() on
	 * EVERY render frame (per keystroke), while the claimed-set only changes
	 * in ingest()/reset() — without this cache a hostile flood at the tracker
	 * caps costs O(tasks × signals) substring scans per repaint (tens of ms,
	 * multiple frame budgets) for the rest of the session. Treat the cached
	 * array as read-only.
	 */
	private unclaimedCache: DetectedTask[] | undefined;

	constructor(options: TaskTrackerOptions = {}) {
		this.unclaimedCap = options.unclaimedCap ?? UNCLAIMED_TASK_CAP;
		this.maxTracked = options.maxTracked ?? MAX_TRACKED_TASKS;
		this.maxSignals = options.maxSignals ?? MAX_CLAIM_SIGNALS;
	}

	/**
	 * Scan rows for tasks (message.text bodies only) and claim signals.
	 * Returns tasks whose ids were not tracked before this call (toast input).
	 * Never throws on hostile rows.
	 */
	ingest(rows: readonly TaskRowLike[]): DetectedTask[] {
		this.unclaimedCache = undefined; // tasks/claim signals may change below
		const fresh: DetectedTask[] = [];
		for (const row of rows) {
			if (row === null || typeof row !== "object") {
				continue;
			}
			if (row.event_type === "message.text" && typeof row.body === "string") {
				const body = row.body;
				if (body.startsWith(CLAIM_PREFIX)) {
					this.pushSignal(this.claimRests, body.slice(CLAIM_PREFIX.length));
				}
				for (const task of detectTasks(body)) {
					if (!this.tasks.has(task.id)) {
						fresh.push(task);
					} else {
						this.tasks.delete(task.id); // refresh insertion order
					}
					this.tasks.set(task.id, task);
					while (this.tasks.size > this.maxTracked) {
						const oldest = this.tasks.keys().next().value as string | undefined;
						if (oldest === undefined) {
							break;
						}
						this.tasks.delete(oldest);
					}
				}
				continue;
			}
			// row.state is the status label; row.status is MEMBERSHIP — never
			// read row.status here (brief §2.5).
			if (
				row.event_type === "agent.status" &&
				row.state === "claimed" &&
				typeof row.message === "string"
			) {
				this.pushSignal(this.claimStatusMessages, row.message);
			}
		}
		return fresh;
	}

	private pushSignal(list: string[], signal: string): void {
		list.push(signal.slice(0, MAX_SIGNAL_CHARS));
		while (list.length > this.maxSignals) {
			list.shift();
		}
	}

	private isClaimed(id: string): boolean {
		return (
			this.claimRests.some((rest) => startsAtBoundary(rest, id)) ||
			this.claimStatusMessages.some((message) => mentionsId(message, id))
		);
	}

	/** Unclaimed tasks (extracted − claimed), capped; heuristic, always ~-marked.
	 * Memoized between ingests (see unclaimedCache) — callers must not mutate. */
	unclaimed(): DetectedTask[] {
		if (this.unclaimedCache !== undefined) {
			return this.unclaimedCache;
		}
		const result: DetectedTask[] = [];
		for (const task of this.tasks.values()) {
			if (!this.isClaimed(task.id)) {
				result.push(task);
				if (result.length >= this.unclaimedCap) {
					break;
				}
			}
		}
		this.unclaimedCache = result;
		return result;
	}

	unclaimedCount(): number {
		return this.unclaimed().length;
	}

	/** Every tracked task id (completions filter shapes downstream, U5). */
	taskIds(): string[] {
		return [...this.tasks.keys()];
	}

	reset(): void {
		this.tasks = new Map();
		this.claimRests = [];
		this.claimStatusMessages = [];
		this.unclaimedCache = undefined;
	}
}
