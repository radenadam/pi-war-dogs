/**
 * The browser transport — the RENDER tier. `auto` escalates here when the
 * static HTTP tier (static.ts) reports doubt or JS-dependence evidence;
 * tier:"render" comes here directly. One invocation → one fully-rendered
 * page, the way a human sees it, with a real Chrome fingerprint.
 *
 * The Chrome is HEADLESS and daemon-owned — it never shows a window and it is
 * completely separate from the 9222 debug Chrome (which is reserved for the
 * agent's interactive browser/intercept). One daemon (daemon.ts) owns a single
 * Chrome for the whole machine; every client (pi session, CLI, scout) connects
 * over CDP via daemon-client.ts, and the daemon exits after 10 idle minutes.
 * `closeBrowser()` here only drops this client's connection.
 */

import type { APIRequestContext, Browser, BrowserContext, Page } from "playwright-core";
import { captureChrome } from "./affordances.ts";
import { getDaemonBrowser, touchDaemonActivity } from "./daemon-client.ts";
import { guardUrl, isRequestHostBlockedSync } from "./guard.ts";
import { extractPdf } from "./pdf.ts";
import type { PageChrome, RawCapture } from "./types.ts";
import { envInt, errLabel } from "./util.ts";

/** Resolve a string promise, or "" if it doesn't finish within `ms` — keeps a
 *  hung page.content()/text() from blowing past the render deadline. */
const raceStr = (p: Promise<string>, ms: number): Promise<string> =>
	Promise.race([p.catch(() => ""), new Promise<string>((r) => setTimeout(() => r(""), Math.max(500, ms)))]);

const NAV_TIMEOUT = 30_000;
const MAX_API_CAPTURE = 25;
const MAX_API_BYTES = 200_000;
const MAX_REDIRECT_HOPS = 8;
const MAX_TEXT_BYTES = 1_000_000;

// Known consent-manager (CMP) accept buttons — deterministic id/class/attr, so
// they're safe and fast, and work inside iframes. Covers the common CMPs.
const CONSENT_SELECTORS = [
	"#onetrust-accept-btn-handler", // OneTrust
	"#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", // Cookiebot
	"#CybotCookiebotDialogBodyButtonAccept",
	"#didomi-notice-agree-button", // Didomi
	'button[aria-label="Agree and close"]',
	'button[data-testid="uc-accept-all-button"]', // Usercentrics
	".qc-cmp2-summary-buttons button[mode='primary']", // Quantcast
	"button.sp_choice_type_11", // Sourcepoint
	'button[title="Accept all"]',
	"#truste-consent-button", // TrustArc
	".osano-cm-accept-all", // Osano
	".cky-btn-accept", // CookieYes
	".cmplz-accept", // Complianz
	".fc-cta-consent", // Google Funding Choices
	'[aria-label="Accept all"]',
	'[aria-label="Accept All"]',
	"#accept-cookies",
	"#gdpr-consent-accept",
];

// Fallback: any button whose accessible name starts like an accept control. The
// explicit selectors above run first, so this only fires for unknown CMPs.
const ACCEPT_TEXT = /^(accept|agree|allow all|allow cookies|got it|i agree|i accept|understood|consent)/i;

// iframe URLs that look like a consent dialog (many CMPs render in an iframe).
const CMP_FRAME =
	/consent|cookie|onetrust|cookiebot|sourcepoint|quantcast|trustarc|didomi|usercentrics|privacy|gdpr|cmp|consensu|sp-prod|funding/i;

const HTML_CT = /text\/html|application\/xhtml/i;
// Kept in step with static.ts's routing and fetch.ts's XML_CT/TEXT_CT: a
// resource that reads as content on one tier must not read as "binary" on
// another. text/html is matched by HTML_CT first, so the text/ prefix is safe.
const TEXTUAL_CT = /^text\/|\+xml|\/xml|json|javascript|ecmascript|yaml|csv|x-sh|x-python|toml|ini|sql|rss|atom/i;

