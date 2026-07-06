/**
 * Worker configuration loading and resolution.
 *
 * Same semantics as the Pi extension's config module (independent copy,
 * worker flavor), per DESIGN.md §2:
 *
 *   resolution order per value:
 *     explicit argument > environment variable > .iroh-room-pi.json (cwd) > safe default
 *
 *   - EVERY IROH_* env var treats an empty string as unset (mirrors the
 *     extension's envValue() and the binary's IROH_ROOMS_HOME handling)
 *   - path-like values (iroh_rooms_home, iroh_rooms_bin, artifact_dir) expand
 *     a leading `~`/`~/` in env and file values before resolving
 *
 * Fail-closed rules:
 *   - malformed .iroh-room-pi.json  -> ConfigError naming the file
 *   - wrongly-typed known file keys -> ConfigError (unknown keys are ignored)
 *   - a *provided* room_id that does not match /^blake3:[0-9a-f]{64}$/ is an
 *     error at its precedence level; it never silently falls through to a
 *     lower-precedence value (that would mask typos)
 *   - explicitly configured binary paths must exist and be regular files
 *   - no binary resolvable at all -> ConfigError explaining the three options
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export const CONFIG_FILE_NAME = '.iroh-room-pi.json';

export const ROOM_ID_PATTERN = /^blake3:[0-9a-f]{64}$/;
export const IDENTITY_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Configuration failure. Always carries an actionable, non-secret message. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Explicit-argument layer (highest precedence), e.g. from CLI flags. */
export interface WorkerConfigOverrides {
  roomId?: string;
  dataDir?: string;
  binPath?: string;
  agentName?: string;
  artifactDir?: string;
  defaultProgress?: number;
}

/** Injectable sources so tests never depend on ambient process state. */
export interface ConfigSources {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface ResolvedWorkerConfig {
  /** blake3:<64-hex> room id, when configured anywhere. */
  roomId?: string;
  /** Absolute iroh-rooms home; passed to every CLI call as --data-dir. */
  dataDir?: string;
  /**
   * Absolute path to an explicitly configured iroh-rooms binary (validated to
   * exist). Undefined means "look up `iroh-rooms` on PATH lazily" — see
   * resolveIrohRoomsBin().
   */
  binPath?: string;
  agentName: string;
  /** Absolute artifact directory (default: <cwd>/artifacts). */
  artifactDir: string;
  /** Integer 0..=100 when configured; used as the default --progress. */
  defaultProgress?: number;
  defaultPreviewHost: string;
  defaultPreviewPort: number;
  /** 64-hex identity ids allowed on preview pipes by default. */
  allowedPreviewMembers: string[];
  allowArtifactPathsOutsideWorkspace: boolean;
  /** Set when .iroh-room-pi.json existed and parsed. */
  configFilePath?: string;
  /** The cwd everything relative was resolved against. */
  cwd: string;
}

/** Shape of the (all-optional) .iroh-room-pi.json file after validation. */
interface ConfigFileValues {
  room_id?: string;
  iroh_rooms_home?: string;
  iroh_rooms_bin?: string;
  agent_name?: string;
  artifact_dir?: string;
  default_progress?: number;
  default_preview_host?: string;
  default_preview_port?: number;
  allowed_preview_members?: string[];
  allow_artifact_paths_outside_workspace?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectString(file: string, key: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new ConfigError(`${file}: "${key}" must be a string (got ${typeof value})`);
  }
  return value;
}

function expectNumber(file: string, key: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`${file}: "${key}" must be a finite number (got ${typeof value})`);
  }
  return value;
}

function expectBoolean(file: string, key: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${file}: "${key}" must be a boolean (got ${typeof value})`);
  }
  return value;
}

function expectStringArray(file: string, key: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError(`${file}: "${key}" must be an array of strings`);
  }
  return value as string[];
}

/**
 * Read and validate .iroh-room-pi.json from `cwd`. A missing file is fine
 * (returns {}); a present-but-malformed file fails closed.
 */
export function loadConfigFile(cwd: string): { values: ConfigFileValues; path?: string } {
  const filePath = join(cwd, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { values: {} };
    }
    throw new ConfigError(`could not read ${filePath}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${filePath} is not valid JSON: ${String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new ConfigError(`${filePath} must contain a JSON object at the top level`);
  }
  // Unknown keys are ignored for forward compatibility; known keys are
  // type-checked (fail closed on wrong types).
  const values: ConfigFileValues = {};
  if ('room_id' in parsed) values.room_id = expectString(filePath, 'room_id', parsed['room_id']);
  if ('iroh_rooms_home' in parsed) values.iroh_rooms_home = expectString(filePath, 'iroh_rooms_home', parsed['iroh_rooms_home']);
  if ('iroh_rooms_bin' in parsed) values.iroh_rooms_bin = expectString(filePath, 'iroh_rooms_bin', parsed['iroh_rooms_bin']);
  if ('agent_name' in parsed) values.agent_name = expectString(filePath, 'agent_name', parsed['agent_name']);
  if ('artifact_dir' in parsed) values.artifact_dir = expectString(filePath, 'artifact_dir', parsed['artifact_dir']);
  if ('default_progress' in parsed) values.default_progress = expectNumber(filePath, 'default_progress', parsed['default_progress']);
  if ('default_preview_host' in parsed) values.default_preview_host = expectString(filePath, 'default_preview_host', parsed['default_preview_host']);
  if ('default_preview_port' in parsed) values.default_preview_port = expectNumber(filePath, 'default_preview_port', parsed['default_preview_port']);
  if ('allowed_preview_members' in parsed) {
    values.allowed_preview_members = expectStringArray(filePath, 'allowed_preview_members', parsed['allowed_preview_members']);
  }
  if ('allow_artifact_paths_outside_workspace' in parsed) {
    values.allow_artifact_paths_outside_workspace = expectBoolean(
      filePath,
      'allow_artifact_paths_outside_workspace',
      parsed['allow_artifact_paths_outside_workspace'],
    );
  }
  return { values, path: filePath };
}

