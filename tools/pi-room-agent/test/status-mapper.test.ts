import { describe, expect, it } from 'vitest';

import {
  INITIAL_MAPPER_STATE,
  isTestishCommand,
  mapPiEventToStatus,
  STATUS_VOCABULARY,
  type MapperState,
  type PiEventLike,
} from '../src/status-mapper.js';

function agentEnd(stopReason?: string): PiEventLike {
  const message: Record<string, unknown> = { role: 'assistant' };
  if (stopReason !== undefined) message['stopReason'] = stopReason;
  return { type: 'agent_end', messages: [{ role: 'user' }, message] };
}

describe('STATUS_VOCABULARY', () => {
  it('exports the full SPEC §12 vocabulary in order', () => {
    expect(STATUS_VOCABULARY).toEqual([
      'idle',
      'observing',
      'claimed',
      'planning',
      'implementing',
      'testing',
      'sharing_artifacts',
      'preview_available',
      'blocked',
      'ready_for_review',
      'done',
      'failed',
      'cancelled',
    ]);
  });
});

describe('mapPiEventToStatus', () => {
  it('starts from claimed', () => {
    expect(INITIAL_MAPPER_STATE).toEqual({ status: 'claimed', sawToolExecution: false });
  });

  it('agent_start → planning', () => {
    const { state, transition } = mapPiEventToStatus(INITIAL_MAPPER_STATE, { type: 'agent_start' });
    expect(state.status).toBe('planning');
    expect(transition).toEqual({ from: 'claimed', to: 'planning', reason: 'pi agent run started' });
  });

  it('emits no transition when the status does not change', () => {
    const planning: MapperState = { status: 'planning', sawToolExecution: false };
    const { state, transition } = mapPiEventToStatus(planning, { type: 'agent_start' });
    expect(state.status).toBe('planning');
    expect(transition).toBeNull();
  });

  it('agent_start resets sawToolExecution so a second run maps implementing again', () => {
    // Run 1: start, tool, end.
    let state: MapperState = INITIAL_MAPPER_STATE;
    state = mapPiEventToStatus(state, { type: 'agent_start' }).state;
    state = mapPiEventToStatus(state, { type: 'tool_execution_start', toolName: 'edit' }).state;
    state = mapPiEventToStatus(state, agentEnd('stop')).state;
    expect(state).toEqual({ status: 'ready_for_review', sawToolExecution: true });

    // Run 2 on the same threaded state: agent_start must reset the per-run flag…
    const start2 = mapPiEventToStatus(state, { type: 'agent_start' });
    expect(start2.state).toEqual({ status: 'planning', sawToolExecution: false });
    expect(start2.transition?.to).toBe('planning');

    // …so run 2's first tool execution posts implementing (not silence).
    const tool2 = mapPiEventToStatus(start2.state, { type: 'tool_execution_start', toolName: 'edit' });
    expect(tool2.state).toEqual({ status: 'implementing', sawToolExecution: true });
    expect(tool2.transition).toEqual({
      from: 'planning',
      to: 'implementing',
      reason: 'first tool execution (edit)',
    });
  });

  it('first tool_execution_start → implementing', () => {
    const planning: MapperState = { status: 'planning', sawToolExecution: false };
    const { state, transition } = mapPiEventToStatus(planning, {
      type: 'tool_execution_start',
      toolName: 'read',
    });
    expect(state).toEqual({ status: 'implementing', sawToolExecution: true });
    expect(transition).toEqual({
      from: 'planning',
      to: 'implementing',
      reason: 'first tool execution (read)',
    });
  });

  it('subsequent non-test tool executions do not change the status', () => {
    const implementing: MapperState = { status: 'implementing', sawToolExecution: true };
    const { state, transition } = mapPiEventToStatus(implementing, {
      type: 'tool_execution_start',
      toolName: 'edit',
    });
    expect(state).toEqual(implementing);
    expect(transition).toBeNull();
  });

  it('bash with a test-ish command → testing, at any point', () => {
    const implementing: MapperState = { status: 'implementing', sawToolExecution: true };
    const { state, transition } = mapPiEventToStatus(implementing, {
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'npm test' },
    });
    expect(state.status).toBe('testing');
    expect(transition?.to).toBe('testing');
  });

  it('a test-ish bash command as the FIRST tool goes to testing, not implementing', () => {
    const planning: MapperState = { status: 'planning', sawToolExecution: false };
    const { state } = mapPiEventToStatus(planning, {
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'vitest run' },
    });
    expect(state).toEqual({ status: 'testing', sawToolExecution: true });
  });

  it('a non-test bash command first → implementing', () => {
    const planning: MapperState = { status: 'planning', sawToolExecution: false };
    const { state } = mapPiEventToStatus(planning, {
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'ls -la' },
    });
    expect(state.status).toBe('implementing');
  });

  it('bash without args is not treated as a test run', () => {
    const planning: MapperState = { status: 'planning', sawToolExecution: false };
    const { state } = mapPiEventToStatus(planning, { type: 'tool_execution_start', toolName: 'bash' });
    expect(state.status).toBe('implementing');
  });

  it('agent_end with a normal stop → ready_for_review', () => {
    const testing: MapperState = { status: 'testing', sawToolExecution: true };
    const { state, transition } = mapPiEventToStatus(testing, agentEnd('stop'));
    expect(state.status).toBe('ready_for_review');
    expect(transition?.reason).toBe('pi agent run completed');
  });

  it('agent_end with no messages counts as success', () => {
    const { state } = mapPiEventToStatus(
      { status: 'implementing', sawToolExecution: true },
      { type: 'agent_end' },
    );
    expect(state.status).toBe('ready_for_review');
  });

  it('agent_end aborted → failed', () => {
    const { state, transition } = mapPiEventToStatus(
      { status: 'implementing', sawToolExecution: true },
      agentEnd('aborted'),
    );
    expect(state.status).toBe('failed');
    expect(transition?.reason).toBe('pi agent run aborted');
  });

  it('agent_end error → failed', () => {
    const { state, transition } = mapPiEventToStatus(
      { status: 'testing', sawToolExecution: true },
      agentEnd('error'),
    );
    expect(state.status).toBe('failed');
    expect(transition?.reason).toBe('pi agent run error');
  });

  it('agent_end with stopReason length (truncated run) → blocked, never ready_for_review', () => {
    const { state, transition } = mapPiEventToStatus(
      { status: 'implementing', sawToolExecution: true },
      agentEnd('length'),
    );
    expect(state.status).toBe('blocked');
    expect(transition).toEqual({
      from: 'implementing',
      to: 'blocked',
      reason: 'pi agent run truncated at token limit',
    });
  });

  it('reads the LAST assistant message stopReason', () => {
    const event: PiEventLike = {
      type: 'agent_end',
      messages: [
        { role: 'assistant', stopReason: 'error' },
        { role: 'assistant', stopReason: 'stop' },
      ],
    };
    const { state } = mapPiEventToStatus({ status: 'testing', sawToolExecution: true }, event);
    expect(state.status).toBe('ready_for_review');
  });

  it('ignores lifecycle events that carry no status meaning', () => {
    const state: MapperState = { status: 'implementing', sawToolExecution: true };
    for (const type of [
      'turn_start',
      'turn_end',
      'message_start',
      'message_update',
      'message_end',
      'tool_execution_update',
      'tool_execution_end',
      'queue_update',
      'compaction_start',
      'auto_retry_start',
      'extension_error',
      'some_future_event',
    ]) {
      const result = mapPiEventToStatus(state, { type });
      expect(result.transition).toBeNull();
      expect(result.state.status).toBe('implementing');
    }
  });

  it('never mutates the input state', () => {
    const state: MapperState = { status: 'claimed', sawToolExecution: false };
    mapPiEventToStatus(state, { type: 'agent_start' });
    mapPiEventToStatus(state, { type: 'tool_execution_start', toolName: 'bash', args: { command: 'npm test' } });
    expect(state).toEqual({ status: 'claimed', sawToolExecution: false });
  });
});

describe('isTestishCommand', () => {
  it('matches common test invocations', () => {
    for (const command of [
      'npm test',
      'npm run test',
      'pnpm test',
      'yarn run test',
      'bun test',
      'vitest run --coverage',
      'npx jest src/',
      'pytest -q',
      'cargo test --workspace',
      'cargo nextest run',
      'go test ./...',
      'node --test test/',
      'make test',
      'cd /repo && npm test',
    ]) {
      expect(isTestishCommand(command), command).toBe(true);
    }
  });

  it('does not match non-test commands', () => {
    for (const command of [
      'ls -la',
      'npm install',
      'npm run build',
      'echo test',
      'git commit -m "add tests"',
      'cargo build --release',
    ]) {
      expect(isTestishCommand(command), command).toBe(false);
    }
  });
});
