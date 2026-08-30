/**
 * static tier: plain-HTTP fetch + extraction + the routing gate.
 *
 * This is tier 0 of betterFetch (fetch.ts): optimistic, fast (~300ms), and
 * honest about confidence. The gate answers one question: "is there positive
 * evidence this page needs JavaScript, or reason to doubt the extraction?"
 * Verdicts:
 *   static-ok        → serve this content, labeled tier:"http"
 *   doubt            → no hard evidence but low confidence; escalate to chrome
 *   would-escalate   → positive JS-dependence evidence; escalate to chrome
 * Policy (owner decision): when in doubt, chrome wins. Hollowness has no home.
 *
 * Never guesses "is this complete" (unprovable without rendering); detects
 * evidence: empty app roots, hydration markers, script-heaviness, low yield,
 * and code-drop (code-heavy pages whose <pre> blocks the extractor dropped).
 *
 * Both tiers run the SAME extractor (extract.ts). They used to disagree:
 * this tier ran Readability+Turndown, which has no table rule and drops big
 * data tables outright — the S&P-500 list came back as 4KB of prose with the
 * whole 503-row table missing, gate `static-ok`, notes `[]`, so `auto` served
 * it as a good page (audit-demonstrated). Readability also emitted unresolved
 * relative hrefs and empty image alts, and `structured` was hard-coded empty.
 * One extractor means one answer for a URL, whichever tier happens to serve it.
 */

import { Agent, fetch as undiciFetch, getGlobalDispatcher } from "undici";
import { load } from "cheerio";
import { extract } from "./extract.ts";
import { guardUrl, guardedLookup, policyBlockReason } from "./guard.ts";
import type { CodeBlock, MdTable } from "./types.ts";
import { errLabel } from "./util.ts";

export type StaticGate = "static-ok" | "doubt" | "would-escalate";
export type StaticStatus = "ok" | "not-found" | "blocked" | "rate-limited" | "escalate" | "error";

export interface StaticResult {
	status: StaticStatus;
	gate: StaticGate;
	signals: string[];
	title: string | null;
	byline: string | null;
	publishedAt: string | null;
	modifiedAt: string | null;
	content: string;
	contentChars: number;
	/** What the extractor produced before its memory cap (== contentChars normally). */
	extractedChars: number;
	htmlChars: number;
	httpStatus: number;
	finalUrl: string;
	contentType: string;
	structured: { tables: MdTable[]; codeBlocks: CodeBlock[]; jsonld: unknown[] };
	links: { text: string; href: string }[];
	notes: string[];
}

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_BODY = 8 * 1024 * 1024;
const MAX_REDIRECTS = 8;

/** Thrown when a fetch hop (entry or redirect target) fails the SSRF guard. */
class GuardError extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}

/**
 * Every static-tier connection resolves DNS through guardedLookup: the
 * addresses checked ARE the addresses dialled, so a rebinding flip between a
 * guard check and the connect is structurally impossible on this tier. The
 * per-hop guardUrl below stays as the pre-flight (schemes, hostnames, ports,
 * typed refusal messages); this Agent is the enforcement behind it.
 */
const pinnedAgent = new Agent({ connect: { lookup: guardedLookup } });

/**
 * Fetch with SSRF guarding on EVERY hop, not just the entry.
 *
 * `redirect: "follow"` re-checks nothing, so a public host that 302s to
 * http://127.0.0.1 (or a metadata endpoint) is followed and its body returned
 * — demonstrated in the audit. We follow manually and `guardUrl()` each
 * location, so a redirect can never reach a private/reserved host the entry
 * check would have refused.
 */
async function guardedFetch(startUrl: string, timeoutMs: number) {
	let url = startUrl;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const g = await guardUrl(url);
		if (!g.ok) throw new GuardError(g.reason ?? "blocked");
		const res = await undiciFetch(url, {
			redirect: "manual",
			dispatcher: pinnedAgent,
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				"user-agent": UA,
				accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
				"accept-language": "en-US,en;q=0.9",
			},
		});
		// undici surfaces 3xx as opaqueredirect only for redirect:"follow"; with
		// "manual" the status and Location header are visible, so follow by hand.
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get("location");
			if (!loc) return { res, finalUrl: url }; // a redirect with no target — hand it back as-is
			// Consume the body so the socket is released before the next hop.
			await res.body?.cancel?.().catch(() => {});
			url = new URL(loc, url).toString();
			continue;
		}
		return { res, finalUrl: url };
	}
	throw new GuardError(`too many redirects (>${MAX_REDIRECTS})`);
}

