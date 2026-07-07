/** Lifecycle controller for the opt-in Room Cockpit custom UI. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";

import { createCockpitComponent } from "./wire.js";
import { type CockpitDataSource, type CockpitTab } from "./model.js";

export type CockpitMode = "full" | "overlay";
export type CockpitCloseReason = "user" | "shutdown" | "reload";

export interface CockpitControllerLike {
	open(mode: CockpitMode, ctx: ExtensionContext): Promise<void>;
	close(reason: CockpitCloseReason): void;
	isOpen(): boolean;
	selectTab?(tab: CockpitTab): void;
	shutdown(): void;
}

interface CloseResult {
	reason: CockpitCloseReason;
}

export class CockpitController implements CockpitControllerLike {
	private readonly dataSource: CockpitDataSource;
	private openPromise: Promise<void> | undefined;
	private closeDone: ((result: CloseResult) => void) | undefined;
	private unsubscribe: (() => void) | undefined;
	private overlayHandle: OverlayHandle | undefined;
	private component: { setSnapshot(snapshot: ReturnType<CockpitDataSource["getSnapshot"]>): void; setTab(tab: CockpitTab): void; invalidate(): void } | undefined;
	private requestRender: (() => void) | undefined;
	private token = 0;

	constructor(options: { dataSource: CockpitDataSource }) {
		this.dataSource = options.dataSource;
	}

	isOpen(): boolean {
		return this.openPromise !== undefined;
	}

	async open(mode: CockpitMode, ctx: ExtensionContext): Promise<void> {
		if (this.openPromise !== undefined) {
			try {
				this.overlayHandle?.setHidden(false);
				this.overlayHandle?.focus();
			} catch {
				// stale overlay handle after reload; cleanup will clear it
			}
			this.component?.setSnapshot(this.dataSource.getSnapshot());
			this.safeRender();
			void this.dataSource.requestRefresh();
			return this.openPromise;
		}
		const token = ++this.token;
		const promise = ctx.ui.custom<CloseResult>((tui, theme, _keybindings, done) => {
			this.closeDone = done;
			let component = createCockpitComponent({
				snapshot: this.dataSource.getSnapshot(),
				theme,
				getHeight: () => tui.terminal.rows,
				onClose: () => this.close("user"),
				onRefresh: () => this.dataSource.requestRefresh(),
				requestRender: () => {
					try {
						tui.requestRender();
					} catch {
						// stale runtime
					}
				},
			});
			this.component = component;
			this.requestRender = () => {
				try {
					tui.requestRender();
				} catch {
					// stale tui after reload; cleanup handles it
				}
			};
			this.unsubscribe = this.dataSource.subscribe(() => {
				try {
					component.setSnapshot(this.dataSource.getSnapshot());
					tui.requestRender();
				} catch {
					// stale runtime after reload
				}
			});
			return {
				render: (width: number) => component.render(width),
				handleInput: (data: string) => {
					component.handleInput(data);
					try {
						tui.requestRender();
					} catch {
						// stale runtime
					}
				},
				invalidate: () => component.invalidate(),
				dispose: () => {},
			};
		}, mode === "overlay" ? {
			overlay: true,
			overlayOptions: {
				anchor: "right-center",
				width: "35%",
				minWidth: 44,
				maxHeight: "85%",
				margin: { right: 1 },
				visible: (termWidth: number) => termWidth >= 100,
			},
			onHandle: (handle) => {
				this.overlayHandle = handle;
				handle.focus();
			},
		} : undefined)
			.then(() => undefined)
			.catch(() => undefined)
			.finally(() => {
				if (this.token === token) {
					this.cleanup();
				}
			});
		this.openPromise = promise;
		return promise;
	}

	close(reason: CockpitCloseReason): void {
		const done = this.closeDone;
		if (done === undefined) {
			return;
		}
		this.closeDone = undefined;
		try {
			done({ reason });
		} catch {
			this.cleanup();
		}
	}

	selectTab(tab: CockpitTab): void {
		this.component?.setTab(tab);
		this.safeRender();
	}

	shutdown(): void {
		this.close("shutdown");
		this.cleanup();
	}

	private safeRender(): void {
		try {
			this.requestRender?.();
		} catch {
			// stale runtime after reload
		}
	}

	private cleanup(): void {
		const unsubscribe = this.unsubscribe;
		this.unsubscribe = undefined;
		try {
			unsubscribe?.();
		} catch {
			// no-op
		}
		try {
			this.overlayHandle?.hide();
		} catch {
			// no-op
		}
		this.overlayHandle = undefined;
		this.component = undefined;
		this.requestRender = undefined;
		this.closeDone = undefined;
		this.openPromise = undefined;
	}
}
