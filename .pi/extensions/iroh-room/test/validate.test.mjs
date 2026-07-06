import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadExtension } from "./helpers.mjs";
import { FILE_ID, FILE_ID_HEX, IDENTITY_AGENT, PIPE_ID } from "./fixtures.mjs";

const ext = await loadExtension();
const {
	clampTailLimit,
	validateAllowList,
	validateArtifactIds,
	validateArtifactPath,
	validateFileName,
	validateLabel,
	validateMessageBody,
	validateMime,
	validatePipeId,
	validateProgress,
	validateStatusLabel,
	validateStatusMessage,
	validateTcpTarget,
	validateTtlSeconds,
} = await ext.importModule("validate");

const cleanups = [ext.cleanup];
after(async () => {
	for (const cleanup of cleanups) await cleanup();
});

/* ------------------------------ status label ----------------------------- */

test("status label: accepts 1..=64 BYTES, rejects over-limit, empty, control chars", () => {
	assert.equal(validateStatusLabel("implementing"), "implementing");
	assert.equal(validateStatusLabel("x".repeat(64)), "x".repeat(64));
	// 32 two-byte chars = 64 bytes → accepted even though only 32 chars.
	assert.equal(validateStatusLabel("é".repeat(32)), "é".repeat(32));
	// 33 two-byte chars = 66 bytes → rejected even though only 33 chars < 64.
	assert.throws(() => validateStatusLabel("é".repeat(33)), /66 bytes.*64 bytes/);
	assert.throws(() => validateStatusLabel("x".repeat(65)), /65 bytes/);
	assert.throws(() => validateStatusLabel(""), /non-empty/);
	assert.throws(() => validateStatusLabel("   "), /non-empty/);
	assert.throws(() => validateStatusLabel(undefined), /required/);
	assert.throws(() => validateStatusLabel(42), /required/);
	assert.throws(() => validateStatusLabel("bad\nlabel"), /control characters/);
	assert.throws(() => validateStatusLabel("bad\x7f"), /control characters/);
});

/* ----------------------------- status message ---------------------------- */

test("status message: optional, <=4096 bytes (multibyte counted in bytes)", () => {
	assert.equal(validateStatusMessage(undefined), undefined);
	assert.equal(validateStatusMessage("ok"), "ok");
	assert.equal(validateStatusMessage("x".repeat(4096)), "x".repeat(4096));
	// 1024 four-byte emoji = 4096 bytes → accepted; 1025 → rejected.
	assert.equal(validateStatusMessage("🚀".repeat(1024)), "🚀".repeat(1024));
	assert.throws(() => validateStatusMessage("🚀".repeat(1025)), /4100 bytes.*4096 bytes/);
	assert.throws(() => validateStatusMessage(7), /must be a string/);
});

/* -------------------------------- progress ------------------------------- */

test("progress: integer 0..=100 only", () => {
	assert.equal(validateProgress(undefined), undefined);
	assert.equal(validateProgress(0), 0);
	assert.equal(validateProgress(100), 100);
	assert.throws(() => validateProgress(-1), /between 0 and 100/);
	assert.throws(() => validateProgress(101), /between 0 and 100/);
	assert.throws(() => validateProgress(4.5), /integer/);
	assert.throws(() => validateProgress(Number.NaN), /integer/);
	assert.throws(() => validateProgress("50"), /integer/);
});

/* ------------------------------ artifact ids ----------------------------- */

test("artifact ids: <=16, file_<32-hex> or bare 32-hex, passed through as given", () => {
	assert.equal(validateArtifactIds(undefined), undefined);
	assert.deepEqual(validateArtifactIds([FILE_ID, FILE_ID_HEX]), [FILE_ID, FILE_ID_HEX]);
	const sixteen = Array.from({ length: 16 }, () => FILE_ID);
	assert.deepEqual(validateArtifactIds(sixteen), sixteen);
	assert.throws(() => validateArtifactIds([...sixteen, FILE_ID]), /17 entries.*16/);
	assert.throws(() => validateArtifactIds(["file_short"]), /invalid artifact id/);
	assert.throws(() => validateArtifactIds([`FILE_${FILE_ID_HEX}`]), /invalid artifact id/);
	assert.throws(() => validateArtifactIds("file_abc"), /must be an array/);
});

