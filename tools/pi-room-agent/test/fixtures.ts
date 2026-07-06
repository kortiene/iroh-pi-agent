/**
 * CLI stdout/stderr fixtures matching the exact formats printed by
 * iroh-rooms 0.1.0 (research-cli.md §3 — quoted from the println! sites in
 * crates/iroh-rooms-cli). If the CLI output format changes, update these
 * together with the parsers in src/room-cli.ts.
 */

export const ROOM_ID = `blake3:${'ab'.repeat(32)}`;
export const EVENT_ID = `blake3:${'0f'.repeat(32)}`;
export const EVENT_ID_2 = `blake3:${'2e'.repeat(32)}`;
export const SENDER_ID = 'cd'.repeat(32);
export const MEMBER_ID = 'ef'.repeat(32);
export const FILE_ID = `file_${'12'.repeat(16)}`;
export const PIPE_ID = '34'.repeat(16);
export const INVITE_ID = '78'.repeat(16);
export const BLOB_HASH = `blake3:${'56'.repeat(32)}`;

/** `agent status` — note the alignment padding on `room:` / `from:`. */
export const AGENT_STATUS_STDOUT = `status: ${EVENT_ID}
room:   ${ROOM_ID}
from:   ${SENDER_ID}
stored: yes
delivered: 1 connected peer(s)
`;

/**
 * `room send` — the delivered line has TWO 0-delivered wording variants
 * (message.rs print_send, both observed live): "no other members to reach"
 * (nobody else in the room) and "no peers online" (members exist, none
 * connected). Both are pinned here.
 */
export const ROOM_SEND_STDOUT = `sent: ${EVENT_ID}
room: ${ROOM_ID}
from: ${SENDER_ID}
stored: yes
delivered: 0 (no other members to reach — stored locally only)
`;

export const ROOM_SEND_STDOUT_NO_PEERS_ONLINE = `sent: ${EVENT_ID}
room: ${ROOM_ID}
from: ${SENDER_ID}
stored: yes
delivered: 0 (no peers online — stored locally only)
`;

export const FILE_SHARE_STDOUT = `imported: /work/artifacts/report.md
file_id: ${FILE_ID}
name: report.md
mime: text/markdown
size: 1234 bytes
hash: ${BLOB_HASH}
event: ${EVENT_ID_2}
room: ${ROOM_ID}
provider: you (local)
next: run \`iroh-rooms room tail ${ROOM_ID}\` to serve it, then peers can \`iroh-rooms file fetch ${ROOM_ID} ${FILE_ID}\`
`;

/**
 * `pipe expose` startup block (long-running; this is stdout before serving).
 * The `listening:` line is `<64-hex device id>@<ip:port>[,<[v6]:port>...]` —
 * verified against a live run (e2e-verified-facts.md; render_endpoint_addr).
 */
export const PIPE_EXPOSE_STDOUT = `room: ${ROOM_ID}
target: 127.0.0.1:3000
label: preview
allow: ${MEMBER_ID}
listening: ${SENDER_ID}@192.0.2.7:4433,[2001:db8::7]:4433
tip: share this address with connectors via --peer
pipe_id: ${PIPE_ID}
connectors run: iroh-rooms pipe connect ${ROOM_ID} ${PIPE_ID} --local <PORT>
close it with: iroh-rooms pipe close ${PIPE_ID}
serving the pipe; press Ctrl-C to close it...
`;

/**
 * A syntactically plausible (but fake) roomtkt1 invite ticket, assembled at
 * runtime so secret scanners never see a secret-shaped literal in this file.
 */
export const INVITE_TICKET = ['roomtkt1', 'q', 'fake0'.repeat(12)].join('');

/**
 * `room invite` / `agent invite` — ticket on its own 2-space-indented line
 * under `ticket:`, followed by the secret warning line (verified against the
 * live binary; e2e-verified-facts.md).
 */
