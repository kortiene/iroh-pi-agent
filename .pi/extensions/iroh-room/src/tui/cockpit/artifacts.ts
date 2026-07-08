/** Artifacts tab renderer for the read-only Room Cockpit. */

import type { CockpitSnapshot, FileSummary } from "./model.js";
import { groupLabel, padCell, sectionTitle, shortId, type RenderKit } from "./layout.js";
import { roomText } from "../sanitize.js";

export function orderedArtifacts(files: readonly FileSummary[]): FileSummary[] {
	return [...files].sort((a, b) => {
		const an = a.name ?? a.id ?? a.blobHash ?? "";
		const bn = b.name ?? b.id ?? b.blobHash ?? "";
		return an.localeCompare(bn);
	});
}

function sizeText(size: number | undefined): string {
	if (size === undefined) return "—";
	if (size < 1024) return `${size} B`;
	const kib = size / 1024;
	if (kib < 1024) return `${Math.round(kib)} KiB`;
	return `${Math.round(kib / 1024)} MiB`;
}

function idText(file: FileSummary): string {
	return file.id ?? file.blobHash ?? "?";
}

function headerLine(kit: RenderKit): string {
	const header = `   ${padCell("artifact", 14, kit.fit)} ${padCell("name", 24, kit.fit)} ${padCell("size", 8, kit.fit)} provider`;
	return kit.styler("dim", kit.fit(header, kit.width));
}

function renderArtifact(file: FileSummary, selected: boolean, kit: RenderKit): string {
	const marker = selected ? "▌" : " ";
	const id = padCell(roomText(shortId(idText(file)), 14, kit.fit) || "?", 14, kit.fit);
	const name = padCell(roomText(file.name ?? "(unnamed)", 24, kit.fit) || "(unnamed)", 24, kit.fit);
	const size = padCell(roomText(sizeText(file.sizeBytes), 8, kit.fit) || "—", 8, kit.fit);
	const provider = roomText(file.provider ?? "", Math.max(0, kit.width - 54), kit.fit);
	const plain = `${marker} ◇ ${id} ${name} ${size} ${provider}`;
	if (plain.length > kit.width) {
		return kit.styler(selected ? "accent" : "muted", kit.fit(plain, kit.width));
	}
	return `${kit.styler(selected ? "accent" : "dim", marker)} ${kit.styler("accent", "◇")} ${kit.styler(selected ? "text" : "muted", id)} ${kit.styler(selected ? "text" : "muted", name)} ${kit.styler("dim", size)} ${kit.styler("dim", provider)}`;
}

export function renderArtifacts(snapshot: CockpitSnapshot, kit: RenderKit, selectedIndex: number): string[] {
	const lines: string[] = [];
	const files = orderedArtifacts(snapshot.files);
	lines.push(sectionTitle("Artifacts", kit));
	lines.push(kit.styler("dim", "Files shared in the current room snapshot; file_id mapping improves after a manual refresh."));
	lines.push("");
	if (files.length === 0) {
		lines.push(kit.styler("dim", "No shared files in the current ambient snapshot."));
		lines.push(kit.styler("dim", "Press r to refresh; first release is read-only and never fetches files."));
		return lines;
	}
	const withFileId = files.filter((file) => typeof file.id === "string" && file.id.startsWith("file_")).length;
	lines.push(
		kit.fit(
			` ${kit.styler("muted", "ARTIFACTS")} ${kit.styler("accent", String(files.length))} ${kit.styler("dim", `· ${withFileId} file ids mapped`)}`,
			kit.width,
		),
	);
	lines.push(headerLine(kit));
	const clamped = Math.max(0, Math.min(selectedIndex, files.length - 1));
	const maxRows = Math.max(4, Math.min(16, kit.width > 100 ? 18 : 12));
	const start = Math.max(0, Math.min(clamped - Math.floor(maxRows / 2), Math.max(0, files.length - maxRows)));
	const shown = files.slice(start, start + maxRows);
	for (const file of shown) {
		const index = files.indexOf(file);
		lines.push(renderArtifact(file, index === clamped, kit));
	}
	if (files.length > shown.length) {
		lines.push(kit.styler("dim", `   +${files.length - shown.length} more`));
	}
	const selected = files[clamped];
	if (selected !== undefined) {
		lines.push("");
		lines.push(groupLabel("Inspector", kit));
		lines.push(`  ${kit.styler("muted", "file id".padEnd(10))} ${selected.id !== undefined ? roomText(selected.id, Math.max(0, kit.width - 14), kit.fit) : kit.styler("dim", "—")}`);
		lines.push(`  ${kit.styler("muted", "blob".padEnd(10))} ${selected.blobHash !== undefined ? roomText(selected.blobHash, Math.max(0, kit.width - 14), kit.fit) : kit.styler("dim", "—")}`);
		lines.push(`  ${kit.styler("muted", "name".padEnd(10))} ${selected.name !== undefined ? roomText(selected.name, Math.max(0, kit.width - 14), kit.fit) : kit.styler("dim", "—")}`);
		lines.push(`  ${kit.styler("muted", "size".padEnd(10))} ${sizeText(selected.sizeBytes)}`);
		lines.push(`  ${kit.styler("muted", "mime".padEnd(10))} ${selected.mime !== undefined ? roomText(selected.mime, Math.max(0, kit.width - 14), kit.fit) : kit.styler("dim", "—")}`);
		lines.push(`  ${kit.styler("muted", "provider".padEnd(10))} ${selected.provider !== undefined ? roomText(selected.provider, Math.max(0, kit.width - 14), kit.fit) : kit.styler("dim", "—")}`);
	}
	lines.push("");
	lines.push(kit.styler("dim", "untrusted room content · no file fetch in this build"));
	return lines;
}
