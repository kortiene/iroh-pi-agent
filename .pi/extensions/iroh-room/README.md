# iroh-room — Pi extension

Project-local [Pi](https://github.com/earendil-works/pi) extension that lets a Pi coding
agent operate inside an [iroh-room](https://github.com/kortiene/iroh-room): post signed
`agent.status` updates, send room messages, read tail snapshots, share artifacts, and expose
loopback preview pipes — all by shelling out to the `iroh-rooms` CLI. No protocol changes,
no runtime dependencies.

## How it loads

Pi discovers `.pi/extensions/iroh-room/index.ts` automatically when you start `pi` in this
repo **after the project is trusted** (answer the trust prompt, or run `pi -a` to approve for
the session). The TypeScript is loaded raw via jiti — no build step, no `npm install` needed
at runtime; `typebox` and `@earendil-works/*` imports are aliased to Pi's bundled packages.
Use `/reload` inside Pi to pick up code changes.

## Tools (model-facing)

| Tool | What it does |
| --- | --- |
| `iroh_agent_status` | Post a signed `agent.status` (label ≤64 bytes, message ≤4096 bytes, integer progress 0..100, ≤16 artifact ids) |
| `iroh_room_send` | Send a room message (1..16384 bytes) |
| `iroh_room_tail_snapshot` | Offline read of recent events → compact summaries (no raw stdout; limit clamped 1..500, default 50) |
| `iroh_file_share` | Share a workspace file as a content-addressed artifact (≤100 MiB, path must resolve inside the workspace or `artifact_dir`) |
| `iroh_pipe_expose` | Expose `127.0.0.1:<port>` to explicitly allowed members via a background `pipe expose` child |
| `iroh_pipe_close` | Close a pipe (SIGINT→SIGKILL for pipes this session owns, CLI otherwise) |
| `iroh_pipe_list` | CLI pipe list + the pipes owned by this session |
| `iroh_room_members` | Offline member list (`--json`) |
| `iroh_file_list` | Shared files (`--json`) |
| `iroh_identity_show` | Local identity (`--json`) |

`iroh_file_fetch` is deliberately **not** implemented (post-MVP; see `docs/pi-harness.md`).

Envelope contract: success → `{ ok: true, event_id?/file_id?/pipe_id?, …, stdout, stderr? }`;
CLI failure → `{ ok: false, exit_code, error_code?, error_detail?, stdout, stderr }` (returned,
not thrown); local failures (validation, missing config, missing binary, spawn/timeout) throw.
All CLI output is secret-redacted and capped to 8 KB before entering an envelope.

## Slash commands

| Command | Usage |
| --- | --- |
| `/room` | Show resolved config, binary + version, identity, health, active preview pipes |
| `/room-status` | `/room-status <status> [message...]` (completes the advisory status vocabulary) |
| `/room-send` | `/room-send <message>` |
| `/room-artifact` | `/room-artifact <path> [name]` (quote paths with spaces) |
| `/room-preview` | `/room-preview [--tcp 127.0.0.1:PORT] [--allow <64-hex>]... \| --close [pipe_id]` |
| `/room-tail` | `/room-tail [limit]` |

## Configuration

Resolution order per value: explicit tool argument > environment variable >
`.iroh-room-pi.json` (in the Pi cwd) > safe default. See `.iroh-room-pi.json.example`
at the repo root and the full reference in `docs/pi-harness.md`.

Env vars: `IROH_ROOM_ID`, `IROH_ROOMS_HOME`, `IROH_ROOMS_BIN` (path to the binary; else
`iroh-rooms` is looked up on PATH), `IROH_ROOM_AGENT_NAME`, `IROH_ROOM_DEFAULT_PROGRESS`,
`IROH_ROOM_ALLOWED_PREVIEW_MEMBER`, `IROH_ROOM_ARTIFACT_DIR`.

Everything fails closed: malformed `.iroh-room-pi.json`, bad room ids, missing binary, or
invalid inputs produce clear errors and nothing is sent.

## Development

```sh
cd .pi/extensions/iroh-room
npm install        # dev-only: typescript + @types/node (runtime needs nothing)
npm run typecheck  # tsc --noEmit (paths in tsconfig.json point at the global pi install)
npm test           # node --test test/*.test.mjs (self-transpiling, no build artifacts)
```

The `paths` entries in `tsconfig.json` map `@earendil-works/*` and `typebox` to the globally
installed Pi package for **typecheck only**; update them if the node/pi version changes.
`src/config.ts`, `src/validate.ts`, `src/redact.ts`, `src/cli.ts`, and `src/pipes.ts` are
kept free of pi imports so the tests can import them directly after transpiling.
