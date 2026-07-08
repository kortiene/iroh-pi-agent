#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage: tools/release-check.sh [options]

Runs the local release/checkpoint gates:
  - clean working tree check (unless --allow-dirty)
  - Pi extension typecheck + tests
  - Headless worker typecheck + tests
  - optional headless worker smoke dry-run when room config is available

Options:
  --allow-dirty     Do not fail if git has local changes
  --skip-smoke      Skip the smoke:headless dry-run preflight
  --smoke-full      Run full smoke: posts a room-task and runs the real worker
                    (mutates the configured room; never use casually)
  --help            Show this help
USAGE
}

allow_dirty=0
skip_smoke=0
smoke_full=0
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) allow_dirty=1 ;;
    --skip-smoke) skip_smoke=1 ;;
    --smoke-full) smoke_full=1 ;;
    --help) usage; exit 0 ;;
    *) echo "unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() { printf '\n== %s ==\n' "$*" >&2; }
run() { printf '+' >&2; printf ' %q' "$@" >&2; printf '\n' >&2; "$@"; }

step "git state"
git status --short --branch
if [[ "$allow_dirty" -ne 1 ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree is dirty; commit/stash changes or pass --allow-dirty" >&2
  exit 1
fi

step "Pi extension quality gates"
run npm --prefix .pi/extensions/iroh-room run typecheck
run npm --prefix .pi/extensions/iroh-room test

step "Headless worker quality gates"
run npm --prefix tools/pi-room-agent run typecheck
run npm --prefix tools/pi-room-agent test

if [[ "$skip_smoke" -eq 1 ]]; then
  step "headless smoke dry-run skipped"
  exit 0
fi

room_id="${IROH_ROOM_ID:-}"
agent_home="${IROH_ROOMS_HOME:-}"
iroh_bin="${IROH_ROOMS_BIN:-}"
if [[ -f .iroh-room-pi.json ]]; then
  mapfile -t config_values < <(node <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cfg = JSON.parse(fs.readFileSync('.iroh-room-pi.json', 'utf8'));
const expand = (value) => {
  if (typeof value !== 'string') return '';
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
};
console.log(cfg.room_id ?? '');
console.log(expand(cfg.iroh_rooms_home));
console.log(expand(cfg.iroh_rooms_bin));
NODE
  )
  room_id="${room_id:-${config_values[0]:-}}"
  agent_home="${agent_home:-${config_values[1]:-}}"
  iroh_bin="${iroh_bin:-${config_values[2]:-}}"
fi

if [[ -z "$room_id" || -z "$agent_home" || -z "$iroh_bin" || ! -x "$iroh_bin" ]]; then
  step "headless smoke dry-run skipped"
  echo "Set IROH_ROOM_ID, IROH_ROOMS_HOME, and executable IROH_ROOMS_BIN, or provide .iroh-room-pi.json, to enable it." >&2
  exit 0
fi

step "Headless worker smoke preflight"
smoke_args=(--room "$room_id" --data-dir "$agent_home" --bin "$iroh_bin")
if [[ "$smoke_full" -eq 1 ]]; then
  echo "WARNING: --smoke-full mutates room $room_id by posting and claiming a task." >&2
  smoke_args+=(--post-task --run-worker)
fi
run npm --prefix tools/pi-room-agent run smoke:headless -- "${smoke_args[@]}"

step "release check complete"
