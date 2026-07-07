/** Timeline tab renderer for the read-only Room Cockpit. */

import type { CockpitSnapshot, TimelineEvent } from "./model.js";
import { kv, sectionTitle, shortId, timeCell, type RenderKit } from "./layout.js";
import { roomText } from "../sanitize.js";
import { AUTHOR_COLS, STATUS_LABEL_COLS } from "../style.js";

const TYPE_ABBREV: Record<string, string> = {
	"message.text": "msg",
	"agent.status": "sts",
	"file.shared": "file",
	"pipe.opened": "pipe",
	"pipe.closed": "pipe",
	"member.invited": "mbr",
	"member.joined": "mbr",
	"member.left": "mbr",
	"member.removed": "mbr",
	"room.created": "room",
};

export function timelineRow(event: TimelineEvent, selected: boolean, kit: RenderKit): string {
	const time = timeCell(event.timestamp);
	const author = roomText(event.author ?? "?", AUTHOR_COLS, kit.fit) || "?";
	const typeRaw = event.type;
	const type = TYPE_ABBREV[typeRaw] ?? (roomText(typeRaw, STATUS_LABEL_COLS, kit.fit) || "?");
	const prefix = selected ? "›" : " ";
	const used = prefix.length + 1 + time.length + 1 + author.length + 1 + type.length + 1;
	const summary = roomText(event.summary, Math.max(0, kit.width - used), kit.fit);
	const line = `${kit.styler(selected ? "accent" : "dim", prefix)} ${kit.styler("dim", time)} ${kit.styler("muted", author)} ${kit.styler("accent", type)} ${summary}`;
	return kit.fit(line, kit.width);
}

export function renderTimeline(snapshot: CockpitSnapshot, kit: RenderKit, selectedIndex: number): string[] {
	const lines: string[] = [];
	const events = snapshot.events;
	lines.push(sectionTitle("Timeline", kit));
	lines.push(kit.styler("dim", "filters: all · messages · statuses · files · members · pipes · tasks"));
	lines.push("");
	if (events.length === 0) {
		lines.push(kit.styler("dim", "No room events in the current ambient snapshot."));
		lines.push(kit.styler("dim", "Press r to request a refresh through the ambient poll path."));
		return lines;
	}
	const clamped = Math.max(0, Math.min(selectedIndex, events.length - 1));
	const maxRows = Math.max(4, Math.min(14, Math.floor((kit.width > 100 ? 18 : 12))));
	const start = Math.max(0, Math.min(clamped - Math.floor(maxRows / 2), Math.max(0, events.length - maxRows)));
	for (const event of events.slice(start, start + maxRows)) {
		const index = events.indexOf(event);
		lines.push(timelineRow(event, index === clamped, kit));
	}
	const selected = events[clamped];
	lines.push("");
	lines.push(kit.styler("muted", "Inspector"));
	if (selected !== undefined) {
		lines.push(kv("event", shortId(selected.eventId), kit));
		lines.push(kv("type", selected.type, kit));
		lines.push(kv("author", selected.author ?? "?", kit));
		lines.push(kv("lamport", selected.lamport === undefined ? "?" : String(selected.lamport), kit));
		lines.push(kv("summary", selected.summary, kit));
	}
	lines.push("");
	lines.push(kit.styler("dim", "untrusted room content"));
	return lines;
}