// One warm headless Chrome per machine, owned by the fetch daemon and shared
// by every client (pi sessions, CLI, scouts) over CDP. This module only ever
// connects; daemon.ts owns launch and lifetime. See daemon-client.ts.
let _browser: Browser | null = null;
let _launching: Promise<Browser> | null = null; // connect lock — no double-connect under concurrency

// Cap concurrent renders (each is real RAM/CPU). Env-tunable for heavy research
// on machines with headroom; keep it modest — 20 simultaneous headless renders
// will spike memory/CPU hard.
const MAX_CONCURRENT = envInt("WEBFETCH_CONCURRENCY", 4, 1);

async function getBrowser(): Promise<Browser> {
	if (_browser?.isConnected()) return _browser;
	// A concurrent caller may already be connecting — await that, don't connect twice.
	if (_launching) return _launching;
	_launching = getDaemonBrowser()
		.then((b) => {
			_browser = b;
			return b;
		})
		.finally(() => {
			_launching = null;
		});
	return _launching;
}

export async function closeBrowser(): Promise<void> {
	const b = _browser;
	_browser = null;
	// Connected (not owned) browser: close() drops this client's connection and
	// contexts; the daemon's Chrome keeps serving other clients.
	if (b) await b.close().catch(() => {});
}

// A tiny counting semaphore capping concurrent renders.
let _permits = MAX_CONCURRENT;
const _waiters: (() => void)[] = [];
function acquire(): Promise<void> {
	if (_permits > 0) {
		_permits--;
		return Promise.resolve();
	}
	return new Promise((res) => _waiters.push(res));
}
function release(): void {
	const next = _waiters.shift();
	if (next)
		next(); // hand the permit straight to the next waiter
	else _permits++;
}

