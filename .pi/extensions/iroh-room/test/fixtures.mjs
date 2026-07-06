/**
 * Byte-plausible iroh-rooms CLI stdout/stderr fixtures, pinned to the formats
 * documented in the Phase 0 recon (research-cli §3: labeled `key: value`
 * lines, single-line JSON for --json outputs, alignment padding included).
 */

const hex64 = (seed) => seed.repeat(Math.ceil(64 / seed.length)).slice(0, 64);
const hex32 = (seed) => seed.repeat(Math.ceil(32 / seed.length)).slice(0, 32);

export const ROOM_HEX = hex64("7c9e1a2b3c4d5e6f");
export const ROOM_ID = `blake3:${ROOM_HEX}`;

export const EVENT_STATUS = `blake3:${hex64("0badc0de1badc0de")}`;
export const EVENT_SEND = `blake3:${hex64("feedface01234567")}`;
export const EVENT_SHARE = `blake3:${hex64("cafebabe89abcdef")}`;

export const IDENTITY_ADMIN = hex64("e1d2c3b4a5968778");
export const IDENTITY_AGENT = hex64("1a2b3c4d5e6f7a8b");
export const DEVICE_ID = hex64("9f8e7d6c5b4a3928");

export const FILE_ID_HEX = hex32("0f1e2d3c4b5a6978");
export const FILE_ID = `file_${FILE_ID_HEX}`;
export const PIPE_ID = hex32("a1b2c3d4e5f60718");
export const BLOB_HASH = `blake3:${hex64("ab12cd34ef56ab78")}`;

export const INVITE_TICKET = `roomtkt1${"qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(3)}`;

/* `agent status` — event id on the `status:` line; note the alignment padding. */
export const STATUS_STDOUT = `status: ${EVENT_STATUS}
room:   ${ROOM_ID}
from:   ${IDENTITY_AGENT}
stored: yes
delivered: 1 connected peer(s)
`;

/* `room send` — event id on the `sent:` line. */
export const SEND_STDOUT = `sent: ${EVENT_SEND}
room: ${ROOM_ID}
from: ${IDENTITY_AGENT}
stored: yes
delivered: 0 (no peers online — stored locally only)
`;

/* `file share` — file_id on line 2, event id on the `event:` line. */
export const SHARE_STDOUT = `imported: /tmp/work/artifacts/report.md
file_id: ${FILE_ID}
name: report.md
mime: text/markdown
size: 1834 bytes
hash: ${BLOB_HASH}
event: ${EVENT_SHARE}
room: ${ROOM_ID}
provider: you (local)
next: run \`iroh-rooms room tail ${ROOM_ID}\` to serve it, then peers can \`iroh-rooms file fetch ${ROOM_ID} ${FILE_ID}\`
`;

/* `pipe expose` startup block (the command then blocks until Ctrl-C). */
export const EXPOSE_STDOUT = `room: ${ROOM_ID}
target: 127.0.0.1:3000
label: preview
allow: ${IDENTITY_ADMIN}
listening: ${hex32("9a8b7c6d5e4f3a2b")}@ip4:203.0.113.7:4433
tip: share this address with connectors via --peer
pipe_id: ${PIPE_ID}
connectors run: iroh-rooms pipe connect ${ROOM_ID} ${PIPE_ID} --local <PORT>
close it with: iroh-rooms pipe close ${PIPE_ID}
serving the pipe; press Ctrl-C to close it...
`;

export const PIPE_CLOSE_STDOUT = `closed pipe ${PIPE_ID} in room ${ROOM_ID}
`;

export const PIPE_LIST_STDOUT = `room: ${ROOM_ID}
pipe_id: ${PIPE_ID}
  owner: ${IDENTITY_AGENT}
  label: preview
  allowed: 1
  expires_at: never
`;

/* `identity show --json` — single-line JSON object. */
export const IDENTITY_JSON = `${JSON.stringify({
	version: 1,
	name: "pi-agent",
	identity_id: IDENTITY_AGENT,
	device_id: DEVICE_ID,
	created_at_ms: 1751500000000,
})}\n`;

/* `room members --json` — single-line JSON object. */
export const MEMBERS_JSON = `${JSON.stringify({
	room: ROOM_ID,
	admin: IDENTITY_ADMIN,
	members: [
		{ identity_id: IDENTITY_ADMIN, role: "admin", status: "active", is_admin: true },
		{ identity_id: IDENTITY_AGENT, role: "agent", status: "active", is_admin: false },
	],
})}\n`;

/* `file list --json` — single-line JSON array. */
export const FILE_LIST_JSON = `${JSON.stringify([
	{ file_id: FILE_ID, name: "report.md", size_bytes: 1834, blob_hash: BLOB_HASH, provider: "local" },
])}\n`;

/* `room tail --offline --json` — single-line JSON array, one row per event
 * type, stable fields + flattened type-specific content fields. */
