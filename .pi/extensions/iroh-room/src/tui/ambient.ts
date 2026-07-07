/**
 * AmbientController — the ONLY module that owns timers (brief §4 M1).
 *
 * Created once in index.ts (like PipeManager) and passed into command
 * registration via the wired-options DI. Lifecycle:
 *
 * - session_start (any reason), ctx.mode === "tui" ONLY:
 *   - config resolves but has no room_id  -> TOTAL silence (no widget, no
 *     pill, no timer, no poll);
 *   - config resolution THROWS            -> one warning toast + a dim
 *     "iroh ⚙ unconfigured" pill, nothing else (no polling — no mid-session
 *     config re-reads for the ambient layer);
 *   - otherwise: restore density (latest "iroh-room.density" custom entry on
 *     ctx.sessionManager.getBranch(), else pulse_density config, else "2"),
 *     and if density !== "off": one deep init poll (--limit=500) through the
 *     cli.ts builders — SCHEDULED, never awaited: session_start must not
 *     block on a subprocess whose runtime grows with the (untrusted) room
 *     log size — then a setTimeout-CHAINED loop (never setInterval),
 *     every timer unref()'d, single-flight, 5s cadence, 2s-for-30s boost
 *     after our own commands/tools, 5→10→20→40→60s backoff on failure with
 *     one feed_failing toast per episode + a matching feed_recovered.
 * - density "off" tears the poll loop down entirely and clears widget+pill.
 * - ALL teardown is idempotent and runs from the single session_shutdown
 *   handler in index.ts (after runtime replacement stale pi calls throw).
 *
 * The controller shells out ONLY via the injected exec through the cli.ts
 * argv builders; parsing goes through parseTailJson; diffing through the
 * pure RoomFeedStore; rendering through the pure pulse.ts builders.
 */

import process from "node:process";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

import {
	buildMembersArgs,
	buildTailArgs,
	buildWhoamiArgs,
	parseJsonLine,
	parseTailJson,
	runCli,
	type ExecFn,
	type TailRow,
} from "../cli.js";
import { resolveBinary, resolveConfig, type Env, type ResolvedConfig } from "../config.js";
import {
	AMBIENT_POLL_MS,
	AMBIENT_TAIL_LIMIT,
	BACKOFF_LADDER_MS,
	BOOST_POLL_MS,
	BOOST_WINDOW_MS,
	DEEP_TAIL_LIMIT,
	DEFAULT_PULSE_DENSITY,
	DENSITY_ENTRY_TYPE,
	IDENTITY_ID_RE,
	MEMBERS_POLL_EVERY_TICKS,
	PULSE_DENSITIES,
	PULSE_STATUS_KEY,
	PULSE_WIDGET_KEY,
	STALE_AFTER_TICKS,
	TOAST_COOLDOWN_MS,
	type PulseDensity,
} from "../constants.js";
import { PipeManager } from "../pipes.js";
import { mentionCompletions } from "./complete.js";
import {
	RoomFeedStore,
	classifyPollError,
	describePollFailure,
	failureFromRun,
} from "./feed.js";
import { ToastClassifier, type Toast } from "./notify.js";
import { renderPill, renderPulse, type PulseView } from "./pulse.js";
import { TaskTracker } from "./tasks.js";
import { fitWidth, themeStyler } from "./wire.js";

/** Injectable timer shim; the default wraps setTimeout and unref()s. */
export interface TimerShim {
	set(fn: () => void | Promise<void>, ms: number): unknown;
	clear(handle: unknown): void;
}

