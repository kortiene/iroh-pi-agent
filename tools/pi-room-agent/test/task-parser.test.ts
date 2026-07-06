import { describe, expect, it } from 'vitest';

import { parseRoomTasks, ROOM_TASK_TYPES } from '../src/task-parser.js';

/** The exact example block from SPEC.md §11. */
const SPEC_EXAMPLE = `\`\`\`room-task
id: IR-PI-001
type: implement
title: Add Pi extension for iroh-room
repo: kortiene/iroh-room
branch: agent/ir-pi-001
goal: Implement the project-local Pi extension that exposes room tools.
acceptance:
  - /room works
  - /room-status works
  - /room-send works
  - /room-artifact works
  - /room-preview works
budget:
  max_usd: 2.00
  max_minutes: 30
\`\`\``;

describe('parseRoomTasks — happy path', () => {
  it('parses the SPEC §11 example block completely', () => {
    const { tasks, errors } = parseRoomTasks(`please pick this up\n\n${SPEC_EXAMPLE}\n\nthanks!`);
    expect(errors).toEqual([]);
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.id).toBe('IR-PI-001');
    expect(task.type).toBe('implement');
    expect(task.title).toBe('Add Pi extension for iroh-room');
    expect(task.repo).toBe('kortiene/iroh-room');
    expect(task.branch).toBe('agent/ir-pi-001');
    expect(task.goal).toBe('Implement the project-local Pi extension that exposes room tools.');
    expect(task.acceptance).toEqual([
      '/room works',
      '/room-status works',
      '/room-send works',
      '/room-artifact works',
      '/room-preview works',
    ]);
    expect(task.budget).toEqual({ maxUsd: 2, maxMinutes: 30 });
    expect(task.extra).toEqual({});
  });

  it('parses multiple blocks in one message', () => {
    const text = `${SPEC_EXAMPLE}\n\nand also:\n\n\`\`\`room-task\nid: IR-PI-002\ntype: review\ntitle: Review the extension\n\`\`\``;
    const { tasks, errors } = parseRoomTasks(text);
    expect(errors).toEqual([]);
    expect(tasks.map((t) => t.id)).toEqual(['IR-PI-001', 'IR-PI-002']);
    expect(tasks[1]!.type).toBe('review');
    expect(tasks[1]!.acceptance).toEqual([]);
    expect(tasks[1]!.budget).toBeUndefined();
  });

  it('accepts every declared task type', () => {
    for (const type of ROOM_TASK_TYPES) {
      const { tasks, errors } = parseRoomTasks(
        `\`\`\`room-task\nid: T-1\ntype: ${type}\ntitle: x\n\`\`\``,
      );
      expect(errors).toEqual([]);
      expect(tasks[0]!.type).toBe(type);
    }
  });

  it('strips inline quotes from values and list items', () => {
    const { tasks, errors } = parseRoomTasks(
      `\`\`\`room-task\nid: "T-1"\ntype: 'implement'\ntitle: "A quoted title"\nacceptance:\n  - "quoted item"\n  - 'single quoted'\n\`\`\``,
    );
    expect(errors).toEqual([]);
    expect(tasks[0]!.id).toBe('T-1');
    expect(tasks[0]!.type).toBe('implement');
    expect(tasks[0]!.title).toBe('A quoted title');
    expect(tasks[0]!.acceptance).toEqual(['quoted item', 'single quoted']);
  });

  it('preserves colons inside values', () => {
    const { tasks } = parseRoomTasks(
      `\`\`\`room-task\nid: T-1\ntype: debug\ntitle: fix: the parser: part 2\n\`\`\``,
    );
    expect(tasks[0]!.title).toBe('fix: the parser: part 2');
  });

  it('collects unknown top-level keys in extra', () => {
    const { tasks, errors } = parseRoomTasks(
      `\`\`\`room-task\nid: T-1\ntype: test\ntitle: x\npriority: high\nassignee: pi-agent\n\`\`\``,
    );
    expect(errors).toEqual([]);
    expect(tasks[0]!.extra).toEqual({ priority: 'high', assignee: 'pi-agent' });
  });

  it('handles CRLF line endings', () => {
    const text = '```room-task\r\nid: T-1\r\ntype: implement\r\ntitle: x\r\n```\r\n';
    const { tasks, errors } = parseRoomTasks(text);
    expect(errors).toEqual([]);
    expect(tasks).toHaveLength(1);
  });

  it('returns empty results for text without any room-task block', () => {
    expect(parseRoomTasks('just a normal message with ```js\ncode\n``` in it')).toEqual({
      tasks: [],
      errors: [],
    });
    expect(parseRoomTasks('')).toEqual({ tasks: [], errors: [] });
  });
});

