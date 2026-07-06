import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFIG_FILE_NAME,
  ConfigError,
  requireRoomId,
  resolveIrohRoomsBin,
  resolveWorkerConfig,
} from '../src/config.js';

const ROOM_A = `blake3:${'a'.repeat(64)}`;
const ROOM_B = `blake3:${'b'.repeat(64)}`;
const ROOM_C = `blake3:${'c'.repeat(64)}`;
const MEMBER = 'd'.repeat(64);

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pi-room-agent-config-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writeConfigFile(value: unknown): void {
  writeFileSync(join(cwd, CONFIG_FILE_NAME), typeof value === 'string' ? value : JSON.stringify(value));
}

describe('resolveWorkerConfig precedence', () => {
  it('uses safe defaults when nothing is configured', () => {
    const config = resolveWorkerConfig({}, { cwd, env: {} });
    expect(config.roomId).toBeUndefined();
    expect(config.dataDir).toBeUndefined();
    expect(config.binPath).toBeUndefined();
    expect(config.agentName).toBe('pi-agent');
    expect(config.artifactDir).toBe(resolve(cwd, 'artifacts'));
    expect(config.defaultProgress).toBeUndefined();
    expect(config.defaultPreviewHost).toBe('127.0.0.1');
    expect(config.defaultPreviewPort).toBe(3000);
    expect(config.allowedPreviewMembers).toEqual([]);
    expect(config.allowArtifactPathsOutsideWorkspace).toBe(false);
    expect(config.configFilePath).toBeUndefined();
    expect(config.cwd).toBe(cwd);
  });

  it('reads all keys from .iroh-room-pi.json', () => {
    writeConfigFile({
      room_id: ROOM_C,
      iroh_rooms_home: '.iroh/agent',
      agent_name: 'worker-7',
      artifact_dir: 'out/artifacts',
      default_progress: 10,
      default_preview_host: '127.0.0.1',
      default_preview_port: 8080,
      allowed_preview_members: [MEMBER],
      allow_artifact_paths_outside_workspace: true,
    });
    const config = resolveWorkerConfig({}, { cwd, env: {} });
    expect(config.roomId).toBe(ROOM_C);
    expect(config.dataDir).toBe(resolve(cwd, '.iroh/agent'));
    expect(config.agentName).toBe('worker-7');
    expect(config.artifactDir).toBe(resolve(cwd, 'out/artifacts'));
    expect(config.defaultProgress).toBe(10);
    expect(config.defaultPreviewPort).toBe(8080);
    expect(config.allowedPreviewMembers).toEqual([MEMBER]);
    expect(config.allowArtifactPathsOutsideWorkspace).toBe(true);
    expect(config.configFilePath).toBe(join(cwd, CONFIG_FILE_NAME));
  });

  it('lets environment variables override the config file', () => {
    writeConfigFile({ room_id: ROOM_C, agent_name: 'from-file', artifact_dir: 'file-artifacts' });
    const config = resolveWorkerConfig(
      {},
      {
        cwd,
        env: {
          IROH_ROOM_ID: ROOM_B,
          IROH_ROOM_AGENT_NAME: 'from-env',
          IROH_ROOM_ARTIFACT_DIR: 'env-artifacts',
          IROH_ROOM_DEFAULT_PROGRESS: '42',
          IROH_ROOM_ALLOWED_PREVIEW_MEMBER: MEMBER,
        },
      },
    );
    expect(config.roomId).toBe(ROOM_B);
    expect(config.agentName).toBe('from-env');
    expect(config.artifactDir).toBe(resolve(cwd, 'env-artifacts'));
    expect(config.defaultProgress).toBe(42);
    expect(config.allowedPreviewMembers).toEqual([MEMBER]);
  });

  it('lets explicit arguments override environment variables', () => {
    writeConfigFile({ room_id: ROOM_C });
    const config = resolveWorkerConfig(
      { roomId: ROOM_A, dataDir: 'arg-home', agentName: 'arg-name' },
      { cwd, env: { IROH_ROOM_ID: ROOM_B, IROH_ROOMS_HOME: 'env-home', IROH_ROOM_AGENT_NAME: 'env-name' } },
    );
    expect(config.roomId).toBe(ROOM_A);
    expect(config.dataDir).toBe(resolve(cwd, 'arg-home'));
    expect(config.agentName).toBe('arg-name');
  });

  it('treats an empty IROH_ROOMS_HOME as unset (matches the binary)', () => {
    writeConfigFile({ iroh_rooms_home: 'file-home' });
    const config = resolveWorkerConfig({}, { cwd, env: { IROH_ROOMS_HOME: '' } });
    expect(config.dataDir).toBe(resolve(cwd, 'file-home'));
  });
});

