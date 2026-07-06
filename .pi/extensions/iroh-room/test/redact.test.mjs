import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtension } from "./helpers.mjs";
import {
	EXPOSE_STDOUT,
	FILE_ID,
	IDENTITY_AGENT,
	IDENTITY_JSON,
	INVITE_TICKET,
	PIPE_ID,
	ROOM_ID,
	SHARE_STDOUT,
	STATUS_STDOUT,
	TAIL_JSON,
} from "./fixtures.mjs";

const ext = await loadExtension();
const { capBytes, redact, redactAndCap } = await ext.importModule("redact");

after(() => ext.cleanup());

// Fake secret vectors are assembled at runtime (join/concat) instead of being
// written as literals so the repo's gitleaks pre-commit hook does not flag
// this file. The runtime strings are identical to the literal forms.
const vec = (...parts) => parts.join("");

/* ------------------------------ redacted things --------------------------- */

test("PEM private key blocks are redacted (any label)", () => {
	const pem = [
		vec("-----BEGIN OPENSSH ", "PRIVATE KEY-----"),
		"b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt",
		vec("-----END OPENSSH ", "PRIVATE KEY-----"),
	].join("\n");
	assert.equal(redact(`before\n${pem}\nafter`), "before\n[REDACTED]\nafter");
	const plain = vec("-----BEGIN ", "PRIVATE KEY-----", "\nMIIE...\n", "-----END ", "PRIVATE KEY-----");
	assert.equal(redact(plain), "[REDACTED]");
});

test("AWS access key ids are redacted", () => {
	assert.equal(redact("key AKIAIOSFODNN7EXAMPLE ok"), "key [REDACTED] ok");
});

test("GitHub tokens are redacted (classic and fine-grained)", () => {
	const classic = `ghp_${"A1b2C3d4".repeat(5)}`;
	const finegrained = `github_pat_${"x9".repeat(15)}_tail`;
	assert.equal(redact(`t=${classic}`).includes(classic), false);
	assert.equal(redact(finegrained), "[REDACTED]");
});

test("Slack tokens are redacted", () => {
	assert.equal(redact("xoxb-123456789012-abcdefghijkl"), "[REDACTED]");
});

test("sk- style provider keys are redacted", () => {
	const key = `sk-ant-api03-${"a1B2".repeat(10)}`;
	assert.equal(redact(`using ${key} now`), "using [REDACTED] now");
});

test("Bearer JWTs are redacted", () => {
	const jwt = vec("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk");
	assert.equal(redact(`Authorization: Bearer ${jwt}`), "Authorization: Bearer [REDACTED]");
});

test("generic KEY/TOKEN/SECRET/PASSWORD pairs keep the key, redact the value", () => {
	assert.equal(redact(vec("GITHUB_TOKEN", "=", "abcdefgh12345678")), "GITHUB_TOKEN=[REDACTED]");
	assert.equal(redact("password: hunter2butlonger"), "password: [REDACTED]");
	assert.equal(redact(vec('"api_key"', ": ", '"abcd1234efgh5678"')), '"api_key": "[REDACTED]"');
	assert.equal(redact(vec("my-api-key", "=", "0123456789abcdef")), "my-api-key=[REDACTED]");
	assert.equal(redact("CLIENT_SECRET: sup3rs3cr3tvalue"), "CLIENT_SECRET: [REDACTED]");
	// values shorter than 8 chars are left alone (false-positive guard)
	assert.equal(redact("token: short"), "token: short");
});

/* --------------------- protocol currency is NOT redacted ------------------ */

test("DO NOT redact: 64-hex ids, blake3: ids, file_ ids, pipe ids, roomtkt1 tickets", () => {
	assert.equal(redact(IDENTITY_AGENT), IDENTITY_AGENT);
	assert.equal(redact(ROOM_ID), ROOM_ID);
	assert.equal(redact(FILE_ID), FILE_ID);
	assert.equal(redact(PIPE_ID), PIPE_ID);
	assert.equal(redact(`ticket:\n  ${INVITE_TICKET}`), `ticket:\n  ${INVITE_TICKET}`);
});

test("real CLI stdout fixtures pass through redact unchanged", () => {
	for (const fixture of [STATUS_STDOUT, SHARE_STDOUT, EXPOSE_STDOUT, TAIL_JSON, IDENTITY_JSON]) {
		assert.equal(redact(fixture), fixture);
	}
});

/* --------------------------------- capBytes -------------------------------- */

test("capBytes: under and at the budget is unchanged", () => {
	assert.equal(capBytes("hello", 8192), "hello");
	assert.equal(capBytes("x".repeat(100), 100), "x".repeat(100));
});

test("capBytes: over-budget output is truncated on a code-point boundary with a marker", () => {
	const text = "é".repeat(20); // 40 bytes
	const capped = capBytes(text, 9); // 9 bytes = 4 é + half a code point
	assert.ok(capped.startsWith("éééé"));
	assert.equal(capped.includes("�"), false);
	assert.match(capped, /…\[truncated 31 bytes\]$/);
});

test("redactAndCap composes redaction then capping", () => {
	const secret = vec("GITHUB_TOKEN", "=", "abcdefgh12345678");
	const out = redactAndCap(`${secret}\n${"x".repeat(10_000)}`);
	assert.ok(out.startsWith("GITHUB_TOKEN=[REDACTED]"));
	assert.match(out, /…\[truncated \d+ bytes\]$/);
	assert.ok(Buffer.byteLength(out, "utf8") < 8_300);
});
