/**
 * Extraction: turn HTML into structure-preserving markdown + metadata.
 *
 * Pure function (HTML string in, Extracted out) so it can be tested against
 * fixtures with no network and no browser. The whole point vs. a
 * reading-optimised extractor is FIDELITY: tables stay tables, code stays
 * code with its language, and publish/modify dates are first-class — those are
 * exactly the things a research agent needs and Readability-class tools flatten.
 */

import { load } from "cheerio";
import type { CodeBlock, Extracted, MdTable } from "./types.ts";
import { collapseWs, resolveUrl, urlDate } from "./util.ts";

/**
 * A MEMORY bound, not a reading limit. The reading limit is truncate.ts (2000
 * lines / 50 KB) and it is reported in the tool's text; this cap only stops a
 * pathological page from materialising an unbounded string. It used to be
 * 200_000 chars, silently applied: capContent() then computed "of N lines /
 * N KB" from the ALREADY-CAPPED text and saved the capped text to disk, so
 * "read the rest, starting at line 1861" pointed at a file whose last line was
 * cut mid-URL and which held a third of the page. Nothing said so. When this
 * cap fires now it says so, in the content and in a note.
 */
const MAX_CONTENT = 5_000_000;

// Removed before content serialisation. Structural noise, never article body.
const BOILERPLATE = [
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"iframe",
	"form",
	"button",
	"nav",
	"footer",
	"aside",
	'[role="navigation"]',
	'[role="banner"]',
	'[role="contentinfo"]',
	'[role="search"]',
	'[aria-hidden="true"]',
	"[hidden]",
	// Only the PAGE header. A bare "header" also matched
	// <article><header><h1>…</h1><time>…</time></header>, so the article lost its
	// own title and date from the body — the one <header> that is content.
	"body > header",
	".nav",
	".navbar",
	".menu",
	".sidebar",
	".footer",
	".site-header",
	".site-footer",
	".cookie",
	".consent",
	".gdpr",
	".ad",
	".ads",
	".advert",
	".advertisement",
	".social",
	".share",
	".sharing",
	".related",
	".recommended",
	".comments",
	".newsletter",
	".subscribe",
	".promo",
	".popup",
	".modal",
];

interface Ctx {
	base: string;
	tables: MdTable[];
	codeBlocks: CodeBlock[];
	links: { text: string; href: string }[];
}

