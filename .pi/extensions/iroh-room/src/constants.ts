/**
 * Shared constants for the iroh-room Pi extension.
 *
 * The byte limits mirror crates/iroh-rooms-core/src/event/constants.rs in the
 * iroh-room repo. We enforce them here, pre-IO, so the model gets a clear
 * local error instead of a CLI round-trip failure.
 */

export const CONFIG_FILE_NAME = ".iroh-room-pi.json";

/** iroh-rooms-core validation limits (bytes unless stated otherwise). */
export const MAX_STATUS_LABEL_BYTES = 64;
export const MAX_STATUS_MESSAGE_BYTES = 4096;
export const MAX_ARTIFACT_REFS = 16;
export const MAX_MESSAGE_BODY_BYTES = 16_384;
export const MAX_SHARED_FILE_BYTES = 104_857_600; // 100 MiB
export const MAX_FILE_NAME_BYTES = 255;
export const MAX_MIME_TYPE_BYTES = 255;
export const MAX_LABEL_BYTES = 255;

/** Tail snapshot behavior. */
export const DEFAULT_TAIL_LIMIT = 50;
export const MIN_TAIL_LIMIT = 1;
export const MAX_TAIL_LIMIT = 500;

/** Runtime behavior. */
export const EXEC_TIMEOUT_MS = 60_000;
export const PIPE_ID_PARSE_TIMEOUT_MS = 20_000;
export const PIPE_CLOSE_GRACE_MS = 5_000;
export const OUTPUT_CAP_BYTES = 8_192;

/** ID shapes (see iroh-room docs/protocol.md + crates ids.rs). */
export const ROOM_ID_RE = /^blake3:[0-9a-f]{64}$/;
export const IDENTITY_ID_RE = /^[0-9a-f]{64}$/;
export const ARTIFACT_ID_RE = /^(file_)?[0-9a-f]{32}$/;
export const PIPE_ID_RE = /^[0-9a-f]{32}$/;
export const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
/** Stricter than the binary (which allows 127.0.0.0/8 + ::1) per SPEC §10.5. */
export const LOOPBACK_TCP_RE = /^127\.0\.0\.1:(\d{1,5})$/;

/**
 * Advisory agent.status vocabulary (SPEC §12). Used for autocomplete and
 * prompt guidance; NOT enforced — the protocol accepts any 1..=64 byte label.
 */
export const STATUS_VOCABULARY = [
	"idle",
	"observing",
	"claimed",
	"planning",
	"implementing",
	"testing",
	"sharing_artifacts",
	"preview_available",
	"blocked",
	"ready_for_review",
	"done",
	"failed",
	"cancelled",
] as const;

export const TOOL_NAMES = {
	agentStatus: "iroh_agent_status",
	roomSend: "iroh_room_send",
	tailSnapshot: "iroh_room_tail_snapshot",
	fileShare: "iroh_file_share",
	pipeExpose: "iroh_pipe_expose",
	pipeClose: "iroh_pipe_close",
	pipeList: "iroh_pipe_list",
	roomMembers: "iroh_room_members",
	fileList: "iroh_file_list",
	identityShow: "iroh_identity_show",
} as const;

/**
 * Custom message types for the TUI transcript cards (rendered by
 * src/tui/wire.ts; emitted by commands.ts). The `content` of these messages
 * is LLM-visible and must contain zero room-authored text; room strings
 * travel only in `details`, which never reaches the model.
 */
export const CARD_TYPE = "iroh-room.card";
export const RECEIPT_TYPE = "iroh-room.receipt";

export const COMMAND_NAMES = {
	room: "room",
	roomStatus: "room-status",
	roomSend: "room-send",
	roomArtifact: "room-artifact",
	roomPreview: "room-preview",
	roomTail: "room-tail",
	roomPulse: "room-pulse",
	roomCockpit: "room-cockpit",
} as const;

/* ------------------------------------------------------------------ */
/* Room pulse (brief §4 M1). Cadences/backoff/ring sizes live here and */
/* are constructor-injectable on RoomFeedStore / AmbientController for */
/* tests (house precedent: PipeManager timeouts).                      */
/* ------------------------------------------------------------------ */

/** ctx.ui.setWidget key for the below-editor pulse widget. */
export const PULSE_WIDGET_KEY = "iroh-room-pulse";
/** ctx.ui.setStatus key for the footer pill. */
export const PULSE_STATUS_KEY = "iroh-room";
/** appendEntry customType persisting the chosen pulse density. */
export const DENSITY_ENTRY_TYPE = "iroh-room.density";

export const PULSE_DENSITIES = ["off", "pill", "1", "2"] as const;
export type PulseDensity = (typeof PULSE_DENSITIES)[number];
export const DEFAULT_PULSE_DENSITY: PulseDensity = "2";
export const MAX_ROOM_LABEL_CHARS = 32;

/** Ambient poll cadence; boosted after our own commands/tools run. */
export const AMBIENT_POLL_MS = 5_000;
export const BOOST_POLL_MS = 2_000;
export const BOOST_WINDOW_MS = 30_000;
/** Failure backoff ladder (streak 1..N; the last entry repeats). */
export const BACKOFF_LADDER_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
/** Snapshot is rendered stale once older than this many cadences. */
export const STALE_AFTER_TICKS = 3;

/** Seen-ring capacity (event ids ordered by (lamport ?? -1, event_id)). */
export const SEEN_RING_CAPACITY = 2048;
/** Deep poll (--limit) for session init and gap repair. */
export const DEEP_TAIL_LIMIT = 500;
/** Steady ambient poll --limit. */
export const AMBIENT_TAIL_LIMIT = 100;

/* ------------------------------------------------------------------ */
/* M2 — signal + flows (brief §3, §4 M2).                              */
/* ------------------------------------------------------------------ */

/**
 * Completion-value shape for room task ids (U5): a deliberate tightening for
 * COMPLETIONS ONLY — the grammar itself accepts any non-empty scalar, so
 * non-conforming ids are dropped from completions, never from tracking.
 */
export const TASK_ID_COMPLETION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** `room members --json` poll runs on every Nth successful tail tick. */
export const MEMBERS_POLL_EVERY_TICKS = 6;
/** Per-kind toast cooldown for the M2 classifier (notify.ts). */
export const TOAST_COOLDOWN_MS = 30_000;
/** Unclaimed room-task cap (heuristic count; always ~-marked). */
export const UNCLAIMED_TASK_CAP = 50;
