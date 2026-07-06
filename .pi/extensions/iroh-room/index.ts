/**
 * iroh-room Pi extension — entry point.
 *
 * Registers 10 model-facing tools and 6 slash commands that wrap the
 * `iroh-rooms` CLI (status, messages, tail snapshots, artifacts, loopback
 * preview pipes). Everything is registered synchronously in the factory body
 * (registering later is silently dropped). The shared PipeManager owns any
 * background `pipe expose` children and is drained on session_shutdown.
 *
 * See README.md for configuration (.iroh-room-pi.json, IROH_ROOM_* env vars)
 * and docs/pi-harness.md for the full harness walkthrough.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerIrohCommands } from "./src/commands.js";
import { PipeManager } from "./src/pipes.js";
import { registerIrohTools, type IrohRoomOptions } from "./src/tools.js";

/**
 * Build the extension entry. Exported so tests can inject deps (exec, env,
 * PipeManager) and verify the session_shutdown wiring against a live child;
 * Pi itself loads the zero-options default export below.
 */
export function createIrohRoomExtension(options: IrohRoomOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		// One shared PipeManager for tools, commands, AND session_shutdown —
		// splitting them would leak `pipe expose` children on shutdown.
		const pipes = options.pipes ?? new PipeManager();
		const wired: IrohRoomOptions = { ...options, pipes };
		registerIrohTools(pi, wired);
		registerIrohCommands(pi, wired);
		pi.on("session_shutdown", async () => {
			await pipes.closeAll();
		});
	};
}

export default createIrohRoomExtension();