export function extract(html: string, baseUrl: string): Extracted {
	const $ = load(html);

	// --- metadata FIRST, before we strip anything (JSON-LD lives in <script>). ---
	const jsonld: unknown[] = [];
	$('script[type="application/ld+json"]').each((_i, el) => {
		try {
			jsonld.push(JSON.parse($(el).text()));
		} catch {
			/* malformed LD blocks are common; skip */
		}
	});
	const ldFlat = flattenLd(jsonld);
	const ld = (key: string): string | null => {
		for (const o of ldFlat) {
			const v = (o as Record<string, unknown>)[key];
			if (typeof v === "string" && v) return v;
		}
		return null;
	};

	const meta = (sel: string): string | null => {
		const c = $(sel).attr("content");
		return c && c.trim() ? c.trim() : null;
	};

	const title =
		meta('meta[property="og:title"]') ||
		meta('meta[name="twitter:title"]') ||
		ld("headline") ||
		$("title").first().text().trim() ||
		null;

	const byline = meta('meta[name="author"]') || meta('meta[property="article:author"]') || ldAuthor(ldFlat) || null;

	const publishedAt =
		ld("datePublished") ||
		meta('meta[property="article:published_time"]') ||
		meta('meta[name="date"]') ||
		$("time[datetime]").first().attr("datetime") ||
		null ||
		urlDate(baseUrl);

	const modifiedAt = ld("dateModified") || meta('meta[property="article:modified_time"]') || null;

	// --- strip boilerplate, then pick the content root. ---
	for (const sel of BOILERPLATE) $(sel).remove();

	// Prefer <main> (the primary content REGION) over a nested <article>. An
	// <article> is often just one block within main — picking it first drops
	// everything else (e.g. GitHub's file-list table lives in <main> beside the
	// README <article>). Boilerplate (nav/aside/footer) is already stripped
	// above, so <main> is content, not chrome. Fall back to article, then body.
	const rootEl =
		$("main").first()[0] ||
		$('[role="main"]').first()[0] ||
		$("article").first()[0] ||
		$("body").first()[0] ||
		$.root()[0];

	const ctx: Ctx = { base: baseUrl, tables: [], codeBlocks: [], links: [] };
	const blocks = rootEl ? serializeChildren(rootEl, ctx) : [];
	let content = blocks
		.join("\n\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	const extractedChars = content.length;
	const truncated = extractedChars > MAX_CONTENT;
	if (truncated) {
		content = content.slice(0, MAX_CONTENT);
		// Cut on a line boundary so the last thing the reader sees is a whole
		// line, not half a URL, then SAY that the rest was never extracted.
		const nl = content.lastIndexOf("\n");
		if (nl > MAX_CONTENT * 0.9) content = content.slice(0, nl);
		content += `\n\n… [extraction capped at ${MAX_CONTENT} characters; this page produced ${extractedChars}. The remainder was NOT extracted and is not in the saved file.]`;
	}

	const htmlChars = html.length;
	const contentChars = content.length;

	return {
		title,
		byline,
		publishedAt,
		modifiedAt,
		content,
		structured: { tables: ctx.tables, codeBlocks: ctx.codeBlocks, jsonld },
		links: dedupeLinks(ctx.links),
		contentChars,
		extractedChars,
		htmlChars,
		boilerplateRatio: htmlChars ? +(1 - contentChars / htmlChars).toFixed(3) : 0,
		truncated,
	};
}

// ------------------------------------------------------------------ helpers

function flattenLd(items: unknown[]): unknown[] {
	const out: unknown[] = [];
	const push = (x: unknown) => {
		if (Array.isArray(x)) x.forEach(push);
		else if (x && typeof x === "object") {
			out.push(x);
			const g = (x as Record<string, unknown>)["@graph"];
			if (g) push(g);
		}
	};
	items.forEach(push);
	return out;
}

function ldAuthor(ldFlat: unknown[]): string | null {
	for (const o of ldFlat) {
		const a = (o as Record<string, unknown>).author;
		if (typeof a === "string" && a) return a;
		if (a && typeof a === "object") {
			const n = (a as Record<string, unknown>).name;
			if (typeof n === "string" && n) return n;
		}
	}
	return null;
}

// domhandler node helpers (kept `any` — tsx strips types; runtime is duck-typed)
const isTag = (n: any) => n && (n.type === "tag" || n.type === "script" || n.type === "style");
const isText = (n: any) => n && n.type === "text";
const tag = (n: any): string => (n.name || "").toLowerCase();
const kids = (n: any): any[] => n.children || [];

/**
 * Elements that occupy their own line in a browser. Two of them side by side
 * are two things, not one word: concatenating their text with no separator
 * produced "Print extra outputRepeat for more detail" and a table cell whose
 * two <div>s fused into one token. A separator is inserted only at these
 * boundaries, so ordinary inline runs ("Hello <b>world</b>!") are untouched.
 */
const BLOCKISH = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"br",
	"dd",
	"details",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"li",
	"main",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"summary",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"ul",
]);

/** Concatenate descendant text, collapsing whitespace (for inline/normal text). */
function textCollapsed(node: any): string {
	let out = "";
	const walk = (n: any) => {
		if (isText(n)) out += n.data || "";
		else if (isTag(n)) {
			const block = BLOCKISH.has(tag(n));
			if (block) out += " ";
			kids(n).forEach(walk);
			if (block) out += " ";
		}
	};
	walk(node);
	return collapseWs(out);
}

