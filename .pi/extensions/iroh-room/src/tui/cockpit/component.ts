/** Focused full-screen Room Cockpit component (read-only Phase 1). */

import type { FitFn, Styler } from "../style.js";
import { renderHealth } from "./health.js";
import {
	borderBottom,
	borderMid,
	borderTop,
	boxLine,
	clampLines,
	feedColor,
	feedGlyph,
	formatAge,
	safeWidth,
	shortRoom,
	type RenderKit,
} from "./layout.js";
import { COCKPIT_TABS, type CockpitKeyRouter, type CockpitSnapshot, type CockpitTab } from "./model.js";
import { renderOverview } from "./overview.js";
import { renderTasks } from "./tasks.js";
import { renderTimeline } from "./timeline.js";

export interface CockpitComponentOptions {
	snapshot: CockpitSnapshot;
	styler: Styler;
	fit: FitFn;
	keys: CockpitKeyRouter;
	getHeight: () => number | undefined;
	onClose: () => void;
	onRefresh: () => Promise<void>;
	requestRender: () => void;
}

export class CockpitComponent {
	private snapshot: CockpitSnapshot;
	private readonly styler: Styler;
	private readonly fit: FitFn;
	private readonly keys: CockpitKeyRouter;
	private readonly getHeight: () => number | undefined;
	private readonly onClose: () => void;
	private readonly onRefresh: () => Promise<void>;
	private readonly requestRender: () => void;
	private tab: CockpitTab = "overview";
	private selected: Record<CockpitTab, number> = {
		overview: 0,
		timeline: 0,
		tasks: 0,
		health: 0,
	};
	private showHelp = false;
	private refreshing = false;
	private notice: string | undefined;

	constructor(options: CockpitComponentOptions) {
		this.snapshot = options.snapshot;
		this.styler = options.styler;
		this.fit = options.fit;
		this.keys = options.keys;
		this.getHeight = options.getHeight;
		this.onClose = options.onClose;
		this.onRefresh = options.onRefresh;
		this.requestRender = options.requestRender;
		this.selected.timeline = Math.max(0, this.snapshot.events.length - 1);
	}

	setSnapshot(snapshot: CockpitSnapshot): void {
		this.snapshot = snapshot;
		this.clampSelection();
		this.invalidate();
		this.requestRender();
	}

	setTab(tab: CockpitTab): void {
		this.tab = tab;
		this.notice = undefined;
		this.invalidate();
		this.requestRender();
	}

	render(width: number): string[] {
		const w = safeWidth(width);
		const height = Math.max(8, Math.floor(this.getHeight() ?? 24));
		const now = Date.now();
		const kit: RenderKit = { styler: this.styler, fit: this.fit, width: Math.max(1, w - 4), now };
		const room = shortRoom(this.snapshot.config.roomId);
		const lines: string[] = [];
		lines.push(borderTop("iroh-room cockpit", room, w, this.fit));
		lines.push(boxLine(this.statusLine(now, Math.max(1, w - 4)), w, this.fit));
		lines.push(borderMid(w, this.fit));
		lines.push(boxLine(this.tabLine(Math.max(1, w - 4)), w, this.fit));
		lines.push(borderMid(w, this.fit));
		const bodyHeight = Math.max(0, height - 8);
		const body = this.showHelp ? this.helpLines(kit) : this.bodyLines(kit);
		for (const line of body.slice(0, bodyHeight)) {
			lines.push(boxLine(line, w, this.fit));
		}
		while (lines.length < height - 3) {
			lines.push(boxLine("", w, this.fit));
		}
		if (this.notice !== undefined) {
			lines.push(boxLine(this.styler("warning", this.fit(this.notice, Math.max(1, w - 4))), w, this.fit));
		} else {
			lines.push(borderMid(w, this.fit));
		}
		lines.push(boxLine(this.footerLine(Math.max(1, w - 4)), w, this.fit));
		lines.push(borderBottom(w, this.fit));
		return clampLines(lines.slice(0, height), w, this.fit);
	}

	handleInput(data: string): void {
		if (this.keys.isClose(data)) {
			this.onClose();
			return;
		}
		if (this.keys.isHelp(data)) {
			this.showHelp = !this.showHelp;
			this.notice = undefined;
			this.invalidate();
			this.requestRender();
			return;
		}
		const tab = this.keys.tabFor(data);
		if (tab !== undefined) {
			this.setTab(tab);
			return;
		}
		if (this.keys.isNextTab(data)) {
			this.moveTab(1);
			return;
		}
		if (this.keys.isPrevTab(data)) {
			this.moveTab(-1);
			return;
		}
		if (this.keys.isUp(data)) {
			this.moveSelection(-1);
			return;
		}
		if (this.keys.isDown(data)) {
			this.moveSelection(1);
			return;
		}
		if (this.keys.isRefresh(data)) {
			void this.refresh();
			return;
		}
		if (this.keys.isEnter(data)) {
			this.notice = "Inspector is read-only in this build.";
			this.invalidate();
			this.requestRender();
			return;
		}
		if (this.keys.isReadOnlyAction(data)) {
			this.notice = "Mutating cockpit actions are read-only in this build.";
			this.invalidate();
			this.requestRender();
		}
	}

