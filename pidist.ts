/**
 * Where the RUNNING pi's `dist/` is — for the few internals war-dogs reaches
 * that pi does not export from its package index (the syntax highlighter, the
 * theme loader). Every reach is listed in dev/internals/README.md's Upgrade Contract with a
 * probe; every caller falls back when the module is missing.
 *
 * `process.argv[1]` is the `pi` BIN SYMLINK when launched from PATH
 * (`~/.npm-global/bin/pi`); its real path is `…/dist/cli.js` (demonstrated:
 * the un-realpath'd test failed silently). Outside pi (a probe, the CLI) the
 * caller may set argv[1] to `<pi>/dist/cli.js` itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function piDistDir(): string | null {
	let a1 = process.argv[1] ?? "";
	try {
		a1 = fs.realpathSync(a1);
	} catch {}
	// 0.83 runs `<pi>/dist/cli.js`; 0.84.3's bin is the BUNDLE,
	// `<pi>/dist/bundle/cli.js` (pre-sweep 2026-08-25) — either way the
	// answer is the `dist/` directory, where the module tree lives.
	const m = /^(.*[\\/]dist)[\\/](?:bundle[\\/])?cli\.js$/.exec(a1);
	return m ? m[1] : null;
}

const cache = new Map<string, Promise<any>>();

/** Import `<pi>/dist/<rel>` once; resolves to null when pi's dist cannot be found or the import fails. */
export function importPiModule(rel: string): Promise<any> {
	let p = cache.get(rel);
	if (!p) {
		const dir = piDistDir();
		p = dir ? import(path.join(dir, rel)).catch(() => null) : Promise.resolve(null);
		cache.set(rel, p);
	}
	return p;
}
