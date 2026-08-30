/**
 * Serialize the captured page chrome into an honest "page map" — pure function,
 * unit-tested over mock PageChrome (no browser needed).
 *
 * This is the section that makes "whole" mode faithful: every landmark labelled
 * by its true role, the current item bolded, tabs shown as tabs with their
 * selected state, alternatives you can't see flagged, and interactive controls
 * inventoried. Prepended to the extracted body in whole mode.
 */

import type { PageChrome } from "./types.ts";

export function renderPageMap(chrome: PageChrome | undefined): string {
	if (!chrome) return "";
	const lines: string[] = ["## Page map — structure & affordances"];

	// Landmarks: nav/banner/complementary/contentinfo/search, with their links.
	for (const lm of chrome.landmarks) {
		if (lm.role === "main") continue; // the body is rendered below, not here
		const head = `[${lm.role}${lm.label ? `: ${lm.label}` : ""}]`;
		// Real markdown links — a nav a human can click means an href the agent can
		// follow. Current item bolded inside the link.
		const links = lm.links.filter((l) => l.text).map((l) => `[${l.current ? `**${l.text}**` : l.text}](${l.href})`);
		lines.push(links.length ? `${head} ${links.join(" · ")}` : head);
	}

	// Tablists: which tab is selected, and whether the others' content is loaded.
	for (const tl of chrome.tablists) {
		if (!tl.tabs.length) continue;
		const tabs = tl.tabs.map((t) => {
			let s = t.name;
			if (t.selected) s += " (selected)";
			else if (!t.alternateLoaded) s += " ⚠ content not loaded — click to fetch";
			return s;
		});
		lines.push(`[tablist] ${tabs.join("  ·  ")}`);
	}

	// Controls: what the agent could DO here, deduped.
	if (chrome.controls.length) {
		const ctl = chrome.controls.map((c) => {
			const label = c.name || c.role;
			const n = c.count > 1 ? ` ×${c.count}` : "";
			const st = c.states.length ? ` (${c.states.join(", ")})` : "";
			return c.name ? `${label}${st}${n}` : `[${c.role}]${st}${n}`;
		});
		lines.push(`[controls] ${ctl.join(" · ")}`);
	}

	return lines.join("\n");
}

/** A one-line summary for logs / the CLI header. */
export function pageMapSummary(chrome: PageChrome | undefined): string {
	if (!chrome) return "none";
	const navs = chrome.landmarks.filter((l) => l.role !== "main").length;
	const tabs = chrome.tablists.reduce((n, t) => n + t.tabs.length, 0);
	return `${navs} landmarks · ${chrome.tablists.length} tablists (${tabs} tabs) · ${chrome.controls.length} controls`;
}
