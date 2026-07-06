# pi-room-agent — headless iroh-room worker (SCAFFOLD)

Phase 3 scaffold (SPEC.md §15 / §20) of the headless worker that lets a
Pi-powered agent operate inside an iroh-room without a human at the terminal:
tail the room, detect ` ```room-task ` blocks, claim eligible tasks, drive Pi
over its RPC mode, stream Pi lifecycle events back as `agent.status`
transitions, and share final artifacts.

## Status: what is real vs scaffold

| Module | State |
|---|---|
| `src/config.ts` | REAL + tested. Precedence: explicit arg > env > `.iroh-room-pi.json` > default; fail-closed on malformed config/room ids/binaries. |
| `src/task-parser.ts` | REAL + tested. Canonical hand-rolled parser for the ` ```room-task ` YAML subset; never throws, returns `{tasks, errors}`. |
| `src/status-mapper.ts` | REAL + tested. Pure fold from Pi RPC events to `agent.status` transitions + `STATUS_VOCABULARY`. |
| `src/room-cli.ts` | REAL. Pure argv builders + stdout parsers (fixture-tested against the exact iroh-rooms 0.1.0 output formats) + secret redaction. The `spawnSync` runner is intentionally thin and untested. |
| `src/main.ts` | SCAFFOLD, tested orchestration. Arg parsing, config load, identity verify, poll-diff tail loop (mandatory startup priming with retry), task detection, claim plumbing all work and are covered by `test/main.test.ts` via an injected runner; the Pi drive is a TODO stub (posts `blocked` after claiming so the room sees an honest signal). Import-safe: `main()` only runs when executed directly. |
| `src/pi-rpc.ts` | SCAFFOLD. Protocol-correct JSONL client for `pi --mode rpc --no-session -a` (StringDecoder + manual `\n` scan — Node readline is not RPC-compliant). Compiles; not exercised end-to-end. |
| `src/preview-pipe.ts` | SCAFFOLD. Background `pipe expose` supervisor (resolve on `pipe_id:`, SIGINT→SIGKILL close, registry). Compiles; not exercised end-to-end. |
| `src/artifact-publisher.ts` | SCAFFOLD. Fail-closed artifact path validation (exists, regular file, ≤100 MiB, symlink-resolved workspace containment) + `file share` round-trip. Compiles; not exercised end-to-end. |

## Usage

```bash
npm install        # devDeps only (typescript, vitest, tsx, @types/node)
npm run typecheck
npm test

# no network, prints planned CLI argv (offline tail read runs if a binary is
# configured). Fails closed without a room id — pass --room, set IROH_ROOM_ID,
# or run in a directory whose .iroh-room-pi.json sets room_id:
npm start -- --room blake3:<64-hex> --once --dry-run

# one real poll iteration (requires room id + identity + iroh-rooms binary):
npm start -- --once

# continuous poll loop:
npm start -- --poll-interval 5
```

Flags: `--room <blake3:64-hex>`, `--data-dir <path>`, `--once`, `--dry-run`,
`--poll-interval <seconds>`, `--help`.

## Configuration

Resolution order per value: explicit argument > environment variable >
`.iroh-room-pi.json` (in cwd) > safe default. See `docs/pi-harness.md` at the
repo root for the full reference. Quick version:

- `IROH_ROOM_ID` — room id (`blake3:<64-hex>`, strictly validated)
- `IROH_ROOMS_HOME` — agent data dir; passed to every CLI call as `--data-dir`.
  Use a SEPARATE home for the agent identity — never a human/admin identity.
- `IROH_ROOMS_BIN` — path to the `iroh-rooms` binary (else found on PATH)
- `IROH_ROOM_AGENT_NAME`, `IROH_ROOM_DEFAULT_PROGRESS`,
  `IROH_ROOM_ALLOWED_PREVIEW_MEMBER`, `IROH_ROOM_ARTIFACT_DIR`

Everything fails closed: missing room id, unresolvable binary, malformed
config file, or invalid inputs produce clear errors and nothing is sent.

## Design notes

- The only integration surface is the `iroh-rooms` CLI (no protocol changes,
  AC11). There is no live JSON tail in iroh-rooms 0.1.0, so the loop is
  poll-diff: `room tail --offline --json --limit=200 -- <ROOM>` every N
  seconds, keyed on the set of seen `event_id`s. All argv uses equals-form
  options and a literal `--` before positionals so untrusted values starting
  with `-` are never parsed as flags.
- Pi is driven over RPC (`pi --mode rpc --no-session -a`); `-a`/`--approve` is
  required headlessly or the project's `.pi/` extension/skills/prompts are
  silently ignored (trust is never prompted in non-interactive modes).
- Status vocabulary (advisory, SPEC §12): idle, observing, claimed, planning,
  implementing, testing, sharing_artifacts, preview_available, blocked,
  ready_for_review, done, failed, cancelled.
- All CLI stdout/stderr that reaches logs passes through `redact()`
  (private keys, cloud/API tokens, KEY=value secrets); protocol ids
  (blake3:…, 64-hex identities, file_…, pipe ids, roomtkt1… tickets) are
  never redacted.

## Next steps (in order)

1. Enable the Pi drive: wire `PiRpcClient` + `mapPiEventToStatus` into
   `main.ts` `driveTaskWithPi()` (the wiring is sketched there), sending the
   task through the `.pi/prompts/room-implement.md` template.
2. Publish artifacts on `agent_end` via `artifact-publisher.ts` and post
   `ready_for_review` with the collected `file_…` ids + the SPEC §11.3
   handoff message.
3. Claim-conflict resolution: scan the tail for existing claims of a task id
   before claiming (currently a TODO; out of MVP scope per DESIGN §12).
4. Integration tests against a real `iroh-rooms` binary (loopback network
   stack) and a real `pi --mode rpc` child.
5. Longer term: replace the RPC subprocess with the Pi SDK
   (`createAgentSession`) for typed, in-process control (SPEC §15.3).

Out of scope for MVP (DESIGN §12): new protocol events, `iroh_file_fetch`,
live tail streaming, task scheduling, budget enforcement, sandboxing,
multi-agent coordination.
