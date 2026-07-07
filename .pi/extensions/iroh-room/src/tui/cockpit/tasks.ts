/** Tasks tab renderer for the read-only Room Cockpit. */

import type { CockpitSnapshot, TaskSummary } from "./model.js";
import { sectionTitle, type RenderKit } from "./layout.js";
import { roomText } from "../sanitize.js";
import { GLYPHS } from "../style.js";

function taskGlyph(task: TaskSummary): string {
	switch (task.state) {
		case "done":
			return "✓";
		case "ready_for_review":
			return "◆";
		case "claimed":
			return "◐";
		default:
			return GLYPHS.task;
	}
}

function renderTask(task: TaskSummary, selected: boolean, kit: RenderKit): string {
	const marker = selected ? "›" : " ";
	const id = roomText(task.id, 18, kit.fit) || "?";
	const type = roomText(task.type, 10, kit.fit) || "?";
	const used = marker.length + 1 + 2 + 1 + id.length + 1 + type.length + 1;
	const title = roomText(task.title, Math.max(0, kit.width - used), kit.fit);
	return kit.fit(`${kit.styler(selected ? "accent" : "dim", marker)} ${taskGlyph(task)} ${id} ${kit.styler("muted", type)} ${title}`, kit.width);
}

function groupRows(title: string, tasks: TaskSummary[], selectedId: string | undefined, kit: RenderKit): string[] {
	const rows = [`${kit.styler("muted", `${title}~`)} ${kit.styler("dim", `(${tasks.length})`)}`];
	if (tasks.length === 0) {
		rows.push(kit.styler("dim", "  (none)"));
		return rows;
	}
	for (const task of tasks.slice(0, 8)) {
		rows.push(renderTask(task, task.id === selectedId, kit));
	}
	if (tasks.length > 8) {
		rows.push(kit.styler("dim", `  ${tasks.length - 8} more…`));
	}
	return rows;
}

export function renderTasks(snapshot: CockpitSnapshot, kit: RenderKit, selectedIndex: number): string[] {
	const lines: string[] = [];
	const all = snapshot.tasks.all;
	const selected = all[Math.max(0, Math.min(selectedIndex, Math.max(0, all.length - 1)))];
	const selectedId = selected?.id;
	lines.push(sectionTitle("Tasks", kit));
	lines.push(kit.styler("dim", "Room-task board is heuristic; every column is ~-marked. Read-only in this build."));
	lines.push("");
	lines.push(...groupRows("Backlog", snapshot.tasks.unclaimed, selectedId, kit));
	lines.push("");
	lines.push(...groupRows("Claimed", snapshot.tasks.claimed, selectedId, kit));
	lines.push("");
	lines.push(...groupRows("Ready", snapshot.tasks.readyForReview, selectedId, kit));
	lines.push("");
	lines.push(...groupRows("Done", snapshot.tasks.done, selectedId, kit));
	if (selected !== undefined) {
		lines.push("");
		lines.push(kit.styler("muted", "Inspector"));
		lines.push(`  ${kit.styler("muted", "id".padEnd(10))} ${roomText(selected.id, Math.max(0, kit.width - 14), kit.fit)}`);
		lines.push(`  ${kit.styler("muted", "state".padEnd(10))} ${selected.state}~`);
		lines.push(`  ${kit.styler("muted", "title".padEnd(10))} ${roomText(selected.title, Math.max(0, kit.width - 14), kit.fit)}`);
	}
	return lines;
}
