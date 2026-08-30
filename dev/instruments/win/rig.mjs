// The Windows rig: a pi process inside a ConPTY (node-pty), its VT stream fed
// to a headless xterm so the screen can be read back — the tmux + capture-pane
// of the Linux instruments, for a platform without tmux. `launch()` returns a
// handle with screen/text/waitFor/send/key/mouse/wheel/paste; `setup.mjs`
// builds the private agent dirs it boots from; `scenarios.mjs` is the suite.
//
// What ConPTY hides, measured (2026-08-30): it never forwards DECAWM (`?7l/h`)
// and swallows the mouse-mode RESETS (`?1003l`, `?1006l`) and pi's `?1004l`,
// while forwarding `?1049h/l` and the mouse-mode SETS. So the pty stream can
// prove the alt screen but not the mouse/autowrap restore — for those the
// witness is pi-tui's own write log (`PI_TUI_WRITE_LOG=<file>`, everything
// that goes through `terminal.write`, the pager's teardown included). Input
// passes through: SGR mouse reports, bracketed paste, alt+key, ctrl keys.
import pty from "node-pty";
import xterm from "@xterm/headless";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { Terminal } = xterm;

export const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The war-dogs folder (this file lives in dev/instruments/win/). */
export const WD = path.resolve(HERE, "..", "..", "..");
/** pi's package dir: `PI_ROOT`, else `npm root -g` (pi-node and npm -g both put it there). */
export const PI_ROOT = (() => {
	if (process.env.PI_ROOT) return process.env.PI_ROOT;
	try {
		const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const p = path.join(root, "@earendil-works", "pi-coding-agent");
		if (fs.existsSync(path.join(p, "dist", "index.js"))) return p;
	} catch {}
	throw new Error("pi package not found under `npm root -g`; set PI_ROOT");
})();
export const NODE = process.execPath;
export const CLI = fs.existsSync(path.join(PI_ROOT, "dist", "bundle", "cli.js"))
	? path.join(PI_ROOT, "dist", "bundle", "cli.js")
	: path.join(PI_ROOT, "dist", "cli.js");
/** Scratch: the private agent dirs, logs, the test image. */
export const SCRATCH = process.env.WD_RIG_DIR || path.join(os.tmpdir(), "wd-rig");
export const AGENT = path.join(SCRATCH, "agent");
export const AGENT_OFF = path.join(SCRATCH, "agent-off");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const KEYS = {
	enter: "\r",
	esc: "\x1b",
	"ctrl-c": "\x03",
	"ctrl-d": "\x04",
	"ctrl-g": "\x07",
	"ctrl-r": "\x12",
	"ctrl-s": "\x13",
	"ctrl-o": "\x0f",
	up: "\x1b[A",
	down: "\x1b[B",
	pgup: "\x1b[5~",
	pgdn: "\x1b[6~",
	"alt-s": "\x1bs",
	"alt-v": "\x1bv",
	tab: "\t",
};

export function launch({ args = [], cwd = os.homedir(), cols = 140, rows = 40, env = {}, agentDir = AGENT, log } = {}) {
	const term = new Terminal({ cols, rows, allowProposedApi: true });
	const raw = [];
	let exited = null;
	const p = pty.spawn(NODE, [CLI, ...args], {
		name: "xterm-256color",
		cols,
		rows,
		cwd,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TERM: "xterm-256color", COLORTERM: "truecolor", ...env },
	});
	p.onData((d) => {
		raw.push(d);
		term.write(d);
		if (log) fs.appendFileSync(log, d);
	});
	p.onExit((e) => {
		exited = e;
	});
	const api = {
		pty: p,
		term,
		screen() {
			const b = term.buffer.active;
			const out = [];
			for (let i = 0; i < term.rows; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
			return out;
		},
		text() {
			return api.screen().join("\n");
		},
		alt() {
			return term.buffer.active.type === "alternate";
		},
		rawText() {
			return raw.join("");
		},
		send(s) {
			p.write(s);
		},
		key(name) {
			const k = KEYS[name];
			if (!k) throw new Error("unknown key " + name);
			p.write(k);
		},
		paste(s) {
			p.write("\x1b[200~" + s + "\x1b[201~");
		},
		mouse(col, row, btn = 0) {
			p.write(`\x1b[<${btn};${col};${row}M`);
			p.write(`\x1b[<${btn};${col};${row}m`);
		},
		wheel(col, row, up = true) {
			p.write(`\x1b[<${up ? 64 : 65};${col};${row}M`);
		},
		async waitFor(re, ms = 30000, label) {
			const t0 = Date.now();
			while (Date.now() - t0 < ms) {
				const t = api.text();
				if (re.test(t)) return t;
				if (exited)
					throw new Error(
						"pi exited (" + JSON.stringify(exited) + ") while waiting for " + (label ?? re) + "\n--- screen ---\n" + t,
					);
				await sleep(100);
			}
			throw new Error("timeout waiting for " + (label ?? re) + "\n--- screen ---\n" + api.text());
		},
		async waitGone(re, ms = 30000) {
			const t0 = Date.now();
			while (Date.now() - t0 < ms) {
				if (!re.test(api.text())) return;
				await sleep(100);
			}
			throw new Error("timeout waiting for " + re + " to go");
		},
		async waitExit(ms = 20000) {
			const t0 = Date.now();
			while (Date.now() - t0 < ms) {
				if (exited) return exited;
				await sleep(100);
			}
			throw new Error("pi did not exit\n--- screen ---\n" + api.text());
		},
		exited: () => exited,
		kill() {
			try {
				p.kill();
			} catch {}
		},
	};
	return api;
}

export function show(api, label) {
	console.log(`--- screen: ${label} (alt=${api.alt()}) ---`);
	console.log(
		api
			.screen()
			.map((l, i) => String(i).padStart(2) + "|" + l)
			.join("\n"),
	);
}

/** The terminal-mode restore, read from a pi-tui write log (not the pty stream — see the header). */
export function modesRestored(written) {
	const tail = written.slice(-4000);
	return {
		altOff: tail.includes("\x1b[?1049l"),
		mouseOff: tail.includes("\x1b[?1003l") && tail.includes("\x1b[?1006l"),
		autowrapOn: tail.includes("\x1b[?7h"),
	};
}
