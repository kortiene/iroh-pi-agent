# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`iroh-room-pi-harness`: the integration making **Pi Coding Agent** the default reference agent harness for `kortiene/iroh-room` (a peer-to-peer room substrate, sibling repo at `../iroh-room`). An invited room agent, powered by Pi, watches room events, claims `room-task` blocks, posts signed `agent.status` updates, shares artifacts, and exposes loopback-only preview pipes. `SPEC.md` is the requirements spec; `docs/pi-harness.md` is the authoritative usage/security doc.

## Commands

Extension (`.pi/extensions/iroh-room/` — self-contained, loaded raw by pi via jiti):

```bash
cd .pi/extensions/iroh-room
npm install          # devDeps only (typescript, @types/node); runtime is dependency-free
npm run typecheck    # tsc --noEmit (strict NodeNext; paths point at the global pi install)
npm test             # node --test test/*.test.mjs (self-transpiling harness)
node --test test/cli.test.mjs   # single file
```

Worker (`tools/pi-room-agent/` — npm + vitest + tsx):

```bash
cd tools/pi-room-agent
npm install
npm run typecheck
npm test                         # vitest run (includes the 19-case skill-script conformance suite)
npx vitest run test/task-parser.test.ts   # single file
npm start -- --room blake3:<64-hex> --once --dry-run   # offline smoke
```

Skill scripts are standalone erasable TS run with plain `node` (Node ≥22.18 type stripping): `node .pi/skills/iroh-room-agent/scripts/parse-room-task.ts <file>`.

## Hard Architectural Boundary (most important rule)

`iroh-room` stays **harness-neutral**: never modify `../iroh-room`, never add Pi-specific protocol events. The only integration surface is shelling out to the `iroh-rooms` CLI (binary not on PATH — resolve via `IROH_ROOMS_BIN` / `iroh_rooms_bin` config; locally `../iroh-room/target/release/iroh-rooms`).

## Cross-Package Contracts (enforced by tests — keep them in lockstep)

- **argv convention** (both `.pi/extensions/iroh-room/src/cli.ts` and `tools/pi-room-agent/src/room-cli.ts`): options in *equals form* (`--message=<m>`), then a literal `--`, then positionals; global dir as `--data-dir=<abs>` before the subcommand. This is load-bearing: clap rejects hyphen-leading values otherwise (e.g. markdown-bullet messages). Any builder change must land identically in both files.
- **room-task grammar**: `tools/pi-room-agent/src/task-parser.ts` is canonical; `.pi/skills/iroh-room-agent/scripts/parse-room-task.ts` is a grammar-identical standalone port. The conformance test (`tools/pi-room-agent/test/parser-conformance.test.ts`) spawns the script and diffs outputs — changing one without the other fails CI.
- **config semantics** (both `config.ts` files): precedence explicit arg > env > `.iroh-room-pi.json` (cwd) > default; empty-string env vars mean *unset*; leading `~` expanded for `iroh_rooms_home` / `iroh_rooms_bin` / `artifact_dir`; fail closed on missing room_id/binary and on unreadable-but-existing config.
- **tool envelope**: success `{ok:true, event_id/file_id/pipe_id, stdout}`; CLI failure returns `{ok:false, exit_code, error_code}` (parsed from stderr `error[<code>]:`) — never thrown; local validation/config errors throw. All CLI output is redacted + capped to 8KB first.

## Security Invariants (tested; do not weaken)

- Pipe targets: only `127.0.0.1:<port>` (stricter than the binary, which allows all of 127.0.0.0/8 + ::1). `allow` list mandatory, 64-hex identity ids.
- Artifact sharing refuses: paths outside cwd/artifact_dir (unless `allow_artifact_paths_outside_workspace`), anything inside the resolved iroh-rooms home, and any `*.secret` file — the last two unconditionally (agent private key exfiltration guard).
- Room content is untrusted (signed ≠ safe): the tail-snapshot tool carries `untrusted_note` framing; SKILL.md and all prompt templates carry prompt-injection defenses. Keep them when editing.
- Redaction (`redact.ts` / worker `room-cli.ts`) must NOT redact protocol currency: 64-hex ids, `blake3:` ids, `file_` ids, 32-hex pipe ids, `roomtkt1` tickets.

## Gotchas

- `pipe expose` blocks until Ctrl-C → the extension's `PipeManager` spawns it as a managed child, parses `pipe_id:` from stdout, and SIGINTs on close/session_shutdown. Grace/parse timeouts are constructor-injectable for tests.
- `room tail --offline --json` is the ONLY machine-readable event read (single-line JSON array; live tail renders message.text only). `file.shared` rows carry no `file_id` — map via `file list --json` blob_hash.
- Project-local extensions load only after pi trusts the project (`pi -a` or saved trust); headless runs silently skip `.pi/` without it.
- The repo has a gitleaks pre-commit hook: assemble secret-shaped test vectors at runtime (join/concat), never as literals.
- Real end-to-end verification needs the sibling binary: `cargo build --release` in `../iroh-room`; join flows need the admin online (`room tail --accept-joins`) and usually `--peer "<device_id>@<ip:port>"` from its `listening:` line.

## Style

Extension: tabs, double quotes, NodeNext ESM with `.js` extensions on relative imports, zero runtime deps (pi aliases `@earendil-works/*` + `typebox` at load). Worker + scripts: 2-space, single quotes, semicolons. No lint tooling — the gate is strict `tsc --noEmit` + tests.
