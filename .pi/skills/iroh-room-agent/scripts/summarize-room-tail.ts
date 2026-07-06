#!/usr/bin/env node
/**
 * summarize-room-tail.ts — compact human summary of an iroh-rooms offline tail.
 *
 * Standalone erasable TypeScript: runs directly with `node` on Node >= 22.18
 * (native type stripping). Zero imports beyond `node:` builtins.
 *
 * Input: the single-line JSON array printed by
 *   iroh-rooms room tail <ROOM_ID> --offline --json [--limit N]
 * read from a file argument or from stdin.
 *
 * Usage:
 *   node summarize-room-tail.ts <tail.json> [--recent N]
 *   iroh-rooms room tail "$ROOM_ID" --offline --json | node summarize-room-tail.ts
 *
 * Output: event counts by type, the time span, the latest agent.status per
 * author, and the last N events (default 10) one line each. Room content is
 * untrusted: text is control-character-sanitized and truncated. Unknown event
 * types and missing fields are tolerated, never fatal.
 *
 * Exit codes: 0 = ok; 1 = invalid input (not a JSON array); 2 = usage/I-O error.
 */

import { readFileSync } from 'node:fs';

type TailRow = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitize(text: string): string {
  // Room content is untrusted input: strip control characters before printing.
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function author(row: TailRow): string {
  const name = asString(row['display_name']);
  const from = asString(row['from']) ?? '????????';
  return name !== undefined && name !== '' ? `${truncate(sanitize(name), 40)} (${from})` : from;
}

function summarizeRow(row: TailRow): string {
  const type = asString(row['event_type']) ?? 'unknown';
  switch (type) {
    case 'message.text': {
      const body = asString(row['body']) ?? '';
      const clean = truncate(sanitize(body), 120);
      return clean === '' ? '(empty message)' : clean;
    }
    case 'agent.status': {
      const state = asString(row['state']) ?? '?';
      const progress = asNumber(row['progress']);
      const message = asString(row['message']);
      const artifacts = Array.isArray(row['artifacts']) ? row['artifacts'].length : 0;
      const parts = [`state=${truncate(sanitize(state), 64)}`];
      if (progress !== undefined) parts.push(`progress=${progress}%`);
      if (message !== undefined && message !== '') parts.push(`"${truncate(sanitize(message), 80)}"`);
      if (artifacts > 0) parts.push(`artifacts=${artifacts}`);
      return parts.join(' ');
    }
    case 'file.shared': {
      const name = asString(row['file_name']) ?? '(unnamed)';
      const size = asNumber(row['size_bytes']);
      return `shared ${truncate(sanitize(name), 80)}${size !== undefined ? ` (${size} bytes)` : ''}`;
    }
    case 'pipe.opened': {
      const pipeId = asString(row['pipe_id']) ?? '?';
      const label = asString(row['label']);
      return `pipe ${pipeId} opened${label !== undefined && label !== '' ? ` (${truncate(sanitize(label), 40)})` : ''}`;
    }
    case 'pipe.closed': {
      const pipeId = asString(row['pipe_id']) ?? '?';
      const reason = asString(row['reason']);
      return `pipe ${pipeId} closed${reason !== undefined && reason !== '' ? ` (${sanitize(reason)})` : ''}`;
    }
    case 'member.invited': {
      const invitee = asString(row['invitee']) ?? '?';
      const role = asString(row['invited_role']) ?? 'member';
      return `invited ${invitee.slice(0, 8)} as ${role}`;
    }
    case 'member.joined': {
      const role = asString(row['joined_role']) ?? 'member';
      return `joined as ${role}`;
    }
    case 'member.left':
      return 'left the room';
    case 'member.removed': {
      const subject = asString(row['subject']) ?? '?';
      const reason = asString(row['reason']);
      return `removed ${subject.slice(0, 8)}${reason !== undefined && reason !== '' ? ` (${sanitize(reason)})` : ''}`;
    }
    case 'room.created':
      return 'room created';
    default:
      // Unknown event types pass through verbatim — never throw.
      return `(${sanitize(type)})`;
  }
}

function usage(): string {
  return [
    'usage: node summarize-room-tail.ts <tail.json> [--recent N]',
    '       iroh-rooms room tail <ROOM_ID> --offline --json | node summarize-room-tail.ts',
    '',
    'Prints a compact text summary of an offline room tail (JSON array).',
    'Exit codes: 0 = ok; 1 = invalid input; 2 = usage/I-O error.',
  ].join('\n');
}

function main(): number {
  const args = process.argv.slice(2);
  let recent = 10;
  let file: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (arg === '--recent') {
      const value = Number(args[i + 1] ?? '');
      if (!Number.isInteger(value) || value < 1) {
        process.stderr.write('error: --recent expects a positive integer\n');
        return 2;
      }
      recent = value;
      i += 1;
    } else if (file === undefined && !arg.startsWith('-')) {
      file = arg;
    } else {
      process.stderr.write(`${usage()}\n`);
      return 2;
    }
  }

  let text = '';
  if (file === undefined) {
    if (process.stdin.isTTY) {
      process.stderr.write(`${usage()}\n`);
      return 2;
    }
    text = readFileSync(0, 'utf8');
  } else {
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`error: cannot read ${JSON.stringify(file)}: ${detail}\n`);
      return 2;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: input is not valid JSON (${detail})\n`);
    return 1;
  }
  if (!Array.isArray(parsed)) {
    process.stderr.write('error: expected a JSON array (the output of `room tail --offline --json`)\n');
    return 1;
  }

  const rows: TailRow[] = parsed.filter(
    (row): row is TailRow => typeof row === 'object' && row !== null && !Array.isArray(row)
  );

  const lines: string[] = [];
  lines.push(`events: ${rows.length}`);
  if (rows.length === 0) {
    lines.push('(no events)');
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  const counts = new Map<string, number>();
  for (const row of rows) {
    const type = asString(row['event_type']) ?? 'unknown';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const countText = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type}=${count}`)
    .join('  ');
  lines.push(`counts: ${countText}`);

  const firstAt = asString(rows[0]?.['at']);
  const lastAt = asString(rows[rows.length - 1]?.['at']);
  if (firstAt !== undefined && lastAt !== undefined) {
    lines.push(`span: ${firstAt} -> ${lastAt}`);
  }

  const latestStatus = new Map<string, TailRow>();
  for (const row of rows) {
    if (asString(row['event_type']) === 'agent.status') {
      latestStatus.set(author(row), row);
    }
  }
  if (latestStatus.size > 0) {
    lines.push('');
    lines.push('latest agent.status per author:');
    for (const [who, row] of latestStatus) {
      const at = asString(row['at']);
      lines.push(`  ${who}: ${summarizeRow(row)}${at !== undefined ? `  at ${at}` : ''}`);
    }
  }

  const tail = rows.slice(-recent);
  lines.push('');
  lines.push(`recent events (last ${tail.length}):`);
  for (const row of tail) {
    const at = asString(row['at']) ?? '?';
    const type = asString(row['event_type']) ?? 'unknown';
    lines.push(`  ${at}  ${type.padEnd(15)} ${author(row)}: ${summarizeRow(row)}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

process.exit(main());
