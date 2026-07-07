/**
 * Slash commands (SPEC §8.3/§8.4, DESIGN §5):
 * /room, /room-status, /room-send, /room-artifact, /room-preview, /room-tail,
 * /room-pulse, /room-cockpit.
 *
 * Handlers parse the raw args string, run the SAME core ops as the tools
 * (validation, config resolution, CLI path), and report through
 * ctx.ui.notify. All UI is guarded by ctx.hasUI so non-UI modes never crash;
 * headless automation should prefer the tools, which are the real surface.
 *
 * TUI mode (ctx.mode === "tui") upgrades the output channel (brief §4 M0):
 * /room and /room-tail emit one "iroh-room.card" custom message instead of a
 * notify dump, and the effectful commands additionally emit a one-line
 * "iroh-room.receipt" after success. The LLM-visible `content` of every
 * card/receipt carries ZERO room-authored text — counts, ids, and our own
 * command's echo only; room strings travel in `details`, which never reaches
 * the model. `triggerTurn` is never set. Non-TUI modes keep the exact same
 * say() output as before.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildWhoamiArgs, parseJsonLine, runCli, tokenize } from "./cli.js";
import { resolveBinary, resolveConfig, resolveRoomId, type ResolvedConfig } from "./config.js";
import {
	CARD_TYPE,
	COMMAND_NAMES,
	DENSITY_ENTRY_TYPE,
	PIPE_ID_RE,
	PULSE_DENSITIES,
	RECEIPT_TYPE,
	STATUS_VOCABULARY,
	type PulseDensity,
} from "./constants.js";
import { previewArgCompletions, sendArgCompletions } from "./tui/complete.js";
import {
	makeDeps,
	opAgentStatus,
	opFileShare,
	opPipeClose,
	opPipeExpose,
	opRoomSend,
	opTailSnapshot,
	type Envelope,
	type IrohRoomOptions,
	type ToolDeps,
} from "./tools.js";
import { registerCardRenderers } from "./tui/wire.js";
import { COCKPIT_TABS, type CockpitTab } from "./tui/cockpit/model.js";

function say(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, type);
	}
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function describeFailure(envelope: Envelope): string {
	const code = envelope.error_code !== undefined ? `, ${String(envelope.error_code)}` : "";
	const detail =
		envelope.error_detail !== undefined ? String(envelope.error_detail) : String(envelope.stderr ?? "");
	return `failed (exit ${String(envelope.exit_code)}${code}): ${detail}`.trim();
}

function isTui(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui";
}

/**
 * Member-pick select deadline (brief §1: ui.select takes { signal?, timeout? };
 * anything other than an explicit pick is a decline). Without it the awaited
 * select can park the handler forever when the host disposes an open selector
 * on session replacement without settling its promise.
 */
const MEMBER_PICK_TIMEOUT_MS = 60_000;

