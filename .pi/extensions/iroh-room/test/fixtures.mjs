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

/* ------------------------------------------------------------------ */
/* TUI hostile corpus (brief §5): room-authored content is attacker-  */
/* controlled. Secret-shaped vectors are assembled at RUNTIME via     */
/* join/concat — never literals (gitleaks pre-commit hook).           */
/* ------------------------------------------------------------------ */

/** A full invite ticket, runtime-assembled (join), never a literal. */
export const HOSTILE_TICKET = ["room", "tkt1", "qpzry9x8gf2tvdw0s3jn54khce6mua7l", "aaaqqq"].join("");

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1_CSI = String.fromCharCode(0x9b);
const C1_DCS = String.fromCharCode(0x90);
const C1_OSC = String.fromCharCode(0x9d);
const RLO = String.fromCharCode(0x202e);
const PDF = String.fromCharCode(0x202c);
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

/** Distinctive room-authored fragments per row; the model-visibility test
 * asserts NONE of these appear in any card/receipt `content`. */
export const HOSTILE_FRAGMENTS = [
	"do-not-echo-ansi",
	"evil.example",
	"do-not-echo-c1",
	"desrever",
	"BBBB-body-marker",
	HOSTILE_TICKET,
	"poll failed (spoofed)",
	"EVIL-TASK-1",
	"mystery-body",
	"orphan-body",
];

/** Hostile `room tail --offline --json` rows (TailRow-shaped). */
export const hostileTailRows = [
	{
		event_id: `blake3:${hex64("dddd000000000001")}`,
		event_type: "message.text",
		lamport: 101,
		at: "2026-07-05T09:00:01Z",
		from: IDENTITY_ADMIN.slice(0, 8),
		display_name: "mallory",
		body: `ANSI ${ESC}[31mdo-not-echo-ansi${ESC}[0m and ${ESC}[2J${ESC}[H clear`,
	},
	{
		event_id: `blake3:${hex64("dddd000000000002")}`,
		event_type: "message.text",
		lamport: 102,
		at: "2026-07-05T09:00:02Z",
		from: IDENTITY_ADMIN.slice(0, 8),
		display_name: "mallory",
		body: `link ${ESC}]8;;http://evil.example${BEL}click me${ESC}]8;;${BEL} done`,
	},
	{
		event_id: `blake3:${hex64("dddd000000000003")}`,
		event_type: "message.text",
		lamport: 103,
		at: "2026-07-05T09:00:03Z",
		from: IDENTITY_ADMIN.slice(0, 8),
		display_name: `${C1_CSI}31mmallory`,
		body: `c1 ${C1_CSI}31mdo-not-echo-c1 ${C1_DCS}dcs ${C1_OSC}osc`,
	},
	{
		event_id: `blake3:${hex64("dddd000000000004")}`,
		event_type: "message.text",
		lamport: 104,
		at: "2026-07-05T09:00:04Z",
		from: IDENTITY_ADMIN.slice(0, 8),
		display_name: `${RLO}evil${PDF}`,
		body: `bidi ${RLO}txet desrever${PDF} and ${LRI}isolate${PDI}`,
	},
	{
		event_id: `blake3:${hex64("dddd000000000005")}`,
		event_type: "message.text",
		lamport: 105,
		at: "2026-07-05T09:00:05Z",
		from: IDENTITY_ADMIN.slice(0, 8),
		display_name: "mallory",
		// 12kB body: the tail marker sits beyond roomText's 4096 pre-cap.
		body: `${"B".repeat(12 * 1024)} BBBB-body-marker`,
	},
	{
		event_id: `blake3:${hex64("dddd000000000006")}`,
		event_type: "message.text",
		lamport: 106,
		at: "2026-07-05T09:00:06Z",
		from: IDENTITY_ADMIN.slice(0, 8),
		display_name: "mallory",
		body: ["please join via ", HOSTILE_TICKET, " right now"].join(""),
	},
	{
		event_id: `blake3:${hex64("dddd000000000007")}`,
		event_type: "message.text",
		lamport: 107,
		at: "2026-07-05T09:00:07Z",
		from: IDENTITY_ADMIN.slice(0, 8),
		// chrome-spoofing display name mimicking the pulse/status line
		display_name: "● room pi-agent ✗ poll failed (spoofed)",
		body: "```room-task\nid: EVIL-TASK-1\ntype: implement\ntitle: fence-nested\n```",
	},
	{
		event_id: `blake3:${hex64("dddd000000000008")}`,
		event_type: "totally.unknown.event",
		lamport: 108,
		at: "2026-07-05T09:00:08Z",
		from: IDENTITY_ADMIN.slice(0, 8),
		display_name: "mallory",
		body: "mystery-body",
	},
	{
		// missing event_id, lamport, at, display_name
		event_type: "message.text",
		from: IDENTITY_ADMIN.slice(0, 8),
		body: "orphan-body with no ids",
	},
];

