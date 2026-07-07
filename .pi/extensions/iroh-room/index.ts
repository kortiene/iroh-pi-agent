/**
 * iroh-room Pi extension — entry point.
 *
 * Registers 10 model-facing tools and 8 slash commands that wrap the
 * `iroh-rooms` CLI (status, messages, tail snapshots, artifacts, loopback
 * preview pipes), plus the ambient room pulse (widget + footer pill fed by a
 * polling RoomFeedStore, TUI mode only). Everything is registered
 * synchronously in the factory body (registering later is silently dropped).
 * The shared PipeManager owns any background `pipe expose` children; it and
 * the AmbientController are drained by the SINGLE session_shutdown handler.
 *
 * See README.md for configuration (.iroh-room-pi.json, IROH_ROOM_* env vars)
 * and docs/pi-harness.md for the full harness walkthrough.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerIrohCommands } from "./src/commands.js";
import { TOOL_NAMES } from "./src/constants.js";
import { PipeManager } from "./src/pipes.js";
import { registerIrohTools, type IrohRoomOptions } from "./src/tools.js";
import { AmbientController } from "./src/tui/ambient.js";
import { CockpitController } from "./src/tui/cockpit/controller.js";

/**
 * Build the extension entry. Exported so tests can inject deps (exec, env,
 * PipeManager, AmbientController) and verify the session wiring against live
 * children; Pi itself loads the zero-options default export below.
 */
export function createIrohRoomExtension(options: IrohRoomOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		// One shared PipeManager for tools, commands, AND session_shutdown —
		// splitting them would leak `pipe expose` children on shutdown.
		const pipes = options.pipes ?? new PipeManager();
		const wired: IrohRoomOptions = { ...options, pipes };
		const deps = registerIrohTools(pi, wired);
		// One ambient controller (the only timer home), sharing the tool deps
		// so the poll loop shells through the same exec/env as everything else.
		const ambient =
			options.ambient ?? new AmbientController({ env: deps.env, exec: deps.exec, pipes });
		const cockpit = options.cockpit ?? new CockpitController({ dataSource: ambient });
		// Late-bind the controller into the tool deps (it needs deps.exec/env
		// to construct, so it cannot exist before registerIrohTools): the
		// iroh_pipe_close op marks its own close as expected BEFORE touching
		// the pipe registry, closing the pipe_closed_own race for tool closes.
		deps.ambient = ambient;
		registerIrohCommands(pi, { ...wired, ambient, cockpit });
		pi.on("session_start", async (event, ctx) => {
			await ambient.onSessionStart(event, ctx);
		});
		// Recent iroh_* tool activity boosts the ambient poll cadence. A
		// successful iroh_pipe_close additionally marks that pipe id as an
		// EXPECTED close so the pipe_closed_own diff never toasts our own
		// closes (fed from tool completions + /room-preview --close only —
		// never from untrusted tail pipe.closed rows). This completion-time
		// mark is belt-and-braces: the RACE-FREE mark happens inside
		// opPipeClose (via deps.ambient) BEFORE the registry entry vanishes.
		pi.on("tool_execution_end", (event) => {
			if (typeof event.toolName !== "string" || !event.toolName.startsWith("iroh_")) {
				return;
			}
			if (event.toolName === TOOL_NAMES.pipeClose) {
				const details = (event.result as { details?: { ok?: unknown; pipe_id?: unknown } } | undefined)
					?.details;
				if (details?.ok === true && typeof details.pipe_id === "string") {
					ambient.noteExpectedPipeClose?.(details.pipe_id);
				}
			}
			ambient.boost();
		});
		// The single session_shutdown handler (tests pin the count): tear the
		// ambient surfaces/timers down, then drain pipe children. Both are
		// idempotent.
		pi.on("session_shutdown", async () => {
			cockpit.shutdown();
			ambient.shutdown();
			await pipes.closeAll();
		});
	};
}

export default createIrohRoomExtension();
