import { describe, expect, it } from 'vitest';

import {
  buildAgentStatusArgs,
  buildFileListArgs,
  buildFileShareArgs,
  buildIdentityShowArgs,
  buildPipeCloseArgs,
  buildPipeExposeArgs,
  buildPipeListArgs,
  buildRoomMembersArgs,
  buildRoomSendArgs,
  buildRoomTailArgs,
  CliValidationError,
  parseCodedError,
  parseFileShareOutput,
  parseIdentityShow,
  parsePipeExposeOutput,
  parseSendEventId,
  parseStatusEventId,
  parseTailRows,
  redact,
} from '../src/room-cli.js';
import {
  AGENT_STATUS_STDOUT,
  BLOB_HASH,
  CODED_ERROR_STDERR,
  EVENT_ID,
  EVENT_ID_2,
  FILE_ID,
  FILE_SHARE_STDOUT,
  IDENTITY_SHOW_JSON,
  INVITE_STDOUT,
  INVITE_TICKET,
  MEMBER_ID,
  PIPE_EXPOSE_STDOUT,
  PIPE_ID,
  ROOM_ID,
  ROOM_SEND_STDOUT,
  ROOM_SEND_STDOUT_NO_PEERS_ONLINE,
  SENDER_ID,
  TAIL_JSON_STDOUT,
} from './fixtures.js';

const CTX = {};
const CTX_HOME = { dataDir: '/agent/home' };

