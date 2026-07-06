/**
 * Model-facing tools (SPEC §10, DESIGN §5).
 *
 * Envelope contract (uniform across tools):
 * - success:      { ok: true, event_id?/file_id?/pipe_id?, …parsed fields, stdout, stderr? }
 * - CLI failure:  { ok: false, exit_code, error_code?, error_detail?, stdout, stderr } — RETURNED, not thrown
 * - local errors (validation, missing config, binary not found, spawn/timeout)
 *   THROW, which marks the tool result as an error for the model.
 *
 * All CLI output is redacted and capped to 8KB before entering an envelope.
 * The core ops are exported so slash commands (commands.ts) share the exact
 * same validation + CLI path.
 */

import process from "node:process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	buildCloseArgs,
	buildExposeArgs,
	buildFileListArgs,
	buildMembersArgs,
	buildPipeListArgs,
	buildSendArgs,
	buildShareArgs,
	buildStatusArgs,
	buildTailArgs,
	buildWhoamiArgs,
	parseJsonLine,
	parseSendEventId,
	parseShareOutput,
	parseStatusEventId,
	parseTailJson,
	runCli,
	snapshotFromRows,
	withDataDir,
	type CliRunResult,
	type ExecFn,
} from "./cli.js";
import { resolveBinary, resolveConfig, resolveRoomId, type Env, type ResolvedConfig } from "./config.js";
import { STATUS_VOCABULARY, TOOL_NAMES } from "./constants.js";
import { PipeManager } from "./pipes.js";
import { redact, redactAndCap } from "./redact.js";
import {
	clampTailLimit,
	validateAllowList,
	validateArtifactIds,
	validateArtifactPath,
	validateFileName,
	validateLabel,
	validateMessageBody,
	validateMime,
	validatePipeId,
	validateProgress,
	validateStatusLabel,
	validateStatusMessage,
	validateTcpTarget,
	validateTtlSeconds,
} from "./validate.js";

/* ------------------------------------------------------------------ */
/* deps and envelope plumbing                                          */
/* ------------------------------------------------------------------ */

export interface ToolDeps {
	exec: ExecFn;
	env: Env;
	pipes: PipeManager;
}

export interface IrohRoomOptions {
	exec?: ExecFn;
	env?: Env;
	pipes?: PipeManager;
}

/** Build the dependency bundle; defaults wire pi.exec, process.env, a fresh PipeManager. */
export function makeDeps(pi: ExtensionAPI, options: IrohRoomOptions = {}): ToolDeps {
	return {
		exec: options.exec ?? ((command, args, execOptions) => pi.exec(command, args, execOptions)),
		env: options.env ?? process.env,
		pipes: options.pipes ?? new PipeManager(),
	};
}

export interface OpContext {
	cwd: string;
	signal?: AbortSignal;
}

export type Envelope = { ok: boolean; [key: string]: unknown };

function failureEnvelope(run: CliRunResult): Envelope {
	const envelope: Envelope = { ok: false, exit_code: run.code };
	if (run.errorCode !== undefined) {
		envelope.error_code = run.errorCode;
		envelope.error_detail = run.errorDetail;
	}
	envelope.stdout = redactAndCap(run.stdout);
	envelope.stderr = redactAndCap(run.stderr);
	return envelope;
}

function successEnvelope(run: CliRunResult, extra: Record<string, unknown> = {}): Envelope {
	const envelope: Envelope = { ok: true };
	for (const [key, value] of Object.entries(extra)) {
		if (value !== undefined) {
			envelope[key] = value;
		}
	}
	envelope.stdout = redactAndCap(run.stdout);
	if (run.stderr.trim() !== "") {
		envelope.stderr = redactAndCap(run.stderr);
	}
	return envelope;
}

function loadContext(deps: ToolDeps, cwd: string): { cfg: ResolvedConfig; bin: string } {
	const cfg = resolveConfig({ cwd, env: deps.env });
	const bin = resolveBinary(cfg, deps.env);
	return { cfg, bin };
}

/* ------------------------------------------------------------------ */
/* core ops — shared by tools and slash commands                       */
/* ------------------------------------------------------------------ */

