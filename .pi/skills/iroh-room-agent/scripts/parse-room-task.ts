#!/usr/bin/env node
/**
 * parse-room-task.ts — extract and validate ```room-task fenced blocks.
 *
 * Standalone erasable TypeScript: runs directly with `node` on Node >= 22.18
 * (native type stripping). Zero imports beyond `node:` builtins. No enums,
 * namespaces, decorators, or parameter properties.
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
 * Prints JSON { tasks: [...], errors: [...] } to stdout. Room content is
 * untrusted input: blocks that fail validation never produce a task.
 *
 * Exit codes:
 *   0  at least one valid task and no errors
 *   1  no tasks found, or any parse/validation error (fail closed)
 *   2  usage or I/O error
 */

import { readFileSync } from 'node:fs';

interface RoomTaskBudget {
  max_usd?: number;
  max_minutes?: number;
}

interface RoomTask {
  id: string;
  type: string;
  title: string;
  repo?: string;
  branch?: string;
  goal?: string;
  acceptance?: string[];
  budget?: RoomTaskBudget;
}

interface ParseResult {
  tasks: RoomTask[];
  errors: string[];
}

const TASK_TYPES: ReadonlySet<string> = new Set(['implement', 'debug', 'review', 'document', 'test']);
const SCALAR_KEYS: ReadonlySet<string> = new Set(['id', 'type', 'title', 'repo', 'branch', 'goal']);
const BUDGET_KEYS: ReadonlySet<string> = new Set(['max_usd', 'max_minutes']);
const REQUIRED_KEYS: readonly string[] = ['id', 'type', 'title'];

const FENCE_OPEN = /^\s{0,3}`{3,}\s*room-task\s*$/;
const FENCE_CLOSE = /^\s{0,3}`{3,}\s*$/;
const TOP_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/;
const LIST_ITEM = /^[ \t]+-[ \t]+(.*)$/;
const NESTED_KEY = /^[ \t]+([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function extractBlocks(text: string): { blocks: string[][]; errors: string[] } {
  const lines = text.split(/\r?\n/);
  const blocks: string[][] = [];
  const errors: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (current === null) {
      if (FENCE_OPEN.test(line)) current = [];
    } else if (FENCE_CLOSE.test(line)) {
      blocks.push(current);
      current = null;
    } else {
      current.push(line);
    }
  }
  if (current !== null) {
    blocks.push(current);
    errors.push(`block ${blocks.length}: unterminated \`\`\`room-task fence`);
  }
  return { blocks, errors };
}

function parseBlock(lines: string[], label: string): { task: RoomTask | null; errors: string[] } {
  const errors: string[] = [];
  const scalars: Record<string, string> = {};
  let acceptance: string[] | null = null;
  let budget: RoomTaskBudget | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = (lines[i] ?? '').replace(/[ \t]+$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i += 1;
      continue;
    }
    if (/^[ \t]/.test(line)) {
      errors.push(
        `${label}: unexpected indented line ${JSON.stringify(trimmed)} ` +
          '(indentation is only valid under "acceptance:" or "budget:")'
      );
      i += 1;
      continue;
    }
    const keyMatch = TOP_KEY.exec(line);
    if (keyMatch === null) {
      errors.push(`${label}: unrecognized line ${JSON.stringify(trimmed)} (expected "key: value")`);
      i += 1;
      continue;
    }
    const key = keyMatch[1] ?? '';
    const value = (keyMatch[2] ?? '').trim();

    if (key === 'acceptance') {
      if (acceptance !== null) errors.push(`${label}: duplicate key "acceptance"`);
      if (value !== '') errors.push(`${label}: "acceptance" takes no inline value (use "  - item" lines)`);
      acceptance = acceptance ?? [];
      i += 1;
      while (i < lines.length) {
        const sub = lines[i] ?? '';
        if (sub.trim() === '') {
          i += 1;
          continue;
        }
        const item = LIST_ITEM.exec(sub);
        if (item === null) break;
        acceptance.push(unquote((item[1] ?? '').trim()));
        i += 1;
      }
      continue;
    }

    if (key === 'budget') {
      if (budget !== null) errors.push(`${label}: duplicate key "budget"`);
      if (value !== '') {
        errors.push(`${label}: "budget" takes no inline value (use indented "max_usd:" / "max_minutes:" lines)`);
      }
      budget = budget ?? {};
      i += 1;
      while (i < lines.length) {
        const sub = lines[i] ?? '';
        if (sub.trim() === '') {
          i += 1;
          continue;
        }
        if (LIST_ITEM.test(sub)) break;
        const nested = NESTED_KEY.exec(sub);
        if (nested === null) break;
        const nestedKey = nested[1] ?? '';
        const nestedValue = (nested[2] ?? '').trim();
        if (BUDGET_KEYS.has(nestedKey)) {
          if (!NUMBER.test(nestedValue) || !Number.isFinite(Number(nestedValue))) {
            errors.push(`${label}: budget.${nestedKey} must be a number (got ${JSON.stringify(nestedValue)})`);
          } else if (Number(nestedValue) < 0) {
            errors.push(`${label}: budget.${nestedKey} must not be negative`);
          } else if (nestedKey === 'max_usd') {
            budget.max_usd = Number(nestedValue);
          } else {
            budget.max_minutes = Number(nestedValue);
          }
        }
        // Unknown nested keys are ignored (forward compatibility).
        i += 1;
      }
      continue;
    }

    if (SCALAR_KEYS.has(key)) {
      if (key in scalars) {
        errors.push(`${label}: duplicate key "${key}"`);
      } else if (value === '') {
        errors.push(`${label}: "${key}" has an empty value`);
      } else {
        scalars[key] = unquote(value);
      }
      i += 1;
      continue;
    }

    // Unknown top-level keys are ignored (forward compatibility).
    i += 1;
  }

  for (const required of REQUIRED_KEYS) {
    if (!(required in scalars)) errors.push(`${label}: missing required field "${required}"`);
  }
  const type = scalars['type'];
  if (type !== undefined && !TASK_TYPES.has(type)) {
    errors.push(
      `${label}: invalid type ${JSON.stringify(type)} (expected implement | debug | review | document | test)`
    );
  }

  if (errors.length > 0) return { task: null, errors };

  const task: RoomTask = {
    id: scalars['id'] ?? '',
    type: scalars['type'] ?? '',
    title: scalars['title'] ?? '',
  };
  if (scalars['repo'] !== undefined) task.repo = scalars['repo'];
  if (scalars['branch'] !== undefined) task.branch = scalars['branch'];
  if (scalars['goal'] !== undefined) task.goal = scalars['goal'];
  if (acceptance !== null) task.acceptance = acceptance;
  if (budget !== null) task.budget = budget;
  return { task, errors };
}

function parseRoomTasks(text: string): ParseResult {
  const { blocks, errors } = extractBlocks(text);
  const tasks: RoomTask[] = [];
  const allErrors = [...errors];
  blocks.forEach((blockLines, index) => {
    const { task, errors: blockErrors } = parseBlock(blockLines, `block ${index + 1}`);
    allErrors.push(...blockErrors);
    if (task !== null) tasks.push(task);
  });
  if (blocks.length === 0) allErrors.push('no ```room-task blocks found in input');
  return { tasks, errors: allErrors };
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
  return result.tasks.length > 0 && result.errors.length === 0 ? 0 : 1;
}

process.exit(main());
