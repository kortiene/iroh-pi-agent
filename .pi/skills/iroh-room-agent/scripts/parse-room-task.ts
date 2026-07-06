#!/usr/bin/env node
/**
 * parse-room-task.ts — extract and validate ```room-task fenced blocks.
 *
 * Standalone erasable TypeScript: runs directly with `node` on Node >= 22.18
 * (native type stripping). Zero imports beyond `node:` builtins. No enums,
 * namespaces, decorators, or parameter properties.
 *
 * GRAMMAR PARITY: the parsing rules below are a line-for-line port of the
 * worker's canonical parser (tools/pi-room-agent/src/task-parser.ts) so the
 * interactive/skill path and the headless worker always agree on which tasks
 * exist. A conformance test (tools/pi-room-agent/test/parser-conformance.
 * test.ts) runs both parsers over a shared corpus and diffs the results —
 * if you change the grammar here, change the worker parser too (and vice
 * versa) or that test will fail.
 *
 * Usage:
 *   node parse-room-task.ts <file>
 *   cat message.md | node parse-room-task.ts
 *
 * Reads Markdown/plain text (typically a room message body), extracts every
 * ```room-task fenced block, and parses this YAML-subset grammar:
 *
 *   id: IR-PI-001                 # flat `key: value` scalars
 *   type: implement               # implement | debug | review | document | test
 *   title: Add Pi extension for iroh-room
 *   repo: kortiene/iroh-room
 *   branch: agent/ir-pi-001
 *   goal: Implement the project-local Pi extension.
 *   acceptance:                   # string list with `- ` items
 *     - /room works
 *   budget:                       # one nested map with numeric values
 *     max_usd: 2.00
 *     max_minutes: 30
 *
 * Prints JSON { tasks: [...], errors: [...] } to stdout — exactly the worker
 * parser's output shape. Room content is untrusted input: the parser never
 * throws; malformed blocks are reported in `errors` and skipped. A
 * ```room-task opener quoted inside another code fence (``` or ````…) is
 * NOT a task.
 *
 * Exit codes:
 *   0  at least one valid task and no errors
 *   1  no tasks found, or any parse/validation error (fail closed)
 *   2  usage or I/O error
 */

import { readFileSync } from 'node:fs';

const ROOM_TASK_TYPES = ['implement', 'debug', 'review', 'document', 'test'] as const;
type RoomTaskType = (typeof ROOM_TASK_TYPES)[number];

interface RoomTaskBudget {
  maxUsd?: number;
  maxMinutes?: number;
}

interface RoomTask {
  id: string;
  type: RoomTaskType;
  title: string;
  repo?: string;
  branch?: string;
  goal?: string;
  acceptance: string[];
  budget?: RoomTaskBudget;
  /** Unknown keys pass through here (forward compatibility). */
  extra: Record<string, string>;
}

interface ParsedRoomTasks {
  tasks: RoomTask[];
  errors: string[];
}

/*
 * Fence rules follow CommonMark: fences may be indented at most 3 spaces.
 * A room-task block opens with EXACTLY three backticks. Any other 3+-backtick
 * fence line opens a "foreign" fence (```js, ```markdown, ````…), and
 * everything inside it — including ```room-task openers — is quoted content,
 * not a claimable task. A foreign fence closes on a backtick-only line with at
 * least as many backticks as its opener.
 */