export async function renderFetch(
	url: string,
	opts: { settleMs?: number; timeoutMs?: number; maxTotalMs?: number } = {},
): Promise<RawCapture> {
	const settleMs = opts.settleMs ?? 8000;
	const fetchedAt = new Date().toISOString();
	// Hard wall-clock budget for the whole render. Nothing — scroll, settle, tab
	// expansion — may push a fetch past this. Prevents the minutes-long, CPU-
	// spiking hangs heavy live pages (Yahoo Finance) can otherwise cause.
	const t0 = Date.now();
	const deadline = t0 + (opts.maxTotalMs ?? 45_000);
	const log = (m: string) => {
		if (process.env.BWF_DEBUG) console.error(`[bwf +${Date.now() - t0}ms] ${m}`);
	};

	const apiResponses: NonNullable<RawCapture["apiResponses"]> = [];
	const requestChain: NonNullable<RawCapture["requestChain"]> = [];
	const pending: Promise<void>[] = [];
	// Transport facts the model must be told about (a refused redirect, a capped
	// body). Deduped and bounded: notes are a channel, not a log.
	const captureNotes: string[] = [];
	const note = (n: string) => {
		if (captureNotes.length < 6 && !captureNotes.includes(n)) captureNotes.push(n);
	};
	// Entry URL of a document navigation → where its redirect chain really ended.
	// We fulfil the final response at the ORIGINAL request (Chrome never
	// re-enters a route handler for a redirect it follows itself), so page.url()
	// still names the first hop; this map is what makes finalUrl honest.
	const redirectFinal = new Map<string, string>();
	const trueFinal = (u: string) => redirectFinal.get(u) ?? u;

	let httpStatus = 0;
	let finalUrl = url;
	let html = "";
	let contentType = "text/html";
	let isHtml = true;
	let chrome: PageChrome | undefined;
	let pdf: RawCapture["pdf"];
	let respHeaders: Record<string, string> = {};

	// Cap concurrent renders (parallel subagents share one browser). Everything
	// below runs under the permit, released in the finally.
	await acquire();
	touchDaemonActivity(); // feeds the daemon's idle clock; one touch per fetch
	let context: BrowserContext | undefined;
	let page: Page | undefined;

	try {
		const browser = await getBrowser();
		context = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
		page = await context.newPage();
		page.on("popup", (pp) => pp.close().catch(() => {})); // don't leak popups/new tabs

		// SSRF guard on the live network: abort any request — navigation, redirect
		// target, or page-initiated subresource (XHR/fetch/img) — to a private or
		// reserved host. The sync check catches literal private IPs cheaply; the
		// async guardUrl re-resolves the hostname so a subresource to a name that
		// maps to 127.0.0.1 (DNS-rebinding, e.g. *.nip.io) is blocked too, not just
		// navigations. Verdicts are memoised per host so a page hitting one CDN
		// across dozens of requests costs a single DNS lookup — but only for
		// HOST_VERDICT_TTL_MS: Chrome resolves DNS itself and cannot be pinned
		// from here (unlike the static tier's guardedLookup), so a verdict held
		// for the life of the context left the whole render open to a mid-render
		// DNS flip. The TTL bounds that window; repeat lookups inside it are
		// resolver-cached and cheap. The entry URL is already validated upstream
		// in betterFetch.
		const HOST_VERDICT_TTL_MS = 10_000;
		const hostVerdict = new Map<string, { ok: boolean; at: number }>(); // host → allowed (TTL-bounded)
		const allowed = async (u: string): Promise<boolean> => {
			if (isRequestHostBlockedSync(u)) return false;
			let host: string;
			try {
				host = new URL(u).hostname;
			} catch {
				return false;
			}
			const hit = hostVerdict.get(host);
			if (hit !== undefined && Date.now() - hit.at < HOST_VERDICT_TTL_MS) return hit.ok;
			const ok = (await guardUrl(u)).ok;
			hostVerdict.set(host, { ok, at: Date.now() });
			return ok;
		};

		// THE REDIRECT CHAIN IS OURS.
		//
		// A route handler fires ONCE per request. When the handler calls
		// route.continue() — or fulfils a 30x — Chrome follows the redirect itself
		// and the handler is never called again (proven with a route trace: the
		// 302's target produced a `request` event and no `ROUTE` line). So every
		// check above ran on the ENTRY url only, and a public page that 302'd to
		// http://127.0.0.1 was fetched and its body returned, status ok, on
		// tier:"render" AND on the default tier:"auto" whenever static didn't
		// serve (audit-demonstrated: a loopback secret came back as the article).
		//
		// The handler therefore performs each hop itself with maxRedirects:0,
		// guards every Location before taking it, and fulfils the final response.
		// Cookies and Authorization are dropped on a cross-origin hop; 303 (and
		// 301/302 on an unsafe method) become GET, as the fetch standard says.
		await context.route("**/*", async (route) => {
			const req = route.request();
			const start = req.url();
			const isDoc = req.resourceType() === "document";
			try {
				if (!(await allowed(start))) return await route.abort("blockedbyclient");
				let target = start;
				let method = req.method();
				let postData: Buffer | null = req.postDataBuffer();
				let headers: Record<string, string> | undefined;
				for (let hop = 0; ; hop++) {
					const resp = await route.fetch({
						url: target,
						method,
						maxRedirects: 0,
						...(headers ? { headers } : {}),
						...(postData ? { postData } : {}),
					});
					const st = resp.status();
					const loc = st >= 300 && st < 400 ? resp.headers()["location"] : undefined;
					if (!loc) {
						if (target !== start) {
							if (isDoc) redirectFinal.set(start, target);
							// The browser believes it is still at `start`, so relative URLs
							// would resolve against the wrong origin. Tell the document where
							// it really is.
							const body = withBaseHref(await resp.body(), resp.headers()["content-type"] || "", target);
							if (body) return await route.fulfill({ response: resp, body });
						}
						return await route.fulfill({ response: resp });
					}
					if (hop >= MAX_REDIRECT_HOPS) {
						if (isDoc) note(`redirect-chain-too-long: more than ${MAX_REDIRECT_HOPS} hops from ${start}`);
						return await route.abort("failed");
					}
					let next: string;
					try {
						next = new URL(loc, target).toString();
					} catch {
						return await route.abort("blockedbyclient");
					}
					if (!(await allowed(next))) {
						note(`blocked-by-policy: refused a redirect to ${hostLabel(next)} (private/reserved host or bad scheme)`);
						return await route.abort("blockedbyclient");
					}
					if (st === 303 || ((st === 301 || st === 302) && method !== "GET" && method !== "HEAD")) {
						method = "GET";
						postData = null;
					}
					if (!sameOrigin(next, target)) {
						headers = { ...req.headers() };
						delete headers.cookie;
						delete headers.authorization;
						delete headers.host;
					}
					target = next;
				}
			} catch (e) {
				// route.fetch owns the transport now, so its failures are the ones the
				// page would otherwise have reported — keep the reason.
				if (isDoc) note(`transport: ${errLabel(e, 120)}`);
				try {
					await route.abort("failed");
				} catch {
					/* route already handled */
				}
			}
		});

		page.on("response", (resp) => {
			try {
				const ct = resp.headers()["content-type"] || "";
				// Cap the chain — a streaming page (live quotes) can fire thousands.
				if (requestChain.length < 1000) requestChain.push({ url: resp.url(), status: resp.status() });
				if (/json/i.test(ct) && apiResponses.length < MAX_API_CAPTURE) {
					// Race the body read against a timeout: a streaming/long-poll response
					// (live quotes) never resolves .text() and would hang the fetch.
					const body = Promise.race<string>([resp.text(), new Promise((res) => setTimeout(() => res(""), 3000))]);
					pending.push(
						body
							.then((b) => {
								if (b)
									apiResponses.push({
										url: resp.url(),
										status: resp.status(),
										contentType: ct,
										body: b.slice(0, MAX_API_BYTES),
									});
							})
							.catch(() => {}),
					);
				}
			} catch {
				/* headers()/url() race on teardown — ignore */
			}
		});

		// Bound the navigation by the REMAINING budget, not a fixed timeout — a host
		// that accepts the connection but never replies must not run past the deadline.
		const gotoTimeout = Math.max(2000, Math.min(opts.timeoutMs ?? NAV_TIMEOUT, deadline - Date.now()));
		const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: gotoTimeout });
		httpStatus = resp?.status() ?? 0;
		respHeaders = resp?.headers() ?? {};
		contentType = respHeaders["content-type"] || "";
		isHtml = HTML_CT.test(contentType) || contentType === "";

		if (isHtml) {
			// A page: behave like a human — dismiss consent, let it settle, scroll to
			// pull in lazy content, then take the rendered DOM. Every phase is guarded
			// by the deadline so a heavy page can't run away.
			log("navigated");
			await dismissConsent(page); // catch banners already present
			await settle(page, Math.min(settleMs, deadline - Date.now()));
			await dismissConsent(page); // and ones that appeared after the page settled
			log("settle1");
			if (Date.now() < deadline) await autoScroll(page, 6, deadline);
			log("scroll");
			await settle(page, Math.min(settleMs, 3000, deadline - Date.now()));
			// Never wait past the deadline for API bodies (each already races a 3s cap).
			await Promise.race([
				Promise.allSettled(pending),
				new Promise((res) => setTimeout(res, Math.max(1000, deadline - Date.now()))),
			]);
			log("settle2+api");
			finalUrl = trueFinal(page.url());
			// Affordances from the PRISTINE DOM first (so tab selected-state is true).
			chrome = await captureChrome(page).catch(() => undefined);
			log("chrome");
			// Then click through tabs to pull in the panels a human would only see on
			// click — "better than a human": every variant at once, not just the active
			// one. Mutates the DOM to inline all panels, so page.content() carries them.
			let expanded = 0;
			if (Date.now() < deadline) expanded = await expandTabs(page, deadline).catch(() => 0);
			if (expanded && chrome) for (const tl of chrome.tablists) for (const t of tl.tabs) t.alternateLoaded = true;
			log(`expand=${expanded}`);
			html = await raceStr(page.content(), Math.max(3000, deadline - Date.now()));
			log(`content len=${html.length}`);
			contentType = contentType || "text/html";
		} else if (/pdf/i.test(contentType)) {
			// A PDF. Chrome's PDF viewer truncates the navigation response body, so
			// fetch the real bytes via the context's HTTP stack (shares cookies/UA,
			// handles walled PDFs); fall back to the nav body only if that fails.
			// context.request is NOT subject to route interception, so it does its
			// own guarded redirect following — Playwright would otherwise chase up to
			// 20 hops with no SSRF check at all.
			finalUrl = trueFinal(page.url());
			const target = resp?.url() || finalUrl;
			// KEEP the first result unless it is missing or is not a PDF. It used to
			// be discarded whenever it was under 1024 bytes and replaced by
			// resp.body(), which fails for a PDF navigation — so a small but
			// perfectly good 390-byte PDF became "[application/pdf — binary resource,
			// no text content extracted]" with status ok.
			let bytes = await guardedApiGet(context.request, target, note, deadline);
			if (!isPdf(bytes) && resp) {
				const alt = await resp.body().catch(() => null);
				if (isPdf(alt)) bytes = alt;
			}
			if (isPdf(bytes)) pdf = extractPdf(Buffer.from(bytes as Buffer));
			else note("pdf-fetch-failed: the response is a PDF but its bytes could not be retrieved");
		} else if (TEXTUAL_CT.test(contentType)) {
			// A JSON/text endpoint: return the raw body, not Chrome's JSON viewer HTML.
			// Cap the read — an unbounded body would buffer into memory — and SAY so
			// when the cap fires, instead of handing over a silently shortened file.
			const raw = resp ? await raceStr(resp.text(), 10_000) : "";
			if (raw.length > MAX_TEXT_BYTES) {
				html = `${raw.slice(0, MAX_TEXT_BYTES)}\n\n… [body capped at ${MAX_TEXT_BYTES} characters; this resource is ${raw.length}. The remainder was NOT read.]`;
				note(`text-capped:${raw.length}`);
			} else {
				html = raw;
			}
			finalUrl = trueFinal(page.url());
		} else {
			// Other binary (image/…): no text here; leave for a typed handler.
			finalUrl = trueFinal(page.url());
		}
	} catch (e) {
		// Partial capture is still useful — salvage whatever rendered. `page` may be
		// undefined if setup (launch/newContext) failed; guard it.
		try {
			if (page) {
				finalUrl = trueFinal(page.url());
				// Race the salvage — a still-navigating page's content() can hang for
				// minutes (this was the deadline-bypass bug).
				html = await raceStr(page.content(), 2000);
			}
		} catch {
			/* nothing to salvage */
		}
		// First line only: the model reads this. Playwright's call log is a
		// multi-line ANSI blob that says nothing the first line does not.
		requestChain.push({
			url: `render-error: ${String((e as Error)?.message ?? e)
				.split("\n")[0]
				.slice(0, 200)}`,
			status: httpStatus,
		});
	} finally {
		// Race the teardown too — context.close() on a wedged page can also hang, and
		// it holds the concurrency permit until it returns.
		if (context) await Promise.race([context.close(), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
		release();
		touchDaemonActivity(); // a long render must not read as daemon idle time
	}

	return {
		url,
		finalUrl,
		httpStatus,
		headers: respHeaders,
		contentType,
		isHtml,
		html,
		fetchedAt,
		apiResponses,
		requestChain,
		chrome,
		pdf,
		captureNotes,
	};
}

// ------------------------------------------------------------------ helpers

const isPdf = (b: Buffer | null): boolean =>
	!!b && b.length > 4 && b.subarray(0, 5).toString("latin1").startsWith("%PDF");

function sameOrigin(a: string, b: string): boolean {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return false;
	}
}