/** Concatenate descendant text WITHOUT collapsing — for <pre>/<code> fidelity. */
function textRaw(node: any): string {
	let out = "";
	const walk = (n: any) => {
		if (isText(n)) out += n.data || "";
		else if (isTag(n)) kids(n).forEach(walk);
	};
	walk(node);
	return out;
}

/** Inline serialisation: bold/italic/code/links, no block breaks. */
function inline(node: any, ctx: Ctx): string {
	if (isText(node)) return collapseWs(node.data || "");
	if (!isTag(node)) return "";
	const t = tag(node);
	// Join children with nothing, EXCEPT across a block boundary, where the
	// browser would have put a line break. Blindly space-joining would put a
	// space before every "!" and ")"; blindly concatenating fused stacked blocks.
	const inner = () => {
		let out = "";
		let afterBlock = false;
		for (const c of kids(node)) {
			const s = inline(c, ctx);
			const block = isTag(c) && BLOCKISH.has(tag(c));
			if (!s) {
				afterBlock = afterBlock || block;
				continue;
			}
			if ((afterBlock || block) && out && !/\s$/.test(out) && !/^\s/.test(s)) out += " ";
			out += s;
			afterBlock = block;
		}
		return out;
	};
	switch (t) {
		case "a": {
			const href = resolveUrl(node.attribs?.href || "", ctx.base);
			const text = inner().trim();
			if (href) {
				if (text) ctx.links.push({ text, href });
				return `[${text || href}](${href})`;
			}
			return text;
		}
		case "strong":
		case "b":
			return `**${inner().trim()}**`;
		case "em":
		case "i":
			return `*${inner().trim()}*`;
		case "code":
			return `\`${textRaw(node)}\``;
		case "br":
			return "\n";
		case "img": {
			// Inline images: surface only accessibility-named ones (alt/title);
			// unnamed icons stay silent by design, but named ones must not vanish.
			const alt = (node.attribs?.alt || node.attribs?.title || "").trim();
			if (!alt) return "";
			const src = resolveUrl(node.attribs?.src || "", ctx.base);
			return src ? `![figure: ${alt}](${src})` : "";
		}
		default:
			return inner();
	}
}

/**
 * Figure marker label: alt, else title, else the file name, else bare "figure".
 * Never empty: an image the model cannot see must still leave a visible,
 * fetchable trace (the src stays in the markdown image syntax).
 */
function figureLabel(attribs: any, src: string): string {
	const named = (attribs?.alt || "").trim() || (attribs?.title || "").trim();
	if (named) return `figure: ${named}`;
	try {
		const file = decodeURIComponent(new URL(src).pathname.split("/").pop() || "");
		if (file && /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(file)) return `figure: ${file}`;
	} catch {}
	return "figure";
}

/** Block-level serialisation. Returns a list of markdown blocks. */
function serializeChildren(node: any, ctx: Ctx): string[] {
	const blocks: string[] = [];
	for (const child of kids(node)) blocks.push(...serializeNode(child, ctx));
	return blocks;
}