	invalidate(): void {
		// Stateless render; method is required by pi-tui and used as an update hook.
	}

	private async refresh(): Promise<void> {
		if (this.refreshing) return;
		this.refreshing = true;
		this.notice = "Refreshing…";
		this.invalidate();
		this.requestRender();
		try {
			await this.onRefresh();
			this.notice = "Refresh complete.";
		} catch {
			this.notice = "Refresh failed; see Health tab.";
		} finally {
			this.refreshing = false;
			this.invalidate();
			this.requestRender();
		}
	}

	private moveTab(delta: number): void {
		const index = COCKPIT_TABS.indexOf(this.tab);
		const next = (index + delta + COCKPIT_TABS.length) % COCKPIT_TABS.length;
		this.tab = COCKPIT_TABS[next] ?? "overview";
		this.notice = undefined;
		this.invalidate();
		this.requestRender();
	}

	private moveSelection(delta: number): void {
		const max = this.selectionMax(this.tab);
		this.selected[this.tab] = Math.max(0, Math.min(max, this.selected[this.tab] + delta));
		this.notice = undefined;
		this.invalidate();
		this.requestRender();
	}

	private selectionMax(tab: CockpitTab): number {
		switch (tab) {
			case "timeline":
				return Math.max(0, this.snapshot.events.length - 1);
			case "tasks":
				return Math.max(0, this.snapshot.tasks.all.length - 1);
			default:
				return 0;
		}
	}

	private clampSelection(): void {
		for (const tab of COCKPIT_TABS) {
			this.selected[tab] = Math.max(0, Math.min(this.selectionMax(tab), this.selected[tab]));
		}
	}

	private bodyLines(kit: RenderKit): string[] {
		switch (this.tab) {
			case "timeline":
				return renderTimeline(this.snapshot, kit, this.selected.timeline);
			case "tasks":
				return renderTasks(this.snapshot, kit, this.selected.tasks);
			case "health":
				return renderHealth(this.snapshot, kit);
			default:
				return renderOverview(this.snapshot, kit);
		}
	}

	private helpLines(kit: RenderKit): string[] {
		return [
			kit.styler("accent", "Help"),
			"",
			"esc/q        close",
			"?            toggle help",
			"tab/S-tab    next/previous tab",
			"1-4          overview/timeline/tasks/health",
			"↑↓           move selection",
			"enter        inspect selected row",
			"r            request refresh through ambient poll path",
			"/            search (future)",
			"",
			kit.styler("dim", "This first cockpit release is read-only. No room events, pipes, files, or model turns are triggered from this UI."),
		];
	}

	private tabLine(width: number): string {
		const labels: Record<CockpitTab, string> = {
			overview: "1 Overview",
			timeline: "2 Timeline",
			tasks: `3 Tasks~ ${this.snapshot.tasks.unclaimed.length}`,
			health: "4 Health",
		};
		const parts = COCKPIT_TABS.map((tab) => {
			const text = labels[tab];
			return tab === this.tab ? this.styler("accent", `[${text}]`) : this.styler("muted", ` ${text} `);
		});
		return this.fit(parts.join("  "), width);
	}

	private statusLine(now: number, width: number): string {
		const state = this.snapshot.feed.state;
		const freshness = this.snapshot.feed.lastOkAt === undefined ? "starting" : formatAge(now, this.snapshot.feed.lastOkAt);
		const identity = this.snapshot.identity?.from8 ?? "no identity";
		const status = this.snapshot.latest.status;
		const statusText = status === undefined ? "no status" : `${status.label}${typeof status.progress === "number" ? ` ${status.progress}%` : ""}`;
		const text = `${feedGlyph(state)} ${state} ${freshness} · ${identity} · ${statusText} · ${this.snapshot.pipes.length} pipes · ${this.snapshot.tasks.unclaimed.length} tasks~ · ${this.snapshot.events.length} events`;
		return this.styler(feedColor(state), this.fit(text, width));
	}

	private footerLine(width: number): string {
		const refreshing = this.refreshing ? " · refreshing" : "";
		return this.fit(`↑↓ move · tab switch · enter inspect · r refresh · ? help · esc close${refreshing}`, width);
	}
}