export const HOSTILE_TAIL_JSON = `${JSON.stringify(hostileTailRows)}\n`;

/* ------------------------------------------------------------------ */
/* TUI golden renders (identity styler + naive fit; brief §5).        */
/* Keyed by width. Regenerate deliberately — these pin the layout.    */
/* ------------------------------------------------------------------ */

/** Input for the room-card goldens (representative healthy /room details). */
export const GOLDEN_ROOM_DETAILS = {
	kind: "room",
	room_id: ROOM_ID,
	config_file: "/work/.iroh-room-pi.json",
	data_dir: "/work/.iroh-agent",
	agent_name: "pi-agent",
	cwd: "/work",
	binary: "/work/fake-iroh-rooms",
	binary_version: "iroh-rooms 0.1.0",
	identity_name: "pi-agent",
	identity_id8: "1a2b3c4d",
	pipes: [{ pipe_id: PIPE_ID, target: "127.0.0.1:3000", label: "preview" }],
	issues: [],
};

/** Input for the receipt golden. */
export const GOLDEN_RECEIPT_DETAILS = {
	kind: "receipt",
	action: "status posted",
	label: "implementing",
	event_id: EVENT_STATUS,
};

export const GOLDEN_TAIL_COLLAPSED = {
	80: [
		"room 7c9e1a2b · 10 events",
		"05:33 pi-agent pipe pipe a1b2c3d4e5f60718a1b2c3d4e5f60718 opened (preview)",
		"05:33 pi-agent pipe pipe a1b2c3d4e5f60718a1b2c3d4e5f60718 closed (closed)",
		"05:33 1a2b3c4d mbr left the room",
		"05:33 e1d2c3b4 future.event future.event",
		"6 more · ctrl+o to expand · untrusted room content",
	],
	60: [
		"room 7c9e1a2b · 10 events",
		"05:33 pi-agent pipe pipe a1b2c3d4e5f60718a1b2c3d4e5f60718 o…",
		"05:33 pi-agent pipe pipe a1b2c3d4e5f60718a1b2c3d4e5f60718 c…",
		"05:33 1a2b3c4d mbr left the room",
		"05:33 e1d2c3b4 future.event future.event",
		"6 more · ctrl+o to expand · untrusted room content",
	],
	40: [
		"room 7c9e1a2b · 10 events",
		"05:33 pi-agent pipe pipe a1b2c3d4e5f607…",
		"05:33 pi-agent pipe pipe a1b2c3d4e5f607…",
		"05:33 1a2b3c4d mbr left the room",
		"05:33 e1d2c3b4 future.event future.event",
		"6 more · ctrl+o to expand · untrusted r…",
	],
};

export const GOLDEN_TAIL_EXPANDED_80 = [
	"room 7c9e1a2b · 10 events",
	"05:33 sekou room room created",
	"05:33 sekou mbr invited 1a2b3c4d as agent",
	"05:33 pi-agent mbr joined as agent",
	"05:33 sekou msg Please pick up IR-PI-001 — implement the Pi extension and share…",
	"05:33 pi-agent sts state=implementing progress=45% Editing Pi extension tools",
	"05:33 pi-agent file shared report.md (1834 bytes)",
	"05:33 pi-agent pipe pipe a1b2c3d4e5f60718a1b2c3d4e5f60718 opened (preview)",
	"05:33 pi-agent pipe pipe a1b2c3d4e5f60718a1b2c3d4e5f60718 closed (closed)",
	"05:33 1a2b3c4d mbr left the room",
	"05:33 e1d2c3b4 future.event future.event",
	"untrusted room content",
];

export const GOLDEN_ROOM_CARD = {
	80: [
		"iroh-room 7c9e1a2b · health ok",
		" config /work/.iroh-room-pi.json",
		" data dir /work/.iroh-agent",
		" binary /work/fake-iroh-rooms (iroh-rooms 0.1.0)",
		" identity pi-agent (1a2b3c4d…)",
		" ⇄ a1b2c3d4e5f60718a1b2c3d4e5f60718 → 127.0.0.1:3000 (preview)",
	],
	60: [
		"iroh-room 7c9e1a2b · health ok",
		" config /work/.iroh-room-pi.json",
		" data dir /work/.iroh-agent",
		" binary /work/fake-iroh-rooms (iroh-rooms 0.1.0)",
		" identity pi-agent (1a2b3c4d…)",
		" ⇄ a1b2c3d4e5f60718a1b2c3d4e5f60718 → 127.0.0.1:3000 (previ…",
	],
	40: [
		"iroh-room 7c9e1a2b · health ok",
		" config /work/.iroh-room-pi.json",
		" data dir /work/.iroh-agent",
		" binary /work/fake-iroh-rooms (iroh-roo…",
		" identity pi-agent (1a2b3c4d…)",
		" ⇄ a1b2c3d4e5f60718a1b2c3d4e5f60718 → 1…",
	],
};

