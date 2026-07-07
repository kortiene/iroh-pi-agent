/**
 * Pure per-tool call/result line builders for all 10 iroh_* tools (M0).
 * Adapted into pi renderCall/renderResult Components by wire.ts.
 *
 * Error styling keys off the `{ok: false}` ENVELOPE, never context.isError:
 * AgentToolResult has no isError, and our CLI failures are returned normally
 * (only thrown local errors set context.isError, and those never reach
 * renderResult with an envelope).
 *
 * Thrown execute() errors (validation, missing config, binary not found,
 * spawn timeout, host aborts/blocks) arrive as the HOST error shape —
 * `{content: [{type: "text", text: <message>}], details: {}}` — with no
 * `ok` field at all. That path renders the host's error text (extracted by
 * wire.ts and passed as `errorText`); it must never be misread as a CLI
 * failure (`exit ?` with the message hidden).
 *
 * Success rows show envelope extras — event_id/file_id/pipe_id are protocol
 * currency: show, don't mask. Failures render `failed (exit N[, code])` plus
 * the CLI's own `next:` hint (extracted from the ALREADY-REDACTED stderr in
 * the envelope, then passed through roomText like any untrusted string).
 *
 * These builders never throw; unknown envelope shapes render a dim
 * placeholder line.
 */

import { roomText } from "./sanitize.js";
import { tailEventRow, UNTRUSTED_TAG } from "./cards.js";
import {
	FILE_NAME_COLS,
	GLYPHS,
	STATUS_LABEL_COLS,
	naiveFit,
	shortEventId,
	type FitFn,
	type Styler,
} from "./style.js";

/** The CLI's remediation hint line on stderr (applied to redacted stderr only). */
export const NEXT_HINT_RE = /^next:\s?(.*)$/m;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function str(obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key];
	return typeof value === "string" ? value : undefined;
}

function safeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
}

/** `label detail` one-liner: label styled as tool title, detail plain-fit. */
function headline(label: string, detail: string, styler: Styler, fit: FitFn, width: number): string {
	const labelCell = fit(label, width);
	const rest = Math.max(0, width - labelCell.length - 1);
	const detailCell = detail === "" ? "" : fit(detail, rest);
	return detailCell === ""
		? styler("toolTitle", labelCell)
		: `${styler("toolTitle", labelCell)} ${detailCell}`;
}

const CALL_LABELS: Record<string, string> = {
	iroh_agent_status: "agent status",
	iroh_room_send: "room send",
	iroh_room_tail_snapshot: "room tail",
	iroh_file_share: "file share",
	iroh_pipe_expose: "pipe expose",
	iroh_pipe_close: "pipe close",
	iroh_pipe_list: "pipe list",
	iroh_room_members: "room members",
	iroh_file_list: "file list",
	iroh_identity_show: "identity show",
};

/** One-line call view per tool. Args are model-authored but sanitized anyway. */
export function buildToolCallLines(
	toolName: string,
	args: unknown,
	styler: Styler,
	fit: FitFn,
	width: number,
): string[] {
	try {
		const w = safeWidth(width);
		const label = CALL_LABELS[toolName] ?? toolName;
		const input = isRecord(args) ? args : {};
		let detail = "";
		switch (toolName) {
			case "iroh_agent_status": {
				const status = roomText(input.status ?? "?", STATUS_LABEL_COLS, fit);
				const progress = typeof input.progress === "number" ? ` · ${input.progress}%` : "";
				detail = `${status}${progress}`;
				break;
			}
			case "iroh_room_send": {
				const body = typeof input.message === "string" ? input.message : "";
				detail = `"${roomText(body, 40, fit)}"`;
				break;
			}
			case "iroh_room_tail_snapshot": {
				detail = typeof input.limit === "number" ? `limit ${input.limit}` : "";
				break;
			}
			case "iroh_file_share": {
				detail = roomText(input.path ?? "?", FILE_NAME_COLS, fit);
				break;
			}
			case "iroh_pipe_expose": {
				const tcp = roomText(input.tcp ?? "?", 21, fit);
				const allow = Array.isArray(input.allow) ? input.allow.length : 0;
				detail = `${tcp} → ${allow} member${allow === 1 ? "" : "s"}`;
				break;
			}
			case "iroh_pipe_close": {
				detail = roomText(input.pipe_id ?? "?", 32, fit);
				break;
			}
			default:
				detail = "";
		}
		return [headline(label, detail, styler, fit, w)];
	} catch {
		return [naiveFit(toolName, safeWidth(width))];
	}
}

function failureLines(
	envelope: Record<string, unknown>,
	styler: Styler,
	fit: FitFn,
	width: number,
): string[] {
	const exit = typeof envelope.exit_code === "number" ? String(envelope.exit_code) : "?";
	const code = str(envelope, "error_code");
	const head = `${GLYPHS.fail} failed (exit ${exit}${code !== undefined ? `, ${code}` : ""})`;
	const lines: string[] = [styler("error", fit(head, width))];
	const detail = str(envelope, "error_detail");
	if (detail !== undefined && detail !== "") {
		lines.push(roomText(detail, width, fit));
	}
	const hint = NEXT_HINT_RE.exec(str(envelope, "stderr") ?? "")?.[1];
	if (hint !== undefined && hint.trim() !== "") {
		lines.push(`${styler("muted", "next:")} ${roomText(hint, Math.max(0, width - 6), fit)}`);
	}
	return lines;
}

/**
 * Result view per tool, keyed off the {ok} envelope (result.details).
 * `errorText` is the host-shaped result text (wire.ts extracts it), shown
 * when there is no envelope — i.e. execute() threw a local error.
 */
