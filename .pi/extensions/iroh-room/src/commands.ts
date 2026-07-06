/**
 * Slash commands (SPEC §8.3/§8.4, DESIGN §5):
 * /room, /room-status, /room-send, /room-artifact, /room-preview, /room-tail.
 *
 * Handlers parse the raw args string, run the SAME core ops as the tools
 * (validation, config resolution, CLI path), and report through
 * ctx.ui.notify. All UI is guarded by ctx.hasUI so non-UI modes never crash;
 * headless automation should prefer the tools, which are the real surface.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildWhoamiArgs, parseJsonLine, runCli, tokenize } from "./cli.js";
import { resolveBinary, resolveConfig, resolveRoomId, type ResolvedConfig } from "./config.js";
import { COMMAND_NAMES, PIPE_ID_RE, STATUS_VOCABULARY } from "./constants.js";
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

function say(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, type);
	}
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Strip one pair of surrounding double quotes, e.g. /room-status implementing "msg". */
function unquote(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function describeFailure(envelope: Envelope): string {
	const code = envelope.error_code !== undefined ? `, ${String(envelope.error_code)}` : "";
	const detail =
		envelope.error_detail !== undefined ? String(envelope.error_detail) : String(envelope.stderr ?? "");
	return `failed (exit ${String(envelope.exit_code)}${code}): ${detail}`.trim();
}

/** Register all 6 slash commands. Must run synchronously in the factory body. */
export function registerIrohCommands(pi: ExtensionAPI, options: IrohRoomOptions = {}): ToolDeps {
	const deps = makeDeps(pi, options);

	pi.registerCommand(COMMAND_NAMES.room, {
		description: "Show iroh-room context: config, identity, binary, health, active preview pipes",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const lines: string[] = [];
			const issues: string[] = [];
			let cfg: ResolvedConfig;
			try {
				cfg = resolveConfig({ cwd: ctx.cwd, env: deps.env });
			} catch (err) {
				say(ctx, `iroh-room config error: ${errText(err)}`, "error");
				return;
			}
			if (cfg.roomId !== undefined) {
				lines.push(`room_id: ${cfg.roomId}`);
			} else {
				lines.push("room_id: (not set)");
				issues.push("no room_id — set IROH_ROOM_ID or \"room_id\" in .iroh-room-pi.json");
			}
			lines.push(`config file: ${cfg.configFilePath ?? "(none found)"}`);
			lines.push(`data dir (--data-dir): ${cfg.home ?? "(iroh-rooms default)"}`);
			lines.push(`agent name: ${cfg.agentName ?? "(unset)"}`);
			lines.push(`cwd: ${ctx.cwd}`);
			let bin: string | undefined;
			try {
				bin = resolveBinary(cfg, deps.env);
				let version = "";
				try {
					const res = await deps.exec(bin, ["--version"], { timeout: 10_000 });
					version = res.code === 0 ? ` (${res.stdout.trim()})` : "";
				} catch {
					// version probe is best-effort
				}
				lines.push(`binary: ${bin}${version}`);
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
			say(ctx, lines.join("\n"), issues.length === 0 ? "info" : "warning");
		},
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
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (raw === "") {
				say(ctx, "usage: /room-status <status> [message...]", "error");
				return;
			}
			const spaceIndex = raw.search(/\s/);
			const status = spaceIndex === -1 ? raw : raw.slice(0, spaceIndex);
			const message = spaceIndex === -1 ? undefined : unquote(raw.slice(spaceIndex + 1));
			try {
				const envelope = await opAgentStatus(
					deps,
					{ cwd: ctx.cwd },
					{ status, ...(message !== undefined && message !== "" ? { message } : {}) },
				);
				if (envelope.ok) {
					say(ctx, `agent.status "${status}" posted: ${String(envelope.event_id ?? "(event id not parsed)")}`);
				} else {
					say(ctx, `agent.status ${describeFailure(envelope)}`, "error");
				}
			} catch (err) {
				say(ctx, `/room-status error: ${errText(err)}`, "error");
			}
		},
	});

	pi.registerCommand(COMMAND_NAMES.roomSend, {
		description: "Send a room message: /room-send <message>",
		handler: async (args, ctx) => {
			const message = unquote(args);
			if (message === "") {
				say(ctx, "usage: /room-send <message>", "error");
				return;
			}
			try {
				const envelope = await opRoomSend(deps, { cwd: ctx.cwd }, { message });
				if (envelope.ok) {
					say(ctx, `message sent: ${String(envelope.event_id ?? "(event id not parsed)")}`);
				} else {
					say(ctx, `room send ${describeFailure(envelope)}`, "error");
				}
			} catch (err) {
				say(ctx, `/room-send error: ${errText(err)}`, "error");
			}
		},
	});

	pi.registerCommand(COMMAND_NAMES.roomArtifact, {
		description: 'Share an artifact: /room-artifact <path> [name] (quote paths with spaces)',
		handler: async (args, ctx) => {
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
				} else {
					say(ctx, `file share ${describeFailure(envelope)}`, "error");
				}
			} catch (err) {
				say(ctx, `/room-artifact error: ${errText(err)}`, "error");
			}
		},
	});

	pi.registerCommand(COMMAND_NAMES.roomPreview, {
		description:
			"Expose a loopback preview: /room-preview [--tcp 127.0.0.1:PORT] [--allow <64-hex>]... | --close [pipe_id]",
		handler: async (args, ctx) => {
			const tokens = tokenize(args);
			let tcp: string | undefined;
			const allow: string[] = [];
			let close = false;
			let closeId: string | undefined;
			for (let i = 0; i < tokens.length; i++) {
				const token = tokens[i];
				if (token === "--tcp") {
					tcp = tokens[++i];
				} else if (token === "--allow") {
					const value = tokens[++i];
					if (value !== undefined) allow.push(value);
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
						const envelope = await opPipeClose(deps, { cwd: ctx.cwd }, { pipe_id: closeId });
						say(
							ctx,
							envelope.ok ? `pipe ${closeId} closed (${String(envelope.closed)})` : `pipe close ${describeFailure(envelope)}`,
							envelope.ok ? "info" : "error",
						);
					} else {
						const closed = await deps.pipes.closeAll();
						say(ctx, closed.length === 0 ? "no preview pipes to close" : `closed ${closed.length} preview pipe(s): ${closed.join(", ")}`);
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
				const allowList = allow.length > 0 ? allow : cfg.allowedPreviewMembers;
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
				} else {
					say(ctx, `pipe expose ${describeFailure(envelope)}`, "error");
				}
			} catch (err) {
				say(ctx, `/room-preview error: ${errText(err)}`, "error");
			}
		},
	});

	pi.registerCommand(COMMAND_NAMES.roomTail, {
		description: "Show recent room events: /room-tail [limit]",
		handler: async (args, ctx) => {
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
				const events = envelope.events as { type: string; author?: string; timestamp?: string; summary: string }[];
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
		},
	});

	return deps;
}