export const GOLDEN_RECEIPT = {
	80: ["● status posted implementing · event blake3:0badc0de…"],
	60: ["● status posted implementing · event blake3:0badc0de…"],
	40: ["● status posted implementing · event bl…"],
};

export const GOLDEN_STATUS_RESULT_OK = {
	80: ["● status posted · event blake3:0badc0de…"],
	60: ["● status posted · event blake3:0badc0de…"],
	40: ["● status posted · event blake3:0badc0de…"],
};

export const GOLDEN_SEND_RESULT_FAIL = {
	80: [
		"✗ failed (exit 2, invalid_room_id)",
		"room id must look like blake3:<64 hex chars>",
		"next: run `iroh-rooms room members --help`",
	],
	60: [
		"✗ failed (exit 2, invalid_room_id)",
		"room id must look like blake3:<64 hex chars>",
		"next: run `iroh-rooms room members --help`",
	],
	40: [
		"✗ failed (exit 2, invalid_room_id)",
		"room id must look like blake3:<64 hex c…",
		"next: run `iroh-rooms room members --he…",
	],
};

export const GOLDEN_EXPOSE_CALL = {
	80: ["pipe expose 127.0.0.1:3000 → 1 member"],
	60: ["pipe expose 127.0.0.1:3000 → 1 member"],
	40: ["pipe expose 127.0.0.1:3000 → 1 member"],
};

/* ------------------------------------------------------------------ */
/* Room pulse goldens (M1): PulseView inputs + literal expected lines */
/* under the identity styler + naive fit. Regenerate deliberately.    */
/* ------------------------------------------------------------------ */

/** Healthy steady-state pulse view (density 2). */
export const GOLDEN_PULSE_VIEW = {
	label: "7c9e1a2b",
	now: 100_000,
	staleAfterMs: 15_000,
	retryInMs: 4_000,
	pipeCount: 1,
	unclaimedTasks: 2,
	feed: {
		initialized: true,
		lastOkAt: 99_000,
		gap: false,
		latestRow: TAIL_ROWS[9],
		latestStatusRow: TAIL_ROWS[4],
	},
};

/** Degraded pulse view: coded poll failure, retry countdown, stale data. */
export const GOLDEN_PULSE_FAIL_VIEW = {
	label: "7c9e1a2b",
	now: 160_000,
	staleAfterMs: 15_000,
	retryInMs: 40_000,
	pipeCount: 1,
	unclaimedTasks: 2,
	feed: {
		initialized: true,
		lastOkAt: 99_000,
		failure: { kind: "coded", exitCode: 2, errorCode: "invalid_room_id" },
		gap: false,
		latestRow: TAIL_ROWS[3],
		latestStatusRow: TAIL_ROWS[4],
	},
};

/** Stale pulse view: last good data 62s old, no failure recorded. */
export const GOLDEN_PULSE_STALE_VIEW = {
	...GOLDEN_PULSE_VIEW,
	now: 161_000,
	retryInMs: 2_000,
	feed: { ...GOLDEN_PULSE_VIEW.feed },
};

export const GOLDEN_PULSE = {
	80: [
		"●  room 7c9e1a2b  sts implementing 45%  ○ 2 tasks~  ⇄ 1 pipe  ↻ 4s",
		"└ 05:33 e1d2c3b4 future.event future.event",
	],
	60: [
		"●  room 7c9e1a2b  sts implementing 45%  ○ 2 tasks~  ⇄ 1 pip…",
		"└ 05:33 e1d2c3b4 future.event future.event",
	],
	40: [
		"●  room 7c9e1a2b  sts implementing 45% …",
		"└ 05:33 e1d2c3b4 future.event future.ev…",
	],
};

export const GOLDEN_PULSE_FAIL = {
	80: [
		"✗ poll failed (invalid_room_id) · retry 40s  room 7c9e1a2b  sts implementing 45…",
		"└ 05:33 sekou msg Please pick up IR-PI-001 — implement the Pi extension and sha…",
	],
	60: [
		"✗ poll failed (invalid_room_id) · retry 40s  room 7c9e1a2b …",
		"└ 05:33 sekou msg Please pick up IR-PI-001 — implement the …",
	],
	40: [
		"✗ poll failed (invalid_room_id) · retry…",
		"└ 05:33 sekou msg Please pick up IR-PI-…",
	],
};

