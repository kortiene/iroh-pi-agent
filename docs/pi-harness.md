# Pi Harness for iroh-room (`iroh-room-pi-harness`)

A [Pi Coding Agent](https://github.com/earendil-works/pi-mono) harness that lets
an invited `iroh-room` agent watch room events, claim work, run coding tasks
locally, post signed status updates, share verified artifacts, and expose live
previews over private peer-to-peer pipes.

Everything shells out to the existing `iroh-rooms` CLI. No protocol changes, no
new event types.

## What it is / what it is not

**It is:**

- A project-local Pi extension (`.pi/extensions/iroh-room/`) exposing `iroh_*`
  tools and `/room*` slash commands that wrap the `iroh-rooms` CLI.
- A Pi skill (`.pi/skills/iroh-room-agent/`) that teaches the model safe
  room-agent behavior, plus prompt templates for implement/review/debug flows.
- A scaffolded headless worker (`tools/pi-room-agent/`) for autonomous
  operation via Pi's RPC mode.

**It is not:**

- A change to the `iroh-room` protocol. `iroh-room` stays harness-neutral:
  identity, membership, the signed event log, files, and pipes all live in the
  `iroh-rooms` binary. Pi is the *default reference harness*, not a protocol
  dependency; other harnesses can integrate against the same CLI surface.
- An agent framework, task scheduler, or sandbox (see
  [Out of scope](#out-of-scope-mvp)).

## Setup

### 1. Build the `iroh-rooms` CLI

```bash
git clone https://github.com/kortiene/iroh-room
cd iroh-room
cargo build --release
# binary: target/release/iroh-rooms
./target/release/iroh-rooms --version   # iroh-rooms 0.1.0
```

### 2. Create identities (separate homes!)

The agent must have its **own** identity in its **own** data directory — never
reuse the admin's home (see [Security notes](#security-notes)). The data
directory is chosen by `--data-dir <PATH>` > `IROH_ROOMS_HOME` env > platform
default (macOS: `~/Library/Application Support/iroh-rooms`).

```bash
# Admin (human), default home:
iroh-rooms identity create --name "alice"
iroh-rooms identity show
# name: alice
# identity_id: <64-hex>
# device_id: <64-hex>

# Agent, separate home:
iroh-rooms --data-dir ~/.iroh-pi-agent identity create --name "pi-agent"
iroh-rooms --data-dir ~/.iroh-pi-agent identity show --json
# {"version":...,"name":"pi-agent","identity_id":"<64-hex>",...}
```

### 3. Create the room and invite the agent (admin)

```bash
iroh-rooms room create "engineering"
# created room "engineering"
# room_id: blake3:<64-hex>

iroh-rooms agent invite <ROOM_ID> <AGENT_IDENTITY_ID>
# invite_id: <32-hex>
# role: agent
# ticket:
#   roomtkt1...
```

The ticket is key-bound to the agent's identity and grants the
least-privileged `agent` role.

### 4. Agent joins (admin must be online)

`room join` needs the admin reachable. The admin runs a tail session with
`--accept-joins`; its startup block prints a `listening:` line whose first
entry is the admin's dialable address (`<device_id>@<ip:port>`, followed by
comma-separated IPv6 alternates). Copy that first address and pass it to the
agent's join via `--peer`:

```bash
# Terminal A — admin (leave running):
iroh-rooms room tail <ROOM_ID> --accept-joins
# accepting joins: yes (...)
# listening: <device_id>@<ip:port>,...    <- copy the first <device_id>@<ip:port>

# Terminal B — agent:
iroh-rooms --data-dir ~/.iroh-pi-agent room join <roomtkt1...> \
  --peer "<device_id>@<ip:port>" --display-name "pi-agent" --timeout 20s
# joined: blake3:<event-id>
# role: agent
```

Without the `--peer` hint the join has to find the admin through network
discovery, which can time out with `error[no_admin_reachable]` (exit 6);
passing the admin's printed `listening:` address makes the join deterministic.

### 5. Configure the harness in your repo

In the repository where Pi will work, create `.iroh-room-pi.json` (start from
[`.iroh-room-pi.json.example`](../.iroh-room-pi.json.example)):

```json
{
  "room_id": "blake3:<64-hex>",
  "iroh_rooms_home": "~/.iroh-pi-agent",
  "iroh_rooms_bin": "/path/to/iroh-room/target/release/iroh-rooms"
}
```

A leading `~` in `iroh_rooms_home`, `iroh_rooms_bin`, or `artifact_dir` is
expanded to your home directory by the harness itself — JSON has no shell, so
nothing else expands it.

### 6. Start Pi and trust the project

Project-local `.pi/` resources (extension, skill, prompts) only load after the
project is trusted. Interactively, Pi shows a trust prompt on first start;
accept it, or start with:

```bash
pi -a    # --approve: trust project-local files for this run
```

Headless modes (`-p`, `--mode json`, `--mode rpc`) never show the prompt — pass
`--approve`, or save the trust decision first, or set the global setting
`defaultProjectTrust: "always"`. Run `/room` inside Pi to confirm the harness
is healthy.

## Configuration reference

Resolution order for every value:

```text
1. Explicit argument (tool input / command flag)
2. Environment variable (an empty value is treated as unset)
3. .iroh-room-pi.json in the current working directory
4. Safe default (or fail closed where no default is safe, e.g. room_id)
```

### Environment variables

| Variable | Meaning |
| --- | --- |
| `IROH_ROOM_ID` | Target room id (`blake3:<64-hex>`). |
| `IROH_ROOMS_HOME` | iroh-rooms data directory. When set (here or in the config file) the harness passes `--data-dir <abs path>` on **every** CLI call, which deterministically beats the env var the binary itself reads. |
| `IROH_ROOMS_BIN` | Path to the `iroh-rooms` binary. Harness addition (the CLI itself does not read it). If unset, `iroh-rooms` is looked up on `PATH`. |
| `IROH_ROOM_AGENT_NAME` | Agent display name used in claim messages. |
| `IROH_ROOM_DEFAULT_PROGRESS` | Default `--progress` for status posts when none is given. |
| `IROH_ROOM_ALLOWED_PREVIEW_MEMBER` | Default allowed member (64-hex identity id) for `/room-preview`. |
| `IROH_ROOM_ARTIFACT_DIR` | Extra directory (outside the workspace) whose files may **also** be shared as artifacts; files inside the workspace cwd are always shareable. Nothing is created on disk. The extension has no default; the worker defaults to `<cwd>/artifacts`. |
| `IROH_ROOM_LABEL` | Display-only room label for the pulse widget/pill (trimmed, <= 32 chars). Local, never sent to the room. |
| `IROH_ROOM_PULSE_DENSITY` | Initial pulse density: `off`, `pill`, `1`, or `2` (see [Room Pulse TUI](#room-pulse-tui)). |

### `.iroh-room-pi.json` keys (all optional)

| Key | Type | Notes |
| --- | --- | --- |
| `room_id` | string | Must match `blake3:<64 lowercase hex>`; anything else is rejected (fail closed). |
| `iroh_rooms_home` | string | Data dir; a leading `~` is expanded by the harness; relative paths resolve against the repo cwd. |
| `iroh_rooms_bin` | string | Binary path; must exist and be a file; `~` is expanded; relative paths resolve against cwd. |
| `agent_name` | string | Default `pi-agent`. |
| `artifact_dir` | string | Extra allowed root for `iroh_file_share` paths besides the workspace cwd (see [Validation limits](#validation-limits-mirroring-iroh-rooms-core)); `~` is expanded. No default in the extension; the worker defaults to `artifacts`. |
| `default_progress` | integer | 0-100. |
| `default_preview_host` | string | Only `127.0.0.1` is usable. |
| `default_preview_port` | integer | e.g. `3000`. |
| `allowed_preview_members` | string[] | 64-hex identity ids. |
| `allow_artifact_paths_outside_workspace` | boolean | Default `false`; keep it that way unless you know why. |
| `room_label` | string | Display-only label shown in the pulse instead of the room id's first 8 hex; trimmed, <= 32 chars. Local, never sent to the room. |
| `pulse_density` | string | Initial pulse density: `off`, `pill`, `1`, or `2` (default `2`). A `/room-pulse` change during a session wins and persists per session. |

Malformed JSON — or a config file that exists but cannot be read (e.g. broken
permissions) — fails closed with an error naming the file. Unknown keys are
ignored (forward compatibility).

Binary resolution: `IROH_ROOMS_BIN` / `iroh_rooms_bin` if set, else
`iroh-rooms` on `PATH`; if neither resolves, every room operation fails closed
with a message explaining those options.

## Tools

Registered by `.pi/extensions/iroh-room/`. Every room-scoped tool accepts an
optional `room_id` that overrides the configured room. Two exceptions:
`iroh_identity_show` takes no arguments, and `iroh_pipe_close` takes only
`pipe_id` (the CLI infers the room from the local log).

| Tool | Purpose | Underlying CLI call |
| --- | --- | --- |
| `iroh_agent_status` | Post a signed `agent.status` event | `iroh-rooms agent status <ROOM> <STATUS> [--message <m>] [--progress <n>] [--artifact <id>]...` |
| `iroh_room_send` | Send a room message | `iroh-rooms room send <ROOM> <MESSAGE>` |
| `iroh_room_tail_snapshot` | Compact snapshot of recent events | `iroh-rooms room tail <ROOM> --offline --json --limit <n>` |
| `iroh_file_share` | Share a local file as a verified artifact | `iroh-rooms file share <ROOM> <PATH> [--name <n>] [--mime <m>]` |
| `iroh_pipe_expose` | Expose a loopback preview to allowed members | `iroh-rooms pipe expose <ROOM> --tcp 127.0.0.1:<port> --allow <id>... [--label <l>] [--expires <n>s]` |
| `iroh_pipe_close` | Close a pipe (extension-owned pipes are stopped directly; others via CLI) | `iroh-rooms pipe close <PIPE_ID>` |
| `iroh_pipe_list` | List open pipes | `iroh-rooms pipe list <ROOM>` |
| `iroh_room_members` | List room members | `iroh-rooms room members <ROOM> --json` |
| `iroh_file_list` | List shared files | `iroh-rooms file list <ROOM> --json` |
| `iroh_identity_show` | Show the local identity | `iroh-rooms identity show --json` |

`iroh_file_fetch` is deliberately **not** implemented in the MVP (post-MVP;
fetch files manually with `iroh-rooms file fetch <ROOM> <FILE_ID>` while the
sharer runs `room tail`).

Argv note: the CLI-call column above uses conventional usage notation. The
exact argv the harness emits passes option values in `--flag=value` form and
inserts a literal `--` separator before user-controlled positional text, so
messages, status labels, file names, and pipe labels that begin with `-`
(e.g. a Markdown bullet list) are passed through literally instead of being
misparsed as CLI flags.

### Validation limits (mirroring `iroh-rooms-core`)

- status label: required, 1-64 bytes, no control characters
- status message: <= 4096 bytes; progress: integer 0-100
- artifact ids: <= 16, each `file_<32-hex>` or bare 32-hex
- message body: 1-16384 bytes
- pipe target: exactly `127.0.0.1:<port>` (1-65535). The binary would accept
  all of `127.0.0.0/8` and `::1`; the harness is deliberately stricter.
- pipe allow-list: non-empty, each a 64-hex identity id
- artifact path: must exist, be a regular file, <= 100 MiB, and resolve
  (after symlinks) inside the workspace or the configured `artifact_dir`
  unless `allow_artifact_paths_outside_workspace` is true. The workspace cwd
  is always an allowed root; `artifact_dir` only *adds* a second one. Paths
  inside the resolved iroh-rooms home (the agent's data dir) and `*.secret`
  files are **always** refused, even with
  `allow_artifact_paths_outside_workspace`
- file name / mime overrides: <= 255 bytes each

### Result envelope

Success: `{ ok: true, event_id | file_id | pipe_id, ..., stdout, stderr? }`.
CLI failure (nonzero exit): `{ ok: false, exit_code, error_code?, error_detail?,
stdout, stderr }` — returned, not thrown. Local failures (validation, missing
config, binary not found, timeout) throw and surface as tool errors. All
stdout/stderr is secret-redacted and truncated to 8 KB.

`iroh_room_tail_snapshot` returns `{ ok, events, summary, untrusted_note }`
instead of raw stdout; `untrusted_note` travels with every snapshot and
reminds the model that event bodies and summaries are third-party room
content — untrusted input, not instructions.

Because `pipe expose` serves until interrupted, `iroh_pipe_expose` runs it as a
managed background child process: the tool returns once `pipe_id:` appears in
its output, the pipe keeps serving while the Pi session lives, and all pipes
are closed on session shutdown.

## Slash commands

| Command | Usage |
| --- | --- |
| `/room` | Show resolved config, identity, binary health, and active preview pipes. |
| `/room-status <status> [message...]` | Post `agent.status`; first token is the status label, the rest becomes the message. |
| `/room-send <message>` | Send a room message (everything after the command is the message; no quotes needed). |
| `/room-artifact <path> [name]` | Share a file; quote arguments containing spaces. |
| `/room-preview [--tcp 127.0.0.1:<port>] [--allow <64-hex>]... \| --close [pipe_id]` | Open a loopback preview pipe (defaults come from config), **or** close one/all with `--close` — an exclusive mode that cannot be combined with `--tcp`/`--allow`. |
| `/room-tail [limit]` | Render a recent-events snapshot. |
| `/room-pulse [off\|pill\|1\|2]` | Set the ambient pulse density; with no argument, cycle it (also bound to `ctrl+alt+r`). |
| `/room-cockpit [open\|overlay\|close\|refresh\|tab <overview\|timeline\|tasks\|health>]` | Open the read-only room cockpit in TUI mode; `overlay` opens it as a right-side overlay. |

A flag given without its value (e.g. a trailing `--tcp`) is a usage error, not
a silent fallback to the config default. Free-text arguments (messages, status
text) may start with `-`; they are passed to the CLI literally (see the argv
note in [Tools](#tools)).

In Pi's interactive TUI, `/room-preview` may also be given `--allow=`/`--close=`
values via argument completion (member ids from the members poll, live pipe
ids), `/room-send` completes `#<task-id>` from the heuristic task tracker, and
running `/room-preview` without `--allow` offers a member picker (labels are
identity-id prefixes lengthened until unique plus the role; the picker times
out after 60 s and declines — fail closed). In non-TUI modes the commands
behave exactly as the table above.

## Room Pulse TUI

In Pi's interactive TUI (and only there — RPC/JSON/print modes get none of
this), the extension adds an ambient, output-only "room pulse":

- **Pulse widget** (<= 2 lines below the editor) and a **footer pill**
  (`iroh ● ○2~ ⇄1`): feed freshness glyph (`●` ok, `◌ data Ns old` stale,
  `✗ poll failed (code) · retry Ns` failing, `⚙` broken config), latest
  status/event one-liner, unclaimed-task count, live pipe count. Density is
  controlled by `/room-pulse` / `ctrl+alt+r` (`off`, `pill`, `1`, `2`);
  `off` tears the poll loop down entirely. The chosen density persists per
  session; `pulse_density` config sets the initial default.
- **Feed**: `room tail --offline --json --limit=100` every 5 s (a pure local
  read — the admin is never contacted), boosted to 2 s for 30 s after any
  `/room*` command or `iroh_*` tool, with 5→10→20→40→60 s backoff on failure
  and one `feed failing` / `feed recovered` toast pair per episode. A deep
  `--limit=500` poll seeds the session (backlog never toasts). Members are
  polled every 6th successful tick. Note the offline tail folds the whole
  room log per call, so cost grows with log size, not `--limit`.
- **Transcript cards** replace text dumps for `/room` and `/room-tail`
  (`ctrl+o` expands; a dim `── new since last look ──` divider marks events
  newer than your previous `/room-tail`), and effectful commands
  (`/room-status`, `/room-send`, `/room-artifact`, `/room-preview`) emit
  one-line receipts so the *model* also sees what the human did.
- **Toasts** (closed set, 30 s per-kind cooldown, batched): new claimable
  task, `@you` mention (your identity's display name or 8-hex prefix), member
  joined/removed (from the trusted members poll), one of *our* preview pipes
  dying unexpectedly (from the trusted local pipe registry), feed
  failing/recovered.
- **Task counts are heuristic** and always rendered with a trailing `~`: the
  tracker re-implements the canonical room-task grammar (fence rules and the
  id/type/title validity gate) and a conformance test keeps it in lockstep
  with the worker parser and the skill script.

Security model (details in [Security notes](#security-notes)): every
room-authored string crosses one sanitizer (`roomText`) before any UI
surface — control/ANSI/C1 bytes, bidi overrides, and zero-width characters
are stripped **before** secret redaction and invite-ticket masking, so a
ticket or secret split by invisible characters still masks; room strings are
never fed to a Markdown renderer, never become argv/keybindings/paths, and
the model-visible `content` of cards/receipts carries counts and ids only,
never room-authored text (which travels display-only). Invite tickets are
masked at the UI layer even though tool envelopes deliberately pass them.
Unconfigured projects get total silence — no widget, no polls, no toasts.

## Skill and prompt templates

- `.pi/skills/iroh-room-agent/SKILL.md` — safe-behavior rules, workflow loop,
  status vocabulary, message templates. Pi advertises it to the model by
  name/description; force it with `/skill:iroh-room-agent`. Its
  `scripts/parse-room-task.ts` and `scripts/summarize-room-tail.ts` run with
  plain `node` (Node >= 22.18).
- `.pi/prompts/room-implement.md`, `room-review.md`, `room-debug.md` — invoked
  as `/room-implement <task>`, `/room-review <target>`, `/room-debug <issue>`.

> **Deviation from SPEC.md §14:** the spec sketched `{{task}}`-style
> placeholders. Pi prompt templates use shell-style placeholders (`$ARGUMENTS`,
> `$1`, `${1:-default}`); `{{...}}` does not exist in Pi. The templates
> therefore take the task/target as `$ARGUMENTS` and instruct the agent to
> fetch room and repo context itself via `iroh_room_tail_snapshot`.

## Room tasks

Work is assigned with structured Markdown inside ordinary room messages:

````markdown
```room-task
id: IR-PI-001
type: implement
title: Add Pi extension for iroh-room
repo: kortiene/iroh-room
branch: agent/ir-pi-001
goal: Implement the project-local Pi extension that exposes room tools.
acceptance:
  - /room works
  - /room-status works
budget:
  max_usd: 2.00
  max_minutes: 30
```
````

Fields: `id`, `type` (`implement | debug | review | document | test`), `title`
(all required); `repo`, `branch`, `goal`, `acceptance` (list), `budget`
(`max_usd`, `max_minutes`) optional. Budgets are advisory in the MVP — nothing
enforces them yet. A `room-task` block quoted inside another code fence (as in
the example above) is treated as documentation, not as a claimable task.

On claim, the agent sends a message
(`Claiming task IR-PI-001 as pi-agent. ...`) and posts
`agent.status = claimed`, progress 5. On completion it posts
`agent.status = ready_for_review`, progress 100, with artifact ids, and sends a
handoff message (summary / artifacts / next steps).

## Interactive workflow

1. Start Pi in the repo (trusted); `/room` to check health.
2. `/room-tail 50` or let the model call `iroh_room_tail_snapshot` to observe.
3. Paste or reference a task: `/room-implement IR-PI-001` (or paste the whole
   `room-task` block as the argument).
4. The model claims, plans, implements, tests, shares artifacts, posts
   `ready_for_review`, and sends the handoff — per the skill.
5. Reviewers fetch artifacts (`iroh-rooms file fetch ...`) and optionally view a
   live preview: you run `/room-preview --tcp 127.0.0.1:3000 --allow <their id>`
   and they run the printed `iroh-rooms pipe connect <ROOM_ID> <PIPE_ID> --local <PORT>`.

## Manual end-to-end test

The flow from SPEC.md §17.3, with real command syntax:

```bash
# 1. Build the CLI
cd /path/to/iroh-room && cargo build --release
export IROH_ROOMS_BIN="$PWD/target/release/iroh-rooms"

# 2. Human identity (admin home = platform default)
"$IROH_ROOMS_BIN" identity create --name "alice"

# 3. Create the room
"$IROH_ROOMS_BIN" room create "pi-harness-test"
# note the printed room_id: blake3:<64-hex>

# 4. Agent identity in a separate home
"$IROH_ROOMS_BIN" --data-dir ~/.iroh-pi-agent identity create --name "pi-agent"
"$IROH_ROOMS_BIN" --data-dir ~/.iroh-pi-agent identity show --json   # note identity_id

# 5. Admin invites the agent
"$IROH_ROOMS_BIN" agent invite <ROOM_ID> <AGENT_IDENTITY_ID>   # note the roomtkt1... ticket

# 6. Agent joins while the admin is online
# Terminal A (admin, leave running) — the startup block prints
# `listening: <device_id>@<ip:port>,...`; copy the first address:
"$IROH_ROOMS_BIN" room tail <ROOM_ID> --accept-joins
# Terminal B (agent) — pass the admin's listening address as --peer:
"$IROH_ROOMS_BIN" --data-dir ~/.iroh-pi-agent room join <roomtkt1...> \
  --peer "<device_id>@<ip:port>" --display-name "pi-agent" --timeout 20s
```

In the repo, write `.iroh-room-pi.json` (room_id, `iroh_rooms_home` pointing at
`~/.iroh-pi-agent` — the harness expands the `~` itself — and
`iroh_rooms_bin`), then:

```text
7.  pi -a                                       # start Pi, trust the project
8.  /room                                       # health: binary, identity, room_id
9.  /room-status claimed Testing Pi harness
10. /room-send Hello from Pi agent
11. mkdir -p artifacts && echo "# Test report" > artifacts/test-report.md
12. /room-artifact artifacts/test-report.md
13. python3 -m http.server 3000 --bind 127.0.0.1    # any loopback dev server
14. /room-preview --tcp 127.0.0.1:3000 --allow <MEMBER_IDENTITY_ID>
```

Verify all four event types landed:

```bash
"$IROH_ROOMS_BIN" --data-dir ~/.iroh-pi-agent room tail <ROOM_ID> --offline --json --limit 20
# expect rows with event_type agent.status, message.text, file.shared, pipe.opened
```

(or `/room-tail 20` inside Pi, or pipe the JSON through
`node .pi/skills/iroh-room-agent/scripts/summarize-room-tail.ts`).

## Headless worker (`tools/pi-room-agent`)

Design (SPEC.md §15): load config → verify identity (`identity show`) → tail
the room by polling `room tail --offline --json` and diffing on `event_id` →
detect `room-task` blocks in `message.text` bodies → claim → drive Pi in RPC
mode (`pi --mode rpc`, JSONL over stdin/stdout) → map Pi lifecycle events to
`agent.status` transitions (`agent_start` → `planning`, first tool execution →
`implementing`, test-ish bash → `testing`, `agent_end` → `ready_for_review` or
`failed`) → share artifacts → optionally expose a preview pipe.

Current status: **scaffold**. Config loading, the task parser, the status
mapper, and CLI arg-builders/parsers are implemented and unit-tested; the Pi
RPC drive, artifact publisher, and preview pipe are compiling stubs with
documented TODOs. Try it with:

```bash
cd tools/pi-room-agent
npm install
npm start -- --room blake3:<64-hex> --once --dry-run
```

Two gotchas, both fail-closed by design:

- **Dry-run still requires a room id.** Pass `--room <blake3:...>`, export
  `IROH_ROOM_ID`, or provide `room_id` via a config file; without one the
  worker exits 1 (`no room id configured`). It does not need the binary or an
  identity for the dry-run itself — the planned argv still prints.
- **`.iroh-room-pi.json` is resolved from the worker's own working
  directory.** `npm start` always runs with cwd `tools/pi-room-agent` (even
  via `npm --prefix`), so the repo-root config file from Setup step 5 is *not*
  picked up. Either pass `--room`/`--data-dir` (or the env vars) explicitly as
  above, or run the entry point from the directory that contains the config:

  ```bash
  # from the repo root (reads ./.iroh-room-pi.json):
  tools/pi-room-agent/node_modules/.bin/tsx tools/pi-room-agent/src/main.ts --once --dry-run
  ```

Remember the trust gotcha: a headless `pi` only loads this project's `.pi/`
resources with `--approve`/`-a` or a saved trust decision.

## Security notes

- **Identity isolation.** The agent uses its own `iroh-rooms` identity in its
  own data dir (`--data-dir` / `IROH_ROOMS_HOME`). No admin identity or human
  private key in the agent workspace. Agents join only through admin-issued,
  key-bound invites and hold the least-privileged `agent` role.
- **Loopback-only pipes.** `iroh_pipe_expose` / `/room-preview` accept exactly
  `127.0.0.1:<port>` and require an explicit member allow-list. Never expose
  public interfaces, the Docker socket, an SSH agent, or credential stores.
- **Untrusted content.** Room events are signed, but signed does not mean
  safe. The skill and every prompt template instruct the model to treat room
  content as untrusted: no secrets, no env vars, no private keys, no
  destructive commands without approval, no writes outside the workspace.
- **Redaction.** All CLI output surfaced to the model passes a conservative
  secret redactor (PEM private keys, AWS/GitHub/Slack/OpenAI-style tokens,
  JWTs, `key=value` credential pairs → `[REDACTED]`). Protocol identifiers
  (identity ids, `blake3:` ids, `file_` ids, pipe ids, tickets) are never
  redacted — they are the protocol's public currency.
- **Fail closed.** Missing `room_id`, unresolvable binary, missing identity,
  or invalid input aborts before anything is sent. Artifact paths must resolve
  inside the workspace (or `artifact_dir`) unless explicitly configured
  otherwise — and the agent's iroh-rooms data dir and `*.secret` files (e.g.
  `identity.secret`, the agent's private signing key) are never shareable,
  regardless of configuration.

## Known CLI gaps (Developer Preview)

- **No live machine-readable tail.** `--json` requires `--offline`; a live
  NDJSON stream is specified upstream but not landed. Machine consumers must
  poll `room tail --offline --json` and diff on `event_id`.
- **Live `room tail` renders only `message.text`** — status/file/pipe events
  show up only in offline reads.
- **`pipe expose` is long-running** (serves until Ctrl-C). The extension
  manages it as a background child; the pipe closes when the Pi session ends.
- **No `room list` command**, and **no `pipe list --json`** (text only).
- **Joins need the admin online** (`room tail --accept-joins`).
- **Delivery requires peers online.** `delivered: 0 (... stored locally only)`
  is normal: the event is signed and stored, and syncs when peers connect.
  Peers can only `file fetch` while a provider (e.g. the sharer running
  `room tail`) is online.

## Troubleshooting

CLI failures print `error[<code>]: <detail>` (sometimes a `next:` hint) on
stderr, with pinned exit codes:

| Exit | Category | Typical codes |
| --- | --- | --- |
| 1 | internal | uncoded errors |
| 2 | usage | `invalid_argument`, `invalid_room_id`, `no_such_file`, `file_too_large`, `identity_not_found`, `room_not_found`, `permission_denied` |
| 3 | auth | `wrong_identity`, `peer_unauthorized` |
| 4 | integrity | `hash_mismatch`, crypto rejects |
| 5 | ticket | invalid/expired/mis-bound invite tickets |
| 6 | connectivity | `no_admin_reachable`, `peer_offline`, `blob_unavailable` |

Tool results carry these through as `{ ok: false, exit_code, error_code, ... }`.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Tool error: binary not found | `iroh-rooms` not on `PATH`, no override set | Set `IROH_ROOMS_BIN` or `iroh_rooms_bin`, or install onto `PATH`; check `/room`. |
| `error[identity_not_found]` (exit 2) | No identity in the resolved data dir | Run `identity create` with the same `--data-dir`/`IROH_ROOMS_HOME` the harness uses; `/room` shows which. |
| `error[room_not_found]` (exit 2) | Wrong `room_id`, or the agent's home never joined this room | Verify the id; confirm membership with `room members <ROOM_ID> --json` from the agent home. |
| `room join` fails / hangs (exit 6, `no_admin_reachable`) | Admin offline, or no dialable address hint | Admin runs `room tail <ROOM_ID> --accept-joins` while the agent joins, **and** the agent passes the admin's printed `listening:` address via `--peer "<device_id>@<ip:port>"` (see Setup step 4). |
| Ticket rejected (exit 5) | Expired, or bound to a different identity | Re-issue `agent invite <ROOM_ID> <AGENT_IDENTITY_ID>` for the agent's actual identity id. |
| Exit 3 on an action | Acting with the wrong identity/role | Agents are least-privileged; admin operations need the admin's home. |
| `/room-preview` refuses the target | Non-loopback `--tcp` | Only `127.0.0.1:<port>` is accepted, by design. |
| Preview opens but nobody connects | Connector not allowed, or wrong id | `--allow` must list the connector's 64-hex identity id (`room members --json`). |
| `delivered: 0 (... stored locally only)` | No peers online | Normal — the event is stored and syncs later. |
| `/room*` commands or `iroh_*` tools missing in Pi | Project not trusted | Start `pi -a` once, or accept the trust prompt; headless runs need `--approve`. |
| Tool returns `ok: false` with `stderr` | CLI-level failure | Read `error_code`/`error_detail`, match against the exit-code table above. |
| Uncoded `error: unexpected argument '-...' found` (exit 2) on a message/status starting with `-` | Harness build predating the argv fix (option values in space form, no `--` separator) | Update the harness: current builds pass `--flag=value` and a literal `--` before positional text, so hyphen-leading content goes through literally. |

## Out of scope (MVP)

Deliberately not implemented: new protocol event types, the `iroh_file_fetch`
tool, live tail streaming, a task scheduler or claim-conflict resolution,
budget enforcement, sandboxed execution, multi-agent coordination, and
publishing any of this as packages. See SPEC.md §5.3/§20 for the longer-term
phases.
