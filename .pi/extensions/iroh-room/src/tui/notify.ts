/**
 * ToastClassifier — the CLOSED toast vocabulary over ambient signals
 * (brief §4 M2). Kinds: task_new, mention, member_joined, member_removed,
 * pipe_closed_own. feed_failing/feed_recovered stay in ambient.ts (M1) and
 * are deliberately NOT duplicated here.
 *
 * Inputs per classify() call:
 * - freshRows: the FeedDelta fresh rows (task detection + mention matching);
 * - memberJoined/memberRemoved: 64-hex id lists from the members-poll diff
 *   (brief §3: join/leave toasts come from `room members --json`, not from
 *   untrusted member.* tail rows);
 * - closedOwnPipes: ids from the per-tick pipes.list() diff minus the
 *   expectedCloses set (trusted local state — NEVER tail pipe.closed rows).
 *
 * Suppression rules (all enforced here, brief §4 M2):
 * - boot watermark: the M1 store already suppresses backlog rows, but the
 *   classifier ALSO never toasts a row at-or-below the boot watermark
 *   (belt-and-braces against re-seeded rings);
 * - self-author: row.from === our from8 (identity fetched once at ambient
 *   init; `from` is the first 8 hex of the sender id, brief §2.6);
 * - per-kind cooldown (30s default, injected now — no clocks here);
 * - batching: N new tasks / members / pipes ⇒ ONE toast per kind per call.
 *
 * Mention matching (brief §3.3): word-boundary, case-insensitive
 * "@" + display_name (only when the name is ≥ 3 chars) and "@" + from8,
 * matched against SANITIZED bodies (roomText). No identity ⇒ mention
 * detection is silently off.
 *
 * Toast text security: room-authored strings pass roomText; ids are
 * shape-checked before display (task ids against TASK_ID_COMPLETION_RE,
 * member/pipe ids against their hex shapes). Never throws.
 *
 * PURE module: no pi/pi-tui imports, no timers.
 */

import { PIPE_ID_RE, TASK_ID_COMPLETION_RE, TOAST_COOLDOWN_MS } from "../constants.js";
import { roomText } from "./sanitize.js";
import { naiveFit, type FitFn } from "./style.js";
import { detectTasks, type DetectedTask } from "./tasks.js";

export type ToastKind =
	| "task_new"
	| "mention"
	| "member_joined"
	| "member_removed"
	| "pipe_closed_own";

export interface Toast {
	kind: ToastKind;
	message: string;
	type: "info" | "warning";
}

/** Structural tail-row slice the classifier reads (TailRow-compatible). */
export interface NotifyRowLike {
	event_id?: unknown;
	event_type?: unknown;
	lamport?: unknown;
	from?: unknown;
	body?: unknown;
	[key: string]: unknown;
}

export interface ClassifyInput {
	now: number;
	freshRows: readonly NotifyRowLike[];
	/** Task ids already tracked BEFORE this tick's ingest (dedupes task_new). */
	knownTaskIds?: ReadonlySet<string>;
	memberJoined?: readonly string[];
	memberRemoved?: readonly string[];
	closedOwnPipes?: readonly string[];
}

export interface ToastClassifierOptions {
	cooldownMs?: number;
	fit?: FitFn;
}

const FROM8_RE = /^[0-9a-f]{8}$/;
const TITLE_COLS = 48;
/** Sanitize-only fit: roomText's pipeline without a width clamp. */
const passFit: FitFn = (text) => text;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary-ish @mention matcher (explicit non-id-char boundaries). */
function mentionRe(handle: string): RegExp {
	return new RegExp(`(?:^|[^A-Za-z0-9_])@${escapeRegExp(handle)}(?:[^A-Za-z0-9_]|$)`, "i");
}

interface BootMark {
	lamport: number;
	id: string;
}

export class ToastClassifier {
	private readonly cooldownMs: number;
	private readonly fit: FitFn;
	private readonly lastToastAt = new Map<ToastKind, number>();
	private boot: BootMark | undefined;
	private from8: string | undefined;
	private matchers: RegExp[] = [];
	private identityKnown = false;

	constructor(options: ToastClassifierOptions = {}) {
		this.cooldownMs = options.cooldownMs ?? TOAST_COOLDOWN_MS;
		this.fit = options.fit ?? naiveFit;
	}

	/**
	 * Wire our identity (fetched ONCE at ambient init). Absent/failed fetch ⇒
	 * mention detection AND self-suppression silently off for the session.
	 */
	setIdentity(identity: { identityId?: string; name?: string } | undefined): void {
		this.from8 = undefined;
		this.matchers = [];
		this.identityKnown = false;
		if (identity === undefined) {
			return;
		}
		const id = typeof identity.identityId === "string" ? identity.identityId : "";
		const from8 = id.slice(0, 8);
		if (!FROM8_RE.test(from8)) {
			return;
		}
		this.identityKnown = true;
		this.from8 = from8;
		this.matchers.push(mentionRe(from8));
		const name = typeof identity.name === "string" ? identity.name.trim() : "";
		if (name.length >= 3) {
			this.matchers.push(mentionRe(name));
		}
	}

