/**
 * fetch daemon client: discovery, spawn, and connect for the shared Chrome.
 *
 * Every fetch path (pi session, CLI, scout) goes through here. At most one
 * daemon exists per machine; at most one Chrome per daemon. A client never
 * launches its own browser.
 *
 * Discovery: read the state file, connect to the ws endpoint. On a miss or a
 * dead endpoint, spawn the daemon (lockdir makes the spawn race-safe), poll
 * for the state file, connect. Activity is signalled by touching the activity
 * file once per fetch; the daemon exits after 10 idle minutes.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { errLabel, stateDir } from "./util.ts";

const STATE_DIR = stateDir();
const STATE_FILE = path.join(STATE_DIR, "fetch-daemon.json");
const ACTIVITY_FILE = path.join(STATE_DIR, "fetch-daemon.activity");
const LOCK_DIR = path.join(STATE_DIR, "fetch-daemon.spawn.lock");
const LOG_FILE = path.join(STATE_DIR, "fetch-daemon.log");
const LASTERROR_FILE = path.join(STATE_DIR, "fetch-daemon.lasterror");

const CONNECT_TIMEOUT_MS = 3_000;
const SPAWN_WAIT_MS = 25_000;
// How long a failed spawn is remembered. Without Chrome installed EVERY render
// fetch paid the full 25s poll and then reported nothing useful; one process
// should learn that once.
const SPAWN_MEMO_MS = 60_000;

let spawnMemo: { at: number; message: string } | null = null;

function thisDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

function extensionRoot(): string {
	// tools/library/webfetch/ → war-dogs/
	return path.resolve(thisDir(), "..", "..", "..");
}

function readState(): { ws: string; pid: number } | null {
	try {
		const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
		if (st?.ws && st?.pid) return st;
	} catch {}
	return null;
}

/** Record fetch activity; the daemon's idle clock keys off this file's mtime. */
export function touchDaemonActivity(): void {
	try {
		fs.mkdirSync(STATE_DIR, { recursive: true });
		const now = new Date();
		fs.writeFileSync(ACTIVITY_FILE, String(Date.now()));
		fs.utimesSync(ACTIVITY_FILE, now, now);
	} catch {}
}

