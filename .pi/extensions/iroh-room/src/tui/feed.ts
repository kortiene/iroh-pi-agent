/**
 * RoomFeedStore (brief §4 M1): the pure diff core behind the pulse widget,
 * footer pill, and (M2) toast classifier.
 *
 * PURE + transport-agnostic: the store ingests ALREADY-PARSED TailRow[]
 * (cli.ts parseTailJson) — it never shells out and never parses JSON, so a
 * live-tail stream child (UP-102) can replace the poll shell later without
 * touching this module.
 *
 * Change detection is a seen-ring, not a bare lamport watermark: tail rows
 * arrive in ascending (lamport, event_id) order over the most-recent --limit
 * window, and causally-incomplete events can surface LATER with
 * lamport <= max (gossip backfill). A pure watermark silently drops those;
 * the ring (capacity-capped, evicting the lowest (lamport ?? -1, event_id))
 * tolerates backfill within its window.
 *
 * Failure taxonomy (brief §2.1) — `room tail --offline` is a pure local
 * sqlite read, so "no_admin_reachable" is IMPOSSIBLE here and must never be
 * rendered. Real failures: coded CLI errors (exit 2: room_not_found /
 * invalid_room_id), uncoded nonzero exits (store corruption), and THROWN
 * local errors from runCli (binary missing, spawn failure, timeout).
 *
 * Staleness is DERIVED at render time from `now - lastOkAt` — the store
 * keeps no stale flag that could rot.
 *
 * Note on cost: `room tail --offline` re-validates and folds the whole room
 * log each call — cost grows with total log size, not with --limit.
 */

import type { TailRow } from "../cli.js";
import { SEEN_RING_CAPACITY } from "../constants.js";

/* ------------------------------------------------------------------ */
/* failure taxonomy                                                    */
/* ------------------------------------------------------------------ */

export type FeedFailureKind = "coded" | "exit" | "binary_missing" | "timeout" | "local";

export interface FeedFailure {
	kind: FeedFailureKind;
	/** CLI exit code (kind "coded" / "exit"). */
	exitCode?: number;
	/** Coded error from stderr `error[<code>]:` (kind "coded"). */
	errorCode?: string;
	/** Local error message (kind "local"); NOT room-authored, still fitted. */
	message?: string;
}

/** Map a non-ok CliRunResult (runCli returned, not threw) onto the taxonomy. */
export function failureFromRun(run: { code: number; errorCode?: string }): FeedFailure {
	if (run.errorCode !== undefined) {
		return { kind: "coded", exitCode: run.code, errorCode: run.errorCode };
	}
	return { kind: "exit", exitCode: run.code };
}

/**
 * Classify a THROWN poll error (runCli/resolveBinary local failures).
 * runCli timeout: "iroh-rooms did not finish within <N>ms (killed)".
 * Binary problems: resolveBinary "…binary not found / does not exist / not a
 * file", or a spawn ENOENT surfaced through "failed to run <bin> …".
 */
export function classifyPollError(err: unknown): FeedFailure {
	const message = err instanceof Error ? err.message : String(err);
	if (/did not finish within \d+ms/.test(message)) {
		return { kind: "timeout" };
	}
	if (/ENOENT/.test(message) || /binary/i.test(message)) {
		return { kind: "binary_missing" };
	}
	return { kind: "local", message };
}

/** Render text for the degraded pulse: "poll failed (…)" per brief §2.1. */
export function describePollFailure(failure: FeedFailure): string {
	switch (failure.kind) {
		case "coded":
			return `poll failed (${failure.errorCode ?? "error"})`;
		case "exit":
			return `poll failed (exit ${failure.exitCode ?? "?"})`;
		case "binary_missing":
			return "poll failed (binary missing)";
		case "timeout":
			return "poll failed (timeout)";
		default:
			return "poll failed (local error)";
	}
}

/* ------------------------------------------------------------------ */
/* store                                                               */
/* ------------------------------------------------------------------ */