describe('parseRoomTasks — quoted blocks inside another fence are NOT tasks', () => {
  it('ignores a room-task block quoted inside a ```markdown fence', () => {
    const text = [
      'Here is an EXAMPLE of the format (do not claim it):',
      '```markdown',
      '```room-task',
      'id: EXAMPLE-1',
      'type: implement',
      'title: Example task, not real',
      '```',
      '```',
    ].join('\n');
    expect(parseRoomTasks(text)).toEqual({ tasks: [], errors: [] });
  });

  it('ignores a room-task block quoted inside a ````-fence (SPEC §11 quoting style)', () => {
    const text = [
      '````markdown',
      '```room-task',
      'id: EXAMPLE-2',
      'type: implement',
      'title: Quoted with four backticks',
      '```',
      '````',
    ].join('\n');
    expect(parseRoomTasks(text)).toEqual({ tasks: [], errors: [] });
  });

  it('a ```-line inside a ````-fence does not close the outer fence', () => {
    const text = [
      '````',
      '```',
      '```room-task',
      'id: EXAMPLE-3',
      'type: implement',
      'title: still quoted',
      '```',
      '````',
    ].join('\n');
    expect(parseRoomTasks(text)).toEqual({ tasks: [], errors: [] });
  });

  it('still parses a legitimate block after a closed foreign fence', () => {
    const text = [
      '```js',
      'console.log("hi");',
      '```',
      '',
      '```room-task',
      'id: REAL-1',
      'type: implement',
      'title: real task after quoted code',
      '```',
    ].join('\n');
    const { tasks, errors } = parseRoomTasks(text);
    expect(errors).toEqual([]);
    expect(tasks.map((t) => t.id)).toEqual(['REAL-1']);
  });

  it('ignores an indentation-quoted (4+ spaces) room-task fence instead of half-parsing it', () => {
    const text = [
      'Example, indented as code:',
      '    ```room-task',
      '    id: EXAMPLE-4',
      '    type: implement',
      '    title: indented example',
      '    ```',
    ].join('\n');
    expect(parseRoomTasks(text)).toEqual({ tasks: [], errors: [] });
  });

  it('still parses a fence indented up to 3 spaces (CommonMark rule)', () => {
    const text = ['   ```room-task', 'id: REAL-2', 'type: test', 'title: ok', '   ```'].join('\n');
    const { tasks, errors } = parseRoomTasks(text);
    expect(errors).toEqual([]);
    expect(tasks.map((t) => t.id)).toEqual(['REAL-2']);
  });
});

