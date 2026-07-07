/** Pi-specific adapters for the Room Cockpit custom component. */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { fitWidth, themeStyler } from "../wire.js";
import { CockpitComponent } from "./component.js";
import { type CockpitKeyRouter, type CockpitSnapshot, type CockpitTab } from "./model.js";

function key(data: string, id: string): boolean {
	try {
		return matchesKey(data, id as Parameters<typeof matchesKey>[1]);
	} catch {
		return false;
	}
}

export const cockpitKeys: CockpitKeyRouter = {
	isClose: (data) => key(data, Key.escape) || key(data, "q") || data === "q",
	isHelp: (data) => key(data, Key.question) || data === "?",
	isNextTab: (data) => key(data, Key.tab),
	isPrevTab: (data) => key(data, Key.shift("tab")),
	isUp: (data) => key(data, Key.up),
	isDown: (data) => key(data, Key.down),
	isRefresh: (data) => key(data, "r") || data === "r",
	isEnter: (data) => key(data, Key.enter) || key(data, Key.return),
	isReadOnlyAction: (data) => ["/", "c", "i", "p", "b", "f", "a", "n", "e", "o", "x", "m", "s", "y"].includes(data),
	tabFor(data): CockpitTab | undefined {
		if (data === "1" || key(data, "1")) return "overview";
		if (data === "2" || key(data, "2")) return "timeline";
		if (data === "3" || key(data, "3")) return "tasks";
		if (data === "4" || key(data, "4")) return "health";
		return undefined;
	},
};

export function createCockpitComponent(options: {
	snapshot: CockpitSnapshot;
	theme: Theme;
	getHeight: () => number | undefined;
	onClose: () => void;
	onRefresh: () => Promise<void>;
	requestRender: () => void;
}): CockpitComponent {
	return new CockpitComponent({
		snapshot: options.snapshot,
		styler: themeStyler(options.theme),
		fit: fitWidth,
		keys: cockpitKeys,
		getHeight: options.getHeight,
		onClose: options.onClose,
		onRefresh: options.onRefresh,
		requestRender: options.requestRender,
	});
}
