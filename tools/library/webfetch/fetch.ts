/**
 * The orchestrator: tier routing, the render cache, truncation-to-file, and
 * the assembly of every typed result. Two tiers serve content — the static
 * HTTP tier (static.ts, ~300ms, gate-checked) and the Chrome render tier
 * (render.ts). `auto` (default) tries static first and escalates to Chrome
 * on any doubt or JS-dependence evidence; `static` pins (no escalation,
 * honest statuses); `render` goes straight to Chrome.
 *
 * Every path returns a typed status so a blocked or empty page is never
 * mistaken for a good one: the oracle (oracle.ts) classifies what the render
 * tier captured, and the static tier's own status vocabulary is mapped
 * honestly in staticResult().
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extract } from "./extract.ts";
import { guardUrl } from "./guard.ts";
import { renderPageMap } from "./honest.ts";
import { classify } from "./oracle.ts";
import { renderFetch } from "./render.ts";
import { staticFetch } from "./static.ts";
import type { StaticResult } from "./static.ts";
import { cut } from "./truncate.ts";
import type { Extracted, FetchOpts, FetchResult, FetchStatus, RawCapture } from "./types.ts";
import { envInt } from "./util.ts";

// Which non-HTML bodies are text. Kept in step with render.ts's TEXTUAL_CT and
// static.ts's routing: a feed that reads as "[application/rss+xml — binary
// resource]" on one tier must not read as content on another.
const XML_CT = /\+xml|\/xml|^text\/xml|rss|atom/i;
const TEXT_CT = /^text\/|json|javascript|ecmascript|yaml|csv|x-sh|x-python|toml|ini|sql/i;

// Where full (untruncated) content is saved when a fetch overflows the limits.
// Private dir (0700), bounded file count — page content can be sensitive and
// this lives in the shared temp dir. Per-USER name under os.tmpdir(): a fixed
// world-writable "/tmp/better-webfetch" could be pre-created by another local
// user (mkdirSync never changes an existing dir's mode) with a symlink at
// the predictable sha1 filename; and it was not the OS temp dir on Windows.
const SAVE_DIR = (() => {
	let uid = "";
	try {
		uid = String(os.userInfo().uid);
	} catch {}
	return path.join(os.tmpdir(), `war-dogs-webfetch${uid ? `-${uid}` : ""}`);
})();
const SAVE_MAX_FILES = 100;
const SAVE_MAX_BYTES = 8 * 1024 * 1024; // one saved page must not fill /tmp

/** Save full content; returns the path, or null if the write failed. */
function saveFull(content: string): string | null {
	let body = content;
	if (Buffer.byteLength(body, "utf8") > SAVE_MAX_BYTES) {
		body = body.slice(0, SAVE_MAX_BYTES);
		const nl = body.lastIndexOf("\n");
		if (nl > 0) body = body.slice(0, nl);
		body += `\n\n… [saved copy capped at ${SAVE_MAX_BYTES} bytes; the page was longer.]`;
	}
	const id = createHash("sha1").update(body).digest("hex").slice(0, 12);
	const file = path.join(SAVE_DIR, `${id}.md`);
	try {
		mkdirSync(SAVE_DIR, { recursive: true, mode: 0o700 });
		// The dir must be OURS and private (mkdirSync leaves an existing dir's
		// owner/mode alone); refuse anything else rather than write into it.
		const st = statSync(SAVE_DIR);
		if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
		if (process.platform !== "win32" && (st.mode & 0o077) !== 0) return null;
		// Never follow a pre-placed symlink at the predictable name: replace it.
		try {
			if (lstatSync(file).isSymbolicLink()) rmSync(file);
		} catch {}
		writeFileSync(file, body, { mode: 0o600, flag: "w" });
		pruneSaveDir();
		return file;
	} catch {
		return null; // never claim a file that isn't there
	}
}