export async function opAgentStatus(
	deps: ToolDeps,
	op: OpContext,
	input: {
		room_id?: string;
		status: string;
		message?: string;
		progress?: number;
		artifact_ids?: string[];
	},
): Promise<Envelope> {
	const { cfg, bin } = loadContext(deps, op.cwd);
	const room = resolveRoomId(cfg, input.room_id);
	const status = validateStatusLabel(input.status);
	const message = validateStatusMessage(input.message);
	const progress = validateProgress(input.progress ?? cfg.defaultProgress);
	const artifactIds = validateArtifactIds(input.artifact_ids);
	const args = buildStatusArgs({
		room,
		status,
		...(message !== undefined ? { message } : {}),
		...(progress !== undefined ? { progress } : {}),
		...(artifactIds !== undefined ? { artifactIds } : {}),
	});
	const run = await runCli(deps.exec, bin, args, opts(cfg, op));
	if (!run.ok) return failureEnvelope(run);
	return successEnvelope(run, { event_id: parseStatusEventId(run.stdout) });
}

export async function opRoomSend(
	deps: ToolDeps,
	op: OpContext,
	input: { room_id?: string; message: string },
): Promise<Envelope> {
	const { cfg, bin } = loadContext(deps, op.cwd);
	const room = resolveRoomId(cfg, input.room_id);
	const message = validateMessageBody(input.message);
	const run = await runCli(deps.exec, bin, buildSendArgs({ room, message }), opts(cfg, op));
	if (!run.ok) return failureEnvelope(run);
	return successEnvelope(run, { event_id: parseSendEventId(run.stdout) });
}

export async function opTailSnapshot(
	deps: ToolDeps,
	op: OpContext,
	input: {
		room_id?: string;
		limit?: number;
		include_agent_status?: boolean;
		include_files?: boolean;
	},
): Promise<Envelope> {
	const { cfg, bin } = loadContext(deps, op.cwd);
	const room = resolveRoomId(cfg, input.room_id);
	const limit = clampTailLimit(input.limit);
	const run = await runCli(deps.exec, bin, buildTailArgs({ room, limit }), opts(cfg, op));
	if (!run.ok) return failureEnvelope(run);
	const rows = parseTailJson(run.stdout);
	const snapshot = snapshotFromRows(rows, {
		includeAgentStatus: input.include_agent_status ?? true,
		includeFiles: input.include_files ?? true,
	});
	// Raw stdout deliberately omitted here to keep the model's context small.
	return {
		ok: true,
		events: snapshot.events.map((event) => ({ ...event, summary: redact(event.summary) })),
		summary: redact(snapshot.summary),
	};
}

export async function opFileShare(
	deps: ToolDeps,
	op: OpContext,
	input: { room_id?: string; path: string; name?: string; mime?: string },
): Promise<Envelope> {
	const { cfg, bin } = loadContext(deps, op.cwd);
	const room = resolveRoomId(cfg, input.room_id);
	const name = validateFileName(input.name);
	const mime = validateMime(input.mime);
	const filePath = validateArtifactPath(input.path, {
		cwd: op.cwd,
		...(cfg.artifactDir !== undefined ? { artifactDir: cfg.artifactDir } : {}),
		allowOutside: cfg.allowArtifactPathsOutsideWorkspace,
	});
	const args = buildShareArgs({
		room,
		path: filePath,
		...(name !== undefined ? { name } : {}),
		...(mime !== undefined ? { mime } : {}),
	});
	const run = await runCli(deps.exec, bin, args, opts(cfg, op));
	if (!run.ok) return failureEnvelope(run);
	const parsed = parseShareOutput(run.stdout);
	return successEnvelope(run, { file_id: parsed.fileId, event_id: parsed.eventId });
}

