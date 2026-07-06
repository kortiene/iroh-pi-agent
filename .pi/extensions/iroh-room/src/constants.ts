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

export const COMMAND_NAMES = {
	room: "room",
	roomStatus: "room-status",
	roomSend: "room-send",
	roomArtifact: "room-artifact",
	roomPreview: "room-preview",
	roomTail: "room-tail",
} as const;