function serializeNode(node: any, ctx: Ctx): string[] {
	if (isText(node)) {
		const t = collapseWs(node.data || "").trim();
		return t ? [t] : [];
	}
	if (!isTag(node)) return [];

	const t = tag(node);

	// Honest tabs: a <ul role="tablist"> (or any element holding role="tab"
	// children) is an interactive switcher, NOT a bullet list. Render it as such
	// — otherwise "python / node.js" reads as two list items instead of two tabs.
	const nrole = (node.attribs?.role || "").toLowerCase();
	if (
		t !== "table" &&
		(nrole === "tablist" || kids(node).some((c: any) => (c.attribs?.role || "").toLowerCase() === "tab"))
	) {
		const tl = serializeTablist(node);
		if (tl) return [tl];
	}

	// ARIA grid/table (div-based tables: dashboards, data grids) → markdown table.
	if (t !== "table" && (nrole === "table" || nrole === "grid" || nrole === "treegrid")) {
		const g = serializeAriaGrid(node, ctx);
		if (g) return [g];
	}

	switch (t) {
		case "h1":
		case "h2":
		case "h3":
		case "h4":
		case "h5":
		case "h6": {
			const level = +t[1];
			const s = inline(node, ctx).trim();
			return s ? [`${"#".repeat(level)} ${s}`] : [];
		}
		case "p": {
			const s = inline(node, ctx).trim();
			return s ? [s] : [];
		}
		case "ul":
		case "ol":
			return [serializeList(node, ctx, t === "ol")];
		case "blockquote": {
			const inner = serializeChildren(node, ctx).join("\n\n");
			return inner
				? [
						inner
							.split("\n")
							.map((l) => `> ${l}`)
							.join("\n"),
					]
				: [];
		}
		case "pre":
			return [serializePre(node, ctx)];
		case "table":
			return [serializeTable(node, ctx)];
		case "hr":
			return ["---"];
		case "figcaption": {
			// Keep figure captions — a human sees them; they describe charts/diagrams.
			const s = inline(node, ctx).trim();
			return s ? [`*Figure: ${s}*`] : [];
		}
		case "br":
			return [];
		case "img": {
			const src = resolveUrl(node.attribs?.src || "", ctx.base);
			if (!src) return [];
			return [`![${figureLabel(node.attribs, src)}](${src})`];
		}
		// Inline elements appearing at block level → one paragraph.
		case "a":
		case "strong":
		case "b":
		case "em":
		case "i":
		case "code":
		case "span":
		case "small":
		case "mark":
		case "sub":
		case "sup":
		case "time":
		case "label":
		case "abbr":
		case "cite":
		case "q": {
			const s = inline(node, ctx).trim();
			return s ? [s] : [];
		}
		// Containers → recurse.
		default:
			return serializeChildren(node, ctx);
	}
}

/**
 * A list item is a BLOCK container, not a run of inline text. Serialising its
 * children through inline() flattened a nested <ul>, a second <p> and an
 * embedded <pre> into one run-on token ("`--verbose` Print extra outputRepeat
 * for more detail"), and a code block inside an item never reached
 * structured.codeBlocks. Children go through serializeNode now, and
 * continuation lines are indented under the marker so nesting survives.
 */
function serializeList(node: any, ctx: Ctx, ordered: boolean): string {
	const items: string[] = [];
	let i = 1;
	for (const li of kids(node)) {
		if (tag(li) !== "li") continue;
		let body = "";
		for (const block of serializeChildren(li, ctx)) {
			if (!block) continue;
			// A nested list hangs directly off its parent item; anything else is a
			// separate block and needs the blank line markdown asks for.
			if (body) body += /^(?:[-*]|\d+\.)\s/.test(block) ? "\n" : "\n\n";
			body += block;
		}
		body = body.trim();
		if (!body) continue;
		const marker = ordered ? `${i++}.` : "-";
		const indent = " ".repeat(marker.length + 1);
		const [head, ...rest] = body.split("\n");
		items.push(`${marker} ${head}` + (rest.length ? `\n${rest.map((l) => (l ? indent + l : l)).join("\n")}` : ""));
	}
	return items.join("\n");
}