export const TAIL_ROWS = [
	{
		event_id: `blake3:${hex64("aaaa000000000001")}`,
		event_type: "room.created",
		lamport: 1,
		admin_seq: 1,
		created_at: 1751600000000,
		at: "2026-07-04T05:33:20Z",
		from: IDENTITY_ADMIN.slice(0, 8),
		display_name: "sekou",
		role: "admin",
		status: "active",
	},
	{
		event_id: `blake3:${hex64("aaaa000000000002")}`,
		event_type: "member.invited",
		lamport: 2,
		admin_seq: 2,
		created_at: 1751600001000,
		at: "2026-07-04T05:33:21Z",
		from: IDENTITY_ADMIN.slice(0, 8),
		display_name: "sekou",
		role: "admin",
		status: "active",
		invitee: IDENTITY_AGENT,
		invited_role: "agent",
	},
	{
		event_id: `blake3:${hex64("aaaa000000000003")}`,
		event_type: "member.joined",
		lamport: 3,
		admin_seq: 3,
		created_at: 1751600002000,
		at: "2026-07-04T05:33:22Z",
		from: IDENTITY_AGENT.slice(0, 8),
		display_name: "pi-agent",
		role: "agent",
		status: "active",
		joined_role: "agent",
	},
	{
		event_id: `blake3:${hex64("aaaa000000000004")}`,
		event_type: "message.text",
		lamport: 4,
		created_at: 1751600003000,
		at: "2026-07-04T05:33:23Z",
		from: IDENTITY_ADMIN.slice(0, 8),
		display_name: "sekou",
		role: "admin",
		status: "active",
		body: "Please pick up IR-PI-001 — implement the Pi extension and share the report when done.",
		format: "plain",
	},
	{
		event_id: `blake3:${hex64("aaaa000000000005")}`,
		event_type: "agent.status",
		lamport: 5,
		created_at: 1751600004000,
		at: "2026-07-04T05:33:24Z",
		from: IDENTITY_AGENT.slice(0, 8),
		display_name: "pi-agent",
		role: "agent",
		status: "active",
		state: "implementing",
		message: "Editing Pi extension tools",
		progress: 45,
		artifacts: [FILE_ID],
	},
	{
		event_id: `blake3:${hex64("aaaa000000000006")}`,
		event_type: "file.shared",
		lamport: 6,
		created_at: 1751600005000,
		at: "2026-07-04T05:33:25Z",
		from: IDENTITY_AGENT.slice(0, 8),
		display_name: "pi-agent",
		role: "agent",
		status: "active",
		file_name: "report.md",
		size_bytes: 1834,
		blob_hash: BLOB_HASH,
	},
	{
		event_id: `blake3:${hex64("aaaa000000000007")}`,
		event_type: "pipe.opened",
		lamport: 7,
		created_at: 1751600006000,
		at: "2026-07-04T05:33:26Z",
		from: IDENTITY_AGENT.slice(0, 8),
		display_name: "pi-agent",
		role: "agent",
		status: "active",
		pipe_id: PIPE_ID,
		label: "preview",
	},
	{
		event_id: `blake3:${hex64("aaaa000000000008")}`,
		event_type: "pipe.closed",
		lamport: 8,
		created_at: 1751600007000,
		at: "2026-07-04T05:33:27Z",
		from: IDENTITY_AGENT.slice(0, 8),
		display_name: "pi-agent",
		role: "agent",
		status: "active",
		pipe_id: PIPE_ID,
		reason: "closed",
	},
	{
		event_id: `blake3:${hex64("aaaa000000000009")}`,
		event_type: "member.left",
		lamport: 9,
		created_at: 1751600008000,
		at: "2026-07-04T05:33:28Z",
		from: IDENTITY_AGENT.slice(0, 8),
		role: "agent",
		status: "left",
	},
	{
		event_id: `blake3:${hex64("aaaa00000000000a")}`,
		event_type: "future.event",
		lamport: 10,
		created_at: 1751600009000,
		at: "2026-07-04T05:33:29Z",
		from: IDENTITY_ADMIN.slice(0, 8),
		role: "admin",
		status: "active",
		mystery_field: "keep-me",
	},
];

export const TAIL_JSON = `${JSON.stringify(TAIL_ROWS)}\n`;

/* Coded errors on stderr: `error[<code>]: <detail>` + optional `next:` hint. */
export const ERROR_STDERR_ROOM = `error[invalid_room_id]: room id must look like blake3:<64 hex chars>
next: run \`iroh-rooms room members --help\`
`;

export const ERROR_STDERR_IDENTITY = `error[identity_not_found]: no local identity found
next: run \`iroh-rooms identity create --name <name>\`
`;

/** pi.exec-shaped success result. */
export const ok = (stdout, stderr = "") => ({ stdout, stderr, code: 0, killed: false });
/** pi.exec-shaped failure result. */
export const fail = (code, stderr, stdout = "") => ({ stdout, stderr, code, killed: false });