	/** Record the boot watermark: max (lamport ?? -1, event_id) of the init rows. */
	markBoot(rows: readonly NotifyRowLike[]): void {
		let boot: BootMark | undefined;
		for (const row of rows) {
			if (row === null || typeof row !== "object" || typeof row.event_id !== "string") {
				continue;
			}
			const mark: BootMark = {
				lamport: typeof row.lamport === "number" ? row.lamport : -1,
				id: row.event_id,
			};
			if (
				boot === undefined ||
				mark.lamport > boot.lamport ||
				(mark.lamport === boot.lamport && mark.id > boot.id)
			) {
				boot = mark;
			}
		}
		this.boot = boot;
	}

	reset(): void {
		this.lastToastAt.clear();
		this.boot = undefined;
		this.from8 = undefined;
		this.matchers = [];
		this.identityKnown = false;
	}

	/** True when the row must never toast (boot backlog or our own event). */
	private suppressed(row: NotifyRowLike): boolean {
		if (this.from8 !== undefined && row.from === this.from8) {
			return true;
		}
		if (this.boot !== undefined) {
			const lamport = typeof row.lamport === "number" ? row.lamport : -1;
			const id = typeof row.event_id === "string" ? row.event_id : "";
			if (
				lamport < this.boot.lamport ||
				(lamport === this.boot.lamport && id <= this.boot.id)
			) {
				return true;
			}
		}
		return false;
	}

	/** Emit at most one toast for a kind, honoring the per-kind cooldown. */
	private emit(toasts: Toast[], kind: ToastKind, now: number, message: string, type: Toast["type"]): void {
		const last = this.lastToastAt.get(kind);
		if (last !== undefined && now - last < this.cooldownMs) {
			return;
		}
		this.lastToastAt.set(kind, now);
		toasts.push({ kind, message, type });
	}

	classify(input: ClassifyInput): Toast[] {
		const toasts: Toast[] = [];
		try {
			const newTasks: DetectedTask[] = [];
			const mentionFroms: string[] = [];
			for (const row of input.freshRows ?? []) {
				if (row === null || typeof row !== "object") {
					continue;
				}
				if (row.event_type !== "message.text" || typeof row.body !== "string") {
					continue;
				}
				if (this.suppressed(row)) {
					continue;
				}
				for (const task of detectTasks(row.body)) {
					if (input.knownTaskIds?.has(task.id) === true) {
						continue;
					}
					if (!newTasks.some((seen) => seen.id === task.id)) {
						newTasks.push(task);
					}
				}
				if (this.identityKnown && this.matchers.length > 0) {
					const flat = roomText(row.body, Number.MAX_SAFE_INTEGER, passFit);
					if (this.matchers.some((re) => re.test(flat))) {
						const from = typeof row.from === "string" && FROM8_RE.test(row.from) ? row.from : "?";
						mentionFroms.push(from);
					}
				}
			}

			if (newTasks.length === 1) {
				const task = newTasks[0] as DetectedTask;
				// ids are room-authored: shown only when completion-shaped (U5).
				const id = TASK_ID_COMPLETION_RE.test(task.id) ? ` ${task.id}` : "";
				const title = roomText(task.title, TITLE_COLS, this.fit);
				this.emit(toasts, "task_new", input.now, `iroh-room: new task~${id}: ${title}`, "info");
			} else if (newTasks.length > 1) {
				this.emit(toasts, "task_new", input.now, `iroh-room: ${newTasks.length} new tasks~`, "info");
			}

			if (mentionFroms.length === 1) {
				this.emit(toasts, "mention", input.now, `iroh-room: mentioned by ${mentionFroms[0]}`, "info");
			} else if (mentionFroms.length > 1) {
				this.emit(toasts, "mention", input.now, `iroh-room: ${mentionFroms.length} mentions`, "info");
			}

			const joined = this.memberIds(input.memberJoined);
			if (joined.length === 1) {
				this.emit(toasts, "member_joined", input.now, `iroh-room: member joined ${(joined[0] as string).slice(0, 8)}…`, "info");
			} else if (joined.length > 1) {
				this.emit(toasts, "member_joined", input.now, `iroh-room: ${joined.length} members joined`, "info");
			}

			const removed = this.memberIds(input.memberRemoved);
			if (removed.length === 1) {
				this.emit(toasts, "member_removed", input.now, `iroh-room: member removed ${(removed[0] as string).slice(0, 8)}…`, "info");
			} else if (removed.length > 1) {
				this.emit(toasts, "member_removed", input.now, `iroh-room: ${removed.length} members removed`, "info");
			}

			const pipes = (input.closedOwnPipes ?? []).filter(
				(id) => typeof id === "string" && PIPE_ID_RE.test(id),
			);
			if (pipes.length === 1) {
				this.emit(toasts, "pipe_closed_own", input.now, `iroh-room: preview pipe closed unexpectedly: ${pipes[0]}`, "warning");
			} else if (pipes.length > 1) {
				this.emit(toasts, "pipe_closed_own", input.now, `iroh-room: ${pipes.length} preview pipes closed unexpectedly`, "warning");
			}
		} catch {
			// hostile input must never take the poll loop down
		}
		return toasts;
	}

	/** 64-hex shape gate + self-suppression for member-diff id lists. */
	private memberIds(ids: readonly string[] | undefined): string[] {
		const result: string[] = [];
		for (const id of ids ?? []) {
			if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) {
				continue;
			}
			if (this.from8 !== undefined && id.slice(0, 8) === this.from8) {
				continue;
			}
			result.push(id);
		}
		return result;
	}
}