export interface FeedDelta {
	/** Rows never seen before (string event_id required; others skipped). */
	freshRows: TailRow[];
	/** All polled rows were unseen while a watermark exists (window overrun). */
	gap: boolean;
	/** Set exactly once per gap episode: caller should run ONE deep repair poll. */
	repair: boolean;
	/** This ingest ended a failure episode. */
	recovered: boolean;
}

/** Pure render view. Row references are the parsed rows (room-authored —
 * every renderer must pass their strings through roomText). */
export interface FeedSnapshot {
	/** init() ran (backlog suppression happened). */
	initialized: boolean;
	/** Timestamp of the last successful poll; staleness derives from it. */
	lastOkAt?: number;
	/** Present while the last poll failed; cleared by the next success. */
	failure?: FeedFailure;
	/** A window overrun is unresolved (deep repair pending/failed). */
	gap: boolean;
	/** Row count of the most recent successful poll. */
	rowCount: number;
	/** Ids currently tracked by the seen-ring. */
	seenCount: number;
	/** Last row of the most recent successful poll. */
	latestRow?: TailRow;
	/** Most recent agent.status row observed (label lives in row.state). */
	latestStatusRow?: TailRow;
}

interface RingEntry {
	lamport: number;
	id: string;
}

/** Order key (lamport ?? -1, event_id); missing lamports sort first. */
function lamportOf(row: TailRow): number {
	return typeof row.lamport === "number" ? row.lamport : -1;
}

function before(a: RingEntry, b: RingEntry): boolean {
	return a.lamport < b.lamport || (a.lamport === b.lamport && a.id < b.id);
}

export class RoomFeedStore {
	private readonly capacity: number;
	/** Ascending by (lamport, id); evictions pop the lowest. */
	private ring: RingEntry[] = [];
	private seen = new Set<string>();
	/** Highest (lamport, id) ever seen — exists once any event was ingested. */
	private watermark: RingEntry | undefined;
	private initializedFlag = false;
	private lastOkAt: number | undefined;
	private failure: FeedFailure | undefined;
	private gapActive = false;
	private lastRowCount = 0;
	private newestId: string | undefined;
	private oldestId: string | undefined;
	private latestRow: TailRow | undefined;
	private latestStatusRow: TailRow | undefined;

	constructor(options: { ringCapacity?: number } = {}) {
		this.capacity = Math.max(1, options.ringCapacity ?? SEEN_RING_CAPACITY);
	}

	/**
	 * Return to construction state. Called at session teardown so that
	 * between sessions the widget cannot render the previous session's
	 * snapshot and a prior failure episode cannot leak a spurious
	 * "feed recovered" toast into the next session's first poll.
	 */
	reset(): void {
		this.ring = [];
		this.seen = new Set();
		this.watermark = undefined;
		this.gapActive = false;
		this.failure = undefined;
		// Full reset: a re-init (session replacement, possibly a DIFFERENT
		// room) must never carry the previous window's rows forward — a stale
		// latestStatusRow would render the old room's status under the new
		// room's label until the new room ever emits one.
		this.lastRowCount = 0;
		this.newestId = undefined;
		this.oldestId = undefined;
		this.latestRow = undefined;
		this.latestStatusRow = undefined;
		this.lastOkAt = undefined;
		this.initializedFlag = false;
	}

	/**
	 * Seed watermark + seen-ring from the deep init poll. Emits ZERO signals
	 * (backlog suppression): nothing already in the room at session start may
	 * toast or count as fresh.
	 */
	init(rows: TailRow[], now: number): void {
		this.reset();
		for (const row of rows) {
			if (typeof row.event_id === "string") {
				this.insert(row);
			}
		}
		this.rememberPoll(rows, now);
		this.initializedFlag = true;
	}