describe('parseRoomTasks — malformed input (never throws)', () => {
  it('reports an unterminated fence and yields no task', () => {
    const { tasks, errors } = parseRoomTasks('```room-task\nid: T-1\ntype: implement\ntitle: x\n');
    expect(tasks).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/line 1/);
    expect(errors[0]).toMatch(/no closing/);
  });

  it('reports missing required fields', () => {
    const { tasks, errors } = parseRoomTasks('```room-task\ntype: implement\ntitle: x\n```');
    expect(tasks).toEqual([]);
    expect(errors.some((e) => e.includes('missing required field "id"'))).toBe(true);

    const noType = parseRoomTasks('```room-task\nid: T-1\ntitle: x\n```');
    expect(noType.tasks).toEqual([]);
    expect(noType.errors.some((e) => e.includes('missing required field "type"'))).toBe(true);

    const noTitle = parseRoomTasks('```room-task\nid: T-1\ntype: implement\n```');
    expect(noTitle.tasks).toEqual([]);
    expect(noTitle.errors.some((e) => e.includes('missing required field "title"'))).toBe(true);
  });

  it('rejects an invalid type with the allowed list in the error', () => {
    const { tasks, errors } = parseRoomTasks('```room-task\nid: T-1\ntype: deploy\ntitle: x\n```');
    expect(tasks).toEqual([]);
    expect(errors[0]).toMatch(/invalid type "deploy"/);
    expect(errors[0]).toMatch(/implement \| debug \| review \| document \| test/);
  });

  it('keeps the task but drops non-numeric budget fields (with an error)', () => {
    const { tasks, errors } = parseRoomTasks(
      `\`\`\`room-task\nid: T-1\ntype: implement\ntitle: x\nbudget:\n  max_usd: lots\n  max_minutes: 30\n\`\`\``,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.budget).toEqual({ maxMinutes: 30 });
    expect(errors.some((e) => e.includes('budget.max_usd is not a number'))).toBe(true);
  });

  it('rejects negative budget values', () => {
    const { tasks, errors } = parseRoomTasks(
      `\`\`\`room-task\nid: T-1\ntype: implement\ntitle: x\nbudget:\n  max_usd: -3\n\`\`\``,
    );
    expect(tasks[0]!.budget).toEqual({});
    expect(errors.some((e) => e.includes('must not be negative'))).toBe(true);
  });

  it('namespaces unknown budget keys into extra', () => {
    const { tasks, errors } = parseRoomTasks(
      `\`\`\`room-task\nid: T-1\ntype: implement\ntitle: x\nbudget:\n  max_tokens: 5000\n\`\`\``,
    );
    expect(errors).toEqual([]);
    expect(tasks[0]!.extra).toEqual({ 'budget.max_tokens': '5000' });
  });

  it('rejects inline values for acceptance and budget', () => {
    const { errors } = parseRoomTasks(
      `\`\`\`room-task\nid: T-1\ntype: implement\ntitle: x\nacceptance: all of it\nbudget: 3\n\`\`\``,
    );
    expect(errors.some((e) => e.includes('acceptance must be a list'))).toBe(true);
    expect(errors.some((e) => e.includes('budget must be a nested map'))).toBe(true);
  });

  it('reports indented lines outside any list/map context', () => {
    const { tasks, errors } = parseRoomTasks(
      `\`\`\`room-task\nid: T-1\ntype: implement\ntitle: x\n  - stray item\n\`\`\``,
    );
    expect(tasks).toHaveLength(1);
    expect(errors.some((e) => e.includes('outside a list or map context'))).toBe(true);
  });

  it('reports unrecognized top-level lines but keeps parsing', () => {
    const { tasks, errors } = parseRoomTasks(
      `\`\`\`room-task\n!!! not yaml at all\nid: T-1\ntype: implement\ntitle: x\n\`\`\``,
    );
    expect(tasks).toHaveLength(1);
    expect(errors.some((e) => e.includes('unrecognized line'))).toBe(true);
  });

  it('treats an empty required value as missing', () => {
    const { tasks, errors } = parseRoomTasks('```room-task\nid:\ntype: implement\ntitle: x\n```');
    expect(tasks).toEqual([]);
    expect(errors.some((e) => e.includes('missing required field "id"'))).toBe(true);
  });

  it('one bad block does not poison a good one', () => {
    const text = `\`\`\`room-task\ntype: implement\n\`\`\`\n\n\`\`\`room-task\nid: T-2\ntype: test\ntitle: good\n\`\`\``;
    const { tasks, errors } = parseRoomTasks(text);
    expect(tasks.map((t) => t.id)).toEqual(['T-2']);
    expect(errors.length).toBeGreaterThan(0);
  });
});