/** Pick the first defined value; report which layer it came from. */
function pick(
  ...candidates: Array<{ source: string; value: string | undefined }>
): { source: string; value: string } | undefined {
  for (const candidate of candidates) {
    if (candidate.value !== undefined) {
      return { source: candidate.source, value: candidate.value };
    }
  }
  return undefined;
}

/**
 * Read an env var, treating empty strings as unset. Mirrors the Pi
 * extension's envValue() and the binary's own IROH_ROOMS_HOME handling, so
 * `export IROH_ROOM_ID=` in a shell profile falls through to the config file
 * instead of failing (or, worse, silently resolving "" against cwd).
 */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Expand a leading `~` or `~/` to the user's home directory (docs show
 * `--data-dir ~/.iroh-pi-agent`-style values). `~user` forms are not
 * supported; anything else passes through unchanged.
 */
function expandTilde(value: string): string {
  if (value === '~') {
    return homedir();
  }
  if (value.startsWith('~/')) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function expandTildeOpt(value: string | undefined): string | undefined {
  return value === undefined ? undefined : expandTilde(value);
}

function validateProgress(source: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new ConfigError(`${source}: default progress must be an integer 0..=100 (got ${value})`);
  }
  return value;
}

/**
 * Resolve the full worker configuration. Pure with respect to `sources`
 * (cwd/env are injectable); reads only the config file from disk.
 */
