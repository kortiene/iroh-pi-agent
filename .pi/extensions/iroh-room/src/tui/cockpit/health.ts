/** Health tab renderer for the read-only Room Cockpit. */

import type { CockpitSnapshot } from "./model.js";
import { feedColor, feedGlyph, formatAge, groupLabel, kv, sectionTitle, type RenderKit } from "./layout.js";

export function renderHealth(snapshot: CockpitSnapshot, kit: RenderKit): string[] {
	const lines: string[] = [];
	lines.push(sectionTitle("Health", kit));
	lines.push("");
	const state = snapshot.feed.state;
	lines.push(
		kit.fit(
			`${kit.styler(feedColor(state), feedGlyph(state))} ${kit.styler(feedColor(state), state)}`,
			kit.width,
		),
	);
	lines.push("");
	lines.push(groupLabel("Configuration", kit));
	lines.push(kv("config file", snapshot.config.configFile ?? "(none found)", kit));
	lines.push(kv("cwd", snapshot.config.cwd ?? "(unknown)", kit));
	lines.push(kv("room id", snapshot.config.roomId ?? "(not configured)", kit));
	lines.push(kv("room label", snapshot.config.roomLabel ?? "(none)", kit));
	lines.push(kv("data dir", snapshot.config.dataDir ?? "(iroh-rooms default)", kit));
	lines.push(kv("binary", snapshot.config.binary ?? "(unknown)", kit));
	lines.push("");
	lines.push(groupLabel("Identity", kit));
	if (snapshot.identity !== undefined) {
		lines.push(kv("name", snapshot.identity.name, kit));
		lines.push(kv("identity id", snapshot.identity.identityId, kit));
		lines.push(kv("from8", snapshot.identity.from8, kit));
		lines.push(kv("device id", snapshot.identity.deviceId ?? "(unknown)", kit));
	} else {
		lines.push(kv("identity", "(not loaded)", kit));
	}
	lines.push("");
	lines.push(groupLabel("Feed", kit));
	lines.push(kv("state", snapshot.feed.state, kit));
	lines.push(kv("last ok", formatAge(kit.now, snapshot.feed.lastOkAt), kit));
	lines.push(kv("next retry", snapshot.feed.nextRetryAt === undefined ? "(not scheduled)" : formatAge(snapshot.feed.nextRetryAt, kit.now), kit));
	lines.push(kv("gap", snapshot.feed.gap ? "yes" : "no", kit));
	lines.push(kv("rows", String(snapshot.feed.rowCount ?? snapshot.events.length), kit));
	lines.push(kv("seen", String(snapshot.feed.seenCount ?? 0), kit));
	lines.push(kv("pipes", String(snapshot.pipes.length), kit));
	if (snapshot.feed.failure !== undefined) {
		lines.push("");
		lines.push(kit.fit(`${kit.styler("warning", "⚠ issue")}  ${kit.styler("warning", snapshot.feed.failure)}`, kit.width));
	}
	lines.push("");
	lines.push(kit.styler("dim", "Diagnostics are local-only. Press r to request a single-flight refresh."));
	return lines;
}