async function tryConnect(ws: string): Promise<Browser | null> {
	try {
		const b = await chromium.connect(ws, { timeout: CONNECT_TIMEOUT_MS });
		// It works: forget any remembered failure, here and on disk, so the next
		// client does not inherit a stale reason.
		spawnMemo = null;
		try {
			fs.rmSync(LASTERROR_FILE, { force: true });
		} catch {}
		return b;
	} catch {
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Take the spawn lock, breaking a DEAD one.
 *
 * The lock is a directory (atomic on POSIX), released in a `finally`. But a
 * `finally` does not run when the process is killed, and the window it
 * guards is the whole 25s spawn-and-poll — so a Ctrl-C on `npm run fetch`,
 * or quitting pi during a first render, could leave the directory behind
 * FOREVER. From then on every render-tier fetch took the "someone else is
 * spawning" branch, polled 25s and failed: the render tier was permanently
 * disabled by a stale empty directory, with only the static tier left.
 *
 * A lock now records its owner pid. It is broken when that owner is gone, or
 * when it has outlived the spawn budget by a wide margin. EPERM from
 * process.kill means the pid exists under another user, which counts as
 * alive — a foreign live lock is still respected.
 */
/** /proc/<pid>/stat field 22 (starttime) — the only thing that tells two
 *  processes with the same pid apart. Readable for any user's process. */
function procStart(pid: number): string | null {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// comm (field 2) is parenthesised and may itself contain spaces/parens.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[19] ?? null; // field 3 is at index 0, so field 22 is index 19
	} catch {
		return null;
	}
}

function readLockOwner(): { pid: number; start?: string } | null {
	try {
		const raw = fs.readFileSync(path.join(LOCK_DIR, "pid"), "utf8").trim();
		if (raw.startsWith("{")) {
			const o = JSON.parse(raw);
			if (Number.isFinite(o?.pid) && o.pid > 0) return { pid: Number(o.pid), start: o.start ?? undefined };
			return null;
		}
		const pid = Number(raw); // legacy: a bare pid, with no way to detect reuse
		return Number.isFinite(pid) && pid > 0 ? { pid } : null;
	} catch {
		return null;
	}
}

function lockAgeMs(): number {
	try {
		return Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
	} catch {
		return -1;
	}
}

function lockIsDead(): boolean {
	const owner = readLockOwner();
	if (owner) {
		const startNow = procStart(owner.pid);
		if (owner.start && startNow && startNow !== owner.start) {
			// The pid is alive but it is NOT our owner: the number was recycled
			// after the owner died. Without the start time this read as "alive"
			// and the lock could never be broken — a 2-hour-old lock kept every
			// render fetch paying 25s and failing, forever.
			return true;
		}
		if (startNow === null) {
			try {
				process.kill(owner.pid, 0);
			} catch (e) {
				// ESRCH: provably gone, so the lock is dead NOW — do not fall
				// through to the age check, or a freshly-orphaned lock stays
				// honoured for another 35s for no reason. EPERM means the pid
				// exists under another user: alive, respect it (until the age
				// check below, which bounds even a foreign lock).
				if ((e as NodeJS.ErrnoException)?.code !== "EPERM") return true;
			}
		}
	}
	// A live owner is respected only for as long as a spawn can legitimately
	// take. Past that the lock is stale whoever holds it — an unverifiable
	// legacy lock, another user's, or a process that is simply not going to
	// finish — and the render tier must not stay disabled by it.
	const age = lockAgeMs();
	return age >= 0 && age > SPAWN_WAIT_MS + 10_000;
}

function acquireLock(): boolean {
	const take = () => {
		fs.mkdirSync(LOCK_DIR); // atomic on POSIX: fails if another process holds it
		try {
			// pid AND its start time: a pid alone cannot be told from the next
			// process to be handed that number.
			const owner = JSON.stringify({ pid: process.pid, start: procStart(process.pid) });
			fs.writeFileSync(path.join(LOCK_DIR, "pid"), owner);
		} catch {}
		return true;
	};
	try {
		fs.mkdirSync(STATE_DIR, { recursive: true });
		return take();
	} catch {}
	// Held by someone. Break it only if that someone is provably gone.
	try {
		if (!lockIsDead()) return false;
		fs.rmSync(LOCK_DIR, { recursive: true, force: true });
		return take();
	} catch {
		return false;
	}
}

function releaseLock(): void {
	try {
		fs.rmSync(LOCK_DIR, { recursive: true, force: true });
	} catch {}
}

/**
 * Start the daemon.
 *
 * Three things this must never do again. It must not spawn a SHIM: the old
 * code ran `node_modules/.bin/tsx`, a symlink whose exec bit does not survive
 * a zip or a FAT copy — and the README's install instruction is literally
 * "copy this folder". It must not spawn without an `error` listener: node
 * emits 'error' for ENOENT/EACCES, an unhandled 'error' event is an
 * uncaughtException, and pi's handler prints "pi exiting due to
 * uncaughtException" and exits — a missing tsx killed the whole session
 * (demonstrated on a copy of the tree). And it must be ONE process, not
 * tsx's CLI: `tsx/dist/cli.mjs` spawns a SECOND node for the script, and on
 * Windows that grandchild — a console app whose parent our `detached: true`
 * left without a console, spawned by tsx with no windowsHide — got a fresh
 * console allocated by the OS, which Windows 11 hosts in a VISIBLE Windows
 * Terminal window for the daemon's whole lifetime (the maintainer's
 * screenshot, 2026-08-31; reproduced: two new console-host processes per
 * daemon spawn). So THIS node runs the daemon directly with tsx registered
 * through `--import` (tsx's package export `.` is its loader), as a file URL
 * because `--import C:\…` is ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows: one
 * process, and our own spawn options govern the only console candidate.
 *
 * stdio goes to a log file rather than /dev/null so the reason a daemon died
 * (no Chrome on this machine, most often) can be reported instead of a bare
 * "did not come up within 25s".
 */
function spawnDaemon(): void {
	const root = extensionRoot();
	const daemon = path.join(thisDir(), "daemon.ts");
	const tsxLoader = path.join(root, "node_modules", "tsx", "dist", "loader.mjs");
	const tsxShim = path.join(root, "node_modules", ".bin", "tsx");
	let cmd: string;
	let args: string[];
	if (fs.existsSync(tsxLoader)) {
		cmd = process.execPath; // this node — no shim, no exec bit, no second process
		args = ["--import", pathToFileURL(tsxLoader).href, daemon];
	} else if (fs.existsSync(tsxShim)) {
		cmd = tsxShim;
		args = [daemon];
	} else {
		throw new Error(`tsx is missing from ${root}/node_modules — run \`npm install\` there (the render tier needs it)`);
	}
	let log: number | undefined;
	try {
		fs.mkdirSync(STATE_DIR, { recursive: true });
		log = fs.openSync(LOG_FILE, "w");
	} catch {
		/* no log file — the spawn still happens, just without a captured reason */
	}
	const child = spawn(cmd, args, {
		detached: true,
		windowsHide: true,
		stdio: log === undefined ? "ignore" : ["ignore", log, log],
	});
	// A spawn failure arrives as an EVENT, not a throw. Unhandled, it is an
	// uncaughtException that takes pi down with it.
	child.on("error", (e) => {
		try {
			fs.writeFileSync(LASTERROR_FILE, `spawn ${cmd}: ${errLabel(e)}`, { mode: 0o600 });
		} catch {}
	});
	child.unref();
	if (log !== undefined) {
		try {
			fs.closeSync(log);
		} catch {}
	}
}

/**
 * What the dying daemon actually said. Prefer its own fatal line — Playwright
 * logs a browser argv dump and a tidy-up message AFTER the failure, so "the
 * last line" is noise ("finished temporary directories cleanup").
 */
const FATAL_PATTERNS = [
	/^fetch-daemon fatal:/i,
	/failed to launch|no chrome\/chromium|executable doesn't exist/i,
	/error/i,
];
function daemonLastError(): string | null {
	for (const f of [LOG_FILE, LASTERROR_FILE]) {
		try {
			const lines = fs
				.readFileSync(f, "utf8")
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
			if (!lines.length) continue;
			// Most specific first: the daemon's OWN fatal line beats any of the
			// browser noise Playwright prints after it.
			for (const re of FATAL_PATTERNS) {
				const hit = lines.find((l) => re.test(l));
				if (hit) return hit.slice(0, 200);
			}
			return lines[lines.length - 1].slice(0, 200);
		} catch {}
	}
	return null;
}

function rememberSpawnFailure(message: string): Error {
	spawnMemo = { at: Date.now(), message };
	try {
		fs.mkdirSync(STATE_DIR, { recursive: true });
		fs.writeFileSync(LASTERROR_FILE, message, { mode: 0o600 });
	} catch {}
	return new Error(message);
}

/** Connect to the shared browser, spawning the daemon if needed. */
export async function getDaemonBrowser(): Promise<Browser> {
	const st = readState();
	if (st) {
		const b = await tryConnect(st.ws);
		if (b) return b;
		// Stale endpoint (dead daemon); fall through to spawn.
	}

	// A spawn that just failed for a structural reason (no Chrome on this box)
	// will fail again the same way. Fail FAST with the reason instead of paying
	// another 25s poll per fetch.
	if (spawnMemo && Date.now() - spawnMemo.at < SPAWN_MEMO_MS) throw new Error(spawnMemo.message);

	if (!acquireLock()) {
		// Another process is spawning right now; wait for the endpoint to appear.
		const deadline = Date.now() + SPAWN_WAIT_MS;
		while (Date.now() < deadline) {
			await sleep(400);
			const st2 = readState();
			if (st2) {
				const b = await tryConnect(st2.ws);
				if (b) return b;
			}
		}
		throw new Error(
			`fetch daemon did not come up: another process holds the spawn lock ${LOCK_DIR}` +
				` (owner pid ${readLockOwner()?.pid ?? "unknown"}, held for ${Math.round(lockAgeMs() / 1000)}s).` +
				` Remove that directory if no daemon is starting.`,
		);
	}

	try {
		// Re-check under the lock: the loser of the race may have just spawned it.
		const st3 = readState();
		if (st3) {
			const b = await tryConnect(st3.ws);
			if (b) return b;
		}
		try {
			spawnDaemon();
		} catch (e) {
			throw rememberSpawnFailure(`fetch daemon could not be started: ${errLabel(e)}`);
		}
		const deadline = Date.now() + SPAWN_WAIT_MS;
		while (Date.now() < deadline) {
			await sleep(400);
			const st4 = readState();
			if (st4) {
				const b = await tryConnect(st4.ws);
				if (b) return b;
			}
		}
		// Say WHY. The daemon's own last words (e.g. "no Chrome/Chromium binary
		// found to launch headless") used to go to /dev/null, leaving every
		// client with a bare timeout and no way to act on it.
		const why = daemonLastError();
		throw rememberSpawnFailure(
			`fetch daemon did not come up within 25s${why ? ` — it said: ${why}` : ` (no output in ${LOG_FILE})`}`,
		);
	} finally {
		releaseLock();
	}
}

/** Report daemon state for `npm run fetch -- --daemon-status`. */
export function daemonStatus(): string {
	const st = readState();
	if (!st) return "no daemon (state file absent)";
	let pidAlive = false;
	try {
		process.kill(st.pid, 0);
		pidAlive = true;
	} catch {}
	let idleFor = "unknown";
	try {
		idleFor = `${Math.round((Date.now() - fs.statSync(ACTIVITY_FILE).mtimeMs) / 1000)}s`;
	} catch {}
	return pidAlive
		? `daemon running (pid ${st.pid}, idle for ${idleFor}, ws ${st.ws})`
		: `stale state file (pid ${st.pid} not running); next fetch will respawn`;
}

/** Stop the daemon for `npm run fetch -- --daemon-stop`. Returns what happened. */
export async function stopDaemon(): Promise<string> {
	const st = readState();
	if (!st) return "no daemon running";
	try {
		process.kill(st.pid, "SIGTERM");
	} catch {
		try {
			fs.rmSync(STATE_FILE, { force: true });
		} catch {}
		return `daemon pid ${st.pid} was not running; cleared stale state`;
	}
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			process.kill(st.pid, 0);
			await sleep(200);
		} catch {
			return `daemon stopped (pid ${st.pid})`;
		}
	}
	return `sent SIGTERM to pid ${st.pid} but it is still alive after 5s`;
}