/* ------------------------------ message body ----------------------------- */

test("message body: 1..=16384 bytes", () => {
	assert.equal(validateMessageBody("hi"), "hi");
	assert.equal(validateMessageBody("x".repeat(16384)), "x".repeat(16384));
	assert.throws(() => validateMessageBody("x".repeat(16385)), /16385 bytes.*16384/);
	// 5462 three-byte chars = 16386 bytes → rejected though far fewer chars.
	assert.throws(() => validateMessageBody("の".repeat(5462)), /16386 bytes/);
	assert.throws(() => validateMessageBody(""), /non-empty/);
	assert.throws(() => validateMessageBody(undefined), /required/);
});

/* -------------------------------- tcp target ----------------------------- */

test("tcp target: only 127.0.0.1:<port> with port 1..=65535", () => {
	assert.equal(validateTcpTarget("127.0.0.1:3000"), "127.0.0.1:3000");
	assert.equal(validateTcpTarget("127.0.0.1:1"), "127.0.0.1:1");
	assert.equal(validateTcpTarget("127.0.0.1:65535"), "127.0.0.1:65535");
	for (const bad of [
		"0.0.0.0:3000",
		"[::1]:3000",
		"::1:3000",
		"127.0.0.2:3000", // stricter than the binary: only 127.0.0.1 exactly
		"192.168.1.10:3000",
		"localhost:3000",
		"example.com:3000",
		"unix:/var/run/docker.sock",
		"127.0.0.1", // missing port
	]) {
		assert.throws(() => validateTcpTarget(bad), /only 127\.0\.0\.1:<port> is allowed/, bad);
	}
	assert.throws(() => validateTcpTarget("127.0.0.1:0"), /must be 1\.\.=65535/);
	assert.throws(() => validateTcpTarget("127.0.0.1:65536"), /must be 1\.\.=65535/);
	assert.throws(() => validateTcpTarget(undefined), /required/);
});

/* -------------------------------- allow list ----------------------------- */

test("allow list: non-empty, 64-hex entries, no default-all", () => {
	assert.deepEqual(validateAllowList([IDENTITY_AGENT]), [IDENTITY_AGENT]);
	assert.throws(() => validateAllowList([]), /non-empty.*no default-all/);
	assert.throws(() => validateAllowList(undefined), /non-empty/);
	assert.throws(() => validateAllowList(["xyz"]), /64-char lowercase hex/);
	assert.throws(() => validateAllowList([IDENTITY_AGENT.toUpperCase()]), /64-char lowercase hex/);
});

/* ------------------------------- ttl seconds ----------------------------- */

test("ttl_seconds: positive integer only", () => {
	assert.equal(validateTtlSeconds(undefined), undefined);
	assert.equal(validateTtlSeconds(90), 90);
	assert.throws(() => validateTtlSeconds(0), /positive integer/);
	assert.throws(() => validateTtlSeconds(-5), /positive integer/);
	assert.throws(() => validateTtlSeconds(1.5), /positive integer/);
	assert.throws(() => validateTtlSeconds("60"), /positive integer/);
});

/* --------------------------------- pipe id ------------------------------- */

test("pipe id: bare 32-hex", () => {
	assert.equal(validatePipeId(PIPE_ID), PIPE_ID);
	assert.throws(() => validatePipeId("abc"), /32 lowercase hex/);
	assert.throws(() => validatePipeId(`file_${FILE_ID_HEX}`), /32 lowercase hex/);
});

/* ------------------------- name / mime / label bytes ---------------------- */

