/** Pipes tab renderer for the read-only Room Cockpit. */

import type { CockpitSnapshot, PipeSummary } from "./model.js";
import { formatAge, groupLabel, padCell, sectionTitle, shortId, type RenderKit } from "./layout.js";
import { roomText } from "../sanitize.js";

export function orderedPipes(pipes: readonly PipeSummary[]): PipeSummary[] {
	return [...pipes].sort((a, b) => {
		const state = a.state.localeCompare(b.state);
		if (state !== 0) return state;
		return a.id.localeCompare(b.id);
	});
}

function pipeStyle(pipe: PipeSummary): { glyph: string; color: string } {
	if (pipe.trustedLocal) return { glyph: "⇄", color: "accent" };
	if (pipe.state === "open") return { glyph: "◌", color: "warning" };
	if (pipe.state === "closed") return { glyph: "×", color: "dim" };
	return { glyph: "?", color: "warning" };
}

function headerLine(kit: RenderKit): string {
	const header = `   ${padCell("pipe", 10, kit.fit)} ${padCell("target", 18, kit.fit)} ${padCell("state", 7, kit.fit)} trusted label`;
	return kit.styler("dim", kit.fit(header, kit.width));
}

function trustText(pipe: PipeSummary): string {
	return pipe.trustedLocal ? "local" : "event";
}

function renderPipe(pipe: PipeSummary, selected: boolean, kit: RenderKit): string {
	const marker = selected ? "▌" : " ";
	const { glyph, color } = pipeStyle(pipe);
	const id = padCell(roomText(shortId(pipe.id), 10, kit.fit) || "?", 10, kit.fit);
	const target = padCell(roomText(pipe.target, 18, kit.fit) || "?", 18, kit.fit);
	const state = padCell(roomText(pipe.state, 7, kit.fit) || "?", 7, kit.fit);
	const trust = padCell(trustText(pipe), 7, kit.fit);
	const used = marker.length + 1 + 2 + 1 + id.length + 1 + target.length + 1 + state.length + 1 + trust.length + 1;
	const label = roomText(pipe.label ?? "", Math.max(0, kit.width - used), kit.fit);
	const plain = `${marker} ${glyph} ${id} ${target} ${state} ${trust} ${label}`;
	if (plain.length > kit.width) {
		return kit.styler(selected ? "accent" : "muted", kit.fit(plain, kit.width));
	}
	return `${kit.styler(selected ? "accent" : "dim", marker)} ${kit.styler(color, glyph)} ${kit.styler(selected ? "text" : "muted", id)} ${kit.styler("dim", target)} ${kit.styler(pipe.state === "open" ? "success" : "dim", state)} ${kit.styler(pipe.trustedLocal ? "accent" : "warning", trust)} ${kit.styler(selected ? "text" : "muted", label)}`;
}

export function renderPipes(snapshot: CockpitSnapshot, kit: RenderKit, selectedIndex: number): string[] {
	const lines: string[] = [];
	const pipes = orderedPipes(snapshot.pipes);
	lines.push(sectionTitle("Pipes", kit));
	lines.push(kit.styler("dim", "Preview pipes are read from the trusted local PipeManager registry; room pipe events are display-only."));
	lines.push("");
	if (pipes.length === 0) {
		lines.push(kit.styler("dim", "No active local preview pipes in this session."));
		lines.push(kit.styler("dim", "Use /room-preview to expose one; future cockpit actions will stay confirmed."));
		return lines;
	}
	const open = pipes.filter((pipe) => pipe.state === "open").length;
	const trusted = pipes.filter((pipe) => pipe.trustedLocal).length;
	lines.push(
		kit.fit(
			` ${kit.styler("muted", "PIPES")} ${kit.styler("accent", String(pipes.length))} ${kit.styler("dim", `· ${open} open · ${trusted} trusted-local`)}`,
			kit.width,
		),
	);
	lines.push(headerLine(kit));
	const clamped = Math.max(0, Math.min(selectedIndex, pipes.length - 1));
	const maxRows = Math.max(4, Math.min(16, kit.width > 100 ? 18 : 12));
	const start = Math.max(0, Math.min(clamped - Math.floor(maxRows / 2), Math.max(0, pipes.length - maxRows)));
	const shown = pipes.slice(start, start + maxRows);
	for (const pipe of shown) {
		const index = pipes.indexOf(pipe);
		lines.push(renderPipe(pipe, index === clamped, kit));
	}
	if (pipes.length > shown.length) {
		lines.push(kit.styler("dim", `   +${pipes.length - shown.length} more`));
	}
	const selected = pipes[clamped];
	if (selected !== undefined) {
		lines.push("");
		lines.push(groupLabel("Inspector", kit));
		lines.push(`  ${kit.styler("muted", "pipe id".padEnd(10))} ${roomText(selected.id, Math.max(0, kit.width - 14), kit.fit)}`);
		lines.push(`  ${kit.styler("muted", "target".padEnd(10))} ${roomText(selected.target, Math.max(0, kit.width - 14), kit.fit)}`);
		lines.push(`  ${kit.styler("muted", "state".padEnd(10))} ${kit.styler(selected.state === "open" ? "success" : "dim", selected.state)}`);
		lines.push(`  ${kit.styler("muted", "trusted".padEnd(10))} ${kit.styler(selected.trustedLocal ? "accent" : "warning", selected.trustedLocal ? "yes, local registry" : "no, event-derived")}`);
		lines.push(`  ${kit.styler("muted", "label".padEnd(10))} ${selected.label !== undefined ? roomText(selected.label, Math.max(0, kit.width - 14), kit.fit) : kit.styler("dim", "—")}`);
		lines.push(`  ${kit.styler("muted", "age".padEnd(10))} ${selected.startedAt !== undefined ? formatAge(kit.now, selected.startedAt) : kit.styler("dim", "unknown")}`);
	}
	lines.push("");
	lines.push(kit.styler("dim", "untrusted room content"));
	return lines;
}