	/** Diff one poll result against the ring. Never throws on hostile rows. */
	ingest(rows: TailRow[], now: number): FeedDelta {
		const recovered = this.failure !== undefined;
		this.failure = undefined;

		const withIds = rows.filter((row) => typeof row.event_id === "string");
		const newest = withIds[withIds.length - 1];

		// Fast path: window fingerprint (row count + oldest AND newest
		// event_id) unchanged -> no diff work. The oldest id is load-bearing:
		// in a --limit-saturated window a gossip backfill (lamport <= max,
		// the exact case the seen-ring exists for) inserts MID-window and
		// pushes the oldest row out, leaving count and newest id unchanged.
		if (
			this.initializedFlag &&
			rows.length === this.lastRowCount &&
			newest?.event_id === this.newestId &&
			withIds[0]?.event_id === this.oldestId
		) {
			this.lastOkAt = now;
			return { freshRows: [], gap: this.gapActive, repair: false, recovered };
		}

		const freshRows = withIds.filter((row) => !this.seen.has(row.event_id as string));

		// Gap: every polled row is unseen while a watermark exists — events may
		// have scrolled past the poll window. Request ONE deep repair poll.
		let repair = false;
		if (this.watermark !== undefined && withIds.length > 0 && freshRows.length === withIds.length) {
			if (!this.gapActive) {
				this.gapActive = true;
				repair = true;
			}
		} else {
			this.gapActive = false;
		}

		for (const row of freshRows) {
			this.insert(row);
		}
		this.rememberPoll(rows, now);
		return { freshRows, gap: this.gapActive, repair, recovered };
	}

	/**
	 * Record a failed poll. lastOkAt is deliberately kept — the last good
	 * snapshot stays on screen with an honest age.
	 */
	recordFailure(failure: FeedFailure, _now: number): { episodeStart: boolean } {
		const episodeStart = this.failure === undefined;
		this.failure = failure;
		return { episodeStart };
	}

	/** Pure view for renderers; staleness derives from now - lastOkAt there. */
	snapshot(): FeedSnapshot {
		const snapshot: FeedSnapshot = {
			initialized: this.initializedFlag,
			gap: this.gapActive,
			rowCount: this.lastRowCount,
			seenCount: this.seen.size,
		};
		if (this.lastOkAt !== undefined) snapshot.lastOkAt = this.lastOkAt;
		if (this.failure !== undefined) snapshot.failure = this.failure;
		if (this.latestRow !== undefined) snapshot.latestRow = this.latestRow;
		if (this.latestStatusRow !== undefined) snapshot.latestStatusRow = this.latestStatusRow;
		return snapshot;
	}

	private rememberPoll(rows: TailRow[], now: number): void {
		this.lastOkAt = now;
		this.lastRowCount = rows.length;
		const lastRow = rows[rows.length - 1];
		if (lastRow !== undefined) {
			this.latestRow = lastRow;
		}
		const withIds = rows.filter((row) => typeof row.event_id === "string");
		const newest = withIds[withIds.length - 1];
		const oldest = withIds[0];
		this.newestId = typeof newest?.event_id === "string" ? newest.event_id : this.newestId;
		this.oldestId = typeof oldest?.event_id === "string" ? oldest.event_id : this.oldestId;
		for (let i = rows.length - 1; i >= 0; i--) {
			const row = rows[i];
			if (row?.event_type === "agent.status") {
				this.latestStatusRow = row;
				break;
			}
		}
	}

	private insert(row: TailRow): void {
		const id = row.event_id as string;
		if (this.seen.has(id)) {
			return;
		}
		const entry: RingEntry = { lamport: lamportOf(row), id };
		// Binary-search insertion keeps the ring ascending by (lamport, id).
		let lo = 0;
		let hi = this.ring.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const probe = this.ring[mid] as RingEntry;
			if (before(probe, entry)) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		this.ring.splice(lo, 0, entry);
		this.seen.add(id);
		if (this.watermark === undefined || before(this.watermark, entry)) {
			this.watermark = entry;
		}
		while (this.ring.length > this.capacity) {
			const evicted = this.ring.shift();
			if (evicted !== undefined) {
				this.seen.delete(evicted.id);
			}
		}
	}
}