/** Keep the save dir bounded — evict the oldest files past the cap. */
function pruneSaveDir(): void {
	try {
		const files = readdirSync(SAVE_DIR).map((f) => `${SAVE_DIR}/${f}`);
		if (files.length <= SAVE_MAX_FILES) return;
		const byAge = files
			.map((f) => {
				try {
					return { f, t: statSync(f).mtimeMs };
				} catch {
					return { f, t: 0 };
				}
			})
			.sort((a, b) => a.t - b.t);
		for (const { f } of byAge.slice(0, files.length - SAVE_MAX_FILES)) {
			try {
				rmSync(f, { force: true });
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* ignore */
	}
}

// In-process render cache. The expensive part is the render; a URL fetched
// twice in a task (read, then verify) reuses one render, and all output modes
// of the same URL share it. Keyed by URL; classification/extraction/mode are
// recomputed per call (cheap). Lives for the process (a long-running host).
//
// TTL is short by default (60s) so frequently-updated pages (live prices) don't
// serve stale — and a cache hit is always flagged with its age so the agent
// knows. For truly live data, pass `noCache` to force a fresh render. Both the
// TTL and the concurrency cap are env-tunable.
const RENDER_TTL = envInt("WEBFETCH_CACHE_TTL_MS", 60_000);
const RENDER_CACHE_MAX = 20;
const _renderCache = new Map<string, { at: number; cap: RawCapture }>();
const _inflight = new Map<string, Promise<RawCapture>>(); // dedupe concurrent identical-URL renders

function cacheCap(url: string, cap: RawCapture): void {
	if (cap.httpStatus === 0) return; // don't cache transport failures
	_renderCache.set(url, { at: Date.now(), cap });
	if (_renderCache.size > RENDER_CACHE_MAX) {
		let oldestKey: string | undefined;
		let oldestAt = Infinity;
		for (const [k, v] of _renderCache) if (v.at < oldestAt) ((oldestAt = v.at), (oldestKey = k));
		if (oldestKey) _renderCache.delete(oldestKey);
	}
}

async function cachedRender(url: string, opts: FetchOpts): Promise<RawCapture> {
	const ropts = { settleMs: opts.settleMs, timeoutMs: opts.timeoutMs, maxTotalMs: opts.maxTotalMs };
	if (opts.noCache) {
		// A forced refresh REPLACES the stale entry. It used to bypass the cache
		// entirely — read and write — so after deliberately fetching fresh, the
		// superseded copy stayed and the next ordinary fetch served it right back
		// (labelled cache-hit, with an age measured from the ORIGINAL fetch).
		const cap = await renderFetch(url, ropts);
		cacheCap(url, cap);
		return cap;
	}
	const hit = _renderCache.get(url);
	if (hit && Date.now() - hit.at < RENDER_TTL) {
		// Flag the hit + its age so the agent can tell fresh from cached.
		return { ...hit.cap, cachedAgeMs: Date.now() - hit.at };
	}
	// A render for this URL is already running — join it instead of starting a
	// 2nd. Keyed by the RENDER OPTIONS too: the in-flight promise was built with
	// the FIRST caller's budgets, so a later caller asking for a longer timeout
	// silently inherited the shorter one. Same url + same budgets can share;
	// different budgets get their own render.
	const key = `${url}|${ropts.settleMs ?? ""}|${ropts.timeoutMs ?? ""}|${ropts.maxTotalMs ?? ""}`;
	const existing = _inflight.get(key);
	if (existing) return existing;
	const p = renderFetch(url, ropts)
		.then((cap) => {
			cacheCap(url, cap);
			return cap;
		})
		.finally(() => _inflight.delete(key));
	_inflight.set(key, p);
	return p;
}

export async function betterFetch(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
	// SSRF / scheme guard — the tool fetches agent-supplied URLs. Reject non-http(s)
	// schemes and private/reserved hosts before touching the browser.
	const g = await guardUrl(url);
	if (!g.ok) return errorResult(url, `blocked-by-policy: ${g.reason}`);
	try {
		return await runFetch(url, opts);
	} catch (e) {
		// Nothing should throw to the caller — always return a typed result.
		return errorResult(url, `fetch-error: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
	}
}

async function runFetch(url: string, opts: FetchOpts): Promise<FetchResult> {
	// Tier 0: static HTTP. Cheap and optimistic; the gate decides if chrome is
	// needed. Escalation policy: any doubt or JS-dependence evidence → chrome.
	const tierPref = opts.tier ?? "auto";
	let escalated: string | null = null;
	if (tierPref !== "render") {
		const s = await staticFetch(url, { timeoutMs: opts.timeoutMs }).catch(() => null);
		// tier:"static" PINS: static only, no escalation — the FetchOpts contract.
		// Whatever static found is reported honestly (a 403 is a bot-wall, a 429
		// is rate-limited), never relabeled "ok" with empty content, and never
		// silently retried through Chrome.
		if (tierPref === "static") {
			if (!s)
				return errorResult(url, 'static-tier-failure: the static fetch threw (tier:"static" never escalates)', "http");
			const out = staticResult(url, s);
			if (s.status === "escalate")
				out.notes.push('needs-render: the static tier cannot serve this page; use tier:"auto" or "render"');
			return out;
		}
		if (s) {
			// A policy block from the static tier — a redirect hop into a private
			// host, or a pinned-lookup refusal — is FINAL. Escalating would just
			// re-attempt the same SSRF through Chrome (whose guard is weaker: it
			// resolves DNS on its own and cannot be pinned). guardedFetch's
			// comment always stated this intent; the orchestrator now honours it
			// instead of bouncing the request into the render tier.
			const policy = s.notes.find((n) => n.startsWith("blocked-by-policy"));
			if (policy) return errorResult(url, policy, "http");
			const serveStatic = (s.status === "ok" && s.gate === "static-ok") || s.status === "not-found";
			if (serveStatic) return staticResult(url, s);
			escalated =
				s.status === "escalate"
					? `escalated: ${s.notes.join(" · ") || s.signals.join(" · ")}`
					: `escalated: static gate=${s.gate}${s.signals.length ? ` (${s.signals.join(" · ")})` : ""}`;
		} else {
			escalated = "escalated: static tier threw";
		}
	}

	const out = await runRender(url, opts);
	if (escalated) out.notes = [escalated, ...out.notes];
	return out;
}

async function runRender(url: string, opts: FetchOpts): Promise<FetchResult> {
	const cap = await cachedRender(url, opts);
	// Anything the transport itself needs the model to know (a refused redirect,
	// a capped text body, a PDF whose bytes never arrived) rides here.
	const capNotes = cap.captureNotes ?? [];

	// Transport failure — Chrome couldn't load anything.
	if (cap.httpStatus === 0 && !cap.html && !cap.pdf) {
		const errNote = cap.requestChain?.find((r) => r.url.startsWith("render-error:"))?.url ?? "unknown error";
		return result(url, cap, "error", emptyExtracted(0), ["transport-failure", ...capNotes, errNote]);
	}

	// Hard HTTP codes on NON-HTML responses. The HTML path runs the oracle,
	// which checks these codes first — but the PDF/JSON/binary branches skip
	// classify() and reported "ok" on any status: a 403 text/plain came back
	// [webfetch: ok · tier:render] (caught live during the audit's redirect
	// probe). Same codes, same precedence, same verdicts as the oracle's
	// rules 1-2.
	if (!cap.isHtml && cap.httpStatus >= 400) {
		const s = cap.httpStatus;
		const status: FetchStatus =
			s === 429
				? "rate-limited"
				: s === 404 || s === 410
					? "not-found"
					: s === 401
						? "login-wall"
						: s === 402
							? "paywall-hard"
							: s === 403
								? "bot-wall"
								: "error";
		return result(url, cap, status, emptyExtracted(cap.html.length), [
			`http:${s}`,
			`non-html:${cap.contentType || "unknown"}`,
			...capNotes,
		]);
	}

	// PDF — layout-preserving text extracted from the bytes.
	if (cap.pdf) {
		const ex: Extracted = {
			...emptyExtracted(cap.pdf.text.length),
			title: cap.pdf.title ?? null,
			content: cap.pdf.text,
			contentChars: cap.pdf.text.length,
			extractedChars: cap.pdf.extractedChars,
			truncated: cap.pdf.truncated,
		};
		const notes = [
			`pdf:${cap.pdf.pages}p`,
			...(cap.pdf.truncated ? [`pdf-capped:${cap.pdf.extractedChars}`] : []),
			...capNotes,
		];
		if (!cap.pdf.text) notes.push("pdf-extraction-empty (scanned/encrypted?)");
		return result(url, cap, cap.pdf.text ? "ok" : "error", ex, notes);
	}

	// Non-HTML. Anything whose bytes ARE the content is returned as text: JSON
	// pretty-printed, XML/RSS through the same extractor as HTML, everything else
	// textual verbatim. Only real binaries get the descriptive placeholder — and
	// a PDF that produced no bytes is an ERROR, not an "ok" placeholder.
	if (!cap.isHtml) {
		const ct = cap.contentType || "";
		if (/json/i.test(ct)) {
			const pretty = tryPrettyJson(cap.html);
			const ex = {
				...emptyExtracted(cap.html.length),
				content: pretty,
				contentChars: pretty.length,
				extractedChars: pretty.length,
			};
			return withApi(result(url, cap, "ok", ex, [`non-html:${ct}`, "returned-json-verbatim", ...capNotes]), cap);
		}
		if (XML_CT.test(ct) && cap.html.trim()) {
			const ex = extract(cap.html, cap.finalUrl);
			if (ex.content.trim()) {
				return withApi(result(url, cap, "ok", ex, [`non-html:${ct}`, `xml-extracted:${ct}`, ...capNotes]), cap);
			}
		}
		if (TEXT_CT.test(ct) && cap.html.trim()) {
			const ex = {
				...emptyExtracted(cap.html.length),
				content: cap.html,
				contentChars: cap.html.length,
				extractedChars: cap.html.length,
			};
			return withApi(result(url, cap, "ok", ex, [`non-html:${ct}`, `returned-verbatim:${ct}`, ...capNotes]), cap);
		}
		if (/pdf/i.test(ct)) {
			// The PDF branch above did not fire: no usable bytes reached extractPdf.
			// The transport usually already said why; only speak for it if it didn't.
			const said = capNotes.some((n) => n.startsWith("pdf-fetch-failed"));
			return result(url, cap, "error", emptyExtracted(cap.html.length), [
				`non-html:${ct}`,
				...capNotes,
				...(said ? [] : ["pdf-fetch-failed: the PDF bytes could not be retrieved, so no text was extracted"]),
			]);
		}
		// Image/binary: no text. Return a descriptive line, not empty content, so
		// the agent doesn't mistake it for an empty page.
		const desc = `[${ct || "binary"} — binary resource, no text content extracted]`;
		return result(
			url,
			cap,
			"ok",
			{ ...emptyExtracted(cap.html.length), content: desc, contentChars: desc.length, extractedChars: desc.length },
			[`non-text:${ct || "unknown"}`, ...capNotes],
		);
	}

	const { status, signals } = classify(cap);
	const ex = extract(cap.html, cap.finalUrl);
	const notes = [...signals, ...capNotes];
	if (ex.truncated) notes.push(`extract-capped:${ex.extractedChars}`);
	if (cap.apiResponses?.length) notes.push(`api-captured:${cap.apiResponses.length}`);
	if (status === "paywall-soft") notes.push("partial content behind metered wall — treat as incomplete");

	// Two modes: `whole` (page map + body) or `content` (body only).
	const mode = opts.mode ?? "whole";
	if (mode === "whole" && cap.chrome) {
		const map = renderPageMap(cap.chrome);
		if (map) ex.content = `${map}\n\n---\n\n${ex.content}`;
	}
	ex.contentChars = ex.content.length;
	notes.push(`mode:${mode}`);

	const out = withApi(result(url, cap, status, ex, notes), cap);
	if (cap.chrome) out.pageMap = cap.chrome;
	return out;
}

// ------------------------------------------------------------------ helpers

/** Wrap a static-tier result as a FetchResult, with the same truncation rules. */
/**
 * Cap the content and, when it had to be cut, save the full text and point at
 * it. ONE implementation on purpose: this block lived twice, verbatim, in
 * staticResult() and result(), so any fix to one silently missed the other.
 */
function capContent(
	content: string,
	notes: string[],
): { content: string; truncated: boolean; fullContentPath?: string; notes: string[] } {
	const c = cut(content);
	if (!c.truncated) return { content, truncated: false, notes };
	const saved = saveFull(content); // null if the write failed — don't lie about it
	const kb = Math.round(c.keptBytes / 1024);
	const totalKb = Math.round(c.totalBytes / 1024);
	// A partially-shown last line must be RE-READ, not skipped: it is counted in
	// keptLines but its tail was never shown, and resuming after it silently ate
	// the remainder (a 200 KB one-line page said "resume at line 2" of a 1-line
	// file — i.e. read nothing).
	const resumeLine = c.keptLines + (c.partial ? 0 : 1);
	const head = `${c.kept}\n\n… [truncated — showing ${c.keptLines} lines / ${kb} KB of ${c.totalLines} lines / ${totalKb} KB.`;
	if (saved) {
		// Tell the agent to RESUME at the offset — reading from the start returns
		// this same first chunk (the host truncates every read the same way). When
		// the cut landed INSIDE a line, a line-based read cannot get past it at
		// all, so hand over the byte offset instead of a resume line that would
		// replay the same chunk forever.
		const how = c.partial
			? `Line ${resumeLine} is cut mid-line above, so reading ${saved} by line just repeats this chunk — continue from the exact byte with \`tail -c +${c.keptBytes + 1} ${saved}\`.`
			: `To read the rest, read ${saved} starting at line ${resumeLine} (reading it from the start returns this same chunk).`;
		return {
			content: `${head} ${how}]`,
			truncated: true,
			fullContentPath: saved,
			notes: [
				...notes,
				`truncated:${c.keptLines}L/${kb}KB · full:${saved} · ${c.partial ? `resume-at-byte:${c.keptBytes + 1}` : `resume-at-line:${resumeLine}`}`,
			],
		};
	}
	return {
		content: `${head} Full content could NOT be saved to disk.]`,
		truncated: true,
		notes: [...notes, `truncated:${c.keptLines}L/${kb}KB · full-save-failed`],
	};
}

function staticResult(url: string, s: StaticResult): FetchResult {
	// Deduped: the static blocked/rate-limited branches record the http code in
	// BOTH signals and notes, which printed "http:403 · http:403".
	let notes = [...new Set([...s.signals, ...s.notes])];
	const capped = capContent(s.content, notes);
	const content = capped.content;
	const truncated = capped.truncated;
	const fullContentPath = capped.fullContentPath;
	notes = capped.notes;
	return {
		url,
		finalUrl: s.finalUrl,
		// Honest status mapping. The auto path only serves ok/not-found through
		// here, but tier:"static" serves EVERYTHING static produced, so every
		// static status must map to a truthful FetchStatus — a 403 relabeled
		// "ok" with empty content is the exact lie this tool exists to prevent.
		// "escalate" (needs Chrome) and "error" both land on "error"; the notes
		// carry the mechanism.
		status:
			s.status === "ok"
				? "ok"
				: s.status === "not-found"
					? "not-found"
					: s.status === "rate-limited"
						? "rate-limited"
						: s.status === "blocked"
							? s.httpStatus === 401
								? "login-wall"
								: "bot-wall"
							: "error",
		tier: "http",
		httpStatus: s.httpStatus,
		fetchedAt: new Date().toISOString(),
		notes,
		title: s.title,
		byline: s.byline,
		publishedAt: s.publishedAt,
		modifiedAt: s.modifiedAt,
		content,
		contentChars: content.length,
		extractedChars: s.extractedChars,
		// Real structure, not an empty stub: this tier runs the same extractor as
		// the render tier, so the CLI header and details.links stop reporting
		// "0 tables / 0 code / 0 links" for every statically-served page.
		structured: s.structured,
		links: s.links,
		htmlChars: s.htmlChars,
		boilerplateRatio: s.htmlChars ? +(1 - s.contentChars / s.htmlChars).toFixed(3) : 0,
		truncated,
		fullContentPath,
	};
}

function result(
	url: string,
	cap: RawCapture,
	status: FetchResult["status"],
	ex: Extracted,
	notes: string[],
): FetchResult {
	// Cache-hit transparency — the agent must be able to tell a fresh render from
	// a cached one (matters for live/frequently-updated pages).
	if (cap.cachedAgeMs != null)
		notes = [...notes, `cache-hit:age=${Math.round(cap.cachedAgeMs / 1000)}s (pass noCache for a fresh render)`];

	// Truncate at 2000 lines / 50 KB (whichever first). Save the full content to
	// disk and point to it, so an agent can read the rest without every fetch
	// dumping a whole page into its context.
	const capped = capContent(ex.content, notes);
	const content = capped.content;
	// ex.truncated may already be set by the extractor; capping only adds to it.
	const truncated = ex.truncated || capped.truncated;
	const fullContentPath = capped.fullContentPath;
	notes = capped.notes;

	return {
		url,
		finalUrl: cap.finalUrl,
		status,
		tier: "render",
		httpStatus: cap.httpStatus,
		fetchedAt: cap.fetchedAt,
		notes,
		...ex,
		content,
		contentChars: content.length,
		truncated,
		fullContentPath,
	};
}

function withApi(r: FetchResult, cap: RawCapture): FetchResult {
	if (cap.apiResponses?.length) r.apiResponses = cap.apiResponses;
	return r;
}

function errorResult(url: string, note: string, tier: FetchResult["tier"] = "render"): FetchResult {
	return {
		url,
		finalUrl: url,
		status: "error",
		tier,
		httpStatus: 0,
		fetchedAt: new Date().toISOString(),
		notes: [note],
		...emptyExtracted(0),
	};
}

function emptyExtracted(htmlChars: number): Extracted {
	return {
		title: null,
		byline: null,
		publishedAt: null,
		modifiedAt: null,
		content: "",
		structured: { tables: [], codeBlocks: [], jsonld: [] },
		links: [],
		contentChars: 0,
		extractedChars: 0,
		htmlChars,
		boilerplateRatio: 0,
		truncated: false,
	};
}

function tryPrettyJson(s: string): string {
	try {
		return JSON.stringify(JSON.parse(s), null, 2);
	} catch {
		return s;
	}
}