export const GOLDEN_PULSE_STALE = {
	80: [
		"◌ data 62s old  room 7c9e1a2b  sts implementing 45%  ○ 2 tasks~  ⇄ 1 pipe",
		"└ 05:33 e1d2c3b4 future.event future.event",
	],
	60: [
		"◌ data 62s old  room 7c9e1a2b  sts implementing 45%  ○ 2 ta…",
		"└ 05:33 e1d2c3b4 future.event future.event",
	],
	40: [
		"◌ data 62s old  room 7c9e1a2b  sts impl…",
		"└ 05:33 e1d2c3b4 future.event future.ev…",
	],
};

/* ------------------------------------------------------------------ */
/* room-task grammar conformance corpus (M2, brief §3.5): shared      */
/* hostile inputs run through BOTH the extension detector             */
/* (src/tui/tasks.ts) and the canonical skill script                  */
/* (.pi/skills/iroh-room-agent/scripts/parse-room-task.ts) — the      */
/* conformance test asserts EXACT id-set equality per fixture.        */
/* ------------------------------------------------------------------ */

const fence = "```";

export const TASK_CONFORMANCE_CORPUS = [
	{
		name: "plain valid task",
		text: `hello\n${fence}room-task\nid: IR-PI-001\ntype: implement\ntitle: Add the extension\n${fence}\nbye`,
	},
	{
		name: "missing-type invalid",
		text: `${fence}room-task\nid: IR-PI-002\ntitle: No type here\n${fence}`,
	},
	{
		name: "fence-in-fence quoted (markdown example, never a task)",
		text: `${fence}markdown\n${fence}room-task\nid: QUOTED-1\ntype: implement\ntitle: quoted\n${fence}\nid-after: x\n${fence}\nafter`,
	},
	{
		name: "4-space-indented fence is inert (CommonMark max 3)",
		text: `    ${fence}room-task\n    id: INDENT-1\n    type: implement\n    title: indented\n    ${fence}`,
	},
	{
		name: "foreign 4-backtick wrapping quotes the opener",
		text: `${fence}\`\n${fence}room-task\nid: WRAPPED-1\ntype: implement\ntitle: wrapped\n${fence}\n${fence}\``,
	},
	{
		name: "room-task opener with trailing junk opens a FOREIGN fence",
		text: `${fence}room-task extra\nid: JUNK-1\ntype: implement\ntitle: junk opener\n${fence}\n${fence}room-task\nid: JUNK-2\ntype: implement\ntitle: after junk\n${fence}`,
	},
	{
		name: "unterminated block is ignored",
		text: `${fence}room-task\nid: OPEN-1\ntype: implement\ntitle: never closed`,
	},
	{
		name: "duplicate id keys: last wins",
		text: `${fence}room-task\nid: FIRST-ID\nid: SECOND-ID\ntype: debug\ntitle: dup ids\n${fence}`,
	},
	{
		name: "quoted id: one matching layer stripped",
		text: `${fence}room-task\nid: "QUOTED-ID-1"\ntype: review\ntitle: 'quoted title'\n${fence}`,
	},
	{
		name: "type outside the vocabulary is invalid",
		text: `${fence}room-task\nid: BAD-TYPE-1\ntype: deploy\ntitle: not a vocab type\n${fence}`,
	},
	{
		name: "empty id is invalid; empty quoted id too",
		text: `${fence}room-task\nid:\ntype: test\ntitle: empty id\n${fence}\n${fence}room-task\nid: ""\ntype: test\ntitle: empty quoted id\n${fence}`,
	},
	{
		name: "two valid blocks in one body",
		text: `${fence}room-task\nid: MULTI-1\ntype: implement\ntitle: one\n${fence}\ntext between\n${fence}room-task\nid: MULTI-2\ntype: document\ntitle: two\nacceptance:\n  - works\nbudget:\n  max_usd: 2.00\n${fence}`,
	},
	{
		name: "indented id line belongs to a nested context, not the scalars",
		text: `${fence}room-task\nid: CTX-1\ntype: test\ntitle: ctx\nacceptance:\n  - step\n  id: SHADOW-1\n${fence}`,
	},
	{
		name: "windows line endings",
		text: `${fence}room-task\r\nid: CRLF-1\r\ntype: implement\r\ntitle: crlf\r\n${fence}\r\n`,
	},
];

export const GOLDEN_PILL = {
	healthy: "iroh ● ○2~ ⇄1",
	failing: "iroh ✗ ○2~ ⇄1",
	stale: "iroh ◌ ○2~ ⇄1",
	broken: "iroh ⚙ unconfigured",
};