/** host:port for a message — never the full URL, which can carry credentials. */
function hostLabel(u: string): string {
	try {
		return new URL(u).host || u;
	} catch {
		return "an unparseable URL";
	}
}

/**
 * Insert `<base href>` so a document served from the end of a redirect chain
 * resolves its relative URLs against where it REALLY came from. We fulfil the
 * final response at the original request, so without this a page reached
 * through example.com → www.example.com would ask example.com for every
 * relative asset. Returns null when it must not touch the bytes (not HTML,
 * UTF-16, or a document that already declares its own base).
 */
function withBaseHref(body: Buffer, contentType: string, finalUrl: string): Buffer | null {
	if (!HTML_CT.test(contentType)) return null;
	if (/charset\s*=\s*["']?utf-?16/i.test(contentType)) return null;
	if (body.length >= 2 && ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff)))
		return null;
	const head = body.subarray(0, 8192).toString("latin1");
	if (/<base[\s>]/i.test(head)) return null;
	const tag = Buffer.from(`<base href="${finalUrl.replace(/"/g, "%22")}">`, "latin1");
	const m = /<head[^>]*>/i.exec(head) ?? /<html[^>]*>/i.exec(head);
	if (!m) return Buffer.concat([tag, body]);
	const at = m.index + m[0].length;
	return Buffer.concat([body.subarray(0, at), tag, body.subarray(at)]);
}

