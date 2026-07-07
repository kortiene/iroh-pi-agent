/**
 * Self-transpiling test harness (house convention, see mx-loom-cockpit):
 * transpile the extension's TypeScript with the locally installed typescript
 * package into a tmp dir, stub the pi-provided "typebox" and
 * "@earendil-works/pi-tui" aliases, then dynamic-import the emitted ESM. The
 * pure modules (config/validate/cli/redact/pipes and src/tui/* except
 * wire.ts) import nothing from @earendil-works, so they load as-is.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/**
 * Naive stand-ins for pi-tui's width utilities so wire.ts is importable
 * under test: code-unit measurement, plain-string truncation (the real ones
 * are ANSI/wide-char aware — cells are always plain when fit, so the
 * difference is invisible to these tests).
 */
const PI_TUI_STUB = `
export const visibleWidth = (text) => [...String(text)].length;
export function truncateToWidth(text, maxWidth, ellipsis = "...", pad = false) {
	const chars = [...String(text)];
	if (maxWidth <= 0) return "";
	if (chars.length <= maxWidth) {
		return pad ? String(text) + " ".repeat(maxWidth - chars.length) : String(text);
	}
	const ell = [...ellipsis];
	return chars.slice(0, Math.max(0, maxWidth - ell.length)).join("") + ellipsis;
}
export const sliceByColumn = (text, start, end) => [...String(text)].slice(start, end).join("");
export const wrapTextWithAnsi = (text) => [String(text)];
export const Key = {
	escape: "escape",
	esc: "esc",
	enter: "enter",
	return: "return",
	tab: "tab",
	up: "up",
	down: "down",
	question: "?",
	shift: (key) => "shift+" + key,
	ctrlAlt: (key) => "ctrl+alt+" + key,
};
export function matchesKey(data, keyId) {
	if (data === keyId) return true;
	if ((keyId === "escape" || keyId === "esc") && data === "\\x1b") return true;
	if (keyId === "enter" && (data === "\\r" || data === "\\n")) return true;
	if (keyId === "return" && (data === "\\r" || data === "\\n")) return true;
	if (keyId === "tab" && data === "\\t") return true;
	if (keyId === "shift+tab" && data === "\\x1b[Z") return true;
	if (keyId === "up" && data === "\\x1b[A") return true;
	if (keyId === "down" && data === "\\x1b[B") return true;
	return false;
}
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
	for (const file of await readdir(join(EXT_ROOT, "src"), { recursive: true })) {
		if (!file.endsWith(".ts")) continue;
		const outPath = join(srcOut, file.replace(/\.ts$/, ".js"));
		await mkdir(dirname(outPath), { recursive: true });
		await transpileFile(join(EXT_ROOT, "src", file), outPath);
	}
	await transpileFile(join(EXT_ROOT, "index.ts"), join(out, "index.js"));

	const typeboxDir = join(out, "node_modules", "typebox");
	await mkdir(typeboxDir, { recursive: true });
	await writeFile(
		join(typeboxDir, "package.json"),
		JSON.stringify({ name: "typebox", version: "0.0.0-stub", type: "module", main: "index.js" }),
	);
	await writeFile(join(typeboxDir, "index.js"), TYPEBOX_STUB);

	const piTuiDir = join(out, "node_modules", "@earendil-works", "pi-tui");
	await mkdir(piTuiDir, { recursive: true });
	await writeFile(
		join(piTuiDir, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-tui",
			version: "0.0.0-stub",
			type: "module",
			main: "index.js",
		}),
	);
	await writeFile(join(piTuiDir, "index.js"), PI_TUI_STUB);

	await writeFile(join(out, "package.json"), JSON.stringify({ type: "module" }));

	return {
		dir: out,
		/** Import a transpiled src module by (sub)path, e.g. importModule("validate") or importModule("tui/cards"). */
		importModule: (name) => import(`file://${join(srcOut, `${name}.js`)}`),
		/** Import the transpiled extension entry point (index.ts). */
		importEntry: () => import(`file://${join(out, "index.js")}`),
		cleanup: () => rm(out, { recursive: true, force: true }),
	};
}

/** A stub ExtensionAPI that records registrations, messages, and event handlers. */
export function stubPi() {
	const tools = [];
	const commands = [];
	const handlers = new Map();
	const sentMessages = [];
	const messageRenderers = new Map();
	const shortcuts = [];
	const entries = [];
	return {
		tools,
		commands,
		handlers,
		sentMessages,
		messageRenderers,
		shortcuts,
		entries,
		registerTool(tool) {
			tools.push(tool);
		},
		registerCommand(name, options) {
			commands.push({ name, ...options });
		},
		registerMessageRenderer(customType, renderer) {
			messageRenderers.set(customType, renderer);
		},
		registerShortcut(shortcut, options) {
			shortcuts.push({ shortcut, ...options });
		},
		sendMessage(message, options) {
			sentMessages.push({ message, options });
		},
		appendEntry(customType, data) {
			entries.push({ customType, data });
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

/** A recording ExtensionContext stub (ui + sessionManager fakes). */
export function stubCtx(overrides = {}) {
	const notifications = [];
	const widgets = new Map();
	const statuses = new Map();
	const autocompleteProviders = [];
	const customComponents = [];
	const ui = {
		notifications,
		widgets,
		statuses,
		autocompleteProviders,
		customComponents,
		notify: (message, type = "info") => notifications.push({ message, type }),
		setWidget: (key, content, options) => {
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, { content, options });
		},
		setStatus: (key, text) => {
			if (text === undefined) statuses.delete(key);
			else statuses.set(key, text);
		},
		addAutocompleteProvider: (factory) => autocompleteProviders.push(factory),
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		custom: (factory, options) => {
			let settle;
			const promise = new Promise((resolve) => {
				settle = resolve;
			});
			const tui = {
				terminal: { columns: 80, rows: 24 },
				renders: 0,
				requestRender() { this.renders++; },
			};
			const theme = { fg: (_color, text) => text, bold: (text) => text };
			const done = (result) => settle(result);
			Promise.resolve(factory(tui, theme, {}, done)).then((component) => {
				customComponents.push({ component, options, tui, done });
			});
			return promise;
		},
	};
	return {
		cwd: process.cwd(),
		mode: "print",
		hasUI: false,
		ui,
		sessionManager: { getBranch: () => [] },
		...overrides,
	};
}

/**
 * Deterministic timer + clock shim for the ambient controller: `timers`
 * plugs into AmbientController's TimerShim, `now` into its clock. advance()
 * fires due timers in order and AWAITS their (async tick) callbacks, so a
 * chained setTimeout loop can be driven step by step. `delays` records every
 * scheduled delay (backoff/boost assertions); pending() counts live timers.
 */
export function stubTimers(startAt = 0) {
	let now = startAt;
	let seq = 0;
	const pending = new Map();
	const delays = [];
	return {
		now: () => now,
		delays,
		pending: () => pending.size,
		timers: {
			set(fn, ms) {
				const id = ++seq;
				delays.push(ms);
				pending.set(id, { fn, at: now + ms });
				return id;
			},
			clear(id) {
				pending.delete(id);
			},
		},
		async advance(ms) {
			const target = now + ms;
			for (;;) {
				let dueId;
				let due;
				for (const [id, timer] of pending) {
					if (timer.at <= target && (due === undefined || timer.at < due.at)) {
						dueId = id;
						due = timer;
					}
				}
				if (due === undefined) break;
				pending.delete(dueId);
				now = Math.max(now, due.at);
				await due.fn();
			}
			now = target;
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