export const INVITE_STDOUT = `invite_id: ${INVITE_ID}
room: ${ROOM_ID}
invitee: ${MEMBER_ID}
role: agent
expires: 2026-07-06T03:19:58Z (in 60s)
ticket:
  ${INVITE_TICKET}
warning: this ticket carries a secret — share it over a private channel and treat it like a password.
next: the invitee runs \`iroh-rooms room join <ticket>\`
`;

export const IDENTITY_SHOW_JSON = `{"version":1,"name":"pi-agent","identity_id":"${SENDER_ID}","device_id":"${MEMBER_ID}","created_at_ms":1751700000000}
`;

/**
 * `room tail --offline --json` — a single-line JSON array of TailRow objects
 * with flattened type-specific content fields; one row per event type.
 */
export const TAIL_JSON_STDOUT =
  JSON.stringify([
    {
      event_id: `blake3:${'a1'.repeat(32)}`,
      event_type: 'room.created',
      lamport: 1,
      admin_seq: 1,
      created_at: 1751700000000,
      at: '2026-07-05T08:00:00Z',
      from: 'cdcdcdcd',
      display_name: 'sekou',
      role: 'admin',
      status: 'active',
    },
    {
      event_id: `blake3:${'a2'.repeat(32)}`,
      event_type: 'member.invited',
      lamport: 2,
      at: '2026-07-05T08:01:00Z',
      from: 'cdcdcdcd',
      role: 'admin',
      status: 'active',
      invitee: SENDER_ID,
      invited_role: 'agent',
    },
    {
      event_id: `blake3:${'a3'.repeat(32)}`,
      event_type: 'member.joined',
      lamport: 3,
      at: '2026-07-05T08:02:00Z',
      from: 'efefefef',
      display_name: 'pi-agent',
      role: 'agent',
      status: 'active',
      joined_role: 'agent',
    },
    {
      event_id: `blake3:${'a4'.repeat(32)}`,
      event_type: 'message.text',
      lamport: 4,
      at: '2026-07-05T08:03:00Z',
      from: 'cdcdcdcd',
      display_name: 'sekou',
      role: 'admin',
      status: 'active',
      body: 'please pick up IR-PI-001\n```room-task\nid: IR-PI-001\ntype: implement\ntitle: Add Pi extension\n```',
      format: 'plain',
    },
    {
      event_id: `blake3:${'a5'.repeat(32)}`,
      event_type: 'agent.status',
      lamport: 5,
      at: '2026-07-05T08:04:00Z',
      from: 'efefefef',
      display_name: 'pi-agent',
      role: 'agent',
      status: 'active',
      state: 'running_tests',
      message: 'Running integration tests',
      progress: 40,
      artifacts: [FILE_ID],
    },
    {
      event_id: `blake3:${'a6'.repeat(32)}`,
      event_type: 'file.shared',
      lamport: 6,
      at: '2026-07-05T08:05:00Z',
      from: 'efefefef',
      role: 'agent',
      status: 'active',
      file_name: 'report.md',
      size_bytes: 1234,
      blob_hash: BLOB_HASH,
    },
    {
      event_id: `blake3:${'a7'.repeat(32)}`,
      event_type: 'pipe.opened',
      lamport: 7,
      at: '2026-07-05T08:06:00Z',
      from: 'efefefef',
      role: 'agent',
      status: 'active',
      pipe_id: PIPE_ID,
      label: 'preview',
    },
    {
      event_id: `blake3:${'a8'.repeat(32)}`,
      event_type: 'pipe.closed',
      lamport: 8,
      at: '2026-07-05T08:07:00Z',
      from: 'efefefef',
      role: 'agent',
      status: 'active',
      pipe_id: PIPE_ID,
      reason: 'closed',
    },
  ]) + '\n';

export const CODED_ERROR_STDERR = `error[room_not_found]: no local room state for ${ROOM_ID}
next: run \`iroh-rooms room join <ticket>\`
`;