export async function opPipeExpose(
	deps: ToolDeps,
	op: OpContext,
	input: { room_id?: string; tcp: string; allow: string[]; label?: string; ttl_seconds?: number },
): Promise<Envelope> {
	const { cfg, bin } = loadContext(deps, op.cwd);
	const room = resolveRoomId(cfg, input.room_id);
	const tcp = validateTcpTarget(input.tcp);
	const allow = validateAllowList(input.allow);
	const label = validateLabel(input.label);
	const ttlSeconds = validateTtlSeconds(input.ttl_seconds);
	const args = withDataDir(
		cfg.home,
		buildExposeArgs({
			room,
			tcp,
			allow,
			...(label !== undefined ? { label } : {}),
			...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
		}),
	);
	// Long-running: goes through PipeManager, not pi.exec. Failures throw.
	const { record, stdout } = await deps.pipes.expose({
		bin,
		args,
		roomId: room,
		target: tcp,
		...(label !== undefined ? { label } : {}),
		cwd: op.cwd,
	});
	const envelope: Envelope = { ok: true, pipe_id: record.pipeId, target: record.target };
	if (record.connectHint !== undefined) {
		envelope.connect_hint = record.connectHint;
	}
	envelope.stdout = redactAndCap(stdout);
	return envelope;
}

export async function opPipeClose(
	deps: ToolDeps,
	op: OpContext,
	input: { pipe_id: string },
): Promise<Envelope> {
	const pipeId = validatePipeId(input.pipe_id);
	if (deps.pipes.has(pipeId)) {
		await deps.pipes.close(pipeId);
		return { ok: true, pipe_id: pipeId, closed: "local", stdout: "" };
	}
	// Not ours — ask the CLI (room is inferred from the local log).
	const { cfg, bin } = loadContext(deps, op.cwd);
	const run = await runCli(deps.exec, bin, buildCloseArgs({ pipeId }), opts(cfg, op));
	if (!run.ok) return failureEnvelope(run);
	return successEnvelope(run, { pipe_id: pipeId, closed: "cli" });
}

export async function opPipeList(
	deps: ToolDeps,
	op: OpContext,
	input: { room_id?: string },
): Promise<Envelope> {
	const { cfg, bin } = loadContext(deps, op.cwd);
	const room = resolveRoomId(cfg, input.room_id);
	const localPipes = deps.pipes.list().map((record) => ({
		pipe_id: record.pipeId,
		room_id: record.roomId,
		target: record.target,
		label: record.label,
		started_at: new Date(record.startedAt).toISOString(),
	}));
	const run = await runCli(deps.exec, bin, buildPipeListArgs({ room }), opts(cfg, op));
	if (!run.ok) return { ...failureEnvelope(run), local_pipes: localPipes };
	return successEnvelope(run, { local_pipes: localPipes });
}

export async function opRoomMembers(
	deps: ToolDeps,
	op: OpContext,
	input: { room_id?: string },
): Promise<Envelope> {
	const { cfg, bin } = loadContext(deps, op.cwd);
	const room = resolveRoomId(cfg, input.room_id);
	const run = await runCli(deps.exec, bin, buildMembersArgs({ room }), opts(cfg, op));
	if (!run.ok) return failureEnvelope(run);
	const extra: Record<string, unknown> = {};
	try {
		const parsed = parseJsonLine<{ room?: string; admin?: string; members?: unknown[] }>(
			run.stdout,
			"room members",
		);
		extra.room = parsed.room;
		extra.admin = parsed.admin;
		extra.members = parsed.members;
	} catch {
		// defensive: keep raw stdout even if the JSON shape shifts
	}
	return successEnvelope(run, extra);
}

export async function opFileList(
	deps: ToolDeps,
	op: OpContext,
	input: { room_id?: string },
): Promise<Envelope> {
	const { cfg, bin } = loadContext(deps, op.cwd);
	const room = resolveRoomId(cfg, input.room_id);
	const run = await runCli(deps.exec, bin, buildFileListArgs({ room }), opts(cfg, op));
	if (!run.ok) return failureEnvelope(run);
	const extra: Record<string, unknown> = {};
	try {
		extra.files = parseJsonLine<unknown[]>(run.stdout, "file list");
	} catch {
		// defensive: keep raw stdout even if the JSON shape shifts
	}
	return successEnvelope(run, extra);
}

export async function opIdentityShow(deps: ToolDeps, op: OpContext): Promise<Envelope> {
	const { cfg, bin } = loadContext(deps, op.cwd);
	const run = await runCli(deps.exec, bin, buildWhoamiArgs(), opts(cfg, op));
	if (!run.ok) return failureEnvelope(run);
	const extra: Record<string, unknown> = {};
	try {
		const parsed = parseJsonLine<{ name?: string; identity_id?: string; device_id?: string }>(
			run.stdout,
			"identity show",
		);
		extra.name = parsed.name;
		extra.identity_id = parsed.identity_id;
		extra.device_id = parsed.device_id;
	} catch {
		// defensive: keep raw stdout even if the JSON shape shifts
	}
	return successEnvelope(run, extra);
}