describe('config file failure modes (fail closed)', () => {
  it('rejects malformed JSON with an error naming the file', () => {
    writeConfigFile('{ not json');
    expect(() => resolveWorkerConfig({}, { cwd, env: {} })).toThrowError(ConfigError);
    expect(() => resolveWorkerConfig({}, { cwd, env: {} })).toThrowError(
      new RegExp(CONFIG_FILE_NAME.replace('.', '\\.')),
    );
  });

  it('rejects a non-object top level', () => {
    writeConfigFile('[1,2,3]');
    expect(() => resolveWorkerConfig({}, { cwd, env: {} })).toThrowError(/JSON object/);
  });

  it('rejects wrongly typed known keys', () => {
    writeConfigFile({ room_id: 123 });
    expect(() => resolveWorkerConfig({}, { cwd, env: {} })).toThrowError(/"room_id" must be a string/);
    writeConfigFile({ allowed_preview_members: 'not-an-array' });
    expect(() => resolveWorkerConfig({}, { cwd, env: {} })).toThrowError(/array of strings/);
    writeConfigFile({ allow_artifact_paths_outside_workspace: 'yes' });
    expect(() => resolveWorkerConfig({}, { cwd, env: {} })).toThrowError(/must be a boolean/);
    writeConfigFile({ default_progress: 'high' });
    expect(() => resolveWorkerConfig({}, { cwd, env: {} })).toThrowError(/must be a finite number/);
  });

  it('ignores unknown keys (forward compatibility)', () => {
    writeConfigFile({ room_id: ROOM_A, some_future_key: { nested: true } });
    expect(resolveWorkerConfig({}, { cwd, env: {} }).roomId).toBe(ROOM_A);
  });
});

describe('room id validation (fail closed, no fall-through)', () => {
  it('rejects a malformed explicit argument', () => {
    expect(() => resolveWorkerConfig({ roomId: 'room_123' }, { cwd, env: {} })).toThrowError(
      /blake3:<64 lowercase hex>/,
    );
  });

  it('rejects a malformed env value even when the file has a valid one', () => {
    writeConfigFile({ room_id: ROOM_A });
    expect(() =>
      resolveWorkerConfig({}, { cwd, env: { IROH_ROOM_ID: 'blake3:SHOUTY' } }),
    ).toThrowError(/IROH_ROOM_ID/);
  });

  it('rejects uppercase hex and wrong lengths', () => {
    for (const bad of [`blake3:${'A'.repeat(64)}`, `blake3:${'a'.repeat(63)}`, 'a'.repeat(64)]) {
      expect(() => resolveWorkerConfig({ roomId: bad }, { cwd, env: {} })).toThrowError(ConfigError);
    }
  });

  it('requireRoomId fails closed with the three configuration options', () => {
    const config = resolveWorkerConfig({}, { cwd, env: {} });
    expect(() => requireRoomId(config)).toThrowError(/--room .*IROH_ROOM_ID.*room_id/s);
    expect(requireRoomId({ roomId: ROOM_A })).toBe(ROOM_A);
  });
});

