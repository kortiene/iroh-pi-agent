/**
 * Three-way grammar lockstep (brief §3.5): the extension's room-task
 * detector (src/tui/tasks.ts) must accept EXACTLY the id set the canonical
 * grammar accepts. The canonical standalone is the skill script
 * (.pi/skills/iroh-room-agent/scripts/parse-room-task.ts — itself
 * conformance-tested against the worker parser); we spawn it over the shared
 * hostile corpus in fixtures.mjs and diff id sets per fixture.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadExtension } from "./helpers.mjs";
import { TASK_CONFORMANCE_CORPUS } from "./fixtures.mjs";

const SCRIPT = fileURLToPath(
	new URL("../../../skills/iroh-room-agent/scripts/parse-room-task.ts", import.meta.url),
);

const ext = await loadExtension();
const { detectTasks } = await ext.importModule("tui/tasks");

after(() => ext.cleanup());

/** Run the canonical skill script over stdin; returns its parsed task ids. */
function scriptTaskIds(input) {
	const result = spawnSync(process.execPath, [SCRIPT], {
		input,
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(result.error, undefined, `spawn failed: ${result.error}`);
	// Exit codes 0/1 are both valid parse outcomes (1 = no tasks or errors,
	// fail closed); 2 would be a usage/O error and means the harness broke.
	assert.notEqual(result.status, 2, `script usage/IO error: ${result.stderr}`);
	const parsed = JSON.parse(result.stdout);
	assert.ok(Array.isArray(parsed.tasks), "script printed a tasks array");
	return parsed.tasks.map((task) => task.id);
}

test("detector vs canonical grammar: EXACT id-set equality over the shared corpus", () => {
	for (const fixture of TASK_CONFORMANCE_CORPUS) {
		const scriptIds = [...new Set(scriptTaskIds(fixture.text))].sort();
		const detectorIds = [...new Set(detectTasks(fixture.text).map((task) => task.id))].sort();
		assert.deepEqual(
			detectorIds,
			scriptIds,
			`id-set mismatch for corpus fixture "${fixture.name}"`,
		);
	}
});

test("corpus sanity: the valid fixtures actually produce ids (the diff is not vacuous)", () => {
	const allIds = TASK_CONFORMANCE_CORPUS.flatMap((fixture) =>
		detectTasks(fixture.text).map((task) => task.id),
	);
	assert.ok(allIds.includes("IR-PI-001"), "plain valid task detected");
	assert.ok(allIds.includes("SECOND-ID"), "duplicate id keys: last wins");
	assert.ok(allIds.includes("QUOTED-ID-1"), "quoted id stripped one layer");
	assert.ok(allIds.includes("MULTI-1") && allIds.includes("MULTI-2"), "multi-block body");
	assert.ok(allIds.includes("CRLF-1"), "CRLF body");
	// the junk opener quotes ONLY until its own fence closes; the block after it is real
	assert.ok(allIds.includes("JUNK-2"), "block after a junk-opener foreign fence");
	for (const rejected of ["IR-PI-002", "QUOTED-1", "INDENT-1", "WRAPPED-1", "JUNK-1", "OPEN-1", "FIRST-ID", "BAD-TYPE-1", "SHADOW-1"]) {
		assert.ok(!allIds.includes(rejected), `${rejected} must not be detected`);
	}
});