/**
 * Read at most `max` bytes and STOP — cancelling the stream rather than
 * downloading the whole body and slicing it afterwards. The old
 * `await res.text()` pulled everything into memory first: a 200 MB page cost
 * 9.9s and 310 MB of RSS before a single byte was thrown away.
 */
async function readCapped(
	body: ReadableStream<Uint8Array> | null,
	max: number,
): Promise<{ bytes: Buffer; capped: boolean; error?: string }> {
	if (!body) return { bytes: Buffer.alloc(0), capped: false };
	const reader = body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	let capped = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.length) continue;
			let buf = Buffer.from(value); // copy: the stream may reuse its backing store
			if (total + buf.length > max) {
				buf = buf.subarray(0, max - total);
				capped = true;
			}
			chunks.push(buf);
			total += buf.length;
			if (capped) break;
		}
	} catch (e) {
		// A body that dies mid-read is a transport failure, not an empty page —
		// swallowing it used to hand the gate an empty string and report "ok".
		return { bytes: Buffer.concat(chunks, total), capped, error: errLabel(e) };
	} finally {
		try {
			await reader.cancel();
		} catch {
			/* already closed */
		}
	}
	return { bytes: Buffer.concat(chunks, total), capped };
}

/** True when a body typed as JSON really does parse as JSON. */
function isParsableJson(kind: string, body: string): boolean {
	if (kind !== "text") return false;
	try {
		JSON.parse(body);
		return true;
	} catch {
		return false;
	}
}