describe('argv builders (equals-form options, "--" before positionals)', () => {
  it('agent status: full argv in contract order, --data-dir= prepended', () => {
    const args = buildAgentStatusArgs(CTX_HOME, {
      roomId: ROOM_ID,
      status: 'implementing',
      message: 'Editing handlers',
      progress: 45,
      artifactIds: [FILE_ID, '12'.repeat(16)],
    });
    expect(args).toEqual([
      '--data-dir=/agent/home',
      'agent', 'status',
      '--message=Editing handlers',
      '--progress=45',
      `--artifact=${FILE_ID}`,
      `--artifact=${'12'.repeat(16)}`,
      '--', ROOM_ID, 'implementing',
    ]);
  });

  it('agent status: minimal argv without data dir', () => {
    expect(buildAgentStatusArgs(CTX, { roomId: ROOM_ID, status: 'observing' })).toEqual([
      'agent', 'status', '--', ROOM_ID, 'observing',
    ]);
  });

  it('dash-prefixed untrusted values ride after "--" or in equals form, never as flags', () => {
    // Battery verified against the real binary (review-tmp/argv-check-worker):
    // a bullet-list message, a "--help" status label, a "-x" status message,
    // and a "-dash.md" file name must all stay positional/option-values.
    expect(buildRoomSendArgs(CTX, { roomId: ROOM_ID, message: '- bullet item' })).toEqual([
      'room', 'send', '--', ROOM_ID, '- bullet item',
    ]);
    expect(buildAgentStatusArgs(CTX, { roomId: ROOM_ID, status: '--help', message: '-x' })).toEqual([
      'agent', 'status', '--message=-x', '--', ROOM_ID, '--help',
    ]);
    expect(buildFileShareArgs(CTX, { roomId: ROOM_ID, path: '/w/a.md', name: '-dash.md' })).toEqual([
      'file', 'share', '--name=-dash.md', '--', ROOM_ID, '/w/a.md',
    ]);
  });

  it('rejects a relative --data-dir (the convention requires an absolute path)', () => {
    expect(() => buildIdentityShowArgs({ dataDir: 'relative/home' })).toThrowError(/absolute/);
  });

  it('agent status: validation fails closed', () => {
    const base = { roomId: ROOM_ID, status: 'ok' };
    expect(() => buildAgentStatusArgs(CTX, { roomId: 'nope', status: 'ok' })).toThrowError(CliValidationError);
    expect(() => buildAgentStatusArgs(CTX, { roomId: ROOM_ID, status: '' })).toThrowError(/non-empty/);
    expect(() => buildAgentStatusArgs(CTX, { roomId: ROOM_ID, status: '   ' })).toThrowError(/non-empty/);
    expect(() => buildAgentStatusArgs(CTX, { roomId: ROOM_ID, status: 'a'.repeat(65) })).toThrowError(/64 bytes/);
    // 33 two-byte chars = 66 bytes but only 33 chars: byte limit, not char limit
    expect(() => buildAgentStatusArgs(CTX, { roomId: ROOM_ID, status: 'é'.repeat(33) })).toThrowError(/64 bytes/);
    expect(() => buildAgentStatusArgs(CTX, { roomId: ROOM_ID, status: 'a\nb' })).toThrowError(/control characters/);
    expect(() => buildAgentStatusArgs(CTX, { ...base, message: 'x'.repeat(4097) })).toThrowError(/4096 bytes/);
    expect(() => buildAgentStatusArgs(CTX, { ...base, progress: 45.5 })).toThrowError(/integer 0\.\.=100/);
    expect(() => buildAgentStatusArgs(CTX, { ...base, progress: -1 })).toThrowError(/integer 0\.\.=100/);
    expect(() => buildAgentStatusArgs(CTX, { ...base, progress: 101 })).toThrowError(/integer 0\.\.=100/);
    expect(() => buildAgentStatusArgs(CTX, { ...base, artifactIds: Array(17).fill(FILE_ID) })).toThrowError(/16/);
    expect(() => buildAgentStatusArgs(CTX, { ...base, artifactIds: ['file_zz'] })).toThrowError(/artifact id/);
    // boundary values pass
    expect(() => buildAgentStatusArgs(CTX, { ...base, status: 'a'.repeat(64), progress: 0 })).not.toThrow();
    expect(() => buildAgentStatusArgs(CTX, { ...base, progress: 100, message: 'x'.repeat(4096) })).not.toThrow();
  });

  it('room send: argv + body byte limits', () => {
    expect(buildRoomSendArgs(CTX_HOME, { roomId: ROOM_ID, message: 'hello' })).toEqual([
      '--data-dir=/agent/home', 'room', 'send', '--', ROOM_ID, 'hello',
    ]);
    expect(() => buildRoomSendArgs(CTX, { roomId: ROOM_ID, message: '' })).toThrowError(/1\.\.=16384/);
    expect(() => buildRoomSendArgs(CTX, { roomId: ROOM_ID, message: 'x'.repeat(16385) })).toThrowError(/16384/);
    expect(() => buildRoomSendArgs(CTX, { roomId: ROOM_ID, message: 'x'.repeat(16384) })).not.toThrow();
  });

  it('room tail: offline json with clamped limit', () => {
    expect(buildRoomTailArgs(CTX, { roomId: ROOM_ID })).toEqual([
      'room', 'tail', '--offline', '--json', '--limit=50', '--', ROOM_ID,
    ]);
    expect(buildRoomTailArgs(CTX, { roomId: ROOM_ID, limit: 1000 })).toContain('--limit=500');
    expect(buildRoomTailArgs(CTX, { roomId: ROOM_ID, limit: 0 })).toContain('--limit=1');
    expect(() => buildRoomTailArgs(CTX, { roomId: ROOM_ID, limit: 2.5 })).toThrowError(/integer/);
  });

  it('file share: absolute path + optional name/mime', () => {
    expect(
      buildFileShareArgs(CTX_HOME, { roomId: ROOM_ID, path: '/w/report.md', name: 'r.md', mime: 'text/markdown' }),
    ).toEqual([
      '--data-dir=/agent/home',
      'file', 'share', '--name=r.md', '--mime=text/markdown', '--', ROOM_ID, '/w/report.md',
    ]);
    expect(() => buildFileShareArgs(CTX, { roomId: ROOM_ID, path: 'relative.md' })).toThrowError(/absolute/);
    expect(() => buildFileShareArgs(CTX, { roomId: ROOM_ID, path: '/w/a', name: 'x'.repeat(256) })).toThrowError(/255/);
    expect(() => buildFileShareArgs(CTX, { roomId: ROOM_ID, path: '/w/a', mime: '' })).toThrowError(/255/);
  });

  it('pipe expose: full argv in contract order', () => {
    expect(
      buildPipeExposeArgs(CTX_HOME, {
        roomId: ROOM_ID,
        tcp: '127.0.0.1:3000',
        allow: [MEMBER_ID, SENDER_ID],
        label: 'preview',
        ttlSeconds: 3600,
      }),
    ).toEqual([
      '--data-dir=/agent/home',
      'pipe', 'expose',
      '--tcp=127.0.0.1:3000',
      `--allow=${MEMBER_ID}`,
      `--allow=${SENDER_ID}`,
      '--label=preview',
      '--expires=3600s',
      '--', ROOM_ID,
    ]);
  });

  it('pipe expose: refuses every non-loopback target with a reason', () => {
    for (const tcp of [
      '0.0.0.0:3000',
      '[::1]:3000',
      '::1:3000',
      'localhost:3000',
      '192.168.1.20:3000',
      '10.0.0.1:80',
      '127.0.0.2:3000', // stricter than the binary: only 127.0.0.1 exactly
      'example.com:3000',
      '/tmp/socket.sock',
      '127.0.0.1', // missing port
    ]) {
      expect(() => buildPipeExposeArgs(CTX, { roomId: ROOM_ID, tcp, allow: [MEMBER_ID] }), tcp).toThrowError(
        /only 127\.0\.0\.1:<port>/,
      );
    }
  });

  it('pipe expose: refuses invalid ports, empty allow, bad ids, bad ttl', () => {
    expect(() => buildPipeExposeArgs(CTX, { roomId: ROOM_ID, tcp: '127.0.0.1:0', allow: [MEMBER_ID] })).toThrowError(/port/);
    expect(() => buildPipeExposeArgs(CTX, { roomId: ROOM_ID, tcp: '127.0.0.1:65536', allow: [MEMBER_ID] })).toThrowError(/port/);
    expect(() => buildPipeExposeArgs(CTX, { roomId: ROOM_ID, tcp: '127.0.0.1:3000', allow: [] })).toThrowError(/non-empty allow/);
    expect(() => buildPipeExposeArgs(CTX, { roomId: ROOM_ID, tcp: '127.0.0.1:3000', allow: ['short'] })).toThrowError(/64-char/);
    expect(() =>
      buildPipeExposeArgs(CTX, { roomId: ROOM_ID, tcp: '127.0.0.1:3000', allow: [MEMBER_ID], ttlSeconds: 0 }),
    ).toThrowError(/positive integer/);
    expect(() =>
      buildPipeExposeArgs(CTX, { roomId: ROOM_ID, tcp: '127.0.0.1:3000', allow: [MEMBER_ID], ttlSeconds: 1.5 }),
    ).toThrowError(/positive integer/);
    // boundary port values pass
    expect(() => buildPipeExposeArgs(CTX, { roomId: ROOM_ID, tcp: '127.0.0.1:1', allow: [MEMBER_ID] })).not.toThrow();
    expect(() => buildPipeExposeArgs(CTX, { roomId: ROOM_ID, tcp: '127.0.0.1:65535', allow: [MEMBER_ID] })).not.toThrow();
  });

  it('pipe close / lists / identity argv', () => {
    expect(buildPipeCloseArgs(CTX, { pipeId: PIPE_ID })).toEqual(['pipe', 'close', '--', PIPE_ID]);
    expect(() => buildPipeCloseArgs(CTX, { pipeId: 'xyz' })).toThrowError(/32 lowercase hex/);
    expect(buildRoomMembersArgs(CTX, { roomId: ROOM_ID })).toEqual(['room', 'members', '--json', '--', ROOM_ID]);
    expect(buildFileListArgs(CTX, { roomId: ROOM_ID })).toEqual(['file', 'list', '--json', '--', ROOM_ID]);
    expect(buildPipeListArgs(CTX, { roomId: ROOM_ID })).toEqual(['pipe', 'list', '--', ROOM_ID]);
    expect(buildIdentityShowArgs(CTX_HOME)).toEqual(['--data-dir=/agent/home', 'identity', 'show', '--json']);
  });
});