/** Register all 8 slash commands. Must run synchronously in the factory body. */
export function registerIrohCommands(pi: ExtensionAPI, options: IrohRoomOptions = {}): ToolDeps {
	const deps = makeDeps(pi, options);
	registerCardRenderers(pi);

	/** One transcript card (tui only). `content` must carry no room-authored text. */
	const sendCard = (content: string, details: Record<string, unknown>): void => {
		pi.sendMessage({ customType: CARD_TYPE, content, display: true, details });
	};

	/** One post-success receipt (tui only). Same security split as cards. */
	const sendReceipt = (ctx: ExtensionContext, content: string, details: Record<string, unknown>): void => {
		if (!isTui(ctx)) return;
		pi.sendMessage({
			customType: RECEIPT_TYPE,
			content,
			display: true,
			details: { kind: "receipt", ...details },
		});
	};

	const ambient = options.ambient;
	const cockpit = options.cockpit;
	/**
	 * Every /room* handler boosts the ambient poll after running (recent
	 * interaction ≈ attention, brief §4 M1). No-op when no controller is wired.
	 */
	const withBoost = (
		handler: (args: string, ctx: ExtensionContext) => Promise<void>,
	): ((args: string, ctx: ExtensionContext) => Promise<void>) => {
		return async (args, ctx) => {
			try {
				await handler(args, ctx);
			} finally {
				ambient?.boost();
			}
		};
	};

	pi.registerCommand(COMMAND_NAMES.room, {
		description: "Show iroh-room context: config, identity, binary, health, active preview pipes",
		handler: withBoost(async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const lines: string[] = [];
			const issues: string[] = [];
			const details: Record<string, unknown> = { kind: "room", cwd: ctx.cwd };
			let cfg: ResolvedConfig;
			try {
				cfg = resolveConfig({ cwd: ctx.cwd, env: deps.env });
			} catch (err) {
				say(ctx, `iroh-room config error: ${errText(err)}`, "error");
				return;
			}
			if (cfg.roomId !== undefined) {
				lines.push(`room_id: ${cfg.roomId}`);
				details.room_id = cfg.roomId;
			} else {
				lines.push("room_id: (not set)");
				issues.push("no room_id — set IROH_ROOM_ID or \"room_id\" in .iroh-room-pi.json");
			}
			lines.push(`config file: ${cfg.configFilePath ?? "(none found)"}`);
			lines.push(`data dir (--data-dir): ${cfg.home ?? "(iroh-rooms default)"}`);
			lines.push(`agent name: ${cfg.agentName ?? "(unset)"}`);
			lines.push(`cwd: ${ctx.cwd}`);
			if (cfg.configFilePath !== undefined) details.config_file = cfg.configFilePath;
			if (cfg.home !== undefined) details.data_dir = cfg.home;
			if (cfg.agentName !== undefined) details.agent_name = cfg.agentName;
			let bin: string | undefined;
			try {
				bin = resolveBinary(cfg, deps.env);
				let version = "";
				try {
					const res = await deps.exec(bin, ["--version"], { timeout: 10_000 });
					version = res.code === 0 ? ` (${res.stdout.trim()})` : "";
					if (res.code === 0) details.binary_version = res.stdout.trim();
				} catch {
					// version probe is best-effort
				}
				lines.push(`binary: ${bin}${version}`);
				details.binary = bin;
			} catch (err) {
				lines.push("binary: NOT FOUND");
				issues.push(errText(err));
			}
			if (bin !== undefined) {
				try {
					const run = await runCli(deps.exec, bin, buildWhoamiArgs(), {
						...(cfg.home !== undefined ? { home: cfg.home } : {}),
						cwd: ctx.cwd,
						timeoutMs: 10_000,
					});
					if (run.ok) {
						const identity = parseJsonLine<{ name?: string; identity_id?: string }>(
							run.stdout,
							"identity show",
						);
						lines.push(`identity: ${identity.name ?? "?"} (${(identity.identity_id ?? "").slice(0, 8)}…)`);
						details.identity_name = identity.name ?? "?";
						details.identity_id8 = (identity.identity_id ?? "").slice(0, 8);
					} else {
						lines.push("identity: none");
						issues.push("no identity — run `iroh-rooms identity create --name <name>` in this data dir");
					}
				} catch (err) {
					lines.push("identity: unknown");
					issues.push(`identity check failed: ${errText(err)}`);
				}
			}
			const pipes = deps.pipes.list();
			if (pipes.length === 0) {
				lines.push("preview pipes: (none)");
			} else {
				lines.push("preview pipes:");
				for (const pipe of pipes) {
					lines.push(`  ${pipe.pipeId} → ${pipe.target}${pipe.label !== undefined ? ` (${pipe.label})` : ""}`);
				}
			}
			lines.push(issues.length === 0 ? "health: ok" : `health: ${issues.join("; ")}`);
			if (isTui(ctx)) {
				details.pipes = pipes.map((pipe) => ({
					pipe_id: pipe.pipeId,
					target: pipe.target,
					...(pipe.label !== undefined ? { label: pipe.label } : {}),
				}));
				details.issues = issues;
				// M2 catch-up slot (brief §3.4): current unclaimed task ids, ≤5,
				// heuristic~. Room-authored — rendered only via roomText in cards.
				const unclaimed = ambient?.listUnclaimedTaskIds?.() ?? [];
				if (unclaimed.length > 0) {
					details.unclaimed_tasks = unclaimed.slice(0, 5);
				}
				sendCard(
					`[iroh-room] room health: ${issues.length === 0 ? "ok" : `${issues.length} issue(s)`} · ${pipes.length} pipe(s)`,
					details,
				);
				return;
			}
			say(ctx, lines.join("\n"), issues.length === 0 ? "info" : "warning");
		}),
	});

	pi.registerCommand(COMMAND_NAMES.roomStatus, {
		description: "Post agent.status: /room-status <status> [message...]",
		getArgumentCompletions: (prefix) => {
			const items = STATUS_VOCABULARY.filter((status) => status.startsWith(prefix)).map((status) => ({
				value: status,
				label: status,
			}));
			return items.length > 0 ? items : null;
		},
		handler: withBoost(async (args, ctx) => {
			const raw = args.trim();
			if (raw === "") {
				say(ctx, "usage: /room-status <status> [message...]", "error");
				return;
			}
			const spaceIndex = raw.search(/\s/);
			const status = spaceIndex === -1 ? raw : raw.slice(0, spaceIndex);
			// Rest of line is the message, VERBATIM (quotes included) — no
			// quote-stripping outside tokenized commands (/room-artifact).
			const message = spaceIndex === -1 ? undefined : raw.slice(spaceIndex + 1).trim();
			try {
				const envelope = await opAgentStatus(
					deps,
					{ cwd: ctx.cwd },
					{ status, ...(message !== undefined && message !== "" ? { message } : {}) },
				);
				if (envelope.ok) {
					say(ctx, `agent.status "${status}" posted: ${String(envelope.event_id ?? "(event id not parsed)")}`);
					sendReceipt(ctx, `[iroh-room] status posted: ${status}`, {
						action: "status posted",
						label: status,
						...(envelope.event_id !== undefined ? { event_id: envelope.event_id } : {}),
					});
				} else {
					say(ctx, `agent.status ${describeFailure(envelope)}`, "error");
				}
			} catch (err) {
				say(ctx, `/room-status error: ${errText(err)}`, "error");
			}
		}),
	});

	pi.registerCommand(COMMAND_NAMES.roomSend, {
		description: "Send a room message: /room-send <message> (#<task-id> completes tracked tasks)",
		// #<task-id> completions over the tracked task ids (U5-validated).
		getArgumentCompletions: (prefix) => sendArgCompletions(prefix, ambient?.listTaskIds?.() ?? []),
		handler: withBoost(async (args, ctx) => {
			// The whole args string is the message, VERBATIM (quotes included).
			const message = args.trim();
			if (message === "") {
				say(ctx, "usage: /room-send <message>", "error");
				return;
			}
			try {
				const envelope = await opRoomSend(deps, { cwd: ctx.cwd }, { message });
				if (envelope.ok) {
					say(ctx, `message sent: ${String(envelope.event_id ?? "(event id not parsed)")}`);
					sendReceipt(ctx, `[iroh-room] message sent: ${String(envelope.event_id ?? "(event id not parsed)")}`, {
						action: "message sent",
						...(envelope.event_id !== undefined ? { event_id: envelope.event_id } : {}),
					});
				} else {
					say(ctx, `room send ${describeFailure(envelope)}`, "error");
				}
			} catch (err) {
				say(ctx, `/room-send error: ${errText(err)}`, "error");
			}
		}),
	});

	pi.registerCommand(COMMAND_NAMES.roomArtifact, {
		description: 'Share an artifact: /room-artifact <path> [name] (quote paths with spaces)',
		handler: withBoost(async (args, ctx) => {
			const tokens = tokenize(args);
			const filePath = tokens[0];
			if (filePath === undefined || filePath === "") {
				say(ctx, "usage: /room-artifact <path> [name]", "error");
				return;
			}
			const name = tokens[1];
			try {
				const envelope = await opFileShare(
					deps,
					{ cwd: ctx.cwd },
					{ path: filePath, ...(name !== undefined ? { name } : {}) },
				);
				if (envelope.ok) {
					say(
						ctx,
						`artifact shared: ${String(envelope.file_id ?? "(file id not parsed)")} (event ${String(envelope.event_id ?? "?")})`,
					);
					sendReceipt(ctx, `[iroh-room] artifact shared: ${String(envelope.file_id ?? "(file id not parsed)")}`, {
						action: "artifact shared",
						...(envelope.file_id !== undefined ? { file_id: envelope.file_id } : {}),
						...(envelope.event_id !== undefined ? { event_id: envelope.event_id } : {}),
					});
				} else {
					say(ctx, `file share ${describeFailure(envelope)}`, "error");
				}
			} catch (err) {
				say(ctx, `/room-artifact error: ${errText(err)}`, "error");
			}
		}),
	});

	pi.registerCommand(COMMAND_NAMES.roomPreview, {
		description:
			"Expose a loopback preview: /room-preview [--tcp 127.0.0.1:PORT] [--allow <64-hex>]... | --close [pipe_id]",
		// --allow= completes members-poll ids; --close= completes live pipe ids.
		getArgumentCompletions: (prefix) =>
			previewArgCompletions(
				prefix,
				ambient?.listMembers?.() ?? [],
				deps.pipes.list().map((pipe) => pipe.pipeId),
			),
		handler: withBoost(async (args, ctx) => {
			const tokens = tokenize(args);
			let tcp: string | undefined;
			const allow: string[] = [];
			let close = false;
			let closeId: string | undefined;
			for (let i = 0; i < tokens.length; i++) {
				const token = tokens[i];
				// Equals forms mirror the completion values (--allow=<id> etc.).
				if (token !== undefined && token.startsWith("--tcp=")) {
					const value = token.slice("--tcp=".length);
					if (value === "") {
						say(
							ctx,
							"--tcp requires a value, e.g. --tcp=127.0.0.1:3000 — omit --tcp entirely to use the configured default",
							"error",
						);
						return;
					}
					tcp = value;
					continue;
				}
				if (token !== undefined && token.startsWith("--allow=")) {
					const value = token.slice("--allow=".length);
					if (value === "") {
						say(
							ctx,
							"--allow requires a value (a 64-hex member identity id) — omit --allow entirely to use allowed_preview_members from config",
							"error",
						);
						return;
					}
					allow.push(value);
					continue;
				}
				if (token !== undefined && token.startsWith("--close=") && token !== "--close=") {
					close = true;
					closeId = token.slice("--close=".length);
					continue;
				}
				if (token === "--tcp") {
					// A flag given WITHOUT a value is a usage error; only an
					// omitted --tcp falls back to the config default.
					const value = tokens[++i];
					if (value === undefined || value.startsWith("--")) {
						say(
							ctx,
							"--tcp requires a value, e.g. --tcp 127.0.0.1:3000 — omit --tcp entirely to use the configured default",
							"error",
						);
						return;
					}
					tcp = value;
				} else if (token === "--allow") {
					const value = tokens[++i];
					if (value === undefined || value.startsWith("--")) {
						say(
							ctx,
							"--allow requires a value (a 64-hex member identity id) — omit --allow entirely to use allowed_preview_members from config",
							"error",
						);
						return;
					}
					allow.push(value);
				} else if (token === "--close") {
					close = true;
					const next = tokens[i + 1];
					if (next !== undefined && !next.startsWith("--")) {
						closeId = next;
						i++;
					}
				} else {
					say(
						ctx,
						`unknown argument ${String(token)} — usage: /room-preview [--tcp 127.0.0.1:PORT] [--allow <64-hex>]... | --close [pipe_id]`,
						"error",
					);
					return;
				}
			}
			try {
				if (close) {
					if (closeId !== undefined) {
						if (!PIPE_ID_RE.test(closeId)) {
							say(ctx, `invalid pipe_id ${closeId}: expected 32 lowercase hex chars`, "error");
							return;
						}
						// Our own close: never a pipe_closed_own toast — opPipeClose
						// marks the id as EXPECTED (via deps.ambient) BEFORE the
						// registry entry vanishes, so a boosted tick mid-await
						// cannot race it.
						const envelope = await opPipeClose(deps, { cwd: ctx.cwd }, { pipe_id: closeId });
						say(
							ctx,
							envelope.ok ? `pipe ${closeId} closed (${String(envelope.closed)})` : `pipe close ${describeFailure(envelope)}`,
							envelope.ok ? "info" : "error",
						);
						if (envelope.ok) {
							sendReceipt(ctx, `[iroh-room] pipe closed: ${closeId}`, {
								action: "pipe closed",
								pipe_id: closeId,
							});
						}
					} else {
						for (const pipe of deps.pipes.list()) {
							ambient?.noteExpectedPipeClose?.(pipe.pipeId);
						}
						const closed = await deps.pipes.closeAll();
						say(ctx, closed.length === 0 ? "no preview pipes to close" : `closed ${closed.length} preview pipe(s): ${closed.join(", ")}`);
						if (closed.length > 0) {
							sendReceipt(ctx, `[iroh-room] closed ${closed.length} preview pipe(s)`, {
								action: "pipes closed",
								count: closed.length,
							});
						}
					}
					return;
				}
				const cfg = resolveConfig({ cwd: ctx.cwd, env: deps.env });
				if (tcp === undefined) {
					if (cfg.defaultPreviewHost !== "127.0.0.1") {
						say(
							ctx,
							`refusing default preview host ${cfg.defaultPreviewHost}: only 127.0.0.1 is allowed — pass --tcp 127.0.0.1:<port>`,
							"error",
						);
						return;
					}
					tcp = `127.0.0.1:${cfg.defaultPreviewPort}`;
				}
				let allowList = allow.length > 0 ? allow : cfg.allowedPreviewMembers;
				// Member-pick (M2, tui only): no --allow and no config allowlist —
				// which today ALWAYS errors — offers a select over the members-poll
				// ids. Labels are a collision-free id prefix (≥8 hex, lengthened
				// until unique) + shape-checked role (members json carries no
				// display names, brief §2.7). undefined/timeout/unknown => decline:
				// the empty allow list falls through to today's exact error.
				// Non-tui behavior stays byte-identical.
				if (allowList.length === 0 && isTui(ctx)) {
					const members = ambient?.listMembers?.() ?? [];
					const offered: { id: string; role: string }[] = [];
					for (const member of members) {
						if (!/^[0-9a-f]{64}$/.test(member.id)) {
							continue; // fail closed: only validated identity ids are offered
						}
						if (offered.some((seen) => seen.id === member.id)) {
							continue; // exact duplicate id: one choice only
						}
						const role = /^[a-z_]{1,16}$/i.test(member.role) ? member.role : "member";
						offered.push({ id: member.id, role });
					}
					// The pick maps straight into the pipe allow-list — an
					// access-control grant — and the id prefix is the ONLY
					// identity signal shown (members json carries no display
					// names, brief §2.7). A short fixed prefix is grindable
					// (~2^32 keygens for 8 hex), so LENGTHEN the shown prefix
					// until it is unique across the offered members: colliding
					// prefixes must never render as indistinguishable choices.
					let prefixLen = 8;
					while (
						prefixLen < 64 &&
						new Set(offered.map((member) => member.id.slice(0, prefixLen))).size !== offered.length
					) {
						prefixLen += 4;
					}
					const labels: string[] = [];
					const byLabel = new Map<string, string>();
					for (const member of offered) {
						const label = `${member.id.slice(0, prefixLen)}${prefixLen < 64 ? "…" : ""} (${member.role})`;
						labels.push(label);
						byLabel.set(label, member.id);
					}
					if (labels.length > 0) {
						// timeout => the promise settles (undefined) even if the
						// user walks away; undefined/unknown label => decline:
						// the empty allow list falls through to today's error.
						const picked = await ctx.ui.select(
							"Allow which member to connect to this preview pipe?",
							labels,
							{ timeout: MEMBER_PICK_TIMEOUT_MS },
						);
						const id = picked === undefined ? undefined : byLabel.get(picked);
						if (id !== undefined) {
							allowList = [id];
						}
					}
				}
				const envelope = await opPipeExpose(deps, { cwd: ctx.cwd }, { tcp, allow: allowList });
				if (envelope.ok) {
					const room = resolveRoomId(cfg);
					const hint =
						envelope.connect_hint !== undefined
							? String(envelope.connect_hint)
							: `iroh-rooms pipe connect ${room} ${String(envelope.pipe_id)} --local <PORT>`;
					say(
						ctx,
						[
							`preview pipe open: ${String(envelope.pipe_id)} → ${String(envelope.target)}`,
							`connectors run: ${hint}`,
							`close it with: /room-preview --close ${String(envelope.pipe_id)}`,
						].join("\n"),
					);
					sendReceipt(
						ctx,
						`[iroh-room] preview pipe open: ${String(envelope.pipe_id)} → ${String(envelope.target)}`,
						{
							action: "preview pipe open",
							pipe_id: envelope.pipe_id,
							target: envelope.target,
						},
					);
				} else {
					say(ctx, `pipe expose ${describeFailure(envelope)}`, "error");
				}
			} catch (err) {
				say(ctx, `/room-preview error: ${errText(err)}`, "error");
			}
		}),
	});

	pi.registerCommand(COMMAND_NAMES.roomTail, {
		description: "Show recent room events: /room-tail [limit]",
		handler: withBoost(async (args, ctx) => {
			const raw = args.trim();
			let limit: number | undefined;
			if (raw !== "") {
				const parsed = Number(raw);
				if (!Number.isFinite(parsed)) {
					say(ctx, "usage: /room-tail [limit]", "error");
					return;
				}
				limit = parsed;
			}
			try {
				const envelope = await opTailSnapshot(
					deps,
					{ cwd: ctx.cwd },
					limit !== undefined ? { limit } : {},
				);
				if (!envelope.ok) {
					say(ctx, `room tail ${describeFailure(envelope)}`, "error");
					return;
				}
				const events = envelope.events as {
					event_id?: string;
					type: string;
					lamport?: number;
					author?: string;
					timestamp?: string;
					summary: string;
				}[];
				if (isTui(ctx)) {
					// Security split: the LLM-visible content carries the count
					// only; the room-authored events live in details (renderer-only).
					let roomId: string | undefined;
					try {
						roomId = resolveConfig({ cwd: ctx.cwd, env: deps.env }).roomId;
					} catch {
						// card renders without the room id prefix
					}
					// New-since-last-look (M2): the controller records this card's
					// max (lamport, event_id) and hands back the PREVIOUS record;
					// cards.ts draws the divider before the first newer event.
					const newSince = ambient?.noteTailLook?.(events);
					sendCard(`[iroh-room] tail snapshot: ${events.length} event${events.length === 1 ? "" : "s"}`, {
						kind: "tail",
						...(roomId !== undefined ? { room_id: roomId } : {}),
						count: events.length,
						...(newSince !== undefined ? { new_since: newSince } : {}),
						events,
					});
					return;
				}
				const lines = events.map(
					(event) =>
						`[${event.timestamp ?? "?"}] ${event.author ?? "?"} ${event.type} — ${event.summary}`,
				);
				lines.push("");
				lines.push(String(envelope.summary));
				say(ctx, lines.join("\n"));
			} catch (err) {
				say(ctx, `/room-tail error: ${errText(err)}`, "error");
			}
		}),
	});

	// Shared by /room-pulse AND the ctrl+alt+r shortcut (M2): the shortcut
	// cycles density through the EXACT same code path as /room-pulse no-arg.
	const pulseHandler = withBoost(async (args: string, ctx: ExtensionContext) => {
		if (ambient === undefined) {
			say(ctx, "room pulse is unavailable (no ambient controller wired)", "warning");
			return;
		}
		const raw = args.trim();
		let density: PulseDensity;
		if (raw === "") {
			density = ambient.cycleDensity();
		} else if ((PULSE_DENSITIES as readonly string[]).includes(raw)) {
			density = raw as PulseDensity;
			await ambient.setDensity(density);
		} else {
			say(ctx, "usage: /room-pulse [off|pill|1|2]", "error");
			return;
		}
		// Persist for session restore (custom entry — never sent to the LLM).
		pi.appendEntry(DENSITY_ENTRY_TYPE, { density });
		say(ctx, `room pulse density: ${density}`);
	});

	pi.registerCommand(COMMAND_NAMES.roomPulse, {
		description: "Set the room pulse density: /room-pulse [off|pill|1|2] (no argument cycles)",
		getArgumentCompletions: (prefix) => {
			const items = PULSE_DENSITIES.filter((density) => density.startsWith(prefix)).map(
				(density) => ({ value: density, label: density }),
			);
			return items.length > 0 ? items : null;
		},
		handler: pulseHandler,
	});

	const cockpitUsage =
		"usage: /room-cockpit [open|close|refresh|tab overview|tab timeline|tab tasks|tab health]";
	const isCockpitTab = (value: string | undefined): value is CockpitTab =>
		value !== undefined && (COCKPIT_TABS as readonly string[]).includes(value);

	pi.registerCommand(COMMAND_NAMES.roomCockpit, {
		description: "Open the read-only iroh-room cockpit (TUI mode only)",
		getArgumentCompletions: (prefix) => {
			const values = ["open", "close", "refresh", "tab", ...COCKPIT_TABS];
			const items = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const tokens = tokenize(args.trim());
			const subcommand = tokens[0] ?? "open";
			if (!isTui(ctx)) {
				if (ctx.mode === "rpc" && ctx.hasUI) {
					say(ctx, "/room-cockpit is only available in TUI mode", "warning");
				}
				return; // json/print: no custom UI and no ambient side effects
			}
			if (cockpit === undefined) {
				say(ctx, "room cockpit is unavailable (no cockpit controller wired)", "warning");
				return;
			}
			if (subcommand === "open") {
				ambient?.boost();
				await cockpit.open("full", ctx);
				return;
			}
			if (subcommand === "close") {
				cockpit.close("user");
				ambient?.boost();
				say(ctx, "room cockpit closed");
				return;
			}
			if (subcommand === "refresh") {
				ambient?.boost();
				await ambient?.requestRefresh();
				say(ctx, "room cockpit refresh requested");
				return;
			}
			if (subcommand === "tab") {
				const tab = tokens[1];
				if (!isCockpitTab(tab)) {
					say(ctx, cockpitUsage, "error");
					return;
				}
				cockpit.selectTab?.(tab);
				ambient?.boost();
				return;
			}
			if (isCockpitTab(subcommand)) {
				cockpit.selectTab?.(subcommand);
				ambient?.boost();
				return;
			}
			say(ctx, cockpitUsage, "error");
		},
	});

	pi.registerShortcut("ctrl+alt+r", {
		description: "Cycle the iroh-room pulse density (off → pill → 1 → 2)",
		handler: (ctx) => pulseHandler("", ctx),
	});

	return deps;
}