const defaultTimers: TimerShim = {
	set(fn, ms) {
		const handle = setTimeout(fn, ms);
		// unref: an ambient poll must never keep the process alive.
		(handle as { unref?: () => void }).unref?.();
		return handle;
	},
	clear(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

/** (lamport, event_id) watermark recorded per /room-tail card emission (M2). */
export interface TailLookMark {
	lamport: number;
	event_id: string;
}

/** Event slice noteTailLook orders by (SnapshotEvent-compatible). */
export interface TailLookEvent {
	event_id?: unknown;
	lamport?: unknown;
	[key: string]: unknown;
}

/**
 * Structural surface commands and index.ts need — lets tests wire recorder
 * fakes without constructing the full controller. The M2 members apart, the
 * members/tasks/pipe/divider methods are OPTIONAL so minimal recorder fakes
 * keep working (callers use optional chaining).
 */
export interface AmbientLike {
	onSessionStart(event: unknown, ctx: ExtensionContext): Promise<void>;
	boost(): void;
	getDensity(): PulseDensity;
	setDensity(density: PulseDensity): Promise<void>;
	cycleDensity(): PulseDensity;
	shutdown(): void;
	/** Members-poll snapshot (64-hex validated ids) for completions/select. */
	listMembers?(): { id: string; role: string }[];
	/** Tracked room-task ids (completions filter shapes downstream, U5). */
	listTaskIds?(): string[];
	/** Unclaimed task ids for the /room card catch-up slot (heuristic~). */
	listUnclaimedTaskIds?(): string[];
	/** Our own iroh_pipe_close / /room-preview --close: suppress the toast. */
	noteExpectedPipeClose?(pipeId: string): void;
	/** Record the max (lamport, event_id) of a /room-tail card; returns the
	 * PREVIOUS record (the divider watermark for this card). */
	noteTailLook?(events: readonly TailLookEvent[]): TailLookMark | undefined;
}

export interface AmbientOptions {
	env?: Env;
	exec?: ExecFn;
	pipes?: PipeManager;
	now?: () => number;
	timers?: TimerShim;
	store?: RoomFeedStore;
	cadenceMs?: number;
	boostCadenceMs?: number;
	boostWindowMs?: number;
	backoffLadderMs?: readonly number[];
	deepLimit?: number;
	pollLimit?: number;
	staleAfterTicks?: number;
	/** `room members --json` runs on every Nth successful tail poll (M2). */
	membersEveryTicks?: number;
	/** Per-kind toast cooldown for the M2 classifier. */
	toastCooldownMs?: number;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export class AmbientController implements AmbientLike {
	private readonly env: Env;
	private readonly exec: ExecFn | undefined;
	private readonly pipes: PipeManager | undefined;
	private readonly now: () => number;
	private readonly timers: TimerShim;
	private readonly store: RoomFeedStore;
	private readonly cadenceMs: number;
	private readonly boostCadenceMs: number;
	private readonly boostWindowMs: number;
	private readonly backoffLadderMs: readonly number[];
	private readonly deepLimit: number;
	private readonly pollLimit: number;
	private readonly staleAfterMs: number;

	private density: PulseDensity = DEFAULT_PULSE_DENSITY;
	/** Session context while the ambient surfaces are live (tui + configured). */
	private ctx: ExtensionContext | undefined;
	/** ui reference kept for teardown even in broken-config mode. */
	private ui: ExtensionContext["ui"] | undefined;
	private cfg: ResolvedConfig | undefined;
	private active = false;

	private running = false;
	private inFlight = false;
	/** Bumped by teardown(): a poll that outlives its session is stale and
	 * must not touch the store, flags, chain, or surfaces when it resumes. */
	private epoch = 0;
	private timerHandle: unknown;
	private nextPollAt: number | undefined;
	private boostUntil = 0;
	private failStreak = 0;
	private storeInitialized = false;
	private needsDeep = true;

	private widgetSet = false;
	private tui: { requestRender(force?: boolean): void } | undefined;
	private lastPill: string | undefined;

	/* ------------------------------ M2 state ------------------------------ */
	private readonly membersEvery: number;
	private readonly tracker = new TaskTracker();
	private readonly classifier: ToastClassifier;
	/** Identity fetch runs ONCE per session (failure => mentions silently off). */
	private identityAttempted = false;
	/** Counts successful tail polls; drives the every-Nth members cadence. */
	private tailSuccessCount = 0;
	/** id -> role from the last successful members poll (undefined = never). */
	private members: Map<string, string> | undefined;
	/** Pipe ids whose disappearance is OURS (tool/command close) — no toast.
	 * Entries are consumed on the first matching disappearance; an entry for
	 * a close that ultimately failed lingers and suppresses at most one later
	 * unexpected-close toast for that id (accepted, heuristic surface). */
	private readonly expectedCloses = new Set<string>();
	/** pipes.list() ids at the previous tick (undefined = baseline pending). */
	private prevPipeIds: Set<string> | undefined;
	/** Max (lamport, event_id) of the last /room-tail card (divider record). */
	private tailLook: TailLookMark | undefined;
	/** The @mention provider registers ONCE per process: host-side provider
	 * factories accumulate with no unregister (pi types.d.ts:135). */
	private mentionProviderRegistered = false;
	/** Values offered by the last mention suggestion round; applyCompletion
	 * claims only these and delegates everything else to the wrapped chain. */
	private lastMentionValues: Set<string> | undefined;

	constructor(options: AmbientOptions = {}) {
		this.env = options.env ?? process.env;
		this.exec = options.exec;
		this.pipes = options.pipes;
		this.now = options.now ?? (() => Date.now());
		this.timers = options.timers ?? defaultTimers;
		this.store = options.store ?? new RoomFeedStore();
		this.cadenceMs = options.cadenceMs ?? AMBIENT_POLL_MS;
		this.boostCadenceMs = options.boostCadenceMs ?? BOOST_POLL_MS;
		this.boostWindowMs = options.boostWindowMs ?? BOOST_WINDOW_MS;
		this.backoffLadderMs = options.backoffLadderMs ?? BACKOFF_LADDER_MS;
		this.deepLimit = options.deepLimit ?? DEEP_TAIL_LIMIT;
		this.pollLimit = options.pollLimit ?? AMBIENT_TAIL_LIMIT;
		this.staleAfterMs = (options.staleAfterTicks ?? STALE_AFTER_TICKS) * this.cadenceMs;
		this.membersEvery = Math.max(1, options.membersEveryTicks ?? MEMBERS_POLL_EVERY_TICKS);
		this.classifier = new ToastClassifier({
			cooldownMs: options.toastCooldownMs ?? TOAST_COOLDOWN_MS,
		});
	}

	/* ---------------------------- lifecycle ---------------------------- */

	async onSessionStart(_event: unknown, ctx: ExtensionContext): Promise<void> {
		this.teardown(); // idempotent; a repeated session_start restarts cleanly
		if (ctx.mode !== "tui") {
			return; // §8 mode matrix: zero ambient activity outside the TUI
		}
		let cfg: ResolvedConfig;
		try {
			cfg = resolveConfig({ cwd: ctx.cwd, env: this.env });
		} catch (err) {
			// Broken config: one warning toast + dim pill, nothing else.
			this.ui = ctx.ui;
			this.safeUi(() => {
				ctx.ui.notify(`iroh-room: config error — ${errText(err)} (pulse disabled)`, "warning");
				ctx.ui.setStatus(PULSE_STATUS_KEY, renderPill(this.brokenView()));
			});
			return;
		}
		if (cfg.roomId === undefined) {
			return; // unconfigured: total silence
		}
		this.ctx = ctx;
		this.ui = ctx.ui;
		this.cfg = cfg;
		this.active = true;
		this.registerMentionProvider(ctx);
		this.density = this.restoreDensity(ctx, cfg);
		await this.applyDensity();
	}

	/**
	 * Editor @mention autocomplete (brief §4 M2, optional provider). Wraps the
	 * current provider chain: our suggestions win only when the cursor sits on
	 * an @-token AND a members roster exists; everything else — including
	 * applyCompletion for items we did not offer — delegates unchanged. The
	 * provider reads live controller state, so it goes inert on teardown;
	 * registration itself is once per process (see mentionProviderRegistered).
	 */
	private registerMentionProvider(ctx: ExtensionContext): void {
		if (this.mentionProviderRegistered) {
			return;
		}
		this.mentionProviderRegistered = true;
		const controller = this;
		this.safeUi(() => {
			ctx.ui.addAutocompleteProvider((current: AutocompleteProvider): AutocompleteProvider => ({
				triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],
				async getSuggestions(lines, cursorLine, cursorCol, options) {
					if (controller.active) {
						const line = lines[cursorLine] ?? "";
						const ours = mentionCompletions(line, cursorCol, controller.members);
						if (ours !== null) {
							controller.lastMentionValues = new Set(ours.items.map((item) => item.value));
							return ours;
						}
					}
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				},
				applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
					if (controller.lastMentionValues?.has(item.value) === true && prefix.startsWith("@")) {
						const line = lines[cursorLine] ?? "";
						const start = Math.max(0, cursorCol - prefix.length);
						const next = `${line.slice(0, start)}${item.value} ${line.slice(cursorCol)}`;
						const nextLines = [...lines];
						nextLines[cursorLine] = next;
						return { lines: nextLines, cursorLine, cursorCol: start + item.value.length + 1 };
					}
					return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				},
				...(current.shouldTriggerFileCompletion
					? { shouldTriggerFileCompletion: current.shouldTriggerFileCompletion.bind(current) }
					: {}),
			}));
		});
	}

	/** Idempotent full teardown; safe after runtime replacement. */
	shutdown(): void {
		this.teardown();
	}

	getDensity(): PulseDensity {
		return this.density;
	}

	async setDensity(density: PulseDensity): Promise<void> {
		this.density = density;
		if (this.active) {
			await this.applyDensity();
		}
	}

	/** off → pill → 1 → 2 → off; applies the new density and returns it. */
	cycleDensity(): PulseDensity {
		const index = PULSE_DENSITIES.indexOf(this.density);
		const next = PULSE_DENSITIES[(index + 1) % PULSE_DENSITIES.length] as PulseDensity;
		void this.setDensity(next);
		return next;
	}

	/** 2s cadence for 30s after our own commands/tools run. No-op when idle. */
	boost(): void {
		if (!this.running) {
			return;
		}
		this.boostUntil = this.now() + this.boostWindowMs;
		if (this.inFlight || this.failStreak > 0) {
			return; // single-flight; backoff wins over boost while failing
		}
		const remaining =
			this.nextPollAt === undefined ? this.boostCadenceMs : this.nextPollAt - this.now();
		this.schedule(Math.max(0, Math.min(this.boostCadenceMs, remaining)));
	}

	/* --------------------------- M2 surfaces --------------------------- */

	/** Members-poll snapshot (64-hex validated at parse) for completions/select. */
	listMembers(): { id: string; role: string }[] {
		if (this.members === undefined) {
			return [];
		}
		return [...this.members].map(([id, role]) => ({ id, role }));
	}

	/** Tracked room-task ids (completions re-validate shapes, U5). */
	listTaskIds(): string[] {
		return this.tracker.taskIds();
	}

	/** Unclaimed task ids (heuristic~; /room card catch-up slot). */
	listUnclaimedTaskIds(): string[] {
		return this.tracker.unclaimed().map((task) => task.id);
	}

	/** Fed by our OWN iroh_pipe_close completions and /room-preview --close. */
	noteExpectedPipeClose(pipeId: string): void {
		if (typeof pipeId === "string" && pipeId !== "") {
			this.expectedCloses.add(pipeId);
		}
	}

	/**
	 * Record the max (lamport ?? -1, event_id) of a /room-tail card's events
	 * and return the PREVIOUS record — the new-since-last-look divider
	 * watermark for the card being emitted. No previous record => undefined
	 * (no divider). Inactive controller records nothing.
	 */
	noteTailLook(events: readonly TailLookEvent[]): TailLookMark | undefined {
		if (!this.active) {
			return undefined;
		}
		let max: TailLookMark | undefined;
		for (const event of events) {
			if (event === null || typeof event !== "object" || typeof event.event_id !== "string") {
				continue;
			}
			const mark: TailLookMark = {
				lamport: typeof event.lamport === "number" ? event.lamport : -1,
				event_id: event.event_id,
			};
			if (
				max === undefined ||
				mark.lamport > max.lamport ||
				(mark.lamport === max.lamport && mark.event_id > max.event_id)
			) {
				max = mark;
			}
		}
		const previous = this.tailLook;
		if (max !== undefined) {
			this.tailLook = max;
		}
		return previous;
	}

	/* ----------------------------- density ----------------------------- */

	private restoreDensity(ctx: ExtensionContext, cfg: ResolvedConfig): PulseDensity {
		try {
			let restored: PulseDensity | undefined;
			for (const entry of ctx.sessionManager.getBranch()) {
				const candidate = entry as { type?: string; customType?: string; data?: unknown };
				if (candidate.type !== "custom" || candidate.customType !== DENSITY_ENTRY_TYPE) {
					continue;
				}
				const density = (candidate.data as { density?: unknown } | undefined)?.density;
				if (typeof density === "string" && (PULSE_DENSITIES as readonly string[]).includes(density)) {
					restored = density as PulseDensity; // keep scanning: latest wins
				}
			}
			return restored ?? cfg.pulseDensity ?? DEFAULT_PULSE_DENSITY;
		} catch {
			return cfg.pulseDensity ?? DEFAULT_PULSE_DENSITY;
		}
	}

	private async applyDensity(): Promise<void> {
		if (!this.active || this.ctx === undefined) {
			return;
		}
		if (this.density === "off") {
			// Off tears the loop down entirely — no polling for an invisible surface.
			this.stopLoop();
			this.clearWidget();
			this.clearPill();
			return;
		}
		if (this.density === "pill") {
			this.clearWidget();
		} else {
			this.ensureWidget();
		}
		this.updateSurfaces();
		this.startLoop();
	}

	/* ---------------------------- poll loop ---------------------------- */

	private startLoop(): void {
		if (this.running) {
			return;
		}
		this.running = true;
		this.failStreak = 0;
		this.boostUntil = 0;
		if (!this.storeInitialized) {
			this.needsDeep = true;
		}
		// Deep init poll first, then the chained loop — scheduled, NEVER
		// awaited: this sits under the host's awaited session_start handler,
		// and a slow/hung `room tail --offline` (cost grows with untrusted
		// room log size, up to the 60s exec timeout) must not block pi
		// startup, session switches, or /room-pulse.
		this.schedule(0);
	}

	private stopLoop(): void {
		this.running = false;
		if (this.timerHandle !== undefined) {
			this.timers.clear(this.timerHandle);
			this.timerHandle = undefined;
		}
		this.nextPollAt = undefined;
		this.boostUntil = 0;
	}

	private schedule(delayMs: number): void {
		if (!this.running) {
			return;
		}
		if (this.timerHandle !== undefined) {
			this.timers.clear(this.timerHandle);
		}
		this.nextPollAt = this.now() + delayMs;
		this.timerHandle = this.timers.set(() => this.tick(), delayMs);
	}

	private currentDelay(): number {
		if (this.failStreak > 0) {
			const index = Math.min(this.failStreak, this.backoffLadderMs.length) - 1;
			return this.backoffLadderMs[index] ?? this.cadenceMs;
		}
		return this.now() < this.boostUntil ? this.boostCadenceMs : this.cadenceMs;
	}

	/** One poll. Single-flight; never rejects; reschedules itself (chain). */
	private async tick(): Promise<void> {
		if (!this.running || this.ctx === undefined || this.cfg === undefined) {
			return;
		}
		if (this.inFlight) {
			return; // overlapping invocation (boost/timer race): never double-run
		}
		this.inFlight = true;
		const epoch = this.epoch;
		this.timerHandle = undefined;
		try {
			// pipe_closed_own runs on EVERY tick (trusted local state, brief §3):
			// an own-pipe death must toast even while the tail poll is failing.
			const closedOwn = this.diffPipes();
			if (closedOwn.length > 0) {
				this.emitToasts(
					this.classifier.classify({
						now: this.now(),
						freshRows: [],
						closedOwnPipes: closedOwn,
					}),
				);
			}
			await this.poll(epoch);
		} catch (err) {
			// poll() maps everything itself; this is a belt-and-braces guard so
			// a chained timer callback can never become an unhandled rejection.
			if (this.pollValid(epoch)) {
				this.recordFailure(classifyPollError(err));
			}
		} finally {
			// A stale tick (teardown bumped the epoch mid-flight) must not
			// clobber the new session's single-flight flag, chain a timer onto
			// its loop, or repaint its surfaces.
			if (epoch === this.epoch) {
				this.inFlight = false;
				if (this.running) {
					this.schedule(this.currentDelay());
				}
				this.updateSurfaces();
			}
		}
	}

	/** A poll resuming after its await may act only while its epoch is
	 * current AND the loop still runs (teardown or density-off mid-flight
	 * silences it: no store writes, no toasts, no failStreak). */
	private pollValid(epoch: number): boolean {
		return epoch === this.epoch && this.running;
	}

	private async poll(epoch: number): Promise<void> {
		const cfg = this.cfg as ResolvedConfig;
		const exec = this.exec;
		if (exec === undefined || cfg.roomId === undefined) {
			return;
		}
		const limit = this.needsDeep ? this.deepLimit : this.pollLimit;
		let rows: TailRow[];
		let bin: string;
		try {
			bin = resolveBinary(cfg, this.env);
			// Identity fetch (brief §3.3): ONCE per session, at ambient init —
			// the first tick that reaches a resolved binary. Failure => mention
			// detection silently off; never a feed failure.
			if (!this.identityAttempted) {
				this.identityAttempted = true;
				await this.fetchIdentity(epoch, exec, bin, cfg);
				if (!this.pollValid(epoch)) {
					return;
				}
			}
			const run = await runCli(exec, bin, buildTailArgs({ room: cfg.roomId, limit }), {
				...(cfg.home !== undefined ? { home: cfg.home } : {}),
				cwd: cfg.cwd,
			});
			if (!this.pollValid(epoch)) {
				return; // stale (restart) or silenced (density off) mid-flight
			}
			if (!run.ok) {
				this.recordFailure(failureFromRun(run));
				return;
			}
			rows = parseTailJson(run.stdout);
		} catch (err) {
			if (this.pollValid(epoch)) {
				this.recordFailure(classifyPollError(err));
			}
			return;
		}
		const hadFailure = this.store.snapshot().failure !== undefined;
		this.failStreak = 0;
		this.needsDeep = false;
		let freshRows: TailRow[] = [];
		if (!this.storeInitialized) {
			this.store.init(rows, this.now()); // zero signals: backlog suppression
			this.storeInitialized = true;
			// Boot watermark + catch-up: backlog rows never toast, but their
			// tasks DO count (the /room card unclaimed list is the catch-up).
			this.classifier.markBoot(rows);
			this.tracker.ingest(rows);
		} else {
			const delta = this.store.ingest(rows, this.now());
			if (delta.repair) {
				this.needsDeep = true; // exactly one deep repair poll per gap episode
			}
			freshRows = delta.freshRows;
		}
		// Members poll every Nth successful tail tick (M2, brief §2.7).
		this.tailSuccessCount += 1;
		let memberJoined: string[] = [];
		let memberRemoved: string[] = [];
		if (this.tailSuccessCount % this.membersEvery === 0) {
			const diff = await this.pollMembers(epoch, exec, bin, cfg);
			if (!this.pollValid(epoch)) {
				return;
			}
			memberJoined = diff.joined;
			memberRemoved = diff.removed;
		}
		// Classify BEFORE ingesting fresh rows so task_new dedupes against the
		// pre-tick tracked set; then track (self-authored tasks still count).
		const toasts = this.classifier.classify({
			now: this.now(),
			freshRows,
			knownTaskIds: new Set(this.tracker.taskIds()),
			memberJoined,
			memberRemoved,
		});
		this.tracker.ingest(freshRows);
		this.emitToasts(toasts);
		if (hadFailure) {
			this.safeUi(() => this.ctx?.ui.notify("iroh-room: feed recovered", "info"));
		}
	}

	/** identity show --json, once; any failure leaves mention detection off. */
	private async fetchIdentity(
		epoch: number,
		exec: ExecFn,
		bin: string,
		cfg: ResolvedConfig,
	): Promise<void> {
		try {
			const run = await runCli(exec, bin, buildWhoamiArgs(), {
				...(cfg.home !== undefined ? { home: cfg.home } : {}),
				cwd: cfg.cwd,
			});
			if (!this.pollValid(epoch) || !run.ok) {
				return;
			}
			const identity = parseJsonLine<{ name?: unknown; identity_id?: unknown }>(
				run.stdout,
				"identity show",
			);
			if (identity === null || typeof identity !== "object") {
				return;
			}
			const identityId = typeof identity.identity_id === "string" ? identity.identity_id : "";
			if (!IDENTITY_ID_RE.test(identityId)) {
				return;
			}
			this.classifier.setIdentity({
				identityId,
				...(typeof identity.name === "string" ? { name: identity.name } : {}),
			});
		} catch {
			// silently off (brief §3.3)
		}
	}

	/**
	 * `room members --json`, parsed DEFENSIVELY (brief §2.7): only records
	 * with 64-hex identity_id survive. The first successful poll is the
	 * baseline (no toasts); later polls return the joined/removed diff.
	 * Failures are silent — members data is a convenience, not feed health.
	 */
	private async pollMembers(
		epoch: number,
		exec: ExecFn,
		bin: string,
		cfg: ResolvedConfig,
	): Promise<{ joined: string[]; removed: string[] }> {
		const none = { joined: [] as string[], removed: [] as string[] };
		let parsed: unknown;
		try {
			const run = await runCli(exec, bin, buildMembersArgs({ room: cfg.roomId as string }), {
				...(cfg.home !== undefined ? { home: cfg.home } : {}),
				cwd: cfg.cwd,
			});
			if (!this.pollValid(epoch) || !run.ok) {
				return none;
			}
			parsed = parseJsonLine<unknown>(run.stdout, "room members");
		} catch {
			return none;
		}
		if (parsed === null || typeof parsed !== "object") {
			return none;
		}
		const rawMembers = (parsed as { members?: unknown }).members;
		if (!Array.isArray(rawMembers)) {
			return none;
		}
		const next = new Map<string, string>();
		for (const entry of rawMembers) {
			if (entry === null || typeof entry !== "object") {
				continue;
			}
			const record = entry as { identity_id?: unknown; role?: unknown };
			if (typeof record.identity_id !== "string" || !IDENTITY_ID_RE.test(record.identity_id)) {
				continue;
			}
			next.set(record.identity_id, typeof record.role === "string" ? record.role : "member");
		}
		const prev = this.members;
		this.members = next;
		if (prev === undefined) {
			return none; // baseline: joins already in the room never toast
		}
		return {
			joined: [...next.keys()].filter((id) => !prev.has(id)),
			removed: [...prev.keys()].filter((id) => !next.has(id)),
		};
	}

	/**
	 * Per-tick pipes.list() diff (trusted local state — NEVER tail
	 * pipe.closed rows): ids that disappeared since the previous tick, minus
	 * the expectedCloses set (consumed on match). First tick is the baseline.
	 */
	private diffPipes(): string[] {
		const current = new Set((this.pipes?.list() ?? []).map((record) => record.pipeId));
		const prev = this.prevPipeIds;
		this.prevPipeIds = current;
		if (prev === undefined) {
			return [];
		}
		const closed: string[] = [];
		for (const id of prev) {
			if (current.has(id)) {
				continue;
			}
			if (this.expectedCloses.delete(id)) {
				continue; // our own close — expected, no toast
			}
			closed.push(id);
		}
		return closed;
	}

	private emitToasts(toasts: Toast[]): void {
		for (const toast of toasts) {
			this.safeUi(() => this.ctx?.ui.notify(toast.message, toast.type));
		}
	}

	private recordFailure(failure: ReturnType<typeof classifyPollError>): void {
		const { episodeStart } = this.store.recordFailure(failure, this.now());
		this.failStreak += 1;
		if (episodeStart) {
			this.safeUi(() =>
				this.ctx?.ui.notify(`iroh-room: feed failing — ${describePollFailure(failure)}`, "warning"),
			);
		}
	}

	/* ----------------------------- surfaces ----------------------------- */

	/** The composed render view; staleness/retry derive from now at call time. */
	private view(): PulseView {
		const feed = this.store.snapshot();
		const cfg = this.cfg;
		const label =
			cfg?.roomLabel ?? (cfg?.roomId ?? "").replace(/^blake3:/, "").slice(0, 8);
		const view: PulseView = {
			label: label === "" ? "?" : label,
			now: this.now(),
			staleAfterMs: this.staleAfterMs,
			pipeCount: this.pipes?.list().length ?? 0,
			feed,
		};
		const unclaimed = this.tracker.unclaimedCount();
		if (unclaimed > 0) {
			view.unclaimedTasks = unclaimed; // heuristic — renderers ~-mark it
		}
		if (this.nextPollAt !== undefined) {
			view.retryInMs = Math.max(0, this.nextPollAt - this.now());
		}
		return view;
	}

	private brokenView(): PulseView {
		return {
			label: "?",
			now: 0,
			staleAfterMs: 0,
			pipeCount: 0,
			brokenConfig: true,
			feed: { initialized: false, gap: false },
		};
	}

	private ensureWidget(): void {
		if (this.widgetSet || this.ctx === undefined) {
			return;
		}
		this.safeUi(() => {
			this.ctx?.ui.setWidget(
				PULSE_WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					const styler = themeStyler(theme);
					let disposed = false;
					return {
						render: (width: number) => renderPulse(this.view(), this.density, width, styler, fitWidth),
						// Mandatory per pi-tui Component; fires on theme change.
						// Nothing cached — every render styles fresh.
						invalidate: () => {},
						dispose: () => {
							if (disposed) {
								return; // safe + idempotent
							}
							disposed = true;
							if (this.tui === tui) {
								this.tui = undefined;
							}
						},
					};
				},
				{ placement: "belowEditor" },
			);
			this.widgetSet = true;
		});
	}

	private clearWidget(): void {
		if (!this.widgetSet) {
			return;
		}
		this.widgetSet = false;
		this.tui = undefined;
		this.safeUi(() => this.ui?.setWidget(PULSE_WIDGET_KEY, undefined));
	}

	private clearPill(): void {
		if (this.lastPill === undefined) {
			return;
		}
		this.lastPill = undefined;
		this.safeUi(() => this.ui?.setStatus(PULSE_STATUS_KEY, undefined));
	}

	/** Refresh pill (on change) + repaint the widget. */
	private updateSurfaces(): void {
		if (!this.active || this.ctx === undefined || this.density === "off") {
			return;
		}
		const pill = renderPill(this.view());
		if (pill !== this.lastPill) {
			this.lastPill = pill;
			this.safeUi(() => this.ctx?.ui.setStatus(PULSE_STATUS_KEY, pill));
		}
		if (this.widgetSet) {
			try {
				this.tui?.requestRender();
			} catch {
				// stale tui after replacement — teardown will clear it
			}
		}
	}

	private teardown(): void {
		this.stopLoop();
		this.clearWidget();
		// Clear the pill even in broken-config mode (which sets no lastPill
		// bookkeeping via updateSurfaces): drop it unconditionally when a ui
		// reference exists.
		if (this.ui !== undefined) {
			this.safeUi(() => this.ui?.setStatus(PULSE_STATUS_KEY, undefined));
		}
		this.lastPill = undefined;
		this.ctx = undefined;
		this.ui = undefined;
		this.cfg = undefined;
		this.active = false;
		// Invalidate any in-flight poll: when it resumes it must find a
		// mismatched epoch and drop ALL side effects (store seed, failStreak,
		// toasts, rescheduling) instead of polluting the next session.
		this.epoch += 1;
		this.inFlight = false;
		this.failStreak = 0;
		this.storeInitialized = false;
		this.needsDeep = true;
		// The store outlives sessions (constructed once with the controller):
		// wipe it so the next session's widget never renders this session's
		// snapshot and a dangling failure episode can't emit a spurious
		// "feed recovered" on the next session's first successful poll.
		this.store.reset();
		// M2 state: a new session must never inherit tasks, identity, member
		// baselines, pipe baselines, or the divider record.
		this.tracker.reset();
		this.classifier.reset();
		this.identityAttempted = false;
		this.tailSuccessCount = 0;
		this.members = undefined;
		this.expectedCloses.clear();
		this.prevPipeIds = undefined;
		this.tailLook = undefined;
		// mentionProviderRegistered stays true (host-side registration is
		// process-wide); the provider goes inert because active is false.
		this.lastMentionValues = undefined;
	}

	/** UI calls must never take the poll loop down (stale pi throws after replacement). */
	private safeUi(fn: () => void): void {
		try {
			fn();
		} catch {
			// swallowed by design
		}
	}
}