describe('stdout parsers (verbatim CLI fixtures)', () => {
  it('parses the event id from agent status output (with alignment padding)', () => {
    expect(parseStatusEventId(AGENT_STATUS_STDOUT)).toBe(EVENT_ID);
    expect(parseStatusEventId('unrelated')).toBeUndefined();
  });

  it('parses the event id from room send output (both delivered wording variants)', () => {
    expect(parseSendEventId(ROOM_SEND_STDOUT)).toBe(EVENT_ID);
    expect(parseSendEventId(ROOM_SEND_STDOUT_NO_PEERS_ONLINE)).toBe(EVENT_ID);
    expect(parseSendEventId(AGENT_STATUS_STDOUT)).toBeUndefined();
  });

  it('parses file_id and event id from file share output', () => {
    expect(parseFileShareOutput(FILE_SHARE_STDOUT)).toEqual({ fileId: FILE_ID, eventId: EVENT_ID_2 });
    expect(parseFileShareOutput('nope')).toEqual({});
  });

  it('parses pipe_id and connect hint from pipe expose startup output', () => {
    const parsed = parsePipeExposeOutput(PIPE_EXPOSE_STDOUT);
    expect(parsed.pipeId).toBe(PIPE_ID);
    expect(parsed.connectHint).toBe(`iroh-rooms pipe connect ${ROOM_ID} ${PIPE_ID} --local <PORT>`);
    expect(parsePipeExposeOutput('room: x\n')).toEqual({});
  });

  it('parses the tail JSON array, one row per event type', () => {
    const rows = parseTailRows(TAIL_JSON_STDOUT);
    expect(rows).toHaveLength(8);
    expect(rows.map((row) => row.event_type)).toEqual([
      'room.created',
      'member.invited',
      'member.joined',
      'message.text',
      'agent.status',
      'file.shared',
      'pipe.opened',
      'pipe.closed',
    ]);
    // flattened type-specific fields pass through verbatim
    const message = rows[3]!;
    expect(message['body']).toContain('```room-task');
    expect(message['format']).toBe('plain');
    const status = rows[4]!;
    expect(status['state']).toBe('running_tests');
    expect(status['progress']).toBe(40);
    expect(status['artifacts']).toEqual([FILE_ID]);
    const file = rows[5]!;
    expect(file['file_name']).toBe('report.md');
    expect(file['size_bytes']).toBe(1234);
    expect(file['blob_hash']).toBe(BLOB_HASH);
    expect(rows[6]!['pipe_id']).toBe(PIPE_ID);
    expect(rows[7]!['reason']).toBe('closed');
  });

  it('tolerates unknown event types and missing fields; skips rows without event_id', () => {
    const rows = parseTailRows(
      JSON.stringify([
        { event_id: `blake3:${'9'.repeat(64)}`, event_type: 'shiny.future', wat: true },
        { event_id: `blake3:${'8'.repeat(64)}` }, // no event_type
        { event_type: 'message.text', body: 'no id' }, // no event_id → skipped
        'not-an-object',
        null,
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.event_type).toBe('shiny.future');
    expect(rows[0]!['wat']).toBe(true);
    expect(rows[1]!.event_type).toBe('unknown');
  });

  it('treats empty output as an empty array and rejects corrupt output', () => {
    expect(parseTailRows('')).toEqual([]);
    expect(parseTailRows('[]\n')).toEqual([]);
    expect(() => parseTailRows('garbage')).toThrowError(/not valid JSON/);
    expect(() => parseTailRows('{"a":1}')).toThrowError(/not a JSON array/);
  });

  it('parses coded errors from stderr', () => {
    expect(parseCodedError(CODED_ERROR_STDERR)).toEqual({
      code: 'room_not_found',
      detail: `no local room state for ${ROOM_ID}`,
    });
    expect(parseCodedError('error: something uncoded')).toBeUndefined();
    expect(parseCodedError('')).toBeUndefined();
  });

  it('parses identity show --json', () => {
    expect(parseIdentityShow(IDENTITY_SHOW_JSON)).toEqual({
      name: 'pi-agent',
      identityId: SENDER_ID,
      deviceId: MEMBER_ID,
    });
    expect(parseIdentityShow('not json')).toBeUndefined();
    expect(parseIdentityShow('[1,2]')).toBeUndefined();
  });
});

describe('redact', () => {
  it('redacts private keys, cloud tokens, and key=value secrets', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----';
    expect(redact(pem)).toBe('[REDACTED]');
    expect(redact('key AKIAIOSFODNN7EXAMPLE ok')).toBe('key [REDACTED] ok');
    expect(redact(`ghp_${'a1B2'.repeat(9)}`)).toBe('[REDACTED]');
    expect(redact(`github_pat_${'a1B2'.repeat(9)}`)).toBe('[REDACTED]');
    expect(redact('xoxb-1234567890-abcdef')).toBe('[REDACTED]');
    expect(redact(`sk-${'proj4bcd'.repeat(4)}`)).toBe('[REDACTED]');
    // Assembled at runtime so secret scanners (gitleaks) do not flag this
    // file for containing literal secret-shaped strings.
    const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcDEF123ghiJKL456'].join('.');
    expect(redact(`Bearer ${fakeJwt}`)).toBe('Bearer [REDACTED]');
    const redactableValue = ['abcdefgh', '12345678'].join('');
    expect(redact(['api_key', redactableValue].join('='))).toBe('api_key=[REDACTED]');
    expect(redact('PASSWORD: hunter22222222')).toBe('PASSWORD: [REDACTED]');
    expect(redact('token = deadbeefcafe99')).toBe('token = [REDACTED]');
  });

  it('redacts prefixed FOO_TOKEN/FOO_SECRET-style keys (same pattern as the extension)', () => {
    const value = ['abcdefgh', '12345678'].join('');
    expect(redact(`GITHUB_TOKEN=${value}`)).toBe('GITHUB_TOKEN=[REDACTED]');
    expect(redact(`NPM_TOKEN: ${value}`)).toBe('NPM_TOKEN: [REDACTED]');
    expect(redact(`MY_API_SECRET=${value}`)).toBe('MY_API_SECRET=[REDACTED]');
    expect(redact(`my-api-key=${value}`)).toBe('my-api-key=[REDACTED]');
    expect(redact(`"authToken": "${value}"`)).toBe('"authToken": "[REDACTED]"');
  });

  it('never redacts the protocol public currency', () => {
    const protocolText = [
      `room_id: ${ROOM_ID}`,
      `event: ${EVENT_ID}`,
      `identity_id: ${SENDER_ID}`,
      `file_id: ${FILE_ID}`,
      `pipe_id: ${PIPE_ID}`,
      'ticket:',
      '  roomtkt1qxyzabcdefghijklmnopqrstuvw0123456789',
    ].join('\n');
    expect(redact(protocolText)).toBe(protocolText);
  });

  it('passes ordinary CLI output through untouched', () => {
    expect(redact(AGENT_STATUS_STDOUT)).toBe(AGENT_STATUS_STDOUT);
    expect(redact(FILE_SHARE_STDOUT)).toBe(FILE_SHARE_STDOUT);
    expect(redact(PIPE_EXPOSE_STDOUT)).toBe(PIPE_EXPOSE_STDOUT);
  });

  it('passes real invite output (ticket + secret warning line) through untouched', () => {
    // The roomtkt1 ticket is protocol currency; the "carries a secret" warning
    // line must also survive redaction verbatim.
    expect(redact(INVITE_STDOUT)).toBe(INVITE_STDOUT);
    expect(INVITE_STDOUT).toContain('warning: this ticket carries a secret');
    expect(INVITE_STDOUT).toContain(`\n  ${INVITE_TICKET}\n`);
  });
});