/**
 * GET through the context's API request stack with the SSRF guard on every hop.
 * `context.request` is not subject to route interception, so Playwright's own
 * 20-hop redirect following would run completely unchecked.
 */
async function guardedApiGet(
	request: APIRequestContext,
	start: string,
	note: (n: string) => void,
	deadline: number,
): Promise<Buffer | null> {
	let url = start;
	for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
		if (isRequestHostBlockedSync(url) || !(await guardUrl(url)).ok) {
			note(`blocked-by-policy: refused a redirect to ${hostLabel(url)} while fetching the document bytes`);
			return null;
		}
		const timeout = Math.max(2000, Math.min(30_000, deadline - Date.now()));
		const r = await request.get(url, { maxRedirects: 0, timeout }).catch(() => null);
		if (!r) return null;
		const st = r.status();
		if (st >= 300 && st < 400) {
			const loc = r.headers()["location"];
			if (!loc) return null;
			try {
				url = new URL(loc, url).toString();
			} catch {
				return null;
			}
			continue;
		}
		return await r.body().catch(() => null);
	}
	return null;
}

async function dismissConsent(page: Page): Promise<boolean> {
	// Try known CMP buttons, then a text-based accept button, in a given frame.
	const tryIn = async (scope: Page | import("playwright-core").Frame): Promise<boolean> => {
		for (const sel of CONSENT_SELECTORS) {
			try {
				const el = scope.locator(sel).first();
				if (await el.isVisible()) {
					await el.click({ timeout: 1000 });
					return true;
				}
			} catch {
				/* not present / not clickable — next */
			}
		}
		try {
			const b = scope.getByRole("button", { name: ACCEPT_TEXT }).first();
			if (await b.isVisible()) {
				await b.click({ timeout: 1000 });
				return true;
			}
		} catch {
			/* none — fall through */
		}
		return false;
	};

	if (await tryIn(page.mainFrame())) return true;
	// Many CMP dialogs live in an iframe — check the consent-looking ones.
	for (const f of page.frames()) {
		if (f === page.mainFrame() || !CMP_FRAME.test(f.url())) continue;
		if (await tryIn(f)) return true;
	}
	return false;
}

