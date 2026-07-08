# iroh-room-pi-harness

[Pi Coding Agent](https://github.com/earendil-works/pi-mono) as the default
agent harness for [`kortiene/iroh-room`](https://github.com/kortiene/iroh-room):
an invited room agent that watches room events, claims tasks, codes locally,
posts signed `agent.status` updates, shares verified artifacts, and exposes
loopback previews over private P2P pipes — all by shelling out to the existing
`iroh-rooms` CLI. Zero protocol changes; `iroh-room` stays harness-neutral.

## Layout

```text
.pi/extensions/iroh-room/    Pi extension: iroh_* tools + /room* slash commands
.pi/skills/iroh-room-agent/  Agent skill (SKILL.md + helper scripts)
.pi/prompts/                 /room-implement, /room-review, /room-debug templates
tools/pi-room-agent/         Headless worker (Pi RPC mode; integration pending)
docs/pi-harness.md           Full documentation (setup, config, tools, security)
.iroh-room-pi.json.example   Config file template
SPEC.md                      Original implementation specification
```

## Quickstart

```bash
# 1. Build the CLI (sibling repo, read-only)
cd /path/to/iroh-room && cargo build --release

# 2. One-time room setup: identities, room, agent invite + join
#    (full walkthrough in docs/pi-harness.md — the agent needs its OWN
#    identity in its OWN data dir, and the admin online running
#    `room tail --accept-joins`; the agent joins with the admin's printed
#    listening address via --peer)

# 3. Configure this repo
cp .iroh-room-pi.json.example .iroh-room-pi.json
#    edit: room_id, iroh_rooms_home (agent data dir), iroh_rooms_bin

# 4. Start Pi here and trust the project
pi -a

# 5. Inside Pi
/room                                     # health check
/room-status observing harness online
/room-send Hello from Pi agent
```

Then assign work by posting a `room-task` fenced block in the room and running
`/room-implement <task id>`.

## Documentation

- [docs/pi-harness.md](docs/pi-harness.md) — setup, configuration reference,
  tool/command reference, room-task format, end-to-end test, security notes,
  troubleshooting.
- [SPEC.md](SPEC.md) — the implementation spec this repo follows.

Status: MVP complete; post-MVP in progress. The interactive extension, skill,
prompt templates, and Room Pulse TUI are functional and locally tested. Room
Cockpit is implemented through its read-only phases: full-screen mode, overlay
mode, and the richer Members / Artifacts / Pipes / Settings tabs. Confirmed
Cockpit mutations are not implemented yet. The headless worker has real config,
task parsing, status mapping, room-tail polling, claim plumbing, an
injectable Pi RPC drive, claim-conflict skipping, and task-named artifact
publication. Real Pi/iroh-room smoke tests have verified failed and successful
paths, including file sharing; broader automated integration coverage and worker
preview support remain before production readiness.

Quality gates: CI runs `npm ci`, `npm run typecheck`, and `npm test` for both
`.pi/extensions/iroh-room` and `tools/pi-room-agent`.

Local release checkpoint:

```bash
tools/release-check.sh
```

This runs extension + worker typecheck/tests and, when `.iroh-room-pi.json` or
the `IROH_ROOM_ID` / `IROH_ROOMS_HOME` / `IROH_ROOMS_BIN` environment variables
are available, the headless worker smoke dry-run preflight. A full mutating
headless smoke is opt-in only:

```bash
tools/release-check.sh --smoke-full
```

Not implemented (by design, for now): `iroh_file_fetch`, live tail streaming,
real Pi RPC integration coverage, task scheduling, budget enforcement,
sandboxing, SDK-native integration, and multi-agent coordination.
