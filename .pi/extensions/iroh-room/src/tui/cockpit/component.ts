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
	sectionTitle,
	shortRoom,
	type RenderKit,
} from "./layout.js";
import { renderMembers } from "./members.js";
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
		members: 0,
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
		lines.push(borderTop("iroh-room cockpit", room, w, this.fit, this.styler));
		lines.push(boxLine(this.statusLine(now, Math.max(1, w - 4)), w, this.fit, this.styler));
		lines.push(borderMid(w, this.fit, this.styler));
		lines.push(boxLine(this.tabLine(Math.max(1, w - 4)), w, this.fit, this.styler));
		lines.push(borderMid(w, this.fit, this.styler));
		const bodyHeight = Math.max(0, height - 8);
		const body = this.showHelp ? this.helpLines(kit) : this.bodyLines(kit);
		for (const line of body.slice(0, bodyHeight)) {
			lines.push(boxLine(line, w, this.fit, this.styler));
		}
		while (lines.length < height - 3) {
			lines.push(boxLine("", w, this.fit, this.styler));
		}
		if (this.notice !== undefined) {
			lines.push(boxLine(this.noticeLine(Math.max(1, w - 4)), w, this.fit, this.styler));
		} else {
			lines.push(borderMid(w, this.fit, this.styler));
		}
		lines.push(boxLine(this.footerLine(Math.max(1, w - 4)), w, this.fit, this.styler));
		lines.push(borderBottom(w, this.fit, this.styler));
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
			case "members":
				return Math.max(0, this.snapshot.members.length - 1);
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
			case "members":
				return renderMembers(this.snapshot, kit, this.selected.members);
			case "health":
				return renderHealth(this.snapshot, kit);
			default:
				return renderOverview(this.snapshot, kit);
		}
	}

	private helpLines(kit: RenderKit): string[] {
		const row = (k: string, action: string): string => {
			const keyPlain = k.padEnd(10);
			const actionPlain = kit.fit(action, Math.max(0, kit.width - 12));
			return `  ${kit.styler("accent", keyPlain)}${kit.styler("text", actionPlain)}`;
		};
		return [
			sectionTitle("Help", kit),
			"",
			row("esc / q", "close the cockpit"),
			row("?", "toggle this help"),
			row("tab / ⇧tab", "next / previous tab"),
			row("1-5", "jump to overview / timeline / tasks / members / health"),
			row("↑ ↓", "move the selection"),
			row("↵", "inspect the selected row"),
			row("r", "refresh through the ambient poll path"),
			`  ${kit.styler("accent", "/".padEnd(10))}${kit.styler("dim", "search (coming soon)")}`,
			"",
			kit.styler(
				"dim",
				kit.fit("Read-only build · no room events, pipes, files, or model turns are triggered here.", kit.width),
			),
		];
	}

	private tabLine(width: number): string {
		const labels: Record<CockpitTab, string> = {
			overview: "Overview",
			timeline: "Timeline",
			tasks: `Tasks~ ${this.snapshot.tasks.unclaimed.length}`,
			members: `Members ${this.snapshot.members.length}`,
			health: "Health",
		};
		const plainParts = COCKPIT_TABS.map((tab, index) =>
			tab === this.tab ? `▸${index + 1} ${labels[tab]}` : ` ${index + 1} ${labels[tab]}`,
		);
		const plain = plainParts.join(" · ");
		if (plain.length > width) {
			return this.styler("muted", this.fit(plain, width));
		}
		// Modern tab strip: active tab gets a leading bar + accent; the numeric
		// hotkey stays dim so the label is what reads. A thin separator between
		// tabs replaces the old double-space gap.
		const parts = COCKPIT_TABS.map((tab, index) => {
			const key = this.styler("dim", String(index + 1));
			if (tab === this.tab) {
				return `${this.styler("accent", "▸")}${key} ${this.styler("accent", labels[tab])}`;
			}
			return ` ${key} ${this.styler("muted", labels[tab])}`;
		});
		return parts.join(this.styler("border", " · "));
	}

	private noticeLine(width: number): string {
		const notice = this.notice ?? "";
		const color = this.refreshing ? "accent" : "warning";
		const plainNotice = this.fit(notice, Math.max(0, width - 2));
		return `${this.styler(color, "•")} ${this.styler("warning", plainNotice)}`;
	}

	private chip(color: string, glyph: string, text: string): string {
		return glyph === "" ? this.styler(color, text) : `${this.styler(color, glyph)} ${this.styler(color, text)}`;
	}

	private statusLine(now: number, width: number): string {
		const state = this.snapshot.feed.state;
		const freshness = this.snapshot.feed.lastOkAt === undefined ? "starting" : formatAge(now, this.snapshot.feed.lastOkAt);
		const identity = this.snapshot.identity?.from8 ?? "no identity";
		const status = this.snapshot.latest.status;
		const statusText = status === undefined ? "no status" : `${status.label}${typeof status.progress === "number" ? ` ${status.progress}%` : ""}`;
		const tasks = this.snapshot.tasks.unclaimed.length;
		const cells = [
			{ plain: `${feedGlyph(state)} ${state} ${freshness}`, color: feedColor(state), glyph: feedGlyph(state), text: `${state} ${freshness}` },
			{ plain: identity, color: "muted", glyph: "", text: identity },
			{ plain: statusText, color: "text", glyph: "", text: statusText },
			{ plain: `⇄ ${this.snapshot.pipes.length}`, color: "muted", glyph: "⇄", text: `${this.snapshot.pipes.length}` },
			{ plain: `○ ${tasks}~`, color: tasks > 0 ? "warning" : "muted", glyph: "○", text: `${tasks}~` },
			{ plain: `${this.snapshot.events.length} events`, color: "dim", glyph: "", text: `${this.snapshot.events.length} events` },
		];
		const visible: typeof cells = [];
		for (const cell of cells) {
			const nextPlain = [...visible.map((seen) => seen.plain), cell.plain].join(" · ");
			if (nextPlain.length > width && visible.length > 0) break;
			visible.push(cell);
		}
		const plain = visible.map((cell) => cell.plain).join(" · ");
		if (plain.length > width) {
			return this.styler(feedColor(state), this.fit(plain, width));
		}
		// Polychromatic status bar: the feed chip carries the state color; the
		// rest are role-colored so identity/status/pipes/tasks stay legible
		// instead of the whole row flipping to one alarm color.
		return visible
			.map((cell) => this.chip(cell.color, cell.glyph, cell.text))
			.join(this.styler("border", " · "));
	}

	private footerLine(width: number): string {
		const entries: { key: string; action: string; color?: string }[] = [
			{ key: "↑↓", action: "move" },
			{ key: "tab", action: "switch" },
			{ key: "↵", action: "inspect" },
			{ key: "r", action: "refresh" },
			{ key: "?", action: "help" },
			{ key: "esc", action: "close" },
		];
		if (this.refreshing) entries.push({ key: "↻", action: "refreshing", color: "dim" });
		const visible: typeof entries = [];
		for (const entry of entries) {
			const nextPlain = [...visible.map((seen) => `${seen.key} ${seen.action}`), `${entry.key} ${entry.action}`].join(" · ");
			if (nextPlain.length > width && visible.length > 0) break;
			visible.push(entry);
		}
		const plain = visible.map((entry) => `${entry.key} ${entry.action}`).join(" · ");
		if (plain.length > width) return this.styler("muted", this.fit(plain, width));
		// Key-cap styling: each shortcut key is accented, its action muted, so
		// the hint row reads as a legend instead of one flat gray sentence.
		return visible
			.map((entry) => `${this.styler("accent", entry.key)} ${this.styler(entry.color ?? "muted", entry.action)}`)
			.join(this.styler("border", " · "));
	}
}
