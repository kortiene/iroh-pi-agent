/**
 * Self-transpiling test harness (house convention, see mx-loom-cockpit):
 * transpile the extension's TypeScript with the locally installed typescript
 * package into a tmp dir, stub the pi-provided "typebox" alias, then
 * dynamic-import the emitted ESM. The pure modules (config/validate/cli/
 * redact/pipes) import nothing from @earendil-works, so they load as-is.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const EXT_ROOT = fileURLToPath(new URL("..", import.meta.url));

const TYPEBOX_STUB = `
export const Type = {
	Object: (properties, options = {}) => ({ type: "object", properties, ...options }),
	String: (options = {}) => ({ type: "string", ...options }),
	Number: (options = {}) => ({ type: "number", ...options }),
	Integer: (options = {}) => ({ type: "integer", ...options }),
	Boolean: (options = {}) => ({ type: "boolean", ...options }),
	Array: (items, options = {}) => ({ type: "array", items, ...options }),
	Optional: (schema) => ({ ...schema, __optional: true }),
};
`;

async function transpileFile(inputPath, outputPath) {
	const input = await readFile(inputPath, "utf8");
	const js = ts.transpileModule(input, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
		},
		fileName: inputPath,
	}).outputText;
	await writeFile(outputPath, js);
}

export async function loadExtension() {
	const out = await mkdtemp(join(tmpdir(), "iroh-room-ext-test-"));
	const srcOut = join(out, "src");
	await mkdir(srcOut, { recursive: true });
	for (const file of await readdir(join(EXT_ROOT, "src"))) {
		if (!file.endsWith(".ts")) continue;
		await transpileFile(join(EXT_ROOT, "src", file), join(srcOut, file.replace(/\.ts$/, ".js")));
	}
	await transpileFile(join(EXT_ROOT, "index.ts"), join(out, "index.js"));

	const typeboxDir = join(out, "node_modules", "typebox");
	await mkdir(typeboxDir, { recursive: true });
	await writeFile(
		join(typeboxDir, "package.json"),
		JSON.stringify({ name: "typebox", version: "0.0.0-stub", type: "module", main: "index.js" }),
	);
	await writeFile(join(typeboxDir, "index.js"), TYPEBOX_STUB);
	await writeFile(join(out, "package.json"), JSON.stringify({ type: "module" }));

	return {
		dir: out,
		/** Import a transpiled src module by basename, e.g. importModule("validate"). */
		importModule: (name) => import(`file://${join(srcOut, `${name}.js`)}`),
		/** Import the transpiled extension entry point (index.ts). */
		importEntry: () => import(`file://${join(out, "index.js")}`),
		cleanup: () => rm(out, { recursive: true, force: true }),
	};
}

/** A stub ExtensionAPI that records registrations and event handlers. */
export function stubPi() {
	const tools = [];
	const commands = [];
	const handlers = new Map();
	return {
		tools,
		commands,
		handlers,
		registerTool(tool) {
			tools.push(tool);
		},
		registerCommand(name, options) {
			commands.push({ name, ...options });
		},
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		async exec() {
			throw new Error("stub pi.exec called — tests must inject their own exec");
		},
	};
}

/** A scripted exec stub: consumes one queued responder per call. */
export function stubExec(queue) {
	const calls = [];
	const exec = async (command, args, options) => {
		calls.push({ command, args, options });
		const next = queue.shift();
		if (next === undefined) {
			throw new Error(`unexpected exec call: ${command} ${args.join(" ")}`);
		}
		return typeof next === "function" ? next(command, args) : next;
	};
	return { calls, exec };
}