describe('default progress validation', () => {
  it('rejects non-integer env values', () => {
    for (const bad of ['abc', '1.5', '-1', '101', '']) {
      expect(() =>
        resolveWorkerConfig({}, { cwd, env: { IROH_ROOM_DEFAULT_PROGRESS: bad } }),
      ).toThrowError(ConfigError);
    }
  });

  it('rejects out-of-range and fractional file values', () => {
    writeConfigFile({ default_progress: 3.5 });
    expect(() => resolveWorkerConfig({}, { cwd, env: {} })).toThrowError(/integer 0\.\.=100/);
    writeConfigFile({ default_progress: 101 });
    expect(() => resolveWorkerConfig({}, { cwd, env: {} })).toThrowError(/integer 0\.\.=100/);
  });
});

describe('allowed preview members', () => {
  it('rejects invalid identity ids from any source', () => {
    writeConfigFile({ allowed_preview_members: ['nope'] });
    expect(() => resolveWorkerConfig({}, { cwd, env: {} })).toThrowError(/64-char lowercase hex/);
    expect(() =>
      resolveWorkerConfig({}, { cwd, env: { IROH_ROOM_ALLOWED_PREVIEW_MEMBER: 'F'.repeat(64) } }),
    ).toThrowError(/64-char lowercase hex/);
  });

  it('env single member overrides the file list', () => {
    writeConfigFile({ allowed_preview_members: ['e'.repeat(64)] });
    const config = resolveWorkerConfig(
      {},
      { cwd, env: { IROH_ROOM_ALLOWED_PREVIEW_MEMBER: MEMBER } },
    );
    expect(config.allowedPreviewMembers).toEqual([MEMBER]);
  });
});

describe('binary resolution', () => {
  it('accepts an existing explicitly configured binary (relative → cwd)', () => {
    writeFileSync(join(cwd, 'fake-iroh-rooms'), '#!/bin/sh\n');
    writeConfigFile({ iroh_rooms_bin: 'fake-iroh-rooms' });
    const config = resolveWorkerConfig({}, { cwd, env: {} });
    expect(config.binPath).toBe(join(cwd, 'fake-iroh-rooms'));
    expect(resolveIrohRoomsBin(config, {})).toBe(join(cwd, 'fake-iroh-rooms'));
  });

  it('IROH_ROOMS_BIN overrides the config file', () => {
    writeFileSync(join(cwd, 'env-bin'), '');
    writeFileSync(join(cwd, 'file-bin'), '');
    writeConfigFile({ iroh_rooms_bin: 'file-bin' });
    const config = resolveWorkerConfig({}, { cwd, env: { IROH_ROOMS_BIN: join(cwd, 'env-bin') } });
    expect(config.binPath).toBe(join(cwd, 'env-bin'));
  });

  it('fails closed when the configured binary does not exist', () => {
    expect(() =>
      resolveWorkerConfig({}, { cwd, env: { IROH_ROOMS_BIN: join(cwd, 'missing') } }),
    ).toThrowError(/not found at/);
  });

  it('fails closed when the configured binary is not a regular file', () => {
    mkdirSync(join(cwd, 'a-dir'));
    expect(() =>
      resolveWorkerConfig({}, { cwd, env: { IROH_ROOMS_BIN: join(cwd, 'a-dir') } }),
    ).toThrowError(/not a regular file/);
  });

  it('falls back to PATH lookup for iroh-rooms', () => {
    const binDir = join(cwd, 'bin');
    mkdirSync(binDir);
    const binary = join(binDir, 'iroh-rooms');
    writeFileSync(binary, '#!/bin/sh\n');
    chmodSync(binary, 0o755);
    const config = resolveWorkerConfig({}, { cwd, env: {} });
    expect(resolveIrohRoomsBin(config, { PATH: binDir })).toBe(binary);
  });

  it('fails closed with all three options when nothing resolves', () => {
    const config = resolveWorkerConfig({}, { cwd, env: {} });
    expect(() => resolveIrohRoomsBin(config, { PATH: join(cwd, 'empty') })).toThrowError(
      /IROH_ROOMS_BIN.*iroh_rooms_bin.*PATH/s,
    );
  });
});