const FENCE_OPEN = /^ {0,3}```room-task\s*$/;
const FENCE_CLOSE = /^ {0,3}```\s*$/;
const FOREIGN_FENCE_OPEN = /^ {0,3}(`{3,})/;
const FOREIGN_FENCE_CLOSE = /^ {0,3}(`{3,})\s*$/;
/** `key: value` (value optional). Key charset excludes ':' so values may contain colons. */
const KEY_VALUE = /^([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/;
const LIST_ITEM = /^\s+-\s*(.*)$/;
const NESTED_KEY = /^\s{2,}([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/;

const KNOWN_SCALAR_KEYS = new Set(['id', 'type', 'title', 'repo', 'branch', 'goal']);

function isRoomTaskType(value: string): value is RoomTaskType {
  return (ROOM_TASK_TYPES as readonly string[]).includes(value);
}

/** Strip one layer of matching surrounding single or double quotes. */
function stripInlineQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

interface RawBlock {
  /** 1-indexed line number of the opening fence, for error messages. */
  startLine: number;
  lines: string[];
}

/**
 * Extract the contents of every properly fenced room-task block, tracking
 * enclosing foreign fences so a quoted example (a ```room-task opener inside
 * a ```markdown or ````… fence) is never treated as a real task.
 */
function extractBlocks(text: string, errors: string[]): RawBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;
  /** Backtick count of the open foreign fence, or null when outside one. */
  let foreignFenceLen: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (current === null) {
      if (foreignFenceLen !== null) {
        const close = FOREIGN_FENCE_CLOSE.exec(line);
        if (close !== null && (close[1] as string).length >= foreignFenceLen) {
          foreignFenceLen = null;
        }
        continue; // quoted content, including any ```room-task opener
      }
      if (FENCE_OPEN.test(line)) {
        current = { startLine: i + 1, lines: [] };
        continue;
      }
      const foreign = FOREIGN_FENCE_OPEN.exec(line);
      if (foreign !== null) {
        foreignFenceLen = (foreign[1] as string).length;
      }
      continue;
    }
    if (FENCE_CLOSE.test(line)) {
      blocks.push(current);
      current = null;
      continue;
    }
    current.lines.push(line);
  }
  if (current !== null) {
    errors.push(
      `room-task block opened at line ${current.startLine} has no closing \`\`\` fence; block ignored`,
    );
  }
  return blocks;
}

function parseBudgetNumber(
  where: string,
  key: string,
  raw: string,
  errors: string[],
): number | undefined {
  const value = stripInlineQuotes(raw.trim());
  if (value === '' || !/^-?\d+(\.\d+)?$/.test(value)) {
    errors.push(`${where}: budget.${key} is not a number (got "${raw.trim()}")`);
    return undefined;
  }
  const parsed = Number(value);
  if (parsed < 0) {
    errors.push(`${where}: budget.${key} must not be negative (got ${parsed})`);
    return undefined;
  }
  return parsed;
}

/** Parse one fenced block; returns null (with errors recorded) when invalid. */
function parseBlock(block: RawBlock, errors: string[]): RoomTask | null {
  const where = `room-task block at line ${block.startLine}`;
  const scalars: Record<string, string> = {};
  const extra: Record<string, string> = {};
  const acceptance: string[] = [];
  const budgetRaw: Record<string, string> = {};
  let sawBudget = false;
  // Active indented context: which top-level key the next indented lines belong to.
  let context: 'acceptance' | 'budget' | null = null;

  for (const line of block.lines) {
    if (line.trim() === '') {
      continue;
    }
    if (!/^\s/.test(line)) {
      // Top-level line: must be `key: value` (or `key:` opening a nested section).
      context = null;
      const match = KEY_VALUE.exec(line);
      if (match === null) {
        errors.push(`${where}: unrecognized line "${line.trim()}"`);
        continue;
      }
      const key = match[1] as string;
      const rawValue = (match[2] as string).trim();
      if (key === 'acceptance') {
        if (rawValue !== '') {
          errors.push(`${where}: acceptance must be a list of "- " items, not an inline value`);
          continue;
        }
        context = 'acceptance';
      } else if (key === 'budget') {
        if (rawValue !== '') {
          errors.push(`${where}: budget must be a nested map (max_usd / max_minutes)`);
          continue;
        }
        context = 'budget';
        sawBudget = true;
      } else if (KNOWN_SCALAR_KEYS.has(key)) {
        scalars[key] = stripInlineQuotes(rawValue);
      } else {
        extra[key] = stripInlineQuotes(rawValue);
      }
      continue;
    }
    // Indented line: belongs to the active list/map context.
    if (context === 'acceptance') {
      const item = LIST_ITEM.exec(line);
      if (item === null) {
        errors.push(`${where}: expected a "- " acceptance item, got "${line.trim()}"`);
        continue;
      }
      acceptance.push(stripInlineQuotes((item[1] as string).trim()));
      continue;
    }
    if (context === 'budget') {
      const nested = NESTED_KEY.exec(line);
      if (nested === null) {
        errors.push(`${where}: expected a "key: value" budget entry, got "${line.trim()}"`);
        continue;
      }
      budgetRaw[nested[1] as string] = nested[2] as string;
      continue;
    }
    errors.push(`${where}: indented line outside a list or map context: "${line.trim()}"`);
  }

  // Required fields: id, type, title. A missing/invalid one invalidates the task.
  let valid = true;
  for (const required of ['id', 'type', 'title'] as const) {
    const value = scalars[required];
    if (value === undefined || value === '') {
      errors.push(`${where}: missing required field "${required}"`);
      valid = false;
    }
  }
  const typeValue = scalars['type'];
  if (typeValue !== undefined && typeValue !== '' && !isRoomTaskType(typeValue)) {
    errors.push(
      `${where}: invalid type "${typeValue}" (expected one of ${ROOM_TASK_TYPES.join(' | ')})`,
    );
    valid = false;
  }
  if (!valid) {
    return null;
  }

  const task: RoomTask = {
    id: scalars['id'] as string,
    type: typeValue as RoomTaskType,
    title: scalars['title'] as string,
    acceptance,
    extra,
  };
  if (scalars['repo'] !== undefined) task.repo = scalars['repo'];
  if (scalars['branch'] !== undefined) task.branch = scalars['branch'];
  if (scalars['goal'] !== undefined) task.goal = scalars['goal'];

  // Budget is optional; a malformed numeric field drops that field (with an
  // error recorded) rather than dropping the whole task.
  if (sawBudget) {
    const budget: RoomTaskBudget = {};
    for (const [key, raw] of Object.entries(budgetRaw)) {
      if (key === 'max_usd') {
        const parsed = parseBudgetNumber(where, key, raw, errors);
        if (parsed !== undefined) budget.maxUsd = parsed;
      } else if (key === 'max_minutes') {
        const parsed = parseBudgetNumber(where, key, raw, errors);
        if (parsed !== undefined) budget.maxMinutes = parsed;
      } else {
        // Unknown budget keys pass through as namespaced extras.
        extra[`budget.${key}`] = stripInlineQuotes(raw.trim());
      }
    }
    task.budget = budget;
  }
  return task;
}

/**
 * Extract and parse every ```room-task block from a message body.
 * Never throws. Text without any room-task fence yields { tasks: [], errors: [] }.
 */
function parseRoomTasks(text: string): ParsedRoomTasks {
  const errors: string[] = [];
  const tasks: RoomTask[] = [];
  for (const block of extractBlocks(text, errors)) {
    const task = parseBlock(block, errors);
    if (task !== null) {
      tasks.push(task);
    }
  }
  return { tasks, errors };
}

function usage(): string {
  return [
    'usage: node parse-room-task.ts <file>',
    '       cat message.md | node parse-room-task.ts',
    '',
    'Extracts ```room-task fenced blocks and prints JSON { tasks, errors } to stdout.',
    'Exit codes: 0 = valid task(s) and no errors; 1 = none found or parse errors; 2 = usage/I-O error.',
  ].join('\n');
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  let text = '';
  if (args.length === 0) {
    if (process.stdin.isTTY) {
      process.stderr.write(`${usage()}\n`);
      return 2;
    }
    text = readFileSync(0, 'utf8');
  } else if (args.length === 1) {
    try {
      text = readFileSync(args[0] ?? '', 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`error: cannot read ${JSON.stringify(args[0])}: ${detail}\n`);
      return 2;
    }
  } else {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  const result = parseRoomTasks(text);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // Fail closed: no valid task, or any error at all, exits nonzero.
  return result.tasks.length > 0 && result.errors.length === 0 ? 0 : 1;
}

process.exit(main());
