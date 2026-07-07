# Room Cockpit — implementation brief

**Status: PROPOSED / NOT IMPLEMENTED.** This brief is the next-step design
artifact for a full opt-in iroh-room cockpit/dashboard inside Pi's interactive
TUI. It complements the already implemented [Room Pulse](pi-harness.md#room-pulse-tui)
ambient layer; it does not replace it.

Where this brief and `docs/tui-cockpit-proposal.md` disagree, this brief wins.
The older proposal deliberately chose the lighter Room Pulse over a cockpit for
MVP. This brief reopens the cockpit idea as a post-MVP feature, using the API
corrections and security invariants proven by `docs/tui-pulse-brief.md`.

Target package: `.pi/extensions/iroh-room/` (tabs, double quotes, NodeNext ESM
with `.js` relative imports, zero runtime dependencies). Worker and
`../iroh-room` stay untouched.

---

## 1. Thesis

Room Pulse is peripheral vision: always-on, small, and non-interrupting.

Room Cockpit is mission control: explicitly opened, keyboard-focused, and
high-density. It should help a human operator answer:

- Is this room configured and healthy?
- Is my agent identity correct?
- What happened recently?
- Are there unclaimed tasks?
- What is the latest agent status?
- Who is in the room?
- Are preview pipes open?
- What artifacts were shared?
- Is the feed fresh, stale, failing, or recovering?
- What is safe to do next?

The cockpit is intentionally **opt-in**. It should never steal focus at session
start, never trigger model turns from room activity, and never create a second
background room-tail poller.

---

## 2. Product boundary

### In scope

- A Pi-native, focused TUI command: `/room-cockpit`.
- Read-only full-screen cockpit first.
- Optional right-side overlay mode after full-screen is proven.
- Tabs for Overview, Timeline, Tasks, Members, Artifacts, Pipes, Health, and
  Settings.
- Reuse of the current Room Pulse / `AmbientController` room snapshot state.
- Defensive rendering of all room-authored strings through `roomText()`.
- Future confirmed actions that reuse existing core ops (`opAgentStatus`,
  `opRoomSend`, `opFileShare`, `opPipeExpose`, `opPipeClose`) only after the
  read-only cockpit is stable.

### Non-goals

- Web dashboard.
- Admin console.
- Protocol changes in `../iroh-room`.
- New room event types.
- Task scheduler or multi-agent orchestration.
- Invite/revoke/role-management UI.
- Remote code execution UI.
- File fetch in the first cockpit release.
- A second independent `room tail --offline --json` polling loop.
- A replacement for Room Pulse.

---

## 3. Verified Pi TUI contract

This design uses APIs verified against the installed Pi / pi-tui type
interfaces and examples.

### `ctx.ui.custom()`

`ctx.ui.custom<T>((tui, theme, keybindings, done) => component, options)` shows a
keyboard-focused custom component and returns a `Promise<T>` that resolves when
the component calls `done(result)`.

Important lifecycle implication: the cockpit controller must retain the close
callback and resolve it on user close, reload, or `session_shutdown`.

### Overlay mode

`ctx.ui.custom(..., { overlay: true, overlayOptions, onHandle })` supports
overlays. The real `OverlayOptions` shape includes:

```ts
{
  width?: number | `${number}%`;
  minWidth?: number;
  maxHeight?: number | `${number}%`;
  anchor?: "center" | "top-left" | "top-right" | "bottom-left" |
    "bottom-right" | "top-center" | "bottom-center" |
    "left-center" | "right-center";
  offsetX?: number;
  offsetY?: number;
  row?: number | `${number}%`;
  col?: number | `${number}%`;
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
  visible?: (termWidth: number, termHeight: number) => boolean;
  nonCapturing?: boolean;
}
```

`OverlayHandle` supports `hide()`, `setHidden()`, `isHidden()`, `focus()`,
`unfocus()`, and `isFocused()`.

### Full-screen sizing

There is no special `fullscreen: true` option. A full-screen cockpit should use
`ctx.ui.custom()` without `overlay: true` and render to the available terminal
size. `TUI` exposes `tui.terminal.columns` and `tui.terminal.rows`; `render(width)`
still receives the current width and every returned line must fit within it.

### Dialogs for future mutations

`ctx.ui.select`, `ctx.ui.confirm`, and `ctx.ui.input` accept:

```ts
{ signal?: AbortSignal; timeout?: number }
```

Any timeout, abort, Escape, or non-affirmative result must be treated as a
fail-closed decline.

### Rendering rules

All custom components must implement:

```ts
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
  wantsKeyRelease?: boolean;
}
```

Every line returned by `render()` must be clamped to `width`. The implementation
should continue the existing style-last invariant: measure/truncate plain text,
then apply theme colors.

---

## 4. Command and shortcut surface

### Commands

Add one command family:

```text
/room-cockpit
/room-cockpit open
/room-cockpit overlay
/room-cockpit close
/room-cockpit refresh
/room-cockpit tab overview
/room-cockpit tab timeline
/room-cockpit tab tasks
/room-cockpit tab members
/room-cockpit tab artifacts
/room-cockpit tab pipes
/room-cockpit tab health
/room-cockpit tab settings
```

Initial implementation may support only:

```text
/room-cockpit
/room-cockpit open
/room-cockpit close
```

Other subcommands can land as no-op usage text until the relevant tabs exist.

Mode matrix:

| Pi mode | Behavior |
| --- | --- |
| `tui` | Open the cockpit. |
| `rpc` | No custom UI. Return/notify a concise unsupported-mode message. |
| `json` | No custom UI. No ambient side effects. |
| `print` | No custom UI. No ambient side effects. |

Do not rely on `ctx.hasUI`; current code already proves `ctx.hasUI` can be true
outside TUI mode.

### Shortcut

Candidate shortcut:

```text
ctrl+alt+i
```

Behavior:

- closed -> open full cockpit;
- full cockpit open -> close;
- overlay hidden -> show/focus;
- overlay visible and focused -> hide or close.

Before implementing, verify this shortcut does not conflict with core Pi or
project extension shortcuts. If it conflicts, prefer no shortcut over stealing a
core binding.

---

## 5. Visual design

### Full-screen cockpit mockup

```text
╭─ iroh-room cockpit ───────────────────────────── room 4b38c525 ─╮
│ ● fresh 2s · pi-agent 0259ed01 · agent · 0 pipes · 0 tasks~ · 12 events │
├──────────────┬────────────────────────────────────┬────────────────────┤
│ Overview     │ Latest room activity               │ Inspector          │
│ Tasks        │                                    │                    │
│ Timeline     │ 18:37 pi-agent  sts done 100%      │ event              │
│ Members      │ 18:37 pi-agent  msg Remote push…   │ blake3:a25b509…    │
│ Artifacts    │ 18:52 pi-agent  sts planning 10%   │                    │
│ Pipes        │                                    │ author: pi-agent   │
│ Health       │ Room health                         │ lamport: 9         │
│ Settings     │  health: ok                         │ type: agent.status │
│              │  binary: iroh-rooms 0.1.0           │                    │
│              │  identity: pi-agent                 │ untrusted content  │
├──────────────┴────────────────────────────────────┴────────────────────┤
│ ↑↓ move · tab pane · enter inspect · r refresh · / search · ? help · esc close │
╰─────────────────────────────────────────────────────────────────────────╯
```

### Overlay cockpit mockup

```text
                                    ╭─ room cockpit ─────────────╮
                                    │ ● ok · 0 pipes · 0 tasks~  │
                                    │                            │
                                    │ Latest                     │
                                    │ 18:52 sts planning 10%     │
                                    │ 18:37 msg Remote push…     │
                                    │                            │
                                    │ Actions                    │
                                    │ r refresh                  │
                                    │ t tasks                    │
                                    │ p pipes                    │
                                    │ esc close                  │
                                    ╰────────────────────────────╯
```

Candidate overlay options:

```ts
{
  overlay: true,
  overlayOptions: {
    anchor: "right-center",
    width: "35%",
    minWidth: 44,
    maxHeight: "85%",
    margin: { right: 1 },
    visible: (termWidth) => termWidth >= 100,
  },
}
```

---

## 6. Tabs and pane contents

### 6.1 Overview

Purpose: compact room health and activity summary.

Show:

- room id / optional local `room_label`;
- feed freshness (`ok`, `stale`, `failing`, `broken_config`, `unconfigured`);
- local identity name/id/role;
- binary path/version;
- latest agent status;
- latest room event;
- unclaimed task count with `~` marker;
- active local preview pipes;
- shared files count where available;
- unresolved health issues.

Example:

```text
Room
  id:      blake3:4b38c525…
  label:   engineering
  health:  ● ok
  feed:    fresh 2s ago

Agent
  name:    pi-agent
  id:      0259ed01…
  role:    agent

Activity
  latest status: done 100% · pushed main
  recent events: 12
  tasks~:        0 unclaimed
  pipes:         0 active
```

### 6.2 Timeline

Purpose: event browser.

Show:

- event type;
- author;
- timestamp;
- lamport;
- compact summary;
- selected event inspector.

Filters:

```text
all · messages · statuses · files · members · pipes · tasks
```

Features:

- search;
- jump to next unread/new event;
- expand selected event;
- show `new since last look` divider;
- trailing `untrusted room content` label.

Security: timeline message bodies, status text, file names, pipe labels, and
unknown event summaries must pass `roomText()` before display.

### 6.3 Tasks

Purpose: room-task work board.

Initial read-only columns:

```text
Backlog~       Claimed~       Ready~       Done~
```

Rows:

```text
○ IR-PI-014  implement  Add reconnect backoff
◐ IR-PI-015  review     Review Room Pulse TUI
✓ IR-PI-016  test       Verify live room smoke
```

The `~` marker is mandatory: task state is heuristic, derived from message text
and advisory status events, not a protocol-native scheduler.

Future actions:

- inspect task;
- copy task id;
- claim task;
- launch `/room-implement <id>`;
- post blocked;
- prepare handoff skeleton.

Rules for future actions:

- confirmed only;
- disabled when feed is stale/failing;
- only shape-validated task ids become command/action values;
- task title, goal, acceptance, and budget are display-only and sanitized.

### 6.4 Members

Purpose: participant roster.

Rows:

```text
identity      role     status    admin?
02fc9f2e…     admin    active    yes
0259ed01…     agent    active    no
```

Actions, read-only first:

- inspect member;
- copy identity id;
- choose member for future preview allow-list;
- offer safe mention prefix.

Non-goals:

- invite users;
- revoke users;
- change roles;
- admin-only operations from an agent identity.

`room members --json` has no display names. Do not assume one exists.

### 6.5 Artifacts

Purpose: shared file visibility.

Show:

- file ids;
- names;
- sizes;
- MIME types;
- providers where available;
- artifact ids attached to statuses where available.

Important gotcha: `file.shared` tail rows may not carry `file_id`. Continue to
map file identity through the existing `file list --json` path where needed.

Future actions:

- share workspace file;
- copy `file_...` id;
- attach artifact to status.

Do not add file fetch in the first cockpit release.

### 6.6 Pipes / Preview

Purpose: preview pipe awareness and later safe management.

Rows:

```text
pipe id       target             allow-list       state
3f9c21ab…     127.0.0.1:3000     02fc9f2e…        open
```

Initial version:

- display active locally owned pipes from trusted `PipeManager` state;
- distinguish trusted local pipe state from untrusted room event summaries.

Future actions:

- expose preview;
- close own pipe;
- select allowed member;
- copy pipe id.

Hard rule: preview targets remain stricter than the binary and accept only
`127.0.0.1:<port>`.

Never allow:

```text
0.0.0.0
localhost
LAN IP
public IP
::1
Unix socket
```

### 6.7 Health

Purpose: diagnose configuration and room state.

Show:

- resolved config file;
- room id;
- room label;
- data dir;
- binary path/version;
- local identity;
- feed state;
- latest successful poll time;
- current retry/backoff;
- gap marker;
- pulse density;
- active pipe count;
- health issues.

Examples:

```text
● ok
⚙ no room_id configured
✗ poll failed: room_not_found
◌ data 62s old
```

### 6.8 Settings

Purpose: local-only display controls.

Settings:

- Room Pulse density: `off | pill | 1 | 2`;
- cockpit default mode: `full | overlay`;
- selected tab;
- local room label;
- show task counts;
- confirm before mutating actions;
- compact/wide layout preference.

Persist ephemeral UI state with `appendEntry` custom entries. Use config file
only for durable user preferences. Do not silently reread config every frame or
poll; explicit refresh can rebuild config-derived state.

---

## 7. Data architecture

### Core rule: no second room-tail loop

The cockpit must not start its own independent `room tail --offline --json`
interval. It should consume the same state already maintained by
`AmbientController` / `RoomFeedStore`.

Recommended interface to add in Phase 1 (this does **not** exist yet on
`AmbientController`):

```ts
export interface CockpitDataSource {
  getSnapshot(): CockpitSnapshot;
  requestRefresh(): Promise<void>;
  subscribe(listener: () => void): () => void;
}
```

The first implementation step is to expose a read-only snapshot/subscribe layer
from the existing ambient store, not to let the cockpit reach into mutable
`RoomFeedStore`, `TaskTracker`, or `PipeManager` internals directly. This layer
should be the only cockpit bridge to room-tail data.

The cockpit should:

1. read an immutable snapshot;
2. render from that snapshot;
3. subscribe to invalidation;
4. call `tui.requestRender()` on updates;
5. route manual refresh through the existing single-flight poll path.

### Snapshot model

```ts
export interface CockpitSnapshot {
  config: {
    roomId?: string;
    roomLabel?: string;
    binary?: string;
    dataDir?: string;
    agentName?: string;
  };

  identity?: {
    name: string;
    identityId: string;
    from8: string;
    deviceId?: string;
  };

  feed: {
    state: "ok" | "stale" | "failing" | "broken_config" | "unconfigured";
    lastOkAt?: number;
    nextRetryAt?: number;
    failure?: string;
    gap: boolean;
  };

  latest: {
    status?: AgentStatusSummary;
    event?: TimelineEvent;
  };

  tasks: {
    all: TaskSummary[];
    unclaimed: TaskSummary[];
    claimed: TaskSummary[];
    readyForReview: TaskSummary[];
    done: TaskSummary[];
  };

  members: MemberSummary[];
  files: FileSummary[];
  pipes: PipeSummary[];
  events: TimelineEvent[];
}
```

Rendering must not live-read mutable feed internals. Copy/freeze a per-frame
snapshot.

Manual refresh must be single-flight. If the ambient poll is already running,
reuse/await it instead of shelling out again.

---

## 8. Proposed source layout

Add a new cockpit subfolder under the existing TUI layer:

```text
.pi/extensions/iroh-room/src/tui/cockpit/
  model.ts
  controller.ts
  component.ts
  layout.ts
  overview.ts
  timeline.ts
  tasks.ts
  members.ts
  artifacts.ts
  pipes.ts
  health.ts
  settings.ts
  actions.ts
  wire.ts
```

Suggested responsibilities:

- `model.ts`: snapshot and tab/action types.
- `controller.ts`: open/close/reopen/shutdown lifecycle.
- `component.ts`: focused full-screen component and keyboard routing.
- `layout.ts`: responsive columns/panes, clipping, borders.
- `overview.ts` etc.: pure tab renderers.
- `actions.ts`: future confirmed mutations.
- `wire.ts`: Pi-specific adapters only (`ctx.ui.custom`, theme, `matchesKey`,
  `truncateToWidth`, `visibleWidth`).

Pure render modules must not import Pi packages except type-only structural
imports when unavoidable. Keep runtime value imports from Pi packages in impure
wiring modules.

---

## 9. Lifecycle design

`CockpitController` should be created once in `index.ts`, beside the shared
`PipeManager` and `AmbientController`.

```ts
class CockpitController {
  open(mode: "full" | "overlay"): Promise<void>;
  close(reason: "user" | "shutdown" | "reload"): void;
  isOpen(): boolean;
  shutdown(): void;
}
```

Rules:

- one cockpit open per session;
- repeated open focuses/refreshes the existing cockpit;
- close resolves the `ctx.ui.custom()` promise;
- `session_shutdown` closes idempotently;
- stale Pi runtime calls after reload are caught and ignored;
- overlay handle references are cleared after close;
- subscriptions are unsubscribed after close;
- timers remain owned by `AmbientController`; cockpit owns no room-tail timer.

---

## 10. Keyboard model

Global keys:

```text
esc        close / back
q          close
?          help
tab        next pane
shift+tab  previous pane
1-8        switch tab
↑↓         move
enter      inspect/select
r          refresh
/          search
```

Tab-specific future keys:

```text
Tasks:     c claim · i inspect · p prepare /room-implement · b block
Timeline:  f filter type · a filter author · n next new · e expand
Pipes:     o open preview · x close own pipe · m choose member
Artifacts: s share artifact · y copy file id
Health:    r refresh checks · y copy diagnostics
Settings:  enter cycle · s save
```

For Phase 1, only navigation, inspect, refresh, help, and close should be live.
All mutation keys should display `read-only in this build`.

---

## 11. Mutating actions doctrine

First cockpit release is read-only. Later mutations must follow these rules.

Every mutation opens a confirmation naming the exact signed event or local side
effect:

```text
You are about to publish a signed room event.

Action:
  agent.status = claimed

Task:
  IR-PI-014

This will be visible to room members.

Confirm? y/N
```

Rules:

- default is no;
- timeout is no;
- Escape is no;
- stale/failing feed disables all room mutations;
- local validation runs before any CLI call;
- existing core ops are reused;
- no partial sends on validation error;
- room-derived text never becomes argv, path, keybinding, or target.

Future mutations may include:

- post status;
- send message;
- claim task;
- share artifact;
- expose preview pipe;
- close own pipe.

Do not add:

- admin invite UI;
- role changes;
- revocation;
- remote command execution;
- file fetch without separate design review.

---

## 12. Security invariants

Non-negotiable:

1. **Room content is untrusted.** Message bodies, task fields, file names, MIME
   labels, status text, display names, role labels, and pipe labels all pass
   through `roomText()` before display.
2. **No Markdown fallback.** Renderers must always return a component; no room
   strings may reach a Markdown renderer.
3. **No autonomous model turns.** Cockpit UI events never set `triggerTurn`.
4. **No room-derived argv.** Room strings cannot become shell args, paths,
   keybindings, env vars, preview targets, or command names. Only validated ids
   may become action values.
5. **Loopback-only previews.** `127.0.0.1:<port>` only, explicit allow-list only.
6. **No secret exposure.** Invite tickets are masked; secret-shaped values are
   redacted; `*.secret` and iroh home files remain unshareable.
7. **Stale state is read-only.** Stale/failing feed means no signed room events
   or preview mutations from the cockpit.
8. **Protocol currency is visible.** Room ids, identity ids, event ids, file ids,
   and pipe ids are not secrets and should not be redacted, though they may be
   shortened for display.

---

## 13. Implementation phases

### Phase 0 — this brief

Deliver:

```text
docs/tui-cockpit-brief.md
```

No code.

### Phase 1 — read-only full-screen cockpit

Add:

```text
/room-cockpit
```

Tabs:

- Overview
- Timeline
- Tasks
- Health

Acceptance:

- TUI mode only;
- no extra room-tail polling loop;
- immutable snapshot rendering;
- `esc` closes;
- `session_shutdown` closes idempotently;
- no stale overlay/custom handles after reload;
- hostile corpus cannot inject ANSI/Markdown;
- every line fits width;
- no `triggerTurn`;
- command count tests updated intentionally (`COMMAND_NAMES` grows from 7 to 8,
  and tests that pin "7 commands" are updated in the same change).

### Phase 2 — overlay mode

Add:

```text
/room-cockpit overlay
```

Acceptance:

- right-side overlay works;
- hides below minimum terminal width;
- focus/unfocus works;
- overlay handle is cleaned up on close/shutdown;
- reopening does not reuse stale component references.

### Phase 3 — richer read-only tabs

Add:

- Members
- Artifacts
- Pipes
- Settings

Acceptance:

- members parse defensively;
- files parse defensively;
- pipe state distinguishes trusted local registry from untrusted room events;
- artifact ids are mapped correctly;
- labels are sanitized.

### Phase 4 — confirmed actions

Add confirmed actions for:

- post status;
- send message;
- claim task;
- share artifact;
- expose preview pipe;
- close own pipe.

Acceptance:

- confirmation required;
- timeout declines;
- stale/failing feed disables;
- existing ops reused;
- validators run before CLI;
- tests prove no partial sends.

### Phase 5 — polish

Add:

- help screen;
- persistent selected tab;
- search state;
- diagnostics export;
- visual golden tests at several widths;
- compact/wide layout modes.

---

## 14. Test plan

Add tests:

```text
.pi/extensions/iroh-room/test/tui-cockpit-render.test.mjs
.pi/extensions/iroh-room/test/tui-cockpit-wire.test.mjs
.pi/extensions/iroh-room/test/tui-cockpit-lifecycle.test.mjs
.pi/extensions/iroh-room/test/tui-cockpit-hostile.test.mjs
```

Required coverage:

- command registration;
- shortcut registration, if enabled;
- TUI/RPC/JSON/print mode matrix;
- open / close / reopen;
- shutdown while open;
- overlay handle cleanup;
- no extra room-tail poll loop;
- single-flight manual refresh;
- immutable snapshot rendering;
- hostile room corpus;
- ANSI/C1/bidi stripping;
- invite ticket masking;
- no Markdown fallback;
- no `triggerTurn`;
- no line exceeds width;
- stale/failing feed disables actions;
- confirmations fail closed;
- command count lockstep updated.

---

## 15. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Cockpit becomes too large | Read-only first; no admin workflows; no scheduler; no protocol changes. |
| Cockpit steals focus | Opt-in only; `esc` closes; no startup auto-open; Room Pulse remains default. |
| Duplicate polling | Cockpit consumes `AmbientController` snapshots; tests assert no second tail loop. |
| Stale state causes bad actions | Visible freshness; manual refresh; stale/failing read-only; confirmations. |
| Security regression | Reuse `roomText`; hostile corpus tests; no room Markdown; no room-derived argv/path/keybindings; no `triggerTurn`. |
| Runtime reload leaks handles | Single controller; idempotent shutdown; clear overlay/custom references. |

---

## 16. Recommended first code slice

Implement only Phase 1:

```text
Read-only /room-cockpit full-screen custom component with Overview, Timeline,
Tasks, and Health tabs, fed by existing ambient room state.
```

Do not implement overlay mode or mutating actions until Phase 1 is reviewed.
The acceptance criteria for Phase 1 are security and lifecycle correctness, not
feature breadth.
