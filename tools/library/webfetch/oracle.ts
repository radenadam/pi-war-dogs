/**
 * The oracle: classify a captured response into a typed status.
 *
 * This is a PURE function over a RawCapture. No I/O, no browser — which is
 * exactly what makes it unit-testable against saved fixtures. Everything
 * upstream keys its escalation decision off this verdict.
 *
 * Ordering matters: hard HTTP codes first, then unmistakable bot walls, then
 * the softer content heuristics. The first rule that fires wins, so the
 * cheapest and most certain signals are checked earliest.
 */

import type { FetchStatus, RawCapture } from "./types.ts";
import { roughText } from "./util.ts";

export interface Verdict {
	status: FetchStatus;
	signals: string[];
}

/** Unambiguous challenge/deny pages. A match here IS a bot wall. */
const STRONG_BOT: [string, RegExp][] = [
	[
		"cf-challenge",
		/just a moment|cf-browser-verification|cf_chl_opt|checking your browser before|enable javascript and cookies to continue/,
	],
	["cf-attention", /attention required.{0,20}cloudflare/],
	["datadome", /datadome|captcha-delivery\.com/],
	["akamai", /access denied.{0,40}reference #\d/],
	["imperva", /incapsula incident|_incapsula_resource/],
];

/** Captcha widgets that ALSO appear on legit pages (login). Only a wall if the page is otherwise empty. */
const WEAK_BOT: [string, RegExp][] = [
	["recaptcha", /google\.com\/recaptcha\/|grecaptcha/],
	["hcaptcha", /hcaptcha\.com/],
	["human-check", /verify you are (a )?human|are you a robot/],
];

const SOFT_404 =
	/page not found|content not found|404[^0-9]{0,6}not found|could not be found|couldn't be found|doesn't exist|does not exist|no longer available|been removed/i;
const PAYWALL_LD = /"isaccessibleforfree"\s*:\s*(false|"false")/i;
const PAYWALL_TEXT =
	/subscribe to (continue|read)|already a subscriber|subscribers only|to continue reading|create a free account to (read|continue)/i;
const SHELL_MARKER =
	/id="root"|id="__next"|id="app"|data-reactroot|ng-app|window\.__nuxt__|__next_data__|<div id="svelte">/i;
const CONSENT = /we use cookies|cookie consent|accept all cookies|manage your cookie|gdpr|before you continue to/i;
const LOGIN =
	/sign in to (continue|read|view|see)|log ?in to (continue|read|view|see)|please (sign|log) ?in|members only|subscribers? only|create (a )?free account to (read|continue|view)|you must be logged in|register to continue/i;

export function classify(cap: RawCapture): Verdict {
	const signals: string[] = [];
	const done = (status: FetchStatus): Verdict => ({ status, signals });

	const h = cap.headers || {};
	const s = cap.httpStatus;
	const htmlLc = (cap.html || "").toLowerCase();
	const text = roughText(cap.html || "");

	// 1 — hard HTTP codes. Certain, cheap, no content inspection needed.
	if (s === 429) return (signals.push("http-429"), done("rate-limited"));
	if (s === 404 || s === 410) return (signals.push(`http-${s}`), done("not-found"));
	if (s >= 500) return (signals.push(`http-${s}`), done("error"));
	// 401 is Unauthorized — a login wall by definition. Without this rule an
	// HTML 401 whose body is over the near-empty floor and matches neither the
	// LOGIN regex nor a password input fell all the way through to "ok", and
	// the model was handed a sign-in page as if it were the article. The code
	// already disagreed with itself here: the static tier maps 401 to
	// login-wall (fetch.ts staticResult) and the non-HTML render path maps it
	// too — only the HTML render path, which goes through this oracle, did not.
	if (s === 401) return (signals.push("http-401"), done("login-wall"));

	// 2 — bot walls. A wall REPLACES the page, so the tell is a fingerprint on a
	// THIN page — not the mere mention of "Cloudflare/CAPTCHA" in a full article
	// (e.g. a page *about* web scraping). Header/403 signals are authoritative on
	// their own; content fingerprints require the page to be near-empty.
	const thin = text.length < 2000;
	if (h["cf-mitigated"] || h["x-datadome"]) return (signals.push("bot:header"), done("bot-wall"));
	const strong = STRONG_BOT.filter(([, re]) => re.test(htmlLc)).map(([n]) => n);
	if (strong.length) {
		signals.push(`bot:${strong.join(",")}`);
		if (thin) return done("bot-wall");
		signals.push("bot-fingerprint-ignored:page-not-thin");
	}
	if (s === 403) return (signals.push("http-403"), done("bot-wall"));

	// 2b — every OTHER 4xx. Rule 1 named the codes it knew and let the rest fall
	// through to the content heuristics, so an HTML error page with more than
	// ~200 chars of body classified "ok": 400, 405, 408, 409, 418 and 451 were
	// all handed to the model as the article (a 451 legal block read as
	// "# status 451 …"). The non-HTML render path already had this catch-all —
	// only the HTML path, which comes through here, did not. 402 is Payment
	// Required, which is a paywall by definition. Placed after the bot-wall rules
	// so 403 keeps its more specific verdict.
	if (s >= 400) return (signals.push(`http-${s}`), done(s === 402 ? "paywall-hard" : "error"));

	const weak = WEAK_BOT.filter(([, re]) => re.test(htmlLc)).map(([n]) => n);
	if (weak.length && text.length < 500) {
		signals.push(`bot:weak:${weak.join(",")}`);
		return done("bot-wall");
	}

	// 3 — explicit rate-limit signal short of a 429.
	if (h["retry-after"]) return (signals.push("retry-after"), done("rate-limited"));

	const scripts = (htmlLc.match(/<script/g) || []).length;

	// 4 — soft-404: a 200 whose lead text announces "not found". Check only the
	// head of the text so an article merely discussing 404s isn't caught.
	if (SOFT_404.test(text.slice(0, 600))) return (signals.push("soft-404-text"), done("not-found"));

	// 5 — paywall. Split hard vs soft by how much real content came through.
	if (PAYWALL_LD.test(htmlLc) || PAYWALL_TEXT.test(text)) {
		signals.push("paywall-marker");
		return done(text.length < 900 ? "paywall-hard" : "paywall-soft");
	}

	// 5b — login wall. A thin-ish page that asks you to sign in (or is a bare
	// password form) is not content — an agent must not read the wall as the page.
	const hasPassword = /<input[^>]+type=["']?password/i.test(htmlLc);
	if ((LOGIN.test(text) || hasPassword) && text.length < 1500) {
		return (signals.push("login-wall"), done("login-wall"));
	}

	// 6 — JS shell: little text plus either a framework mount marker with scripts,
	// or a script-heavy page of non-trivial size. The marker path fires even on a
	// small shell (many real SPAs ship a tiny index.html), the size path catches
	// markerless script-driven pages.
	const shell = SHELL_MARKER.test(htmlLc);
	const thinText = text.length < 500;
	if (thinText && ((shell && scripts >= 2) || (cap.html.length > 5000 && scripts >= 3))) {
		signals.push(`js-shell:${shell ? "marker" : "low-text"}`);
		return done("js-shell");
	}

	// 7 — consent wall that dominates the page (content, if any, is behind JS).
	if (CONSENT.test(htmlLc) && text.length < 400) return (signals.push("consent-wall"), done("consent-wall"));

	// 7b — near-empty floor. A 200 that yields almost no text is NEVER usable
	// content, whatever its markup: no framework marker, few inline scripts
	// (module/preload-driven SPAs), or a bare error page all land here. Reporting
	// "ok" with ~0 chars is the exact lie this tool exists to prevent, so fail to
	// js-shell (escalate to render) instead. Caught after the paywall/soft-404
	// rules so those keep their more specific status.
	if (text.length < 200) return (signals.push(`empty-ish:${text.length}ch`), done("js-shell"));

	signals.push(`content-ok:${text.length}ch`);
	return done("ok");
}
