/**
 * Pure mapping from Pi RPC lifecycle events to iroh-room agent.status
 * transitions (DESIGN.md §7).
 *
 * Mapping contract:
 *   - agent_start                                  -> planning (per-run state resets)
 *   - first tool_execution_start (this run)        -> implementing
 *   - tool_execution_start of bash w/ test command -> testing (any time)
 *   - agent_end, last assistant stopReason normal  -> ready_for_review
 *   - agent_end, stopReason aborted/error          -> failed
 *   - agent_end, stopReason length (truncated run) -> blocked
 *   - anything else                                -> no transition
 *
 * The mapper is a fold: callers thread MapperState through mapPiEventToStatus
 * for each event and post an agent.status update whenever a transition is
 * returned. Transitions are only emitted when the status actually changes.
 *
 * STATUS_VOCABULARY is ADVISORY (SPEC.md §12): iroh-rooms accepts any label
 * up to 64 bytes; the vocabulary exists for consistency across agents.
 */

export const STATUS_VOCABULARY = [
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
] as const;

export type AgentStatus = (typeof STATUS_VOCABULARY)[number];

/**
 * Minimal structural view of a Pi RPC event (docs/rpc.md). Only the fields
 * the mapper inspects are typed; everything else passes through untyped.
 */
export interface PiEventLike {
  type: string;
  toolName?: string;
  args?: Record<string, unknown>;
  messages?: unknown[];
  [key: string]: unknown;
}

export interface MapperState {
  readonly status: AgentStatus;
  /** True once any tool_execution_start has been seen this run. */
  readonly sawToolExecution: boolean;
}

/** A freshly claimed task starts in `claimed` before Pi begins planning. */
export const INITIAL_MAPPER_STATE: MapperState = { status: 'claimed', sawToolExecution: false };

export interface StatusTransition {
  from: AgentStatus;
  to: AgentStatus;
  /** Human-readable trigger, suitable for the agent.status --message. */
  reason: string;
}

export interface MapResult {
  state: MapperState;
  /** Non-null only when the status actually changed. */
  transition: StatusTransition | null;
}

/**
 * Heuristic for "this bash command runs tests". Deliberately conservative:
 * false negatives only cost a less precise status label.
 */
export const TEST_COMMAND_PATTERN =
  /\b(?:vitest|jest|pytest|mocha|playwright test|cargo (?:test|nextest)|go test|node --test|make test|tox|(?:npm|pnpm|yarn|bun) (?:run )?test)\b/i;

export function isTestishCommand(command: string): boolean {
  return TEST_COMMAND_PATTERN.test(command);
}

type AgentEndOutcome = 'success' | 'aborted' | 'error' | 'truncated';

/**
 * Classify an agent_end event by the last assistant message's stopReason
 * (pi-ai reasons: stop | length | toolUse | aborted | error). 'length' means
 * the run was cut off at the token limit — the work is NOT reviewable, so it
 * counts as truncated (mapped to blocked), never as success. Missing or
 * unrecognized data counts as success — the run ended without a reported
 * abort/error.
 */
function agentEndOutcome(event: PiEventLike): AgentEndOutcome {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record['role'] !== 'assistant') {
      continue;
    }
    const stopReason = record['stopReason'];
    if (stopReason === 'aborted') return 'aborted';
    if (stopReason === 'error') return 'error';
    if (stopReason === 'length') return 'truncated';
    return 'success';
  }
  return 'success';
}

function transitionTo(state: MapperState, to: AgentStatus, reason: string, sawToolExecution: boolean): MapResult {
  const nextState: MapperState = { status: to, sawToolExecution };
  if (state.status === to) {
    return { state: nextState, transition: null };
  }
  return { state: nextState, transition: { from: state.status, to, reason } };
}

/**
 * Fold one Pi RPC event into the mapper state, returning the next state and
 * an agent.status transition when one should be posted. Pure: never throws,
 * never mutates its inputs.
 */
export function mapPiEventToStatus(state: MapperState, event: PiEventLike): MapResult {
  switch (event.type) {
    case 'agent_start':
      // A new run begins: reset the per-run tool-execution flag so this run's
      // first tool_execution_start maps to implementing again.
      return transitionTo(state, 'planning', 'pi agent run started', false);

    case 'tool_execution_start': {
      const command = event.args !== undefined ? event.args['command'] : undefined;
      if (event.toolName === 'bash' && typeof command === 'string' && isTestishCommand(command)) {
        return transitionTo(state, 'testing', `running tests: ${event.toolName}`, true);
      }
      if (!state.sawToolExecution) {
        const label = typeof event.toolName === 'string' ? event.toolName : 'tool';
        return transitionTo(state, 'implementing', `first tool execution (${label})`, true);
      }
      // Subsequent non-test tool executions do not change the status.
      return { state: { ...state, sawToolExecution: true }, transition: null };
    }

    case 'agent_end': {
      const outcome = agentEndOutcome(event);
      if (outcome === 'success') {
        return transitionTo(state, 'ready_for_review', 'pi agent run completed', state.sawToolExecution);
      }
      if (outcome === 'truncated') {
        return transitionTo(state, 'blocked', 'pi agent run truncated at token limit', state.sawToolExecution);
      }
      return transitionTo(state, 'failed', `pi agent run ${outcome}`, state.sawToolExecution);
    }

    default:
      // turn_start/turn_end/message_* /tool_execution_update|end/queue_update/
      // compaction_*/auto_retry_*/extension_error and unknown future events:
      // no status change.
      return { state, transition: null };
  }
}
