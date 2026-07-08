/** Settings tab renderer for the read-only Room Cockpit. */

import { groupLabel, kv, sectionTitle, type RenderKit } from "./layout.js";
import type { CockpitSnapshot, CockpitTab } from "./model.js";

export function renderSettings(snapshot: CockpitSnapshot, kit: RenderKit, selectedTab: CockpitTab): string[] {
	const lines: string[] = [];
	lines.push(sectionTitle("Settings", kit));
	lines.push(kit.styler("dim", "Local display controls only. This read-only build does not mutate room state or config."));
	lines.push("");
	lines.push(groupLabel("Display", kit));
	lines.push(kv("selected tab", selectedTab, kit));
	lines.push(kv("pulse density", snapshot.config.pulseDensity ?? "(default/unknown)", kit));
	lines.push(kv("cockpit mode", "full or overlay via command", kit));
	lines.push(kv("task counts", "shown with heuristic ~ marker", kit));
	lines.push(kv("wide layout", "auto by terminal width", kit));
	lines.push("");
	lines.push(groupLabel("Safety", kit));
	lines.push(kv("mutations", "disabled in this build", kit));
	lines.push(kv("future actions", "confirm + timeout fail closed", kit));
	lines.push(kv("file fetch", "not implemented", kit));
	lines.push(kv("preview targets", "127.0.0.1:<port> only", kit));
	lines.push(kv("room text", "sanitized before display", kit));
	lines.push("");
	lines.push(groupLabel("Resolved local context", kit));
	lines.push(kv("room label", snapshot.config.roomLabel ?? "(none)", kit));
	lines.push(kv("agent name", snapshot.config.agentName ?? "(unknown)", kit));
	lines.push(kv("cwd", snapshot.config.cwd ?? "(unknown)", kit));
	lines.push(kv("config file", snapshot.config.configFile ?? "(none found)", kit));
	lines.push(kv("data dir", snapshot.config.dataDir ?? "(iroh-rooms default)", kit));
	lines.push("");
	lines.push(kit.styler("dim", "Future settings may persist via Pi session entries; config files are not silently rewritten here."));
	return lines;
}