export function buildToolResultLines(
	toolName: string,
	envelope: unknown,
	options: { expanded: boolean },
	styler: Styler,
	fit: FitFn,
	width: number,
	errorText?: string,
): string[] {
	try {
		const w = safeWidth(width);
		// Final clamp at the component boundary (U3): no line may exceed the
		// render width, whatever the per-cell budget math produced.
		return resultLines(toolName, envelope, options, styler, fit, w, errorText).map((line) =>
			fit(line, w),
		);
	} catch {
		return [naiveFit("(result render failed)", safeWidth(width))];
	}
}

function resultLines(
	toolName: string,
	envelope: unknown,
	options: { expanded: boolean },
	styler: Styler,
	fit: FitFn,
	w: number,
	errorText: string | undefined,
): string[] {
	if (!isRecord(envelope) || typeof envelope.ok !== "boolean") {
		// No {ok} envelope: execute() threw (host error shape) or there is
		// no result at all. Surface the thrown message — a fabricated
		// "exit ?" would hide it (nothing was executed).
		if (errorText !== undefined && errorText.trim() !== "") {
			return [styler("error", fit(`${GLYPHS.fail} failed`, w)), roomText(errorText, w, fit)];
		}
		return [styler("dim", fit("(no result)", w))];
	}
	if (envelope.ok === false) {
		return failureLines(envelope, styler, fit, w);
	}
	const okLine = (detail: string): string => {
		const rest = Math.max(0, w - 2);
		return `${styler("success", GLYPHS.ok)} ${fit(detail, rest)}`;
	};
	switch (toolName) {
		case "iroh_agent_status":
			return [okLine(`status posted · event ${shortEventId(envelope.event_id)}`)];
		case "iroh_room_send":
			return [okLine(`sent · event ${shortEventId(envelope.event_id)}`)];
		case "iroh_room_tail_snapshot": {
			const events = Array.isArray(envelope.events) ? envelope.events : [];
			const lines = [okLine(`tail snapshot · ${events.length} event${events.length === 1 ? "" : "s"}`)];
			// U7: the untrusted framing survives rendering.
			lines.push(styler("warning", fit(UNTRUSTED_TAG, w)));
			if (options.expanded) {
				for (const event of events) {
					if (isRecord(event)) lines.push(tailEventRow(event, styler, fit, w));
				}
			}
			return lines;
		}
		case "iroh_file_share": {
			const fileId = str(envelope, "file_id") ?? "?";
			return [okLine(`shared · file ${fileId} · event ${shortEventId(envelope.event_id)}`)];
		}
		case "iroh_pipe_expose": {
			const target = str(envelope, "target") ?? "?";
			const lines = [okLine(`pipe ${str(envelope, "pipe_id") ?? "?"} → ${target}`)];
			const hint = str(envelope, "connect_hint");
			if (hint !== undefined) {
				lines.push(roomText(hint, w, fit));
			}
			return lines;
		}
		case "iroh_pipe_close":
			return [okLine(`pipe ${str(envelope, "pipe_id") ?? "?"} closed (${str(envelope, "closed") ?? "?"})`)];
		case "iroh_pipe_list": {
			const local = Array.isArray(envelope.local_pipes) ? envelope.local_pipes : [];
			const lines = [okLine(`${local.length} local pipe${local.length === 1 ? "" : "s"}`)];
			if (options.expanded) {
				for (const pipe of local) {
					if (!isRecord(pipe)) continue;
					const label = str(pipe, "label");
					lines.push(
						` ${styler("muted", GLYPHS.pipe)} ${fit(
							`${str(pipe, "pipe_id") ?? "?"} → ${str(pipe, "target") ?? "?"}${label !== undefined ? ` (${roomText(label, STATUS_LABEL_COLS, fit)})` : ""}`,
							Math.max(0, w - 3),
						)}`,
					);
				}
			}
			return lines;
		}
		case "iroh_room_members": {
			const members = Array.isArray(envelope.members) ? envelope.members : undefined;
			if (members === undefined) return [okLine("members listed")];
			const lines = [okLine(`${members.length} member${members.length === 1 ? "" : "s"}`)];
			if (options.expanded) {
				for (const member of members) {
					if (!isRecord(member)) continue;
					lines.push(
						` ${fit(`${str(member, "role") ?? "?"} ${str(member, "identity_id") ?? "?"}`, Math.max(0, w - 1))}`,
					);
				}
			}
			return lines;
		}
		case "iroh_file_list": {
			const files = Array.isArray(envelope.files) ? envelope.files : undefined;
			if (files === undefined) return [okLine("files listed")];
			const lines = [okLine(`${files.length} file${files.length === 1 ? "" : "s"}`)];
			if (options.expanded) {
				for (const file of files) {
					if (!isRecord(file)) continue;
					const size = typeof file.size_bytes === "number" ? ` (${file.size_bytes} bytes)` : "";
					lines.push(
						` ${fit(`${str(file, "file_id") ?? "?"} ${roomText(file.name ?? "?", FILE_NAME_COLS, fit)}${size}`, Math.max(0, w - 1))}`,
					);
				}
			}
			return lines;
		}
		case "iroh_identity_show": {
			const name = roomText(envelope.name ?? "?", 24, fit);
			const id = str(envelope, "identity_id");
			return [okLine(`${name}${id !== undefined ? ` (${id.slice(0, 8)}…)` : ""}`)];
		}
		default:
			return [okLine("ok")];
	}
}
