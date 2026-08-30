/**
 * Shared types for the fetch pipeline.
 *
 * The design invariant: every fetch returns a *typed verdict*, never just
 * bytes. A Cloudflare interstitial, a JS shell, and a cookie wall are all
 * HTTP 200 — the caller can only act correctly if the tool reports WHICH of
 * those it got. `FetchStatus` is that report.
 */

/**
 * The oracle's verdict on a captured response. This is the whole reason the
 * tool exists: it lets everything upstream (a research grader, an agent)
 * distinguish "the source says X" from "I never actually reached the source".
 *
 *  ok            usable content was extracted
 *  js-shell      200, but the body is an app shell — content is behind JS (escalate to render)
 *  bot-wall      Cloudflare/DataDome/Akamai/etc. challenge (escalate fingerprint/fallback)
 *  consent-wall  a cookie/GDPR wall is all that rendered (escalate to render + dismiss)
 *  paywall-hard  no real content, subscription required
 *  paywall-soft  partial content behind a metered wall — usable, but MARK it
 *  login-wall    the page requires signing in; no content retrieved
 *  not-found     404/410, or a 200 whose text announces "not found" (soft-404)
 *  rate-limited  429 / Retry-After — back off
 *  error         5xx or transport failure
 */
export type FetchStatus =
	| "ok"
	| "js-shell"
	| "bot-wall"
	| "consent-wall"
	| "login-wall"
	| "paywall-hard"
	| "paywall-soft"
	| "not-found"
	| "rate-limited"
	| "error";

/** Which tier produced the content: static HTTP or the Chrome render tier. */
export type Tier = "http" | "render";

/**
 * The raw result of one transport attempt, before classification or
 * extraction. The render tier (step 3) will populate `apiResponses` and
 * `requestChain` from the captured network log; the HTTP tier leaves them empty.
 */
export interface RawCapture {
	url: string;
	finalUrl: string;
	httpStatus: number;
	headers: Record<string, string>;
	contentType: string;
	isHtml: boolean;
	html: string;
	fetchedAt: string;
	/** The "better than a human" channel — the JSON behind an SPA. Empty in step 1. */
	apiResponses?: { url: string; status: number; contentType: string; body: string }[];
	requestChain?: { url: string; status: number }[];
	/** Landmarks + affordances read from the live DOM, for honest "whole" mode. */
	chrome?: PageChrome;
	/** Extracted PDF text + metadata, when the response was a PDF. */
	pdf?: { text: string; pages: number; title?: string; truncated: boolean; extractedChars: number };
	/**
	 * What the TRANSPORT needs the model to know: a redirect refused by the SSRF
	 * guard, a text body cut at the read cap, PDF bytes that never arrived. These
	 * are facts about the capture, not about the content, and they are merged
	 * into the result's notes — the tool's text is the only channel the model
	 * reads, so a transport degradation that only reached a log reached nobody.
	 */
	captureNotes?: string[];
	/** Set when served from the render cache — how old the cached render is, in ms. */
	cachedAgeMs?: number;
}

/**
 * The page's structure and affordances, read from the live DOM's ARIA
 * semantics — the honest layer markdown can't express. This is what makes
 * "whole" mode faithful: nav regions outside the body are kept and labelled,
 * and interactive controls (tabs, buttons, search) carry their true role and
 * state instead of being flattened to prose or deleted as boilerplate.
 */
export interface LinkInfo {
	text: string;
	href: string;
	current?: boolean; // aria-current, or a visual "you are here" highlight
}
export interface Landmark {
	role: string; // navigation | banner | complementary | contentinfo | main | search
	label: string;
	links: LinkInfo[];
}
export interface TabInfo {
	name: string;
	selected: boolean;
	/** false when the tab's panel isn't in the DOM — an alternative you're NOT seeing. */
	alternateLoaded: boolean;
}
export interface Control {
	role: string; // button | searchbox | switch | checkbox | menuitem | textbox…
	name: string;
	states: string[]; // selected | current | expanded | disabled | checked
	count: number; // identical controls collapsed (e.g. "Copy code" ×12)
}
export interface PageChrome {
	landmarks: Landmark[];
	tablists: { tabs: TabInfo[] }[];
	controls: Control[];
}

export interface MdTable {
	markdown: string;
	rows: number;
	cols: number;
}

export interface CodeBlock {
	lang: string | null;
	src: string;
}

/**
 * The product of extraction: structure preserved, not flattened to prose.
 * Tables, code, and dates survive as first-class fields because that is
 * exactly what a research agent needs and what reading-optimised extractors
 * throw away.
 */
export interface Extracted {
	title: string | null;
	byline: string | null;
	publishedAt: string | null;
	modifiedAt: string | null;
	content: string; // markdown
	structured: {
		tables: MdTable[];
		codeBlocks: CodeBlock[];
		jsonld: unknown[];
	};
	links: { text: string; href: string }[];
	contentChars: number;
	/**
	 * How many characters the extractor actually produced, BEFORE its memory cap.
	 * Equal to contentChars unless `truncated` — the cap used to be invisible, so
	 * every "of N lines / N KB" total downstream was computed from the capped
	 * text and understated the page.
	 */
	extractedChars: number;
	htmlChars: number;
	boilerplateRatio: number; // 1 - contentChars/htmlChars
	truncated: boolean;
}

export interface FetchResult extends Extracted {
	url: string;
	finalUrl: string;
	status: FetchStatus;
	tier: Tier;
	httpStatus: number;
	fetchedAt: string;
	/** Oracle evidence + escalation decisions. The audit trail behind `status`. */
	notes: string[];
	/** When content was truncated, the file holding the full untruncated content. */
	fullContentPath?: string;
	/**
	 * The JSON behind an SPA, captured by the render tier — the "better than a
	 * human" channel. Present only when the render tier ran and saw JSON XHRs.
	 */
	apiResponses?: { url: string; status: number; contentType: string; body: string }[];
	/** The page's landmarks + affordances (present in "whole" mode). */
	pageMap?: PageChrome;
}

export interface FetchOpts {
	/** Navigation timeout (ms). Default 30000. */
	timeoutMs?: number;
	/** Settle budget after load (ms). Default 8000. */
	settleMs?: number;
	/**
	 * Output mode:
	 *   whole   — page map (nav + affordances) + body  (default)
	 *   content — the body only
	 * Both are truncated at 2000 lines / 50 KB (whichever first); the full
	 * content is saved to disk and its path returned in `fullContentPath`.
	 */
	mode?: "whole" | "content";
	/** Hard wall-clock budget for the whole render (ms). Default 45000. */
	maxTotalMs?: number;
	/**
	 * Tier routing:
	 *   auto   — try the static HTTP tier first; the gate escalates to chrome on
	 *            any doubt or JS-dependence evidence (default)
	 *   static — static tier only; serve whatever it produces, no escalation
	 *   render — skip static, go straight to chrome
	 */
	tier?: "auto" | "static" | "render";
	/** Bypass the in-process render cache (default: use it; 60s TTL, env-tunable via WEBFETCH_CACHE_TTL_MS). */
	noCache?: boolean;
}