function opts(
	cfg: ResolvedConfig,
	op: OpContext,
): { home?: string; signal?: AbortSignal; cwd?: string } {
	const options: { home?: string; signal?: AbortSignal; cwd?: string } = { cwd: op.cwd };
	if (cfg.home !== undefined) options.home = cfg.home;
	if (op.signal !== undefined) options.signal = op.signal;
	return options;
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

function toolResult(envelope: Envelope): {
	content: { type: "text"; text: string }[];
	details: Envelope;
} {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
		details: envelope,
	};
}

const roomIdParam = () =>
	Type.Optional(
		Type.String({
			description: "Room id (blake3:<64-hex>); defaults to the configured room",
		}),
	);

/** Register all 10 iroh-room tools. Must run synchronously in the factory body. */
export function registerIrohTools(pi: ExtensionAPI, options: IrohRoomOptions = {}): ToolDeps {
	const deps = makeDeps(pi, options);

	pi.registerTool({
		name: TOOL_NAMES.agentStatus,
		label: "Iroh agent status",
		description:
			"Post a signed agent.status event to the configured iroh-room. Use the advisory vocabulary " +
			`(${STATUS_VOCABULARY.join(", ")}) plus a short message and integer progress 0..100.`,
		promptSnippet:
			"iroh_agent_status — post a signed agent.status (label, message, progress, artifact ids) to the configured iroh-room",
		promptGuidelines: [
			`Post iroh_agent_status at major milestones using the advisory vocabulary: ${STATUS_VOCABULARY.join(", ")}.`,
		],
		parameters: Type.Object({
			room_id: roomIdParam(),
			status: Type.String({
				description: `Short status label, 1..64 UTF-8 bytes. Suggested vocabulary: ${STATUS_VOCABULARY.join(", ")}`,
			}),
			message: Type.Optional(Type.String({ description: "Human-readable status message (<=4096 bytes)" })),
			progress: Type.Optional(Type.Integer({ description: "Progress percent, integer 0..100" })),
			artifact_ids: Type.Optional(
				Type.Array(Type.String(), {
					description: "Related artifact file ids (file_<32-hex> or bare 32-hex), max 16",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return toolResult(
				await opAgentStatus(deps, { cwd: ctx.cwd, ...(signal !== undefined ? { signal } : {}) }, params),
			);
		},
	});

	pi.registerTool({
		name: TOOL_NAMES.roomSend,
		label: "Iroh room send",
		description: "Send a human-readable message (1..16384 bytes) to the configured iroh-room.",
		promptSnippet: "iroh_room_send — send a plain room message to the configured iroh-room",
		parameters: Type.Object({
			room_id: roomIdParam(),
			message: Type.String({ description: "Message body, 1..16384 UTF-8 bytes" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return toolResult(
				await opRoomSend(deps, { cwd: ctx.cwd, ...(signal !== undefined ? { signal } : {}) }, params),
			);
		},
	});

	pi.registerTool({
		name: TOOL_NAMES.tailSnapshot,
		label: "Iroh room tail snapshot",
		description:
			"Read recent room events (offline, from the local log) and return a compact snapshot: " +
			"one summarized entry per event plus an overall summary line.",
		promptSnippet:
			"iroh_room_tail_snapshot — read a compact snapshot of recent room events (messages, statuses, files, pipes)",
		parameters: Type.Object({
			room_id: roomIdParam(),
			limit: Type.Optional(Type.Integer({ description: "Max events to read (default 50, clamped to 1..500)" })),
			include_agent_status: Type.Optional(
				Type.Boolean({ description: "Include agent.status events (default true)" }),
			),
			include_files: Type.Optional(Type.Boolean({ description: "Include file.shared events (default true)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return toolResult(
				await opTailSnapshot(deps, { cwd: ctx.cwd, ...(signal !== undefined ? { signal } : {}) }, params),
			);
		},
	});

	pi.registerTool({
		name: TOOL_NAMES.fileShare,
		label: "Iroh file share",
		description:
			"Share a local file with the room as a content-addressed artifact (max 100 MiB). " +
			"The path must resolve inside the workspace (or the configured artifact_dir).",
		promptSnippet: "iroh_file_share — share a local file with the room as a content-addressed artifact",
		parameters: Type.Object({
			room_id: roomIdParam(),
			path: Type.String({ description: "Path to the file (relative to the workspace or absolute)" }),
			name: Type.Optional(Type.String({ description: "Stored display name override (<=255 bytes)" })),
			mime: Type.Optional(Type.String({ description: "MIME type override (<=255 bytes)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return toolResult(
				await opFileShare(deps, { cwd: ctx.cwd, ...(signal !== undefined ? { signal } : {}) }, params),
			);
		},
	});

	pi.registerTool({
		name: TOOL_NAMES.pipeExpose,
		label: "Iroh pipe expose",
		description:
			"Expose a local loopback (127.0.0.1:<port>) preview server to explicitly allowed room members " +
			"over a private P2P pipe. The pipe keeps serving in the background until closed.",
		promptSnippet:
			"iroh_pipe_expose — expose a local 127.0.0.1 port to allowed room members over a private pipe",
		promptGuidelines: [
			"iroh_pipe_expose only accepts loopback targets (127.0.0.1:<port>) and requires an explicit allow-list of member identity ids — never attempt to expose other hosts or interfaces.",
		],
		parameters: Type.Object({
			room_id: roomIdParam(),
			tcp: Type.String({ description: "Loopback target, exactly 127.0.0.1:<port>" }),
			allow: Type.Array(Type.String(), {
				description: "Allowed member identity ids (64-hex), at least one — no default-all",
			}),
			label: Type.Optional(Type.String({ description: "Optional pipe label (<=255 bytes)" })),
			ttl_seconds: Type.Optional(
				Type.Integer({ description: "Optional advisory expiry in seconds (positive integer)" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return toolResult(
				await opPipeExpose(deps, { cwd: ctx.cwd, ...(signal !== undefined ? { signal } : {}) }, params),
			);
		},
	});

	pi.registerTool({
		name: TOOL_NAMES.pipeClose,
		label: "Iroh pipe close",
		description:
			"Close a pipe: pipes opened by this session are terminated locally (SIGINT); " +
			"otherwise `iroh-rooms pipe close` is invoked.",
		parameters: Type.Object({
			pipe_id: Type.String({ description: "Pipe id (32 lowercase hex chars)" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return toolResult(
				await opPipeClose(deps, { cwd: ctx.cwd, ...(signal !== undefined ? { signal } : {}) }, params),
			);
		},
	});

	pi.registerTool({
		name: TOOL_NAMES.pipeList,
		label: "Iroh pipe list",
		description: "List open pipes in the room (CLI view) plus the pipes owned by this session.",
		parameters: Type.Object({ room_id: roomIdParam() }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return toolResult(
				await opPipeList(deps, { cwd: ctx.cwd, ...(signal !== undefined ? { signal } : {}) }, params),
			);
		},
	});

	pi.registerTool({
		name: TOOL_NAMES.roomMembers,
		label: "Iroh room members",
		description: "List room members (offline read of the local log) with roles and statuses.",
		parameters: Type.Object({ room_id: roomIdParam() }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return toolResult(
				await opRoomMembers(deps, { cwd: ctx.cwd, ...(signal !== undefined ? { signal } : {}) }, params),
			);
		},
	});

	pi.registerTool({
		name: TOOL_NAMES.fileList,
		label: "Iroh file list",
		description: "List the room's shared files (file ids, names, sizes, providers).",
		parameters: Type.Object({ room_id: roomIdParam() }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return toolResult(
				await opFileList(deps, { cwd: ctx.cwd, ...(signal !== undefined ? { signal } : {}) }, params),
			);
		},
	});

	pi.registerTool({
		name: TOOL_NAMES.identityShow,
		label: "Iroh identity show",
		description: "Show the local iroh-rooms identity (name, identity_id, device_id).",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			return toolResult(
				await opIdentityShow(deps, { cwd: ctx.cwd, ...(signal !== undefined ? { signal } : {}) }),
			);
		},
	});

	return deps;
}