test("name, mime, label: <=255 bytes, no control chars", () => {
	assert.equal(validateFileName(undefined), undefined);
	assert.equal(validateFileName("report.md"), "report.md");
	assert.throws(() => validateFileName("x".repeat(256)), /256 bytes.*255/);
	// 128 two-byte chars = 256 bytes → rejected though only 128 chars.
	assert.throws(() => validateFileName("é".repeat(128)), /256 bytes/);
	assert.throws(() => validateFileName("a\tb"), /control characters/);
	assert.equal(validateMime("text/markdown"), "text/markdown");
	assert.throws(() => validateMime("x".repeat(256)), /255/);
	assert.equal(validateLabel("preview"), "preview");
	assert.throws(() => validateLabel(""), /non-empty/);
});

/* -------------------------------- tail limit ----------------------------- */

test("tail limit: default 50, clamped to 1..=500", () => {
	assert.equal(clampTailLimit(undefined), 50);
	assert.equal(clampTailLimit(25), 25);
	assert.equal(clampTailLimit(0), 1);
	assert.equal(clampTailLimit(-3), 1);
	assert.equal(clampTailLimit(9999), 500);
	assert.equal(clampTailLimit(12.7), 12);
	assert.throws(() => clampTailLimit("ten"), /must be a number/);
	assert.throws(() => clampTailLimit(Number.POSITIVE_INFINITY), /must be a number/);
});

/* ------------------------------ artifact path ---------------------------- */

async function makeWorkspace() {
	const cwd = await mkdtemp(join(tmpdir(), "iroh-room-validate-"));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

test("artifact path: exists, regular file, inside workspace; returns realpath", async () => {
	const cwd = await makeWorkspace();
	await mkdir(join(cwd, "artifacts"));
	const file = join(cwd, "artifacts", "report.md");
	await writeFile(file, "# report\n");
	const validated = validateArtifactPath("artifacts/report.md", { cwd });
	assert.equal(validated, realpathSync(file));
	// absolute path form works too
	assert.equal(validateArtifactPath(file, { cwd }), realpathSync(file));
});

test("artifact path: missing / directory rejected", async () => {
	const cwd = await makeWorkspace();
	assert.throws(() => validateArtifactPath("nope.md", { cwd }), /does not exist/);
	await mkdir(join(cwd, "somedir"));
	assert.throws(() => validateArtifactPath("somedir", { cwd }), /not a regular file/);
	assert.throws(() => validateArtifactPath(undefined, { cwd }), /path is required/);
});

test("artifact path: size cap enforced (overridable in tests)", async () => {
	const cwd = await makeWorkspace();
	const file = join(cwd, "big.bin");
	await writeFile(file, "0123456789");
	assert.throws(() => validateArtifactPath("big.bin", { cwd, maxBytes: 5 }), /10 bytes.*limit is 5/);
	assert.equal(validateArtifactPath("big.bin", { cwd, maxBytes: 10 }), realpathSync(file));
});

test("artifact path: outside workspace rejected unless allowOutside; symlinks resolved", async () => {
	const cwd = await makeWorkspace();
	const outside = await makeWorkspace();
	const secret = join(outside, "secret.txt");
	await writeFile(secret, "shh");

	// plain outside path
	assert.throws(() => validateArtifactPath(secret, { cwd }), /outside the workspace/);
	// symlink inside the workspace pointing outside must be caught via realpath
	await symlink(secret, join(cwd, "sneaky.txt"));
	assert.throws(() => validateArtifactPath("sneaky.txt", { cwd }), /outside the workspace/);
	// escape hatch
	assert.equal(validateArtifactPath(secret, { cwd, allowOutside: true }), realpathSync(secret));
	// configured artifactDir grants a second containment root
	assert.equal(
		validateArtifactPath(secret, { cwd, artifactDir: outside }),
		realpathSync(secret),
	);
});
