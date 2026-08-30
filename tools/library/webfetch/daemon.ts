/**
 * fetch daemon: the single owner of one headless Chrome for this machine.
 *
 * Runs as a detached process. Launches Chrome via playwright launchServer,
 * writes its websocket endpoint to the state file, and exits when:
 *   - no fetch activity for WEBFETCH_DAEMON_IDLE_MS (default 10 min), or
 *   - it has been up for MAX_AGE_MS (6h; bounds memory drift), or
 *   - told to stop (client deletes the state file and sends SIGTERM).
 *
 * Clients (pi sessions, CLI, scouts) connect over the ws endpoint; spawning
 * and discovery live in daemon-client.ts. Activity is tracked by mtime of the
 * activity file; clients touch it per fetch. Connections are deliberately NOT
 * tracked: an idle-but-connected pi session must not keep Chrome warm forever.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium } from "playwright-core";
import { findChromeOnPath } from "../../../util/chrome.ts";
import { envInt, stateDir } from "./util.ts";

// 0 is honoured (exit at the next check) — `Number(env) || default` used to
// turn the one value meaning "do not linger" back into ten minutes. Any other
// value is floored at 10s so a typo cannot make the daemon churn.
const rawIdle = envInt("WEBFETCH_DAEMON_IDLE_MS", 600_000);
const IDLE_MS = rawIdle > 0 ? Math.max(10_000, rawIdle) : 0;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 30_000;

const LAUNCH_ARGS = [
	"--no-sandbox",
	"--disable-dev-shm-usage",
	"--disable-blink-features=AutomationControlled",
	"--disable-gpu",
];

export { stateDir };
export const STATE_FILE = path.join(stateDir(), "fetch-daemon.json");
export const ACTIVITY_FILE = path.join(stateDir(), "fetch-daemon.activity");

async function launchServer() {
	try {
		return await chromium.launchServer({ headless: true, channel: "chrome", args: LAUNCH_ARGS });
	} catch {
		// Resolve a system Chrome/Chromium from PATH (util/chrome.ts — the
		// same probe the default browser MCP server uses).
		const found = findChromeOnPath();
		if (!found) throw new Error("no Chrome/Chromium binary found to launch headless");
		return await chromium.launchServer({ headless: true, executablePath: found, args: LAUNCH_ARGS });
	}
}

/**
 * Playwright's per-launch profile directories survive a KILLED daemon (2-6 MB
 * each, mode 0700) and nothing else ever removes them. Sweep the ones that are
 * provably nobody's: older than the daemon's own maximum lifetime and with no
 * live process holding their SingletonLock.
 */
function sweepStaleProfiles(): void {
	const tmp = os.tmpdir();
	let names: string[];
	try {
		names = fs.readdirSync(tmp).filter((n) => n.startsWith("playwright_chromiumdev_profile-"));
	} catch {
		return;
	}
	for (const name of names) {
		const dir = path.join(tmp, name);
		try {
			const st = fs.statSync(dir);
			// getuid is absent on Windows; `st.uid !== undefined` skipped every
			// profile there, so stale ones were never swept (2026-08-30).
			if (!st.isDirectory() || (typeof process.getuid === "function" && st.uid !== process.getuid())) continue;
			if (Date.now() - st.mtimeMs < MAX_AGE_MS + 3_600_000) continue; // still possibly in use
			// Chrome's SingletonLock is a symlink ending in "-<pid>".
			try {
				const target = fs.readlinkSync(path.join(dir, "SingletonLock"));
				const pid = Number(/-(\d+)$/.exec(target)?.[1]);
				if (Number.isFinite(pid) && pid > 0) {
					try {
						process.kill(pid, 0);
						continue; // a live Chrome owns it
					} catch {
						/* gone — safe to remove */
					}
				}
			} catch {
				/* no lock file: an abandoned profile */
			}
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore one directory and keep going */
		}
	}
}

function activityMs(): number {
	try {
		return fs.statSync(ACTIVITY_FILE).mtimeMs;
	} catch {
		return 0;
	}
}

async function main() {
	// Single-instance guard: a live state file with a connectable endpoint wins.
	try {
		const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
		if (st?.ws && st?.pid) {
			try {
				process.kill(st.pid, 0);
				process.exit(0); // another daemon already serves
			} catch {}
		}
	} catch {}

	fs.mkdirSync(stateDir(), { recursive: true });
	sweepStaleProfiles();
	const server = await launchServer();
	const startedAt = Date.now();
	fs.writeFileSync(STATE_FILE, JSON.stringify({ ws: server.wsEndpoint(), pid: process.pid, startedAt }), {
		mode: 0o600,
	});
	fs.writeFileSync(ACTIVITY_FILE, String(startedAt));

	const shutdown = async () => {
		try {
			fs.rmSync(STATE_FILE, { force: true });
		} catch {}
		try {
			fs.rmSync(ACTIVITY_FILE, { force: true });
		} catch {}
		try {
			await server.close();
		} catch {}
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	const timer = setInterval(() => {
		const idleFor = Date.now() - activityMs();
		const age = Date.now() - startedAt;
		if (idleFor > IDLE_MS || age > MAX_AGE_MS) void shutdown();
	}, CHECK_EVERY_MS);
	timer.unref();
}

main().catch((e) => {
	try {
		fs.rmSync(STATE_FILE, { force: true });
	} catch {}
	console.error("fetch-daemon fatal:", e?.message ?? e);
	process.exit(1);
});
