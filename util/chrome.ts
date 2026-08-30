/**
 * The one Chrome/Chromium probe. Two consumers share it so the "a system
 * Chrome on PATH" stance is one decision: WebFetch's render tier
 * (tools/library/webfetch/daemon.ts) and the default browser MCP server
 * (mcp/index.ts). Playwright's own `channel: "chrome"` lookup — which finds
 * Chrome where it is NOT on PATH (macOS /Applications, Windows Program
 * Files) — is each consumer's fallback, not this probe's job.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Probed in this order; the first executable on PATH wins. */
export const CHROME_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];

/**
 * The first candidate that is an executable file on PATH (PATHEXT-aware on
 * Windows), or null. In-process on purpose: this used to shell out to
 * `bash -lc "command -v …"`, and a machine without bash made spawnSync return
 * no stdout (a TypeError before the intended "no Chrome" message), while `-l`
 * sourced the user's login profile — arbitrary startup code, a reset PATH —
 * on the first render.
 */
export function findChromeOnPath(names: string[] = CHROME_NAMES): string | null {
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const name of names) {
		for (const dir of dirs) {
			for (const ext of exts) {
				const candidate = path.join(dir, name + ext);
				try {
					fs.accessSync(candidate, fs.constants.X_OK);
					if (fs.statSync(candidate).isFile()) return candidate;
				} catch {}
			}
		}
	}
	return null;
}