/** The charset a body announces about itself: BOM, then <meta>, then XML decl. */
function sniffCharset(bytes: Buffer): string | null {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	const head = bytes.subarray(0, 4096).toString("latin1");
	const m =
		/<meta[^>]+charset\s*=\s*["']?\s*([\w:.+-]+)/i.exec(head) ??
		/<\?xml[^>]+encoding\s*=\s*["']([\w:.+-]+)["']/i.exec(head);
	return m ? m[1] : null;
}

/**
 * Decode a body with the charset it actually uses.
 *
 * `res.text()` decodes UTF-8 unconditionally, so every Shift_JIS / GBK /
 * ISO-8859-1 page came back as mojibake with status `ok` — the model read
 * corrupted text and had no way to know. Order: Content-Type charset, then the
 * document's own declaration, then UTF-8; an undeclared body that is NOT valid
 * UTF-8 is re-read as windows-1252 (what the web actually serves), and any
 * remaining undecodable bytes are reported rather than hidden.
 */
function decodeBody(bytes: Buffer, contentType: string): { text: string; note: string | null } {
	const declared = /charset\s*=\s*["']?\s*([\w:.+-]+)/i.exec(contentType)?.[1] ?? null;
	const sniffed = sniffCharset(bytes);
	const wanted = declared ?? sniffed ?? "utf-8";
	const decode = (label: string): string | null => {
		try {
			return new TextDecoder(label).decode(bytes);
		} catch {
			return null; // unknown label
		}
	};
	let note: string | null = null;
	let text = decode(wanted);
	if (text === null) {
		note = `charset-unknown:${wanted} (decoded as utf-8)`;
		text = decode("utf-8") ?? bytes.toString("utf8");
	}
	if (!declared && !sniffed) {
		let validUtf8 = true;
		try {
			new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			validUtf8 = false;
		}
		if (!validUtf8) {
			const alt = decode("windows-1252");
			if (alt) {
				text = alt;
				note = "charset-fallback:windows-1252 (no charset declared, body is not valid UTF-8)";
			}
		}
	}
	if (!note && text.includes("�")) note = `charset-suspect:${wanted} (body contains undecodable bytes)`;
	return { text, note };
}

const APP_ROOTS = ["#root", "#app", "#__next", "#___gatsby", "[data-reactroot]", "[ng-app]"];
const HYDRATION_MARKERS = [
	"__NEXT_DATA__",
	"__NUXT__",
	"__INITIAL_STATE__",
	"ng-version",
	"data-reactroot",
	"window.__PRELOADED_STATE__",
];

const HTML_CT = /text\/html|application\/xhtml/i;
const XML_CT = /\+xml|\/xml|^text\/xml|rss|atom/i;
// Anything whose bytes ARE the content: served verbatim, never "binary".
const TEXT_CT = /^text\/|json|javascript|ecmascript|yaml|csv|x-sh|x-python|toml|ini|sql/i;

export async function staticFetch(rawUrl: string, opts: { timeoutMs?: number } = {}): Promise<StaticResult> {
	const timeoutMs = opts.timeoutMs ?? 20_000;
	const base: StaticResult = {
		status: "error",
		gate: "doubt",
		signals: [],
		title: null,
		byline: null,
		publishedAt: null,
		modifiedAt: null,
		content: "",
		contentChars: 0,
		extractedChars: 0,
		htmlChars: 0,
		httpStatus: 0,
		finalUrl: rawUrl,
		contentType: "",
		structured: { tables: [], codeBlocks: [], jsonld: [] },
		links: [],
		notes: [],
	};

	let res;
	let finalUrl: string;
	try {
		const got = await guardedFetch(rawUrl, timeoutMs);
		res = got.res;
		finalUrl = res.url || got.finalUrl;
	} catch (e: any) {
		// A guard rejection is a policy block, not a transport failure: escalating
		// to chrome would just re-attempt the same SSRF, so refuse outright.
		// (runFetch honours this — a blocked-by-policy note short-circuits the
		// auto tier's escalation.)
		if (e instanceof GuardError) return { ...base, notes: [`blocked-by-policy: ${e.reason}`] };
		// A pinned-lookup refusal surfaces from inside undici's connect, wrapped
		// in "fetch failed" — same policy semantics, same refusal.
		const policy = policyBlockReason(e);
		if (policy) return { ...base, notes: [`blocked-by-policy: ${policy}`] };
		// Transport trouble: chrome is the ground truth; escalate rather than fail.
		return {
			...base,
			status: "escalate",
			signals: ["transport-failure"],
			notes: [`transport-failure: ${errLabel(e)}`],
		};
	}

	const httpStatus = res.status;
	const contentType = res.headers.get("content-type") ?? "";
	const notes: string[] = [];

	const declaredLength = Number(res.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY) {
		notes.push(`over-size:${declaredLength}b declared, reading only the first ${MAX_BODY}b`);
	}
	const read = await readCapped(res.body as ReadableStream<Uint8Array> | null, MAX_BODY);
	if (read.capped) notes.push(`body-capped:${MAX_BODY}b (the page is larger; the rest was not downloaded)`);
	if (read.error) {
		// Reading the body failed part-way. Chrome may still manage it.
		return {
			...base,
			status: "escalate",
			httpStatus,
			finalUrl,
			contentType,
			htmlChars: read.bytes.length,
			signals: ["transport-failure"],
			notes: [...notes, `transport-failure: ${read.error} (while reading the response body)`],
		};
	}
	// What KIND of body is this? Decided before decoding, so a binary is never
	// turned into a 8 MB string just to be thrown away (and never reports a
	// charset note it has no business having).
	const ctype = contentType.split(";")[0].trim().toLowerCase();
	const sniffHead = read.bytes.subarray(0, 512).toString("latin1");
	const looksHtml = /^\s*(<!doctype html|<html|<head|<body|<meta|<div|<script)/i.test(sniffHead);
	const looksText = !/[\x00-\x08\x0e-\x1f]/.test(sniffHead);
	let kind: "html" | "xml" | "text" | "binary" = HTML_CT.test(ctype)
		? "html"
		: XML_CT.test(ctype)
			? "xml"
			: TEXT_CT.test(ctype)
				? "text"
				: !ctype && read.bytes.length && looksText
					? looksHtml
						? "html"
						: "text"
					: "binary";

	if (kind === "binary") {
		return {
			...base,
			status: "escalate",
			httpStatus,
			finalUrl,
			contentType,
			htmlChars: read.bytes.length,
			signals: [`non-text:${contentType || "unknown"}`],
			notes: [...notes, `non-text:${contentType || "unknown"} → chrome handles`],
		};
	}

	const decoded = decodeBody(read.bytes, contentType);
	const body = decoded.text;
	if (decoded.note) notes.push(decoded.note);

	// A body that declares one type and IS another: browsers do not sniff HTML
	// out of application/json, but a reader must — otherwise the model gets the
	// page's raw source instead of the page. Say which way it was read.
	if (kind !== "html" && looksHtml && !isParsableJson(kind, body)) {
		notes.push(`content-type-mismatch:${contentType || "none"} declared, body read as HTML`);
		kind = "html";
	}

	const fail = (status: StaticStatus, gate: StaticGate, code: string, extra: string[] = []): StaticResult => ({
		...base,
		status,
		gate,
		httpStatus,
		finalUrl,
		contentType,
		htmlChars: body.length,
		signals: [code, ...extra],
		notes: [...notes, code, ...extra],
	});

	if (httpStatus === 404 || httpStatus === 410) {
		const r = fail("not-found", "static-ok", `http:${httpStatus}`);
		r.signals = []; // a 404 is a verdict, not evidence of doubt
		return r;
	}
	if (httpStatus === 429) return fail("rate-limited", "doubt", "http:429");
	// 401 sign-in, 402 payment, 403 bot-wall — mapped to their true statuses in
	// staticResult(). Everything else ≥400 is an error page, not content.
	if (httpStatus === 401 || httpStatus === 402 || httpStatus === 403)
		return fail("blocked", "doubt", `http:${httpStatus}`);
	if (httpStatus >= 400) return fail("escalate", "doubt", `http:${httpStatus}`);

	// XML/RSS/Atom goes through the same extractor as HTML — a feed is text, not a
	// binary blob. Everything else textual is returned VERBATIM: the bytes ARE the
	// content, and re-flowing them would be a lie. Both used to end up as
	// `escalate` → chrome → "[text/plain — binary resource, no text content
	// extracted]" with status ok, and text/plain additionally THREW here.
	if (kind !== "html") return textualResult(base, body, httpStatus, finalUrl, contentType, notes, kind === "xml");

	const $ = load(body);
	const meta = extractMeta($);
	const codeBlocksInHtml = $("pre, code").length;

	const signals: string[] = [];
	let gate: StaticGate = "static-ok";

	for (const sel of APP_ROOTS) {
		const el = $(sel).first();
		if (el.length && (el.text() ?? "").trim().length < 100) {
			signals.push(`empty-app-root:${sel}`);
			gate = "would-escalate";
			break;
		}
	}

	// Destructive, and deliberately last of the DOM reads: nothing below needs
	// scripts, and this avoids a second full parse just to count visible text.
	$("script, style, noscript, template, svg").remove();
	const visibleChars = ($.root().text() ?? "").replace(/\s+/g, " ").trim().length;

	if (visibleChars < 800) {
		for (const m of HYDRATION_MARKERS) {
			if (body.includes(m)) {
				signals.push(`hydration-marker:${m} (thin content)`);
				gate = "would-escalate";
				break;
			}
		}
		if (body.length > 40_000 && visibleChars < 400) {
			signals.push(`script-heavy:${body.length}b html, ${visibleChars} visible chars`);
			if (gate === "static-ok") gate = "would-escalate";
		}
		if (/<noscript[^>]*>/i.test(body)) signals.push("noscript-present (thin content)");
		if (/enable javascript|javascript is required|javascript to run this app/i.test(body)) {
			signals.push("js-required-text");
			if (gate === "static-ok") gate = "would-escalate";
		}
	}

	let content = "";
	let title = meta.title;
	let byline = meta.byline;
	let publishedAt = meta.publishedAt;
	let modifiedAt: string | null = null;
	let structured = base.structured;
	let links = base.links;
	let extractedChars = 0;
	try {
		const ex = extract(body, finalUrl);
		content = ex.content;
		extractedChars = ex.extractedChars;
		title = ex.title || title;
		byline = ex.byline || byline;
		publishedAt = ex.publishedAt || publishedAt;
		modifiedAt = ex.modifiedAt;
		structured = ex.structured;
		links = ex.links;
		if (ex.truncated) notes.push(`extract-capped:${ex.extractedChars}`);
		if (!content) notes.push("extract-empty");
	} catch (e: any) {
		notes.push(`extract-error:${errLabel(e)}`);
	}

	// Post-extraction signals (yield is only knowable now).
	const fencedBlocks = (content.match(/```/g) ?? []).length / 2;
	if (codeBlocksInHtml >= 5 && fencedBlocks <= 1 && body.length > 20_000) {
		signals.push(`code-drop:${codeBlocksInHtml} pre/code in html, ${fencedBlocks} extracted`);
		if (gate === "static-ok") gate = "doubt";
	}
	if (gate === "static-ok" && content.length < 800 && body.length > 50_000) {
		signals.push(`low-yield:${content.length}ch from ${body.length}b html`);
		gate = "would-escalate";
	}
	if (visibleChars < 200 && signals.length === 0) {
		signals.push(`thin-content:${visibleChars}ch`);
		if (gate === "static-ok") gate = "doubt";
	}

	return {
		status: "ok",
		gate,
		signals,
		title,
		byline,
		publishedAt,
		modifiedAt,
		content,
		contentChars: content.length,
		extractedChars,
		htmlChars: body.length,
		httpStatus,
		finalUrl,
		contentType,
		structured,
		links,
		notes,
	};
}

/**
 * A textual, non-HTML body. Plain text, markdown, CSV, JSON, source files and
 * feeds all used to end here as `escalate` → chrome → "[text/plain — binary
 * resource, no text content extracted]" with status ok, and text/plain
 * additionally THREW on this tier (linkedom hands back a null documentElement
 * for a body with no leading tag). The bytes are the content; say so.
 */
function textualResult(
	base: StaticResult,
	body: string,
	httpStatus: number,
	finalUrl: string,
	contentType: string,
	notes: string[],
	viaExtractor: boolean,
): StaticResult {
	let content = body;
	let title: string | null = null;
	let structured = base.structured;
	let links = base.links;
	const outNotes = [...notes];
	if (viaExtractor) {
		try {
			const ex = extract(body, finalUrl);
			if (ex.content.trim().length > 0) {
				content = ex.content;
				title = ex.title;
				structured = ex.structured;
				links = ex.links;
				outNotes.push(`xml-extracted:${contentType || "xml"}`);
			} else {
				outNotes.push(`returned-verbatim:${contentType || "xml"} (nothing to extract)`);
			}
		} catch (e: any) {
			outNotes.push(`extract-error:${errLabel(e)}`);
		}
	} else if (/json/i.test(contentType)) {
		try {
			content = JSON.stringify(JSON.parse(body), null, 2);
		} catch {
			/* not valid JSON after all — serve the bytes */
		}
		outNotes.push(`returned-verbatim:${contentType}`);
	} else {
		outNotes.push(`returned-verbatim:${contentType || "text"}`);
	}
	const trimmed = content.trim();
	if (!trimmed) outNotes.push("empty-body");
	return {
		...base,
		status: "ok",
		gate: "static-ok",
		signals: [],
		title,
		content: trimmed ? content : "",
		contentChars: trimmed ? content.length : 0,
		extractedChars: trimmed ? content.length : 0,
		htmlChars: body.length,
		httpStatus,
		finalUrl,
		contentType,
		structured,
		links,
		notes: outNotes,
	};
}

/** Close keep-alive sockets so CLI processes exit promptly. */
export async function closeStaticHttp(): Promise<void> {
	try {
		await pinnedAgent.close();
	} catch {}
	try {
		await getGlobalDispatcher().close();
	} catch {}
}

function extractMeta($: ReturnType<typeof load>): {
	title: string | null;
	byline: string | null;
	publishedAt: string | null;
} {
	const pick = (sel: string, attr = "content"): string | null => {
		const v = $(sel).first().attr(attr)?.trim();
		return v || null;
	};
	const title =
		pick('meta[property="og:title"]') ??
		pick('meta[name="twitter:title"]') ??
		($("title").first().text()?.trim() || null);
	const byline = pick('meta[name="author"]') ?? pick('meta[property="article:author"]');
	const publishedAt =
		pick('meta[property="article:published_time"]') ??
		pick('meta[name="date"]') ??
		pick('meta[itemprop="datePublished"]') ??
		pick("time[datetime]", "datetime");
	return { title, byline, publishedAt };
}
