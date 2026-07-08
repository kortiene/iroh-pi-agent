/**
 * Grammar-parity conformance suite (SPEC.md §11 / docs/pi-harness.md §Room-task format): the worker's canonical
 * task parser and the standalone skill script MUST implement the same
 * grammar. Every fixture below is fed to both:
 *
 *   - worker: parseRoomTasks() imported directly
 *   - skill:  `node .pi/skills/iroh-room-agent/scripts/parse-room-task.ts`
 *             spawned as a real subprocess on stdin (plain node, Node 22
 *             type stripping — this also proves the script stays standalone)
 *
 * Tasks must match EXACTLY. Errors are compared modulo wording: same count
 * and the same referenced ids/fields (the double-quoted tokens inside each
 * message), so cosmetic rephrasing cannot silently pass while a real grammar
 * divergence fails.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseRoomTasks } from '../src/task-parser.js';

const SCRIPT_PATH = fileURLToPath(
  new URL('../../../.pi/skills/iroh-room-agent/scripts/parse-room-task.ts', import.meta.url),
);

interface ScriptResult {
  tasks: unknown[];
  errors: string[];
  exitCode: number;
}

function runScript(input: string): ScriptResult {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    input,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.error, String(result.error)).toBeUndefined();
  expect(result.status, `script stderr: ${result.stderr}`).not.toBeNull();
  const parsed = JSON.parse(result.stdout) as { tasks: unknown[]; errors: string[] };
  return { tasks: parsed.tasks, errors: parsed.errors, exitCode: result.status as number };
}

/** The double-quoted tokens an error message references (field names, values). */
function quotedTokens(error: string): string[] {
  return [...error.matchAll(/"([^"]*)"/g)].map((match) => match[1] as string).sort();
}

const SPEC_EXAMPLE = [
  '```room-task',
  'id: IR-PI-001',
  'type: implement',
  'title: Add Pi extension for iroh-room',
  'repo: kortiene/iroh-room',
  'branch: agent/ir-pi-001',
  'goal: Implement the project-local Pi extension that exposes room tools.',
  'acceptance:',
  '  - /room works',
  '  - /room-status works',
  'budget:',
  '  max_usd: 2.00',
  '  max_minutes: 30',
  '```',
].join('\n');

/** name → shared fixture input (valid, invalid, quoting, encodings, size). */
const FIXTURES: Record<string, string> = {
  'valid SPEC §11 example': `please pick this up\n\n${SPEC_EXAMPLE}\n\nthanks!`,
  'minimal valid block': '```room-task\nid: T-1\ntype: test\ntitle: x\n```',
  'multi-block message (two valid)': `${SPEC_EXAMPLE}\n\nand:\n\n\`\`\`room-task\nid: IR-PI-002\ntype: review\ntitle: Review it\n\`\`\``,
  'invalid type': '```room-task\nid: T-1\ntype: deploy\ntitle: x\n```',
  'missing required fields': '```room-task\ntype: implement\n```',
  'unterminated block': '```room-task\nid: T-1\ntype: implement\ntitle: x\n',
  'fence-in-fence (markdown quoting)': [
    'example only:',
    '```markdown',
    '```room-task',
    'id: EXAMPLE-1',
    'type: implement',
    'title: quoted, not real',
    '```',
    '```',
  ].join('\n'),
  'fence-in-fence (4-backtick quoting)': [
    '````markdown',
    '```room-task',
    'id: EXAMPLE-2',
    'type: implement',
    'title: quoted, not real',
    '```',
    '````',
  ].join('\n'),
  'real block after a closed foreign fence': [
    '```js',
    'console.log("hi");',
    '```',
    '```room-task',
    'id: REAL-1',
    'type: implement',
    'title: real',
    '```',
  ].join('\n'),
  'CRLF line endings': '```room-task\r\nid: T-CRLF\r\ntype: implement\r\ntitle: x\r\n```\r\n',
  'oversized fields (5000-char title)': `\`\`\`room-task\nid: T-BIG\ntype: implement\ntitle: ${'x'.repeat(5000)}\n\`\`\``,
  'duplicate keys (last wins)': '```room-task\nid: T-1\nid: T-2\ntype: implement\ntitle: x\n```',
  'comment-ish and junk lines': '```room-task\n# a comment\n!!! junk\nid: T-1\ntype: implement\ntitle: x\n```',
  'bad budget values': '```room-task\nid: T-1\ntype: implement\ntitle: x\nbudget:\n  max_usd: lots\n  max_minutes: -3\n```',
  'inline acceptance/budget rejected': '```room-task\nid: T-1\ntype: implement\ntitle: x\nacceptance: all\nbudget: 3\n```',
  'quoted values and colons': `\`\`\`room-task\nid: "T-Q"\ntype: 'implement'\ntitle: fix: the parser: part 2\nacceptance:\n  - "quoted item"\n\`\`\``,
  'indentation-quoted example (4 spaces)': '    ```room-task\n    id: EXAMPLE-4\n    type: implement\n    title: indented\n    ```',
  'no blocks at all': 'just chatting about ```js\ncode\n``` fences',
  'empty input': '',
};

describe('worker parser and skill script implement the SAME grammar', () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    it(`agrees on: ${name}`, () => {
      const worker = parseRoomTasks(input);
      const script = runScript(input);

      // Tasks must be byte-identical (same shape, same values, same order).
      expect(script.tasks).toEqual(worker.tasks);

      // Errors: same count, and each references the same quoted ids/fields.
      expect(script.errors).toHaveLength(worker.errors.length);
      for (let i = 0; i < worker.errors.length; i++) {
        expect(quotedTokens(script.errors[i] as string)).toEqual(
          quotedTokens(worker.errors[i] as string),
        );
      }

      // Exit-code contract: 0 iff at least one task and zero errors.
      const expectedExit = worker.tasks.length > 0 && worker.errors.length === 0 ? 0 : 1;
      expect(script.exitCode).toBe(expectedExit);
    });
  }
});
