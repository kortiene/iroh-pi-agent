/**
 * Secret redaction for CLI stdout/stderr before it reaches the model or UI.
 *
 * Conservative, pattern-based (SPEC.md §16.2). Every match is replaced
 * with "[REDACTED]" (key names of key=value pairs are kept).
 *
 * Deliberately NOT redacted (the protocol's public currency):
 * - bare 64-hex identity/device ids
 * - blake3:<64-hex> room/event/blob ids
 * - file_<32-hex> file ids and bare 32-hex pipe ids
 * - roomtkt1… invite tickets
 *
 * This module must stay free of pi imports so tests can load it directly.
 */

import { OUTPUT_CAP_BYTES } from "./constants.js";

const REDACTED = "[REDACTED]";

/** PEM private key blocks (RSA/EC/OPENSSH/PGP/plain). */
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
/** AWS access key ids. */
const AWS_RE = /\bAKIA[0-9A-Z]{16}\b/g;
/** GitHub tokens (classic + fine-grained). */
const GITHUB_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
/** Slack tokens. */
const SLACK_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
/** OpenAI/Anthropic-style secret keys. */
const SK_RE = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
/** Bearer JWTs. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
/**
 * Generic KEY/TOKEN/SECRET/PASSWORD = value pairs (case-insensitive; allows a
 * prefix such as GITHUB_TOKEN or my-api-key, and JSON-style quoting). The key
 * name and separator are kept; only the value is redacted. Values shorter than
 * 8 characters are left alone to limit false positives.
 */
const KEY_VALUE_RE = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password))(["']?\s*[=:]\s*["']?)([^\s"']{8,})/gi;

export function redact(text: string): string {
	return text
		.replace(PEM_RE, REDACTED)
		.replace(AWS_RE, REDACTED)
		.replace(GITHUB_RE, REDACTED)
		.replace(SLACK_RE, REDACTED)
		.replace(SK_RE, REDACTED)
		.replace(JWT_RE, REDACTED)
		.replace(KEY_VALUE_RE, (_match, key: string, sep: string) => `${key}${sep}${REDACTED}`);
}

/**
 * Truncate to a UTF-8 byte budget without splitting a code point.
 * Appends a marker naming how many bytes were dropped.
 */
export function capBytes(text: string, maxBytes: number = OUTPUT_CAP_BYTES): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= maxBytes) {
		return text;
	}
	// Cutting mid-code-point yields U+FFFD at the end; strip it.
	const cut = buf.subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
	return `${cut}\n…[truncated ${buf.byteLength - maxBytes} bytes]`;
}

/** The standard pipeline for anything CLI-emitted that enters a tool envelope. */
export function redactAndCap(text: string, maxBytes: number = OUTPUT_CAP_BYTES): string {
	return capBytes(redact(text), maxBytes);
}