function serializePre(node: any, ctx: Ctx): string {
	// Language from the <code class="language-xxx"> child, or the <pre> itself.
	let lang: string | null = null;
	const codeChild = kids(node).find((c) => tag(c) === "code");
	const classAttr = (codeChild?.attribs?.class || node.attribs?.class || "") as string;
	const m = classAttr.match(/(?:language|lang|highlight)-([\w+#-]+)/i);
	if (m) lang = m[1].toLowerCase();

	const src = textRaw(codeChild || node).replace(/\n$/, "");
	ctx.codeBlocks.push({ lang, src });
	return `\`\`\`${lang || ""}\n${src}\n\`\`\``;
}

function serializeTablist(node: any): string {
	const tabs: any[] = [];
	const walk = (n: any) => {
		if (!isTag(n)) return;
		if ((n.attribs?.role || "").toLowerCase() === "tab") tabs.push(n);
		else kids(n).forEach(walk);
	};
	kids(node).forEach(walk);
	if (!tabs.length) return "";
	const parts = tabs.map((t) => {
		const name = textCollapsed(t).trim();
		return (t.attribs?.["aria-selected"] || "") === "true" ? `${name} (selected)` : name;
	});
	return `[tabs: ${parts.join(" · ")}]`;
}

function serializeAriaGrid(node: any, ctx: Ctx): string {
	// Rows/cells declared via ARIA roles rather than <tr>/<td>. Common in React
	// data grids and dashboards that render tables out of <div>s.
	const rows: string[][] = [];
	const collectCells = (row: any, cells: string[]) => {
		for (const c of kids(row)) {
			if (!isTag(c)) continue;
			const cr = (c.attribs?.role || "").toLowerCase();
			if (cr === "columnheader" || cr === "rowheader" || cr === "gridcell" || cr === "cell") {
				cells.push(textCollapsed(c).trim().replace(/\|/g, "\\|"));
			} else {
				collectCells(c, cells); // cell may be nested below the row
			}
		}
	};
	const walk = (n: any) => {
		for (const c of kids(n)) {
			if (!isTag(c)) continue;
			if ((c.attribs?.role || "").toLowerCase() === "row") {
				const cells: string[] = [];
				collectCells(c, cells);
				if (cells.length) rows.push(cells);
			} else {
				walk(c); // descend through rowgroup/generic wrappers
			}
		}
	};
	walk(node);
	if (!rows.length) return "";

	const cols = Math.max(...rows.map((r) => r.length));
	const pad = (r: string[]) => r.concat(Array(cols - r.length).fill(""));
	const header = pad(rows[0]);
	const body = rows.slice(1).map(pad);
	const lines = [
		`| ${header.join(" | ")} |`,
		`| ${Array(cols).fill("---").join(" | ")} |`,
		...body.map((r) => `| ${r.join(" | ")} |`),
	];
	const markdown = lines.join("\n");
	ctx.tables.push({ markdown, rows: rows.length, cols });
	return markdown;
}

function serializeTable(node: any, ctx: Ctx): string {
	// Collect every row, its cells the direct th/td of each tr.
	const rows: string[][] = [];
	const collectRows = (n: any) => {
		for (const c of kids(n)) {
			if (tag(c) === "tr") {
				const cells: string[] = [];
				for (const cell of kids(c)) {
					const ct = tag(cell);
					if (ct === "th" || ct === "td") cells.push(textCollapsed(cell).trim().replace(/\|/g, "\\|"));
				}
				if (cells.length) rows.push(cells);
			} else if (isTag(c)) {
				collectRows(c); // descend through thead/tbody/tfoot
			}
		}
	};
	collectRows(node);

	if (!rows.length) return "";
	const cols = Math.max(...rows.map((r) => r.length));
	const pad = (r: string[]) => r.concat(Array(cols - r.length).fill(""));
	const header = pad(rows[0]);
	const body = rows.slice(1).map(pad);

	const lines = [
		`| ${header.join(" | ")} |`,
		`| ${Array(cols).fill("---").join(" | ")} |`,
		...body.map((r) => `| ${r.join(" | ")} |`),
	];
	const markdown = lines.join("\n");
	ctx.tables.push({ markdown, rows: rows.length, cols });
	return markdown;
}

function dedupeLinks(links: { text: string; href: string }[]): { text: string; href: string }[] {
	const seen = new Set<string>();
	const out: { text: string; href: string }[] = [];
	for (const l of links) {
		if (seen.has(l.href)) continue;
		seen.add(l.href);
		out.push(l);
	}
	return out;
}
