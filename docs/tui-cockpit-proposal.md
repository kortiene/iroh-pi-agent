# Room Pulse — TUI proposal for the iroh-room Pi extension

**Status: IMPLEMENTED** — executed via the grounded rewrite in
[`tui-pulse-brief.md`](tui-pulse-brief.md) (which corrects several claims
below; where they disagree, the brief is right). Usage/security doc:
[`pi-harness.md` §Room Pulse TUI](pi-harness.md#room-pulse-tui). This
document is kept as the design-history record. Target:
`.pi/extensions/iroh-room/` on pi v0.80.2.

## How this proposal was produced

Three complete designs were developed independently from distinct philosophies, then
scored by a judge panel on seven criteria (API fidelity, user value, value-per-complexity,
poll robustness, security, testability, coherence with the existing extension):

| Candidate | Philosophy | Judge UX | Judge Risk |
|---|---|---|---|
| **Room Pulse (ambient-first)** | the room is peripheral vision | **62/70 — winner** | **61/70 — winner** |
| Conversation-native transcript | room events as transcript entries | 56/70 | 53/70 |
| Cockpit (full-screen dashboard) | mission control via `ctx.ui.custom()` | 53/70 | 51/70 |

Both judges independently picked Room Pulse. The proposal below is Room Pulse with the
panel's named grafts folded in (marked **[graft]**) and the losing designs' fatal flaws
avoided (see §9). Every API used was verified against the installed pi v0.80.2 type
definitions — nothing here is invented; the flagged doubt about `pi.sendMessage`'s
options argument was resolved against the real `types.d.ts`:

```typescript
sendMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
```

## 1. Thesis

The person at this keyboard is **coding**. The room is where work is assigned, observed,
and reviewed — not where they live. So the room gets the treatment a good status bar gets:

- **Always visible, never interposing.** A ≤2-line "room pulse" widget below the editor
  plus a compact footer pill. Pure output: never takes focus, never opens panels.
- **Interrupt only for signal.** Toasts for a small closed set of events (new claimable
  task, mention, membership change, one of *our* pipes dying, feed failure/recovery),
  throttled and batched.
- **On-demand depth without a mode.** The existing `/room*` commands render themed,
  collapsible transcript cards instead of `notify()` text dumps. No dashboard, no
  full-screen state, no focus ring.
- **The model sees what the human does.** One-line receipt entries for slash-command
  effects and compact tool renderers close today's gap where the model is blind to
  human-posted statuses. **[graft: conversational]**

Who it serves: the human supervising a room agent (is it alive? what's it doing? anything
waiting?), the human driving the agent (zero interruption, fast completions), and the
reviewer (what was shared, is the preview pipe still up).

Honesty doctrine: the feed is polled and the UI says so (freshness glyph always visible);
no invented metrics; heuristic state carries a `~` provenance marker **[graft: cockpit]**;
coded CLI errors render their `error[code]` plus the CLI's own `next:` hint verbatim
**[graft: cockpit]**.

## 2. Surfaces (all verified against pi v0.80.2)

| Surface | API | Role |
|---|---|---|
| `ctx.ui.setWidget("iroh-room-pulse", factory, { placement: "belowEditor" })` | factory form: `render(width)`, repaint via `tui.requestRender()` | The pulse (≤2 lines). Factory form because string-array widgets can't see width and are line-capped. `belowEditor` reads as status chrome, not content. |
| `ctx.ui.setStatus("iroh-room", text)` | composable footer pill | `iroh ● ○2 ⇄1` (feed health, unclaimed tasks, live pipes). Never `setFooter` — that replaces Pi's whole footer. |
| `ctx.ui.notify(msg, type)` | non-blocking toast | High-signal events only, classified + throttled (§5). |
| `pi.sendMessage({customType, content, display: true, details})` + `pi.registerMessageRenderer` | transcript cards | `/room` health card, `/room-tail` events card (collapsed/expanded via the global ctrl+o toggle); ~20-token receipts for slash-command effects. `triggerTurn` is **never** set from room-derived content. **[graft]** |
| Tool `renderCall`/`renderResult` | tool render slots | The 10 `iroh_*` tools stop dumping JSON envelopes; compact themed rows, errors in `theme.fg("error")`. |
| `getArgumentCompletions` / `ctx.ui.addAutocompleteProvider` | completions | `--allow` → member ids, `--close` → pipe ids, `#task-id` → validated task ids **[graft]**; `@mention` (M2, optional). |
| `pi.registerShortcut("ctrl+alt+r")` | one shortcut | Cycle pulse density `off → pill → 1-line → 2-line` (same handler as `/room-pulse`). |
| `truncateToWidth` / `visibleWidth` (injected) | width clamps | Final clamp at every component boundary; injected into pure modules so tests need no pi-tui. |

Deliberately **not** used: `setFooter`, `setHeader`, `setTitle`, `setWorking*`,
`custom()`, `onTerminalInput`, `setEditorComponent`, any `tui.terminal.*` field
(unverified — a fatal-flaw finding against the cockpit design).

## 3. Mockups (80 columns)

Steady ambient state (density `2`; last line is Pi's own footer with our pill at right):

```
................................ transcript ...................................
 ⏺ Bash(npm test -- ws.spec.ts) ✓ 12 passed

┌──────────────────────────────────────────────────────────────────────────────┐
│ > fix the flaky websocket reconnect test█                                    │
└──────────────────────────────────────────────────────────────────────────────┘
 ● room pi-agent·35ecc675  sts implementing 45%   ○ 2 tasks~  ⇄ 1 pipe   ↻ 4s
 └ 12:04 alice msg let's get the preview up before the demo, then we ca…
 main* · pi 45.1k↑ 3.2k↓ · $0.41                                 iroh ● ○2 ⇄1
```

New-task burst (one batched toast for N tasks; raw titles sanitized, ids shape-validated):

```
 ℹ iroh-room: new task ○ IR-PI-014 "Add reconnect backoff to ws client"
   — /room-tail to view, /room-implement IR-PI-014 to claim
```

Degraded state (backoff; last good snapshot stays, with honest age; toast fires once per
failure episode, with a matching recovery toast):

```
 ✗ room pi-agent·35ecc675  poll failed (no_admin_reachable) · retry 40s
 └ last 12:04 alice msg let's get the preview up before the de…   data 62s old
 main* · pi 45.1k↑ 3.2k↓ · $0.41                                 iroh ✗ ○2 ⇄1
```

`/room-tail` transcript card (collapsed; expanded shows all rows) with the
new-since-last-look divider **[graft: cockpit]**:

```
 ⏺ /room-tail 50
 ┌ room 35ecc675 · 50 events · last 12:11 · latest sts implementing 45% pi-agent
 │ 12:04 alice    msg let's get the preview up before the demo, then…
 │ 12:06 pi-agent sts implementing 45% wiring reconnect backoff
 │ ── new since last look ─────────────────────────────────────────────
 │ 12:10 pi-agent ⇄  pipe 3f9c21ab opened (preview)
 │ 12:11 bob      msg ```room-task id: IR-PI-014 type: implement titl…
 └ 45 more · ctrl+o to expand · untrusted room content
```

Unconfigured: total silence — no widget, no pill, no timer, no polls. Broken config: one
warning toast at `session_start` + a dim `iroh ⚙ unconfigured` pill, nothing else.

## 4. Data & refresh — `RoomFeedStore`

One store feeds every surface. Pure diff core + injected effects (exec/theme/fit/now),
in the extension's existing dependency-injection style.

- **Poll**: `room tail --offline --json --limit=100` every **5s** ambient (measured
  ~20ms warm ≈ 0.4% of a core), boosted to **2s for 30s** after any `/room*` command or
  `iroh_*` tool completes (recent interaction ≈ attention), exponential backoff
  5→10→20→40→60s on failure. Single-flight; `setTimeout` chain (not `setInterval`),
  every timer `unref()`'d; started only in `session_start` (tui mode only), torn down
  idempotently in `session_shutdown`. Density `off` tears the poll loop down entirely —
  no polling for an invisible surface. **[graft: cockpit]**
- **Members**: `room members --json` every 6th tick (~30s), for completions and
  join-toasts. **Pipes**: never polled — our pipes come free from the in-process
  `PipeManager.list()`; CLI `pipe list` is text-only and fetched on demand by `/room`.
- **Change detection**: fast path (newest `event_id` + row count unchanged → no work);
  diff via a ring-capped seen-set (2048 ids) ordered by `(lamport, event_id)`. The pure
  `(maxLamport, idsAtMax)` watermark from the conversational design was **rejected** as
  the sole mechanism: it silently drops gossip-backfilled events with `lamport ≤ max`
  (judge-confirmed data-loss flaw). The seen-ring tolerates backfill within its window.
- **Init**: one deep poll (`--limit=500`) at `session_start` seeds watermark, seen-ring,
  task tracker, own-status — and emits **zero toasts** (backlog suppression).
- **Gap detection**: all rows unseen + watermark exists ⇒ events may have scrolled past
  the limit; show `⚠ gap`, schedule one deep repair poll, clear.
- **Staleness is derived at render time** from `now − lastOkAt` (never a rottable flag):
  `●` ok → `◌ data 62s old` stale (>3× cadence) → `✗ poll failed (code) · retry Ns`.
- **State is in-memory, session-scoped.** The room log is the durable store; deep-poll
  re-init on session replacement reconstructs everything. No per-poll `appendEntry`.

Task tracking (heuristic, always rendered with `~`): scan `message.text` bodies for
top-level ```room-task``` fences (fence-in-fence is documentation — same rule as the
worker parser); claimed = later `Claiming task <id>` message or `agent.status`
state=claimed mentioning the id; `unclaimed = extracted − claimed`, capped at 50.

## 5. Toast classifier (closed set, throttled)

`task_new`, `mention` (word-boundary match on sanitized bodies), `member_joined`/
`member_removed`, `pipe_closed_own` (a registry pipe gone from the tail), `feed_failing`/
`feed_recovered` (once per episode). Rules: init-watermark suppression (nothing at or
below the boot watermark toasts), self-author suppression, per-kind 30s cooldown,
batching (three tasks ⇒ one toast). Toast-per-event was explicitly rejected — notify
spam is how extensions get disabled.

## 6. Untrusted-content rendering rules

Every room-sourced string (bodies, task fields, file names, status text, display names,
pipe labels) is attacker-controlled. One chokepoint, `roomText()`, enforced by tests:

```typescript
// src/tui/sanitize.ts — every room string passes through here before ANY UI surface.
const TICKET_RE = /\broomtkt1[a-z2-7]+/gi;
const CTRL_RE = /[\x00-\x1f\x7f-\x9f]/gu;                     // C0+DEL+C1 incl. ESC — kills ANSI/OSC injection
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/gu;  // bidi overrides/isolates
export function roomText(raw: string, maxCols: number, fit: FitFn): string {
	const masked = redact(raw).replace(TICKET_RE, "roomtkt1…[masked]");
	const flat = masked.replace(CTRL_RE, " ").replace(BIDI_RE, "").replace(/\s+/g, " ").trim();
	return fit(flat, maxCols);
}
```

- **U1** Control chars and bidi are dead on arrival — room content can never emit ANSI,
  move the cursor, set OSC titles/hyperlinks, or visually reverse a line.
- **U2** No markup interpretation, ever: room strings render as literal text; the
  `Markdown` component is never fed room content.
- **U3** Structural truncation budgets (author ≤16 cols, status label ≤12, file name
  ≤32, task title ≤40; summaries get the leftover) — content can't push chrome off the
  line; final `truncateToWidth` clamp at every component boundary.
- **U4** `redact()` first on every UI path, and **invite tickets are masked at the UI
  layer** (a `roomtkt1…` in a message must not sit in an always-on widget during a
  screen share) even though tool envelopes deliberately pass them. The cockpit design's
  omission of this was a judge-flagged fatal flaw.
- **U5** No room string ever becomes a keybinding, command, path, or argv. Completion
  *values* must match the existing validators (identity/pipe/task-id shapes) or the item
  is dropped; mention text goes into message bodies only; nothing room-derived reaches
  `setEditorText`/`pasteToEditor`; all argv keeps the `--flag=value` + `--` discipline.
- **U6** `triggerTurn` is never set from room-derived content — room activity must not
  be able to spend tokens or steer the agent. **[graft: conversational]**
- **U7** The untrusted framing survives rendering: cards carry a trailing dim
  `untrusted room content` tag, mirroring `UNTRUSTED_ROOM_CONTENT_NOTE`.
- **Style-last invariant** (written into `style.ts`): measure and truncate cells as
  plain strings, apply `theme.fg` per finished cell — ANSI never enters width math.
  **[graft: cockpit]**

Mutating-flow doctrine for anything the TUI grows later (claim buttons, pickers):
confirms use ADW-style wording naming the concrete signed event to be published, with a
fail-closed timeout, and **mutating actions are disabled while the feed is stale or in
backoff**. **[graft: cockpit]**

## 7. Phased plan

Re-sequenced per the judges: the zero-timer output upgrade ships before any polling.

**M0 — output-channel upgrade (no timers, no polling; ~3–4 days, ~600 src LOC)**
`style.ts` (glyphs, budgets, style-last invariant), `sanitize.ts` (`roomText`),
`cards.ts` (`/room` health card, `/room-tail` events card via
`sendMessage`+`registerMessageRenderer`), `toolviews.ts` (`renderCall`/`renderResult`
for all 10 tools), receipts (`iroh-room.receipt`, ~20 model-visible tokens acking the 6
slash commands' effects — closes the model's blindness to human-posted statuses).
Ships value alone: kills every notify dump in the extension today.

**M1 — the pulse (~1 week, ~700 src LOC)**
`feed.ts` (RoomFeedStore: diff core, watermark+seen-ring, backoff, gap, boost),
`pulse.ts` (renderPulse/renderPill, pure), `ambient.ts` (the only impure module: poll
shell, widget/status wiring, lifecycle), `/room-pulse` density command, feed-health
toasts, unconfigured silence, density-off = polling-off.

**M2 — signal + flows (~1 week, ~600 src LOC)**
`tasks.ts` (heuristic tracker, `~` provenance), `notify.ts` (classifier + throttles),
new-since-last-look divider on cards, `complete.ts` (`--allow`/`--close`/`#task-id`;
optional `@mention` provider re-added each `session_start`), member-pick `select` for
`/room-preview` without `--allow`, `ctrl+alt+r` shortcut, density persisted via one
`appendEntry` on change. Each item independently droppable.

Test strategy (extends the existing node --test self-transpiling harness; `helpers.mjs`
gains ~6 lines to transpile `src/tui/`): pure modules import nothing from
`@earendil-works/*` — theme/fit/now injected, so renders are asserted as plain strings.
Golden renders at widths 80/60/40; a `hostileTailRows` fixture set (ANSI, OSC 8, bidi,
10kB bodies, fence-nested tasks, ticket-bearing messages, chrome-spoofing display
names); one invariant test asserting no rendered line contains ESC, C1 bytes, or
`roomtkt1`; width property `line.length ≤ width` under the identity theme; feed tests
drive scripted stubExec sequences (watermark suppression, backoff, gap repair,
single-flight) with injected `now`.

## 8. Mode matrix

| Mode | Behavior |
|---|---|
| `tui` | Everything above. |
| `rpc` | No ambient (guard `ctx.mode !== "tui"`): no polling (the headless worker owns its own loop; double-polling one data dir is waste), no widget/toasts. Commands/tools unchanged; renderers registered but inert. |
| `json`/`print` | Identical to today: no timers, UI calls no-op, tools unchanged. |

Factory registers everything synchronously (required); all runtime gating lives in
`session_start`.

## 9. Rejected alternatives (with judge findings)

1. **Full-screen cockpit via `ctx.ui.custom()`** (the second candidate): occupies the
   editor slot and steals focus — the opposite thesis; scored lowest on
   value-per-complexity (M0 ≈ 1,100 LOC before first value); depended on the unverified
   `tui.terminal.rows`; omitted UI-layer ticket masking (both judge-flagged). Its best
   ideas are grafted instead (provenance markers, stale-action lockout, confirm wording,
   divider, style-last rule).
2. **Conversation-native transcript feed** (the third candidate): auto-appending
   sanitized-but-attacker-authored room content into persistent, model-visible session
   entries widens the prompt-injection and token-spend surface (2–4k tokens/hour worst
   case) — structurally rejected; its watermark had a judge-confirmed backfill data-loss
   flaw. Its best ideas are grafted instead (receipts for *user-initiated* actions only,
   `#task-id` completion, M0 sequencing, error-episode cards).
3. `setFooter` replacement (clobbers Pi's footer), `aboveEditor` placement (reads as
   content), string-array widgets (width-blind), a supervised live `room tail` child
   (renders only message.text — no feed benefit), per-poll `appendEntry` persistence
   (pollutes every branch), toast-per-event, Markdown rendering of room content,
   always-on 2s cadence — all rejected with reasons in the candidate docs.

## 10. Open questions

1. No `room list` exists (UP-101): pulse shows `roomId(8)`. Add an optional local
   `room_label` config key in the meantime?
2. When upstream live NDJSON tail (UP-102) lands, `RoomFeedStore` keeps its interface
   and swaps the poll shell for a supervised stream child — does `PipeManager`
   generalize into that supervisor?
3. Mention matching: also match the full identity id? Make the min-length threshold
   configurable?
4. Should `/room`'s card list "N tasks arrived while away" as a catch-up affordance,
   given init-watermark toast suppression?
5. `tasks.ts` re-implements the room-task detection conventions — share a module with
   the skill script / worker parser (must stay dependency-free), or accept duplication
   with a cross-fixture conformance test like the worker's?
6. Wide-char (CJK/emoji) budgets: add an integration-tier golden test through the real
   pi-tui `truncateToWidth`?
