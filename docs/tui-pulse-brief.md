# Room Pulse — implementation brief (the improved prompt)

**Status: EXECUTED** (all three milestones implemented and reviewed; usage doc:
[`pi-harness.md` §Room Pulse TUI](pi-harness.md#room-pulse-tui)). One noted
delta: mention *matching* follows §3.3, and the optional `@mention` editor
provider was implemented as `@<from8>` completion (no display names exist in
`room members --json`). This was `docs/tui-cockpit-proposal.md` rewritten as a
grounded, self-contained implementation instruction after a six-reader verification pass
over pi v0.80.2's installed types **and compiled dist JS**, the extension source, the test
harness, the room-task grammar, and `docs/pi-harness.md`/`SPEC.md`. Where this brief and
the proposal disagree, **this brief wins** — every disagreement is a verified correction
(§2). Design thesis, mockups, invariants U1–U7, and milestone sequencing are inherited
from the proposal and not restated in full.

Target: `.pi/extensions/iroh-room/` (tabs, double quotes, NodeNext ESM `.js` relative
imports, zero runtime deps, strict tsc, node --test self-transpiling harness).
Worker and `../iroh-room` are untouched. New code lives in `src/tui/` plus minimal
touches to `index.ts`, `commands.ts`, `tools.ts`, `constants.ts`, `config.ts`,
`tsconfig.json`, `test/helpers.mjs`, `test/fixtures.mjs`.

## 1. Verified API contract (exact, from the installed pi 0.80.2)

Types file: `~/.asdf/installs/nodejs/22.22.3/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` (below: `types.d.ts`).

- `setWidget(key, content, options?)` — two overloads (types.d.ts:96–99). Factory form:
  `(tui: TUI, theme: Theme) => Component & { dispose?(): void }`. Factory is invoked
  **once, synchronously, at the `setWidget` call**; re-setting the same key disposes the
  old component; `undefined` removes it. String-array form is capped at 10 lines and
  word-wraps — factory form has **no cap and no wrap**, so it alone can guarantee the
  ≤2-line budget. `placement: "belowEditor"`.
- `Component` (pi-tui `tui.d.ts:10–31`): `{ render(width: number): string[]; invalidate(): void; handleInput?; wantsKeyRelease? }`.
  `invalidate()` is **required** and fires on theme change — rebuild any cached styled
  lines there. `render` is called every frame with the current width.
- `tui.requestRender(force?)` — repaint, coalesced at ~16ms. Never pass `force`.
- `setStatus(key, text | undefined)` (types.d.ts:78–79). Plain string.
- `notify(message, type?: "info"|"warning"|"error")`.
- `sendMessage<T>(msg: Pick<CustomMessage<T>, "customType"|"content"|"display"|"details">, options?: { triggerTurn?; deliverAs? })`
  (types.d.ts:867–870). `CustomMessage` = `{ role:"custom", customType, content: string | blocks, display: boolean, details?: T, timestamp }`.
  **`content` participates in LLM context** (session-manager.d.ts:212–219); **`details`
  does not** — this split is a security control, see §4 M0.
- `registerMessageRenderer<T>(customType, (message, {expanded}, theme) => Component | undefined)`
  (types.d.ts:864–865, 797–800). **If the renderer returns `undefined` or throws, the
  host renders `content` through the `Markdown` component** — a room-content renderer
  falling through is a Markdown-injection path. Renderers must always return a Component.
- Tool render slots: `renderCall` / `renderResult` on the tool definition; must return a
  `Component`; exceptions are swallowed with a fallback to default Text rendering.
  `AgentToolResult` has **no `isError`**; `context.isError` is only set when `execute()`
  throws. Our `{ok:false}` envelopes return normally — **error styling must key off the
  envelope**, not the context.
- Commands: `registerCommand(name, { description?, getArgumentCompletions?, handler(args, ctx) })`.
  `AutocompleteItem = { value, label, description? }`.
- **No host event fires when a slash command completes** (verified against dist JS:
  extension commands execute and return before the input event is emitted). The M1 poll
  boost is triggered (a) directly inside our own command handlers and (b) via the
  `tool_execution_end` event (`{toolCallId, toolName, result, isError}`, types.d.ts:563–570)
  filtered on `toolName.startsWith("iroh_")`.
- Events: `session_start` `{reason, previousSessionFile?}`; `session_shutdown`
  `{reason: "quit"|"reload"|"new"|"resume"|"fork", targetSessionFile?}`. After runtime
  replacement, stale `pi.*` calls **throw** — all timers must be torn down in
  `session_shutdown`.
- `ExtensionMode = "tui" | "rpc" | "json" | "print"` (types.d.ts:207). **`ctx.hasUI` is
  true in RPC too**, and in RPC `setWidget`/`notify` forward JSON-RPC notifications — the
  §8 mode matrix only exists if we guard `ctx.mode === "tui"` ourselves at every ambient
  surface.
- `theme.fg(color, text)` — **two arguments, not curried**. Valid colors include
  `accent, success, error, warning, muted, dim, text, toolTitle, toolOutput, customMessageText, customMessageLabel`;
  also `theme.bold/italic/underline(text)`. Pure modules must not reference the `Theme`
  class — inject a structural styler `type Styler = (color: string, text: string) => string`.
- `appendEntry(customType, data?)` persists a session entry, never sent to the LLM;
  read-back via `ctx.sessionManager.getBranch()` scanning `type === "custom"` entries by
  `customType` (this is the documented reconstruction pattern).
- `registerShortcut("ctrl+alt+r", { description?, handler })` — valid KeyId.
- `ctx.ui.addAutocompleteProvider(factory)` — factories **accumulate with no unregister**;
  guard with a module-level flag so session replacement within one process doesn't stack
  duplicates.
- pi-tui root exports usable at runtime (jiti aliases **only the bare specifier**):
  `truncateToWidth(text, maxWidth, ellipsis?="...", pad?=false)`, `visibleWidth(str)`,
  `sliceByColumn`, `wrapTextWithAnsi`. No deep subpath imports. Both width utils are
  ANSI-aware, but `truncateToWidth` **injects `\x1b[0m` when truncating styled text**
  (kills continuation styling; ellipsis renders unstyled) — the style-last invariant is
  load-bearing, not a testing convenience.
- `ctx.ui.confirm/select/input` take `{ signal?, timeout? }`; the resolved value on
  timeout is undocumented — treat anything other than an explicit affirmative as decline
  (fail-closed by construction).

## 2. Corrections to the proposal (all verified; fold in, do not re-litigate)

1. **`no_admin_reachable` cannot happen on the poll.** `room tail --offline` is a pure
   local sqlite read. Real poll failures: coded exit 2 (`room_not_found`,
   `invalid_room_id`), uncoded exit 1 (store/corruption), and **thrown** local errors
   from `runCli` (binary missing, 60s timeout) that never produce an `{ok:false}`
   envelope. The degraded-state pulse renders whichever of: `poll failed (<error_code>)`,
   `poll failed (exit N)`, `poll failed (binary missing)`, `poll failed (timeout)`.
2. **`tui.terminal.rows/columns` is typed and public.** The design still doesn't use it
   (`render(width)` supplies width); just don't restate the "unverified" claim.
3. **`theme.fg("error")` shorthand doesn't exist** — signature is `fg(color, text)`.
4. **Offline tail cost grows with total log size** (it re-validates and folds the whole
   room log each call), not with `--limit`. Cadences stay as designed but live in
   `constants.ts` and are injectable in tests; note the cost in the module doc comment.
5. **`agent.status` tail rows carry the label in `state`**; row-level `status` is
   *membership* state (`active`…) on every row. Reading `row.status` for claims silently
   never matches.
6. **`from` is the first 8 hex of the sender id.** Self-suppression and member
   correlation must compare `identity_id.slice(0, 8)`. `display_name` is
   attacker-controlled and optional.
7. **`room members --json`** = single-line `{room, admin: <id|null>, members: [{identity_id, role, status, is_admin}]}`.
   No display names — mention/member features must not assume any.
8. **`sendMessage` options doubt is resolved** — signature verified verbatim; also
   `deliverAs` exists but is irrelevant here (we never trigger turns).
9. **Tail row order is ascending `(lamport, event_id)`** over the most-recent `limit`
   rows; causally-incomplete events are excluded and may appear later with
   `lamport ≤ max` — confirming seen-ring over pure watermark.
10. **`UNTRUSTED_ROOM_CONTENT_NOTE` lives in `tools.ts:176–177`**, not constants. Import
    it from there; do not refactor it (tests import it from tools).

## 3. Decisions on the proposal's open questions (§10) — final

1. **`room_label`: yes.** New optional config key (string, ≤32 chars after trim,
   display-only, local). Pulse shows it instead of `roomId(8)` when set. Follows
   config.ts precedence/empty-string semantics; add config tests.
2. **UP-102 live tail: out of scope.** Keep `RoomFeedStore` transport-agnostic (it
   ingests parsed rows; it never shells out itself) so a stream child can replace the
   poll shell later. One sentence in the module doc; no speculative interfaces.
3. **Mention matching:** at init, fetch `identity show --json` once; match
   word-boundary, case-insensitive `@<display_name>` (only if name length ≥ 3) and
   `@<from8>` (our 8-hex prefix) against sanitized bodies. No configurable threshold
   (YAGNI). If identity fetch fails, mention detection is silently off for the session.
4. **Catch-up affordance:** the `/room` card always shows current unclaimed task ids
   (up to 5, `~`-marked). No separate "arrived while away" state — the count *is* the
   catch-up, and it's honest under init-toast-suppression.
5. **Task detector: duplicate, with full validity gating, plus conformance.** New
   `src/tui/tasks.ts` copies the four fence regexes verbatim from
   `tools/pi-room-agent/src/task-parser.ts:71–74` **and** the required-field gate
   (id/type/title present, type ∈ implement|debug|review|document|test) — without the
   gate the pulse permanently over-counts vs what the worker will claim. A new extension
   test spawns `.pi/skills/iroh-room-agent/scripts/parse-room-task.ts` (stdin, like the
   worker's conformance suite) over a shared hostile corpus in `test/fixtures.mjs` and
   asserts the extension detector extracts **exactly** the id set the canonical grammar
   accepts. Three-way lockstep; document in the module header.
6. **Wide-char integration golden: no.** Pure modules use an injected naive fit; correct
   emoji/CJK math delegates to pi-tui at runtime. Accepted, documented gap.

Additional decisions forced by groundwork:

- **`pipe_closed_own` (M2):** `PipeManager` has no death events and its registry
  self-cleans. Detection = per-tick diff of `pipes.list()` ids (trusted local state)
  against the previous tick, minus an `expectedCloses` set fed by our own
  `iroh_pipe_close` tool completions (via `tool_execution_end`) and `/room-unpreview`.
  Never keyed off tail `pipe.closed` rows (untrusted).
- **Task-id completion shape (U5):** completion *values* must match
  `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/` — a deliberate tightening for completions only
  (the grammar itself accepts any non-empty scalar); non-conforming ids are dropped from
  completions, never from tracking. Constant `TASK_ID_COMPLETION_RE` in `constants.ts`.
- **Config poll containment:** the feed never calls `resolveConfig` per tick. Ambient
  resolves config once at `session_start`; a resolve failure = "broken config" mode (one
  warning toast + dim `iroh ⚙ unconfigured` pill, no polling). No mid-session config
  re-reads for the ambient layer.
- **Members polling moves to M2** (its only consumers — completions, join toasts — are
  M2). M1 polls the tail only.
- **Density persistence:** `appendEntry("iroh-room.density", {density})` on change;
  `session_start` scans `ctx.sessionManager.getBranch()` for the latest such entry.
  Default density `2`. Optional config key `pulse_density` sets the *initial* default.

## 4. Milestones — module-by-module

House DI pattern everywhere: options-object injection with defaults
(`registerIrohTools(pi, {env, exec, pipes})` precedent). Pure modules import **nothing**
from `@earendil-works/*` (structural types only; `import type` is allowed but prefer
local structural types); all pi-tui **value** imports and all timers live in impure
wiring. Reuse `cli.ts` builders (`withDataDir`, tail args, `parseTailJson`,
`CODED_ERROR_RE`) — never hand-roll argv (equals-form + `--` discipline is load-bearing).

### M0 — output-channel upgrade (no timers, no polling)

New files (`src/tui/`):

- **`style.ts`** (pure): glyph constants (`● ◌ ✗ ⚙ ○ ⇄ ↻ ~`), structural
  `Styler`/`FitFn` types, identity styler, `cell()` helpers enforcing **style-last**:
  measure/truncate plain strings, apply color per finished cell, never let ANSI enter
  width math (invariant comment in the file). Column budgets: author ≤16, status label
  ≤12, file name ≤32, task title ≤40, id prefix 8.
- **`sanitize.ts`** (pure, imports `../redact.js`): `roomText(raw, maxCols, fit)`
  exactly as proposal §6, with one addition — slice input to 4096 code units **before**
  regex work (hostile 10kB+ bodies must not cost regex time). Order: pre-cap → `redact()`
  → ticket-mask (`/\broomtkt1[a-z2-7]+/gi` → `roomtkt1…[masked]`) → C0+DEL+C1 → space →
  bidi strip → whitespace collapse → trim → `fit(flat, maxCols)`. Do **not** reuse
  `CONTROL_CHARS_RE` from constants (narrower, non-global, misses C1).
- **`cards.ts`** (pure): line-builders for the `/room` health card and `/room-tail`
  events card (collapsed: header + last 4 rows + `N more · ctrl+o to expand ·
  untrusted room content`; expanded: all rows), given `(details, {expanded}, styler,
  fit, width)`. Every room string passes `roomText`. Unknown event types render as a
  dim generic row — never throw.
- **`toolviews.ts`** (pure): per-tool one/two-line call and result builders for all 10
  `iroh_*` tools. Success: compact themed row from envelope extras (event_id/file_id/
  pipe_id are protocol currency — show, don't mask). Failure (`ok:false`): styled
  `error` cell `failed (exit N[, code])` + the CLI's own `next:` hint when present —
  add `NEXT_HINT_RE = /^next:\s?(.*)$/m` applied to **redacted** stderr, hint rendered
  via `roomText`. `iroh_room_tail_snapshot` result keeps its `untrusted_note` framing
  visible.
- **`wire.ts`** (impure; the only M0 file importing pi-tui values): adapts
  `truncateToWidth`/`theme` into `FitFn`/`Styler`; builds `Component` objects (plain
  object literals satisfying the interface — `render` + mandatory `invalidate`);
  registers the `"iroh-room.card"` message renderer. The renderer **always returns a
  Component** (on bad/missing details: a one-line fallback Component, never
  `undefined`) — enforced by a hostile test, because fallthrough = Markdown injection.

Touches:

- **`tools.ts`**: attach `renderCall`/`renderResult` (from `toolviews.ts` via `wire.ts`
  adapters) to the 10 definitions. Envelope shapes unchanged. Tool count stays 10.
- **`commands.ts`**: in `ctx.mode === "tui"`, `/room` and `/room-tail` emit one
  `pi.sendMessage({customType: "iroh-room.card", content: <model line>, display: true, details})`
  instead of notify dumps; other modes keep today's `say()` text verbatim. Effectful
  commands (`room-status`, `room-send`, `room-share`, `room-preview`, `room-unpreview`)
  additionally emit a receipt card (`customType: "iroh-room.receipt"`, same renderer
  registry) after success, ≤1 line.
- **Security split (load-bearing):** card/receipt `content` (LLM-visible) is a neutral
  one-liner **containing zero room-authored text** — counts, ids, lamports, our own
  command's echo only (e.g. `[iroh-room] tail snapshot: 50 events, latest lamport 123`;
  receipt: `[iroh-room] status posted: implementing 45%`). All room-authored strings
  travel in `details` (renderer-only, never reaches the model). `triggerTurn` is never
  set. This keeps the rejected conversational design's injection surface closed while
  still curing the model's blindness to *our own* actions.
- **`constants.ts`**: new names (`CARD_TYPE`, `RECEIPT_TYPE`, budgets, `NEXT_HINT_RE`,
  `TASK_ID_COMPLETION_RE`) — added here only when shared across modules.
- **`tsconfig.json`**: add `paths` entry
  `"@earendil-works/pi-tui": ["/Users/sekou/.asdf/installs/nodejs/22.22.3/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.d.ts"]`.

### M1 — RoomFeedStore + pulse

- **`feed.ts`** (pure): `RoomFeedStore` — ingests **parsed rows** (`TailRow[]` from
  `cli.ts` `parseTailJson`; never shells out). `init(rows, now)` seeds watermark,
  2048-id seen-ring ordered by `(lamport ?? -1, event_id)`, zero signals (backlog
  suppression). `ingest(rows, now)` → `FeedDelta {freshRows, gap, recovered}` with the
  fast path (newest event_id + row count unchanged → no work). Rows without a string
  `event_id` are skipped (worker's tolerance), never thrown on. Gap: all rows unseen
  while a watermark exists → flag + request one deep repair poll. Staleness derived at
  render time from `now − lastOkAt`; failure state carries the §2.1 taxonomy.
- **`pulse.ts`** (pure): `renderPulse(snapshot, density, width, styler, fit) → string[]`
  (≤2 lines, hard-clamped per line) and `renderPill(snapshot) → string` (plain text,
  e.g. `iroh ● ○2~ ⇄1`). Freshness glyph always present (`● / ◌ data Ns old / ✗ … retry Ns`);
  task counts always `~`-marked; label = `room_label` or `roomId(8)`.
- **`ambient.ts`** (impure; the only timer home): resolve config once; if unconfigured →
  total silence; broken → one warning toast + `iroh ⚙ unconfigured` pill. Otherwise:
  deep init poll (`--limit=500`) then `setTimeout`-chained loop (every timer
  `unref()`'d, single-flight, 5s ambient / 2s×30s boost / 5→10→20→40→60s backoff),
  shelling via injected `exec` through `cli.ts` builders. Wires widget
  (`setWidget("iroh-room-pulse", factory, {placement:"belowEditor"})`, `dispose()` stops
  everything), `setStatus`, `tui.requestRender()` on change. Gated on
  `ctx.mode === "tui"` **and** density ≠ off (off ⇒ loop torn down, not just hidden).
  Boost hooks: our command handlers + `tool_execution_end` on `iroh_*`. Teardown runs
  inside the **existing single `session_shutdown` handler** in `index.ts` (the
  handler-count===1 test stays valid) and is idempotent.
- **`/room-pulse [off|pill|1|2]`** command (update `COMMAND_NAMES` + its deepEqual test
  in the same commit); no args → cycle. Persist via density appendEntry (§3).
- Feed-health toasts: `feed_failing` once per episode + matching `feed_recovered`.

### M2 — signal + flows

- **`tasks.ts`** (pure): detector per §3.5 + tracker (claimed = `Claiming task <id>`
  message-text signal — sufficient alone, the claimed status can legitimately never
  arrive — or `agent.status` with `state === "claimed"` mentioning the id; unclaimed =
  extracted − claimed, capped 50, always `~`).
- **`notify.ts`** (pure): classifier over `FeedDelta` → closed toast set (`task_new`,
  `mention` §3.3, `member_joined`/`member_removed`, `pipe_closed_own` §3, `feed_failing`/
  `feed_recovered`); init-watermark suppression, self-author suppression via `from8`,
  per-kind 30s cooldown, batching (N tasks ⇒ one toast). Toast text: room strings via
  `roomText`, ids shape-validated.
- **`complete.ts`** (pure): completion value filters — `--allow` → 64-hex member ids
  (members poll: every 6th tick, parsed defensively per §2.7), `--close` → 32-hex ids
  from `pipes.list()`, `#task-id` → tracked ids passing `TASK_ID_COMPLETION_RE`.
  Values failing validators are dropped (U5). Wire via `getArgumentCompletions` on the
  existing commands; the optional `@mention` provider registers once behind a
  module-level guard (§1 accumulate trap).
- Cards gain the new-since-last-look divider; member-pick `select` for `/room-preview`
  without `--allow`; `ctrl+alt+r` cycles density (same handler as `/room-pulse`).
- Mutating-flow doctrine (for anything later): ADW-style confirm naming the concrete
  signed event, fail-closed on timeout/undefined, mutating actions disabled while the
  feed is stale or backing off.

## 5. Test plan (extends the existing harness; zero new deps)

Harness changes (`test/helpers.mjs`):
- Recursive transpile: replace the flat readdir with
  `readdir(join(EXT_ROOT, "src"), { recursive: true })`, filter `.endsWith(".ts")`,
  `mkdir(dirname(outPath), {recursive:true})` before writing (add `dirname` import).
  `importModule("tui/pulse")` then works unchanged.
- Write a **pi-tui stub** into the temp `node_modules/@earendil-works/pi-tui` (same
  pattern as the typebox stub): naive `visibleWidth = [...s].length`,
  plain-string `truncateToWidth`, `sliceByColumn`, `wrapTextWithAnsi` passthrough — so
  `wire.ts`/`ambient.ts` are importable under test while runtime uses the real jiti
  alias.
- Extend `stubPi()` with recorder fakes: `sendMessage`, `registerMessageRenderer`,
  `registerShortcut`, `appendEntry`, `events`, and a `ctx.ui` recorder
  (`setWidget`/`setStatus`/`notify`/`addAutocompleteProvider`/`select`), plus a fake
  `sessionManager.getBranch()`. Keep the existing recorders' shapes untouched.

Suites (all `node:test` + `assert/strict`, tabs/double quotes, fixtures centralized in
`fixtures.mjs`, secret-shaped vectors assembled at runtime — gitleaks):
- **Golden renders** at widths 80/60/40 for pulse, pill, both cards, and 2–3 toolviews,
  as literal expected strings under the identity styler + naive fit.
- **Hostile corpus** `hostileTailRows`: ANSI/CSI, OSC 8 hyperlink, C1 bytes, bidi
  overrides, 12kB body, fence-nested task, `roomtkt1` ticket (runtime-assembled),
  chrome-spoofing display names, unknown event type, missing event_id/lamport.
  Invariants: no rendered line (any surface, expanded or collapsed) contains
  `\x1b`, C1 bytes, or `roomtkt1`; every line `length ≤ width`; the card renderer
  returns a Component for **every** hostile input (no `undefined`, no throw).
- **Model-visibility invariant**: for every card/receipt emitted over the hostile
  corpus, `content` contains no substring of any room-authored field (the §4 M0 split).
- **Feed tests**: scripted row sequences + injected `now` — init suppression, fast path,
  backfill within ring, ring eviction, gap + repair, backoff ladder + recovery episode,
  single-flight (via ambient with stubExec), boost window expiry, density-off teardown
  (no pending timers — assert via injected timer shims), teardown idempotence.
- **Conformance**: extension detector vs spawned `parse-room-task.ts` over the shared
  corpus — exact id-set equality (§3.5).
- **Lockstep updates**: `COMMAND_NAMES` deepEqual, tool count 10, session_shutdown
  handler count 1 — updated in the same commit that changes each.

Acceptance per milestone: `npm run typecheck` + `npm test` green in the extension;
`cd tools/pi-room-agent && npm test` untouched and green; no new deps in either
`package.json`; final smoke = headless load check (`pi --print` trust recipe) confirming
the extension registers without UI side effects in non-tui modes.

## 6. Invariants carried over verbatim (enforce, don't restate)

Proposal §6 U1–U7 and the style-last invariant apply exactly as written, with U5's
task-id shape now defined (§3) and U2 sharpened by §1: *the renderer-fallthrough path is
the Markdown component, so "never feed room content to Markdown" concretely means "the
card renderer never returns undefined and never throws."* Redaction currency (64-hex,
`blake3:`, `file_`, 32-hex pipe ids, `roomtkt1`) stays unredacted in envelopes/cards'
protocol fields; tickets are additionally masked at the UI layer (U4).
