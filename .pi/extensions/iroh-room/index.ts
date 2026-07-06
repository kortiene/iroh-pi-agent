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
import { registerIrohTools } from "./src/tools.js";

export default function irohRoomExtension(pi: ExtensionAPI): void {
	const pipes = new PipeManager();
	registerIrohTools(pi, { pipes });
	registerIrohCommands(pi, { pipes });
	pi.on("session_shutdown", async () => {
		await pipes.closeAll();
	});
}
