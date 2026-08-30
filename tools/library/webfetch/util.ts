/** Small pure helpers shared across the fetch pipeline. No I/O. */

import * as os from "node:os";
import * as path from "node:path";

/**
 * The one place the webfetch state directory is named. daemon.ts derived it
 * from `HOME ?? "/tmp"` while daemon-client.ts used `os.homedir()`, so a
 * process with no HOME wrote its state file where the other one would never
 * look for it — two daemons, two Chromes, and a spawn lock nobody shared.
 */
export function stateDir(): string {
	return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "war-dogs");
}

/**
 * A non-negative integer from the environment, or the default.
 *
 * `Number(env) || def` treats the ONE value a user would deliberately pick to
 * turn something off — `0` — as "unset", so `WEBFETCH_CACHE_TTL_MS=0` meant a
 * 60-second cache. An explicit 0 is honoured; only a missing, empty, negative
 * or non-numeric value falls back.
 */
export function envInt(name: string, def: number, min = 0): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return def;
	const n = Number(raw);
	return Number.isFinite(n) && n >= min ? n : def;
}

/**
 * A short, human-readable label for a thrown value. `String(e?.code ?? …)`
 * printed `transport-failure: 23` for an abort (DOMException.code 23) — a
 * number nobody can act on. Name and message first, then the transport code
 * from the cause chain undici wraps its connect errors in.
 */
export function errLabel(e: unknown, max = 160): string {
	const any = e as { name?: string; message?: string; code?: unknown; cause?: { code?: unknown } } | null;
	const bits: string[] = [];
	if (any?.name && any.name !== "Error") bits.push(String(any.name));
	if (any?.message) bits.push(String(any.message));
	const code = typeof any?.cause?.code === "string" ? any.cause.code : typeof any?.code === "string" ? any.code : null;
	if (code && !bits.includes(code)) bits.push(code);
	return (bits.join(": ") || String(e)).slice(0, max);
}

/** Collapse any run of whitespace to a single space. */
export function collapseWs(s: string): string {
	return s.replace(/\s+/g, " ");
}

/**
 * A cheap, parser-free estimate of a page's visible text. Good enough for the
 * oracle's ratio heuristics — it does NOT need to be accurate extraction, only
 * to tell "300 chars of text in 200KB of HTML" (a shell) from a real article.
 */
export function roughText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&[a-z#0-9]+;/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Resolve a possibly-relative href against a base; return null for non-web links. */
export function resolveUrl(href: string, base: string): string | null {
	const h = (href || "").trim();
	if (!h || h.startsWith("#") || h.startsWith("javascript:") || h.startsWith("mailto:") || h.startsWith("tel:")) {
		return null;
	}
	try {
		const u = new URL(h, base);
		return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
	} catch {
		return null;
	}
}

/** Pull a YYYY-MM-DD (or /YYYY/MM/DD/) date out of a URL, if present. */
export function urlDate(url: string): string | null {
	const iso = url.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
	if (iso) {
		const [, y, m, d] = iso;
		return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
	}
	return null;
}