/**
 * Click through every panel-backed tablist, capture each tab's panel, and
 * inline them all into the DOM under `⟨tab⟩ <name>` headings. Tab components
 * mount only the active panel, so the alternatives are invisible until clicked
 * — this makes one fetch return every code variant, labelled. Only touches
 * tablists whose tabs have `aria-controls` (real content panels), never
 * nav-style tab strips. Best-effort: any failure leaves the page untouched.
 */
async function expandTabs(page: Page, deadline: number): Promise<number> {
	// Shim the esbuild `__name` helper in-page (see captureChrome) for the
	// evaluate below, in case affordance capture was skipped.
	await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)").catch(() => {});

	const MAX_GROUPS = 6;
	const MAX_TABS_TOTAL = 16; // hard cap across all groups — Yahoo has dozens
	const tablists = await page.$$("[role=tablist]");
	const captured: ({ panels: { name: string; selected: boolean; html: string }[] } | null)[] = [];
	let count = 0;
	let clicked = 0;

	for (let ti = 0; ti < tablists.length; ti++) {
		// Deadline / budget guards — never let tab expansion run away.
		if (ti >= MAX_GROUPS || clicked >= MAX_TABS_TOTAL || Date.now() > deadline) {
			captured.push(null);
			continue;
		}
		const tl = tablists[ti];
		const tabEls = await tl.$$("[role=tab]");
		const firstControls = tabEls.length ? await tabEls[0].getAttribute("aria-controls") : null;
		// ≥2 tabs AND panel-backed — otherwise it's a nav-style strip, leave it.
		if (tabEls.length < 2 || !firstControls) {
			captured.push(null);
			continue;
		}

		let origIdx = 0;
		for (let i = 0; i < tabEls.length; i++) {
			if ((await tabEls[i].getAttribute("aria-selected")) === "true") origIdx = i;
		}

		const panels: { name: string; selected: boolean; html: string }[] = [];
		for (let i = 0; i < tabEls.length && i < 8; i++) {
			if (clicked >= MAX_TABS_TOTAL || Date.now() > deadline) break;
			const t = tabEls[i];
			const name = (await t.innerText().catch(() => "")).trim().slice(0, 40);
			await t.click({ timeout: 800 }).catch(() => {});
			clicked++;
			await page.waitForTimeout(250); // let the component mount the panel
			const controls = await t.getAttribute("aria-controls");
			let html = "";
			if (controls && !controls.includes('"')) {
				const p = await page.$(`[id="${controls}"]`);
				if (p) html = await p.evaluate((el) => (el as HTMLElement).outerHTML).catch(() => "");
			}
			panels.push({ name, selected: i === origIdx, html });
		}
		await tabEls[origIdx].click({ timeout: 800 }).catch(() => {}); // restore the default tab
		captured.push({ panels });
		count++;
	}

	if (!count) return 0;

	// Replace each tablist's live panel with a static block holding ALL panels,
	// each under a heading. extract.ts then renders every variant with no
	// special-casing and no duplication (the original panel is removed).
	await page.evaluate((groups) => {
		const tls = document.querySelectorAll("[role=tablist]");
		tls.forEach((tl, i) => {
			const g = groups[i];
			if (!g) return;
			tl.querySelectorAll("[role=tab]").forEach((t) => {
				const c = t.getAttribute("aria-controls");
				if (c) {
					const p = document.getElementById(c);
					if (p) p.remove();
				}
			});
			const box = document.createElement("div");
			for (const panel of g.panels) {
				const h = document.createElement("h4");
				h.textContent = `⟨tab⟩ ${panel.name}${panel.selected ? " (default)" : ""}`;
				box.appendChild(h);
				const d = document.createElement("div");
				d.innerHTML = panel.html || "";
				box.appendChild(d);
			}
			tl.insertAdjacentElement("afterend", box);
		});
	}, captured);

	return count;
}

/** Wait for network to quiet, but never hang: SPAs never truly idle. */
async function settle(page: Page, ms: number): Promise<void> {
	try {
		await page.waitForLoadState("networkidle", { timeout: ms });
	} catch {
		/* timed out — expected on chatty pages; proceed */
	}
}

/** Scroll to the bottom a few times to trigger lazy-loaded content. */
async function autoScroll(page: Page, rounds = 6, deadline = Infinity): Promise<void> {
	let last = 0;
	for (let i = 0; i < rounds; i++) {
		if (Date.now() > deadline) return;
		let h = 0;
		try {
			h = await page.evaluate(() => {
				window.scrollTo(0, document.body.scrollHeight);
				return document.body.scrollHeight;
			});
		} catch {
			return;
		}
		if (h === last) return;
		last = h;
		await page.waitForTimeout(400);
	}
}
