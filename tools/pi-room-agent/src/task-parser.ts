/**
 * Canonical parser for fenced ```room-task blocks (SPEC.md §11).
 *
 * Tasks travel as structured Markdown inside ordinary room messages:
 *
 *   ```room-task
 *   id: IR-PI-001
 *   type: implement
 *   title: Add Pi extension for iroh-room
 *   repo: kortiene/iroh-room
 *   branch: agent/ir-pi-001
 *   goal: Implement the project-local Pi extension.
 *   acceptance:
 *     - /room works
 *     - /room-status works
 *   budget:
 *     max_usd: 2.00
 *     max_minutes: 30
 *   ```
 *
 * This is a HAND-ROLLED parser for exactly that YAML subset — flat
 * `key: value` scalars, one `acceptance:` list of `- ` items, one `budget:`
 * nested 2-space map with numeric values — NOT a general YAML parser.
 * Room content is untrusted input, so the parser never throws: malformed
 * blocks are reported in `errors` and skipped (or, for a bad optional field,
 * the field is dropped and the error recorded).
 *
 * The standalone skill script (.pi/skills/iroh-room-agent/scripts/
 * parse-room-task.ts) is a line-for-line port of this grammar; this module is
 * the canonical copy. test/parser-conformance.test.ts runs both parsers over
 * a shared corpus — grammar changes must land in BOTH files or it fails.
 *
 * A ```room-task opener quoted inside another code fence (``` or ````…) is
 * quoted content, never a claimable task (see extractBlocks).
 */

export const ROOM_TASK_TYPES = ['implement', 'debug', 'review', 'document', 'test'] as const;
export type RoomTaskType = (typeof ROOM_TASK_TYPES)[number];

export interface RoomTaskBudget {
  maxUsd?: number;
  maxMinutes?: number;
}

export interface RoomTask {
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

export interface ParsedRoomTasks {
  tasks: RoomTask[];
  errors: string[];
}

/**
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
export function parseRoomTasks(text: string): ParsedRoomTasks {
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