export function resolveWorkerConfig(
  overrides: WorkerConfigOverrides = {},
  sources: ConfigSources = {},
): ResolvedWorkerConfig {
  const cwd = sources.cwd ?? process.cwd();
  const env = sources.env ?? process.env;
  const { values: file, path: configFilePath } = loadConfigFile(cwd);

  // room_id — validate the winning provided value; never fall through past a
  // malformed higher-precedence value.
  const roomPick = pick(
    { source: 'explicit --room argument', value: overrides.roomId },
    { source: 'IROH_ROOM_ID', value: envValue(env, 'IROH_ROOM_ID') },
    { source: `${CONFIG_FILE_NAME} room_id`, value: file.room_id },
  );
  let roomId: string | undefined;
  if (roomPick !== undefined) {
    if (!ROOM_ID_PATTERN.test(roomPick.value)) {
      throw new ConfigError(
        `${roomPick.source}: room id must match blake3:<64 lowercase hex> (got "${roomPick.value}")`,
      );
    }
    roomId = roomPick.value;
  }

  // iroh-rooms home — may be relative (resolve against cwd) or ~-prefixed
  // (expand against the user's home) in env/file values.
  const homePick = pick(
    { source: '--data-dir', value: overrides.dataDir },
    { source: 'IROH_ROOMS_HOME', value: expandTildeOpt(envValue(env, 'IROH_ROOMS_HOME')) },
    { source: `${CONFIG_FILE_NAME} iroh_rooms_home`, value: expandTildeOpt(file.iroh_rooms_home) },
  );
  const dataDir = homePick !== undefined ? resolve(cwd, homePick.value) : undefined;

  // Explicit binary path (validated eagerly, fail closed). When nothing is
  // configured, resolution falls back to PATH lookup in resolveIrohRoomsBin().
  const binPick = pick(
    { source: 'explicit binary argument', value: overrides.binPath },
    { source: 'IROH_ROOMS_BIN', value: expandTildeOpt(envValue(env, 'IROH_ROOMS_BIN')) },
    { source: `${CONFIG_FILE_NAME} iroh_rooms_bin`, value: expandTildeOpt(file.iroh_rooms_bin) },
  );
  let binPath: string | undefined;
  if (binPick !== undefined) {
    const abs = isAbsolute(binPick.value) ? binPick.value : resolve(cwd, binPick.value);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      throw new ConfigError(`${binPick.source}: iroh-rooms binary not found at ${abs}`);
    }
    if (!stat.isFile()) {
      throw new ConfigError(`${binPick.source}: ${abs} is not a regular file`);
    }
    binPath = abs;
  }

  const agentName =
    pick(
      { source: 'explicit agent name', value: overrides.agentName },
      { source: 'IROH_ROOM_AGENT_NAME', value: envValue(env, 'IROH_ROOM_AGENT_NAME') },
      { source: `${CONFIG_FILE_NAME} agent_name`, value: file.agent_name },
    )?.value ?? 'pi-agent';

  const artifactPick = pick(
    { source: 'explicit artifact dir', value: overrides.artifactDir },
    { source: 'IROH_ROOM_ARTIFACT_DIR', value: expandTildeOpt(envValue(env, 'IROH_ROOM_ARTIFACT_DIR')) },
    { source: `${CONFIG_FILE_NAME} artifact_dir`, value: expandTildeOpt(file.artifact_dir) },
  );
  const artifactDir = resolve(cwd, artifactPick?.value ?? 'artifacts');

  // default progress: env value must be a plain non-negative integer string.
  let defaultProgress: number | undefined;
  const envProgress = envValue(env, 'IROH_ROOM_DEFAULT_PROGRESS');
  if (overrides.defaultProgress !== undefined) {
    defaultProgress = validateProgress('explicit default progress', overrides.defaultProgress);
  } else if (envProgress !== undefined) {
    if (!/^\d{1,3}$/.test(envProgress)) {
      throw new ConfigError(`IROH_ROOM_DEFAULT_PROGRESS must be an integer 0..=100 (got "${envProgress}")`);
    }
    defaultProgress = validateProgress('IROH_ROOM_DEFAULT_PROGRESS', Number(envProgress));
  } else if (file.default_progress !== undefined) {
    defaultProgress = validateProgress(`${CONFIG_FILE_NAME} default_progress`, file.default_progress);
  }

  // allowed preview members — env (single id) beats the file array.
  let allowedPreviewMembers: string[];
  const envMember = envValue(env, 'IROH_ROOM_ALLOWED_PREVIEW_MEMBER');
  if (envMember !== undefined) {
    allowedPreviewMembers = [envMember];
  } else {
    allowedPreviewMembers = file.allowed_preview_members ?? [];
  }
  for (const member of allowedPreviewMembers) {
    if (!IDENTITY_ID_PATTERN.test(member)) {
      throw new ConfigError(
        `allowed preview member must be a 64-char lowercase hex identity id (got "${member}")`,
      );
    }
  }

  const defaultPreviewHost = file.default_preview_host ?? '127.0.0.1';
  const defaultPreviewPortRaw = file.default_preview_port ?? 3000;
  if (!Number.isInteger(defaultPreviewPortRaw) || defaultPreviewPortRaw < 1 || defaultPreviewPortRaw > 65535) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME} default_preview_port must be an integer 1..=65535 (got ${defaultPreviewPortRaw})`,
    );
  }

  const config: ResolvedWorkerConfig = {
    agentName,
    artifactDir,
    defaultPreviewHost,
    defaultPreviewPort: defaultPreviewPortRaw,
    allowedPreviewMembers,
    allowArtifactPathsOutsideWorkspace: file.allow_artifact_paths_outside_workspace ?? false,
    cwd,
  };
  if (roomId !== undefined) config.roomId = roomId;
  if (dataDir !== undefined) config.dataDir = dataDir;
  if (binPath !== undefined) config.binPath = binPath;
  if (defaultProgress !== undefined) config.defaultProgress = defaultProgress;
  if (configFilePath !== undefined) config.configFilePath = configFilePath;
  return config;
}

/** Search PATH for an executable regular file named `name`. */
function whichOnPath(name: string, env: Record<string, string | undefined>): string | undefined {
  const pathVar = env['PATH'] ?? '';
  for (const dir of pathVar.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // not there; keep looking
    }
  }
  return undefined;
}

/**
 * Resolve the iroh-rooms binary to invoke: the explicitly configured path if
 * present, else `iroh-rooms` found on PATH. Fails closed with a message
 * explaining all three configuration options.
 */
export function resolveIrohRoomsBin(
  config: Pick<ResolvedWorkerConfig, 'binPath'>,
  env: Record<string, string | undefined> = process.env,
): string {
  if (config.binPath !== undefined) {
    return config.binPath;
  }
  const found = whichOnPath('iroh-rooms', env);
  if (found !== undefined) {
    return found;
  }
  throw new ConfigError(
    'iroh-rooms binary not found. Configure it one of three ways: ' +
      '(1) set the IROH_ROOMS_BIN environment variable to the binary path, ' +
      `(2) set "iroh_rooms_bin" in ${CONFIG_FILE_NAME}, or ` +
      '(3) put an `iroh-rooms` executable on your PATH ' +
      '(build it in the iroh-room repo with `cargo build --release`).',
  );
}

/** Require a configured room id; fail closed with the three ways to set it. */
export function requireRoomId(config: Pick<ResolvedWorkerConfig, 'roomId'>): string {
  if (config.roomId === undefined) {
    throw new ConfigError(
      'no room id configured. Pass --room <blake3:...>, set IROH_ROOM_ID, ' +
        `or set "room_id" in ${CONFIG_FILE_NAME}.`,
    );
  }
  return config.roomId;
}
