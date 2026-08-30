/**
 * Capture the page's structure and affordances from the LIVE DOM — the honest
 * layer that markdown erases. Runs entirely in-page (one `page.evaluate`), so
 * it has full access to computed styles and ARIA state, and returns plain JSON.
 *
 * What it recovers, and why it matters:
 *   - Landmarks (nav / banner / complementary / contentinfo / search): the
 *     chrome OUTSIDE the main body that boilerplate-stripping deletes. A human
 *     sees these; honest "whole" mode keeps them, labelled, with their links
 *     and any "you are here" current item.
 *   - Tablists: the `python / node.js` case — marked as tabs with which is
 *     selected, and whether the non-selected tab's content is even in the DOM
 *     (tab components often mount only the active panel, so the alternative is
 *     an affordance you can't read without clicking).
 *   - Controls (buttons, search, switches…): interactive elements, deduped, so
 *     the agent knows what it could *do* on the page, not just read.
 *
 * Roles are computed from tag + ARIA the same way the browser's accessibility
 * tree does (validated against Accessibility.getFullAXTree on a hard page).
 */

import type { Page } from "playwright-core";
import type { PageChrome } from "./types.ts";

export async function captureChrome(page: Page): Promise<PageChrome> {
	// tsx/esbuild (keepNames) wraps in-page functions with a `__name(...)` helper
	// that doesn't exist in the browser context; shim it as identity so the
	// serialized evaluate function resolves. (String arg is sent verbatim.)
	await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");
	return (await page.evaluate(() => {
		const clean = (s: string | null | undefined): string => (s || "").replace(/\s+/g, " ").trim();

		const visible = (el: Element): boolean => {
			const st = getComputedStyle(el);
			if (st.display === "none" || st.visibility === "hidden") return false;
			return (el as HTMLElement).offsetParent !== null || st.position === "fixed";
		};

		// Computed ARIA role from tag + role attr — matches the accessibility tree
		// for the roles we care about (landmarks + interactive controls).
		const roleOf = (el: Element): string => {
			const explicit = el.getAttribute("role");
			if (explicit) return explicit.trim();
			const t = el.tagName.toLowerCase();
			const inLandmark = () => el.closest("main,article,section,aside,[role=main]") != null;
			switch (t) {
				case "a":
					return el.hasAttribute("href") ? "link" : "generic";
				case "button":
				case "summary":
					return "button";
				case "nav":
					return "navigation";
				case "main":
					return "main";
				case "header":
					return inLandmark() ? "generic" : "banner";
				case "footer":
					return inLandmark() ? "generic" : "contentinfo";
				case "aside":
					return "complementary";
				case "select":
					return "combobox";
				case "textarea":
					return "textbox";
				case "input": {
					const ty = ((el as HTMLInputElement).type || "text").toLowerCase();
					if (ty === "search") return "searchbox";
					if (["button", "submit", "reset", "image"].includes(ty)) return "button";
					if (ty === "checkbox") return "checkbox";
					if (ty === "radio") return "radio";
					if (ty === "hidden") return "generic";
					return "textbox";
				}
				default:
					return t;
			}
		};

		const nameOf = (el: Element): string => {
			const label =
				el.getAttribute("aria-label") ||
				(el as HTMLElement).innerText ||
				el.textContent ||
				(el as HTMLInputElement).placeholder ||
				(el as HTMLInputElement).value ||
				el.getAttribute("title") ||
				"";
			return clean(label).slice(0, 90);
		};

		const statesOf = (el: Element): string[] => {
			const s: string[] = [];
			if (el.getAttribute("aria-selected") === "true") s.push("selected");
			const cur = el.getAttribute("aria-current");
			if (cur && cur !== "false") s.push(cur === "true" ? "current" : `current=${cur}`);
			const exp = el.getAttribute("aria-expanded");
			if (exp) s.push(exp === "true" ? "expanded" : "collapsed");
			if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") s.push("disabled");
			if (el.getAttribute("aria-checked") === "true") s.push("checked");
			return s;
		};

		// "you are here" — aria-current, or a visual active/current/selected class
		// on the link or its list item (the CSS-only highlight a human sees).
		const currentish = (a: Element): boolean => {
			const cur = a.getAttribute("aria-current");
			if (cur && cur !== "false") return true;
			const cls = `${a.className} ${a.parentElement?.className || ""}`;
			return /(^|[\s_-])(active|current|selected)([\s_-]|$)/i.test(cls);
		};

		// ---- landmarks ----
		const lmSel =
			"nav,[role=navigation],header,[role=banner],aside,[role=complementary],footer,[role=contentinfo],[role=search],main,[role=main]";
		const landmarks = [...document.querySelectorAll(lmSel)]
			.filter(visible)
			.slice(0, 10)
			.map((el) => {
				const links = [...el.querySelectorAll("a[href]")]
					.filter(visible)
					.slice(0, 80)
					.map((a) => ({ text: nameOf(a), href: (a as HTMLAnchorElement).href, current: currentish(a) }))
					.filter((l) => l.text);
				return { role: roleOf(el), label: clean(el.getAttribute("aria-label") || ""), links };
			})
			.filter((l) => l.links.length || l.role === "main" || l.role === "search");

		// ---- tablists ---- (capped, like landmarks/controls, so a pathological page can't bloat pageMap)
		const tablists = [...document.querySelectorAll("[role=tablist]")]
			.filter(visible)
			.slice(0, 20)
			.map((tl) => {
				const tabs = [...tl.querySelectorAll("[role=tab]")].map((t) => {
					const controls = t.getAttribute("aria-controls");
					const panel = controls ? document.getElementById(controls) : null;
					const selected = t.getAttribute("aria-selected") === "true";
					// Alternative content is "loaded" only if its panel exists AND is real.
					const alternateLoaded = panel ? visible(panel) : selected;
					return { name: nameOf(t), selected, alternateLoaded };
				});
				return { tabs };
			});

		// ---- controls (deduped by role+name) ----
		const ctlSel =
			"button,[role=button],[role=switch],[role=checkbox],[role=menuitem],[role=searchbox],input,select,textarea,summary";
		const map = new Map<string, { role: string; name: string; states: string[]; count: number }>();
		for (const el of [...document.querySelectorAll(ctlSel)]) {
			if (!visible(el)) continue;
			const r = roleOf(el);
			if (r === "generic" || r === "tab") continue; // tabs handled above
			const n = nameOf(el);
			const key = `${r}|${n}`;
			const ex = map.get(key);
			if (ex) ex.count++;
			else map.set(key, { role: r, name: n, states: statesOf(el), count: 1 });
		}
		const controls = [...map.values()].slice(0, 60);

		return { landmarks, tablists, controls };
	})) as PageChrome;
}
