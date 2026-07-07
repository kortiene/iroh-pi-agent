/** Overview tab renderer for the read-only Room Cockpit. */

import type { CockpitSnapshot } from "./model.js";
import {
	feedColor,
	feedGlyph,
	formatAge,
	kv,
	sectionTitle,
	shortId,
	shortRoom,
	type RenderKit,
} from "./layout.js";
import { roomText } from "../sanitize.js";
import { GLYPHS } from "../style.js";

export function renderOverview(snapshot: CockpitSnapshot, kit: RenderKit): string[] {
	const lines: string[] = [];
	lines.push(sectionTitle("Overview", kit));
	lines.push("");
	lines.push(kit.styler("muted", "Room"));
	lines.push(kv("id", snapshot.config.roomId ?? "(not configured)", kit));
	lines.push(kv("label", snapshot.config.roomLabel ?? "(none)", kit));
	const feed = `${feedGlyph(snapshot.feed.state)} ${snapshot.feed.state}${
		snapshot.feed.lastOkAt !== undefined ? ` · fresh ${formatAge(kit.now, snapshot.feed.lastOkAt)}` : ""
	}`;
	lines.push(`  ${kit.styler("muted", "health".padEnd(16))} ${kit.styler(feedColor(snapshot.feed.state), feed)}`);
	if (snapshot.feed.failure !== undefined) {
		lines.push(kv("issue", snapshot.feed.failure, kit));
	}
	if (snapshot.feed.gap) {
		lines.push(`  ${kit.styler("muted", "gap".padEnd(16))} ${kit.styler("warning", "tail window overrun; deep repair pending")}`);
	}
	lines.push("");
	lines.push(kit.styler("muted", "Agent"));
	if (snapshot.identity !== undefined) {
		lines.push(kv("name", snapshot.identity.name, kit));
		lines.push(kv("id", `${snapshot.identity.from8}…`, kit));
		if (snapshot.identity.deviceId !== undefined) {
			lines.push(kv("device", `${snapshot.identity.deviceId.slice(0, 8)}…`, kit));
		}
	} else {
		lines.push(kv("identity", snapshot.config.agentName ?? "(unknown)", kit));
	}
	lines.push(kv("binary", snapshot.config.binary ?? "(unknown)", kit));
	lines.push("");
	lines.push(kit.styler("muted", "Activity"));
	if (snapshot.latest.status !== undefined) {
		const status = snapshot.latest.status;
		const progress = typeof status.progress === "number" ? ` ${status.progress}%` : "";
		const message = status.message !== undefined ? ` · ${roomText(status.message, 48, kit.fit)}` : "";
		lines.push(kv("latest status", `${status.label}${progress}${message}`, kit));
	} else {
		lines.push(kv("latest status", "(none)", kit));
	}
	if (snapshot.latest.event !== undefined) {
		lines.push(kv("latest event", `${snapshot.latest.event.type} · ${snapshot.latest.event.summary}`, kit));
	} else {
		lines.push(kv("latest event", "(none)", kit));
	}
	lines.push(kv("recent events", String(snapshot.events.length), kit));
	lines.push(kv("tasks~", `${snapshot.tasks.unclaimed.length} unclaimed`, kit));
	lines.push(kv("pipes", `${snapshot.pipes.filter((pipe) => pipe.state === "open").length} active`, kit));
	lines.push(kv("artifacts", `${snapshot.files.length} visible`, kit));
	if (snapshot.feed.state === "unconfigured") {
		lines.push("");
		lines.push(`${kit.styler("warning", GLYPHS.gear)} configure room_id via IROH_ROOM_ID or .iroh-room-pi.json`);
	}
	if (snapshot.feed.state === "broken_config") {
		lines.push("");
		lines.push(`${kit.styler("error", GLYPHS.fail)} fix local iroh-room config before polling`);
	}
	lines.push("");
	lines.push(kit.styler("dim", `${shortRoom(snapshot.config.roomId)} · latest ${shortId(snapshot.latest.event?.eventId)} · untrusted room content`));
	return lines;
}
