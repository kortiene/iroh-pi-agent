/**
 * SCAFFOLD — artifact publishing: validate local files and share them into
 * the room via `iroh-rooms file share`, collecting file_ids for the final
 * ready_for_review status (compiles; validation is real, the CLI round-trip
 * is NOT yet exercised end-to-end).
 *
 * Fail-closed path validation (DESIGN.md §3):
 *   - path must exist and be a regular file
 *   - size <= 104_857_600 bytes (100 MiB, the protocol share cap) — checked
 *     locally first for a clear error before invoking the CLI
 *   - the real (symlink-resolved) path must live inside the workspace (cwd)
 *     or inside the configured artifact_dir, unless
 *     allow_artifact_paths_outside_workspace is set
 *
 * TODO(scaffold):
 *  - integration test with a mocked runner + against the real binary
 *  - optional mime detection (currently caller-provided only)
 *  - retry/backoff on transient CLI failures
 */

import { realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import {
  buildFileShareArgs,
  parseCodedError,
  parseFileShareOutput,
  redact,
  runIrohRooms,
  type Captured,
  type CliContext,
} from './room-cli.js';

/** Protocol share cap (iroh-rooms-core MAX_SHARED_FILE_BYTES). */
export const MAX_SHARED_FILE_BYTES = 104_857_600;

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

export interface ArtifactWorkspace {
  /** Workspace root; artifact paths must live under it (or artifactDir). */
  cwd: string;
  /** Absolute artifact directory (may sit outside cwd). */
  artifactDir: string;
  allowOutsideWorkspace: boolean;
}

function isInside(realPath: string, realRoot: string): boolean {
  return realPath === realRoot || realPath.startsWith(realRoot + sep);
}

/**
 * Validate an artifact path (fail closed) and return the resolved real path
 * to hand to `file share`. Symlinks are resolved BEFORE the containment
 * check so a link inside the workspace cannot smuggle out-of-tree files.
 */
export function validateArtifactPath(path: string, workspace: ArtifactWorkspace): string {
  const absolute = resolve(workspace.cwd, path);
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    throw new ArtifactError(`artifact path does not exist: ${absolute}`);
  }
  if (!stat.isFile()) {
    throw new ArtifactError(`artifact path is not a regular file: ${absolute}`);
  }
  if (stat.size > MAX_SHARED_FILE_BYTES) {
    throw new ArtifactError(
      `artifact is ${stat.size} bytes, over the ${MAX_SHARED_FILE_BYTES}-byte (100 MiB) share cap: ${absolute}`,
    );
  }
  const real = realpathSync(absolute);
  if (!workspace.allowOutsideWorkspace) {
    const realCwd = realpathSync(workspace.cwd);
    let realArtifactDir: string | undefined;
    try {
      realArtifactDir = realpathSync(workspace.artifactDir);
    } catch {
      // artifact dir does not exist yet — only the cwd containment applies
    }
    const inside =
      isInside(real, realCwd) || (realArtifactDir !== undefined && isInside(real, realArtifactDir));
    if (!inside) {
      throw new ArtifactError(
        `refusing to share ${real}: outside the workspace (${realCwd}) and artifact dir ` +
          `(${workspace.artifactDir}); set allow_artifact_paths_outside_workspace to override`,
      );
    }
  }
  return real;
}

export interface PublishOptions {
  binPath: string;
  dataDir?: string;
  roomId: string;
  workspace: ArtifactWorkspace;
  /** Injectable runner for tests; defaults to the real spawnSync runner. */
  runner?: (binPath: string, args: readonly string[]) => Captured;
}

export interface SharedArtifact {
  path: string;
  fileId?: string;
  eventId?: string;
}

export interface PublishResult {
  shared: SharedArtifact[];
  /** file_ids in share order — feed these to agent.status --artifact. */
  fileIds: string[];
  /** Per-path failures (validation or CLI), redacted; empty means all good. */
  errors: string[];
}

/**
 * Share each file into the room, collecting file_ids. Per-path fail-closed:
 * a file that fails validation or sharing is reported in `errors` and does
 * not stop the remaining files.
 */
export function publishArtifacts(paths: readonly string[], options: PublishOptions): PublishResult {
  const runner = options.runner ?? ((bin, args) => runIrohRooms(bin, args));
  const ctx: CliContext = options.dataDir !== undefined ? { dataDir: options.dataDir } : {};
  const result: PublishResult = { shared: [], fileIds: [], errors: [] };

  for (const path of paths) {
    let real: string;
    try {
      real = validateArtifactPath(path, options.workspace);
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const args = buildFileShareArgs(ctx, { roomId: options.roomId, path: real });
    const captured = runner(options.binPath, args);
    if (captured.returncode !== 0) {
      const coded = parseCodedError(captured.stderr);
      const detail = coded !== undefined ? `error[${coded.code}]: ${coded.detail}` : redact(captured.stderr).trim();
      result.errors.push(`file share failed for ${real} (exit ${captured.returncode}): ${detail}`);
      continue;
    }
    const { fileId, eventId } = parseFileShareOutput(captured.stdout);
    const shared: SharedArtifact = { path: real };
    if (fileId !== undefined) {
      shared.fileId = fileId;
      result.fileIds.push(fileId);
    } else {
      result.errors.push(`file share succeeded for ${real} but no file_id was found in stdout`);
    }
    if (eventId !== undefined) shared.eventId = eventId;
    result.shared.push(shared);
  }
  return result;
}
