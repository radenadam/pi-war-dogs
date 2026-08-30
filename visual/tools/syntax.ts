/**
 * Syntax highlighting for the EVIDENCE — read/write bodies, the bash command,
 * edit's diff — in the theme's FIELD palette, byte-exact.
 *
 * Two facts drive this file. (1) pi's public `highlightCode(code, lang)`
 * paints with the live theme's `syntax*` tokens and nothing else, so prose
 * code blocks and the evidence inside an expanded panel had to share one
 * palette — and the maintainer wants the panel, which sits on a field, to
 * read differently from the prose. (2) The rule for tool content is RAW:
 * highlighting must colour the characters the file has, never re-render
 * them; highlight.js does exactly that (it wraps tokens, it does not
 * transform text), so a `.md` read shows its `#` and `**` in colour rather
 * than as a heading. Row counts are checked by every caller anyway.
 *
 * pi's highlighter is `dist/utils/syntax-highlight.js` — `highlight(code,
 * {language, ignoreIllegals, theme})` over highlight.js, where `theme` is a
 * scope→painter table — not exported from pi's package index. It is loaded
 * from the RUNNING pi (`pidist.ts`) once, lazily; a miss falls back to
 * `highlightCode`, i.e. the stock palette (Upgrade Contract).
 *
 * The field palette: `wdSyntax<Scope>` theme keys (Keyword, String, Number,
 * Comment, Function, Type, Variable, Operator, Punctuation), each falling
 * back to its stock `syntax<Scope>` token when the theme lacks it — so a
 * theme without any of them highlights exactly as before. Comments are
 * italic in the field palette; that is the one non-colour difference.
 */

import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { importPiModule } from "../../pidist.ts";
import { WRAPPERS, bashPrograms } from "../../util/shell.ts";

type Painter = (s: string) => string;
type HighlightFn = (
	code: string,
	opts: { language?: string; ignoreIllegals?: boolean; theme?: Record<string, Painter> },
) => string;

let loaded: { highlight: HighlightFn; supportsLanguage: (n: string) => boolean } | null | undefined;
let loading: Promise<void> | undefined;
/**
 * The markdown grammar WITHOUT its emphasis rule, registered on pi's own
 * highlight.js instance as `markdown-field` — the name every markdown body
 * (a `.md` read/write, a skill's text) is highlighted under when it exists.
 * highlight.js's emphasis opens at any `_` not followed by space and runs to
 * the NEXT `_` — across lines — so a path like `node_modules/pi-mcp-adapter`
 * in a skill's "References are relative to …" line italicised (and
 * un-highlighted: nothing nests inside the span) the whole rest of the
 * document, fence and headings included, carried row to row by carrySgr
 * (demonstrated 2026-08-20 on the mcp-scripting skill). Raw text is not
 * authored markdown: an underscore in a path is not emphasis. The
 * instance is the one pi's `syntax-highlight.js` imports (same file, same
 * module cache), so pi's `supportsLanguage`/`highlight` see the variant;
 * a miss (pi moved highlight.js) leaves `markdown` as it was.
 */
let mdField: string | null = null;

/** Kick off the one-time load of pi's highlighter module (idempotent). */
function ensureLoaded(): void {
	if (loaded !== undefined || loading) return;
	loading = importPiModule("utils/syntax-highlight.js").then(async (m: any) => {
		loaded = typeof m?.highlight === "function" && typeof m?.supportsLanguage === "function" ? m : null;
		if (!loaded) return;
		try {
			const h = (await importPiModule("../node_modules/highlight.js/lib/index.js"))?.default;
			const md = h?.getLanguage?.("markdown");
			if (h && md && Array.isArray(md.contains)) {
				const variant = {
					...md,
					contains: md.contains.filter((mode: any) => (mode?.className ?? mode?.scope) !== "emphasis"),
				};
				h.registerLanguage("markdown-field", () => variant);
				if (loaded.supportsLanguage("markdown-field")) mdField = "markdown-field";
			}
		} catch {}
	});
}
ensureLoaded();

/** Does the theme name any field-palette key at all? (Cheap probe: keyword.) */
function hasFieldPalette(theme: any): boolean {
	try {
		return typeof theme?.fg === "function" && !!theme.fg("wdSyntaxKeyword", "\0").split("\0")[0];
	} catch {
		return false;
	}
}

/** `wdSyntax<Scope>` when the theme has it, else the stock `syntax<Scope>`. */
export function fieldPainter(theme: any, scope: string): Painter {
	return tok(theme, scope);
}
function tok(theme: any, scope: string): Painter {
	const wd = `wdSyntax${scope}`;
	const stock = `syntax${scope}`;
	return (s: string) => {
		try {
			const seq = theme.fg(wd, "\0").split("\0")[0] as string;
			if (seq) return theme.fg(wd, s) as string;
		} catch {}
		try {
			return theme.fg(stock, s) as string;
		} catch {
			return s;
		}
	};
}

/** The scope table pi's own builder uses (theme.js buildCliHighlightTheme), over the field tokens. */
function fieldTheme(theme: any): Record<string, Painter> {
	const kw = tok(theme, "Keyword"),
		str = tok(theme, "String"),
		num = tok(theme, "Number"),
		com = tok(theme, "Comment"),
		fn = tok(theme, "Function"),
		ty = tok(theme, "Type"),
		vr = tok(theme, "Variable"),
		op = tok(theme, "Operator"),
		pu = tok(theme, "Punctuation");
	const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
	const muted = (s: string) => {
		try {
			return theme.fg("muted", s) as string;
		} catch {
			return s;
		}
	};
	const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
	const ul = (s: string) => `\x1b[4m${s}\x1b[24m`;
	const added = (s: string) => {
		try {
			return theme.fg("toolDiffAdded", s) as string;
		} catch {
			return s;
		}
	};
	const removed = (s: string) => {
		try {
			return theme.fg("toolDiffRemoved", s) as string;
		} catch {
			return s;
		}
	};
	return {
		keyword: kw,
		built_in: ty,
		literal: num,
		number: num,
		regexp: str,
		string: str,
		comment: (s) => italic(com(s)),
		doctag: com,
		meta: muted,
		function: fn,
		title: fn,
		class: ty,
		type: ty,
		tag: pu,
		name: kw,
		attr: vr,
		variable: vr,
		params: vr,
		operator: op,
		punctuation: pu,
		emphasis: italic,
		strong: bold,
		link: ul,
		addition: added,
		deletion: removed,
		// markdown, raw: the syntax stays on screen, only coloured
		section: fn,
		bullet: op,
		quote: (s) => italic(com(s)),
		code: str,
		symbol: num,
	};
}

/**
 * Highlight `code` (a whole body; callers split/verify rows) in the field
 * palette. Returns undefined when nothing can be highlighted — an unknown
 * language, or a highlighter failure — so callers paint plain.
 */
export function highlightField(code: string, lang: string | undefined, theme: any): string[] | undefined {
	if (!lang) return undefined;
	ensureLoaded();
	if (loaded && hasFieldPalette(theme)) {
		try {
			const use = lang === "markdown" && mdField ? mdField : lang;
			if (!loaded.supportsLanguage(use)) return undefined;
			return carrySgr(
				loaded.highlight(code, { language: use, ignoreIllegals: true, theme: fieldTheme(theme) }).split("\n"),
			);
		} catch {}
	}
	// Stock palette (pi's own highlighter through the public API) — the
	// theme has no field palette, or pi's module could not be reached. Exactly
	// what every caller did before this file existed.
	try {
		return carrySgr(highlightCode(code, lang));
	} catch {
		return undefined;
	}
}

/**
 * Carry an open style across the row break. highlight.js wraps a token that
 * spans lines — a docstring, a block comment, a template literal — in ONE
 * span, so after `.split("\n")` only the first row carries the colour's
 * open sequence and every continuation row starts bare: the second line of a
 * `"""` docstring rendered in the evidence tier while its first and last
 * lines were string-green (demonstrated on the catalogue's write panel;
 * "the single quote doesn't continue in the next line" — maintainer). Rows
 * are independent strings on this surface, so the state active at a row's
 * end is re-opened at the start of the next: fg, bg, bold, italic,
 * underline. Nothing is added to a row whose predecessor ended clean.
 */
export function carrySgr(rows: string[]): string[] {
	let fg = "";
	let bg = "";
	let bold = false;
	let italic = false;
	let ul = false;
	const out: string[] = [];
	for (const row of rows) {
		const carry = `${fg}${bg}${bold ? "\x1b[1m" : ""}${italic ? "\x1b[3m" : ""}${ul ? "\x1b[4m" : ""}`;
		out.push(carry + row);
		for (const m of row.matchAll(/\x1b\[([0-9;]*)m/g)) {
			const p = m[1] === "" ? ["0"] : m[1].split(";");
			for (let i = 0; i < p.length; i++) {
				const v = Number(p[i]);
				if (v === 0) {
					fg = bg = "";
					bold = italic = ul = false;
				} else if (v === 1) bold = true;
				else if (v === 3) italic = true;
				else if (v === 4) ul = true;
				else if (v === 22) bold = false;
				else if (v === 23) italic = false;
				else if (v === 24) ul = false;
				else if (v === 39) fg = "";
				else if (v === 49) bg = "";
				else if ((v === 38 || v === 48) && p[i + 1] === "2") {
					const seq = `\x1b[${v};2;${p[i + 2]};${p[i + 3]};${p[i + 4]}m`;
					if (v === 38) fg = seq;
					else bg = seq;
					i += 4;
				} else if ((v === 38 || v === 48) && p[i + 1] === "5") {
					const seq = `\x1b[${v};5;${p[i + 2]}m`;
					if (v === 38) fg = seq;
					else bg = seq;
					i += 2;
				} else if ((v >= 30 && v <= 37) || (v >= 90 && v <= 97)) fg = `\x1b[${v}m`;
				else if ((v >= 40 && v <= 47) || (v >= 100 && v <= 107)) bg = `\x1b[${v}m`;
			}
		}
	}
	return out;
}

/**
 * The EVIDENCE tier: the reading colour of a panel's body — `wdEvidence`
 * when the theme sets it, else `toolOutput` (the shipped low white). One
 * helper for the sequence (base tones, remaps) and one for painting.
 */
export function evidenceSeq(theme: any): string {
	for (const key of ["wdEvidence", "toolOutput"]) {
		try {
			const seq = theme.fg(key, "\0").split("\0")[0] as string;
			if (seq && /\x1b\[(?:38;|3[0-7]m|9[0-7]m)/.test(seq)) return seq;
		} catch {}
	}
	return "";
}
export function evidenceFg(theme: any, s: string): string {
	const seq = evidenceSeq(theme);
	return seq ? `${seq}${s}\x1b[39m` : s;
}

/** Language for a path, pi's table (exported for callers that need the name). */
export function langOf(filePath: string | undefined): string | undefined {
	return filePath ? getLanguageFromPath(filePath) : undefined;
}

/**
 * A war-dogs BACKGROUND token as an SGR open sequence. pi registers only six
 * fixed keys as backgrounds (theme.js createTheme: selectedBg, userMessageBg,
 * customMessageBg, tool*Bg) and files every other key — ours included — as a
 * FOREGROUND, so `theme.bg("wdCodeBg")` throws. The colour is the same
 * number either way: read the fg sequence and rewrite the SGR selector
 * (`38;` → `48;`, truecolor and 256 alike). `""` or an absent key → "".
 */
export function bgSeqOf(theme: any, key: string): string {
	try {
		const seq = theme.fg(key, "\0").split("\0")[0] as string;
		if (!seq) return "";
		if (/^\x1b\[38;/.test(seq)) return seq.replace(/^\x1b\[38;/, "\x1b[48;");
		const basic = /^\x1b\[(3[0-7]|9[0-7])m$/.exec(seq);
		if (basic) return `\x1b[${Number(basic[1]) + 10}m`;
		return "";
	} catch {
		return "";
	}
}

const SHELL_OP = /^(?:\|\||&&|\||;|;;|&|>>|>|<|<<<?|\d*>>?&?\d*|&>>?)$/;
const SHELL_FLAG = /^--?[A-Za-z0-9][\w.+-]*(?:=.*)?$/;
/** Words and operators, with glued operators split off (`foo;`, `2>/dev/null`). */
const SHELL_TOKEN = /\|\||&&|;;?|&>>?|\d*>>?&?\d*|<<<?|<|\||&|[^\s;|&<>]+/g;

/**
 * Colour what highlight.js leaves PLAIN in a shell command. Its bash grammar
 * marks strings, variables, keywords and a fixed built-in list (`echo`, `cd`,
 * `export`…) — never `ls`, `grep`, `npm`, `git`, never a flag, never `&&` —
 * so a typical command line came out one plain colour (demonstrated: `$ ls
 * -la …` all white on the field). This pass walks the highlighted rows and,
 * inside the spans hljs did NOT paint, colours: a PROGRAM at command position
 * (`bashPrograms` from util/shell.ts is the grammar — the same one the act
 * sentence uses; wrappers like `sudo`/`env`/`xargs` keep the position for the
 * next word) in the field keyword colour, a FLAG (`-la`, `--save-exact=…`) in
 * the field number colour, a control/redirect OPERATOR in the field operator
 * colour, and every other plain word in the evidence tier. hljs's own paint
 * is never touched, and no character moves.
 */
export function shellTone(rows: string[], command: string, theme: any): string[] {
	const programs = new Set(bashPrograms(command));
	// A COMMAND LINE, not source code (maintainer): the convention every
	// highlighting shell shares — fish, zsh-syntax-highlighting, Warp — is
	// that the command name is the star and everything else recedes:
	// bold command, arguments quiet, options a step apart, strings warm
	// (hljs's), operators dim. Three keys of their own, each with a fallback
	// that already reads that way: `wdShellCommand` (bold; falls back to the
	// evidence tier, bold), `wdShellFlag` (falls back to the field variable
	// colour), `wdShellOperator` (falls back to the field operator colour).
	const ev = evidenceSeq(theme);
	const plain = (s: string) => (ev ? `${ev}${s}\x1b[39m` : s);
	const own = (key: string, fallback: (s: string) => string) => (s: string) => {
		try {
			if (theme.fg(key, "\0").split("\0")[0]) return theme.fg(key, s) as string;
		} catch {}
		return fallback(s);
	};
	const cmd0 = own("wdShellCommand", plain);
	const kw = (s: string) => `\x1b[1m${cmd0(s)}\x1b[22m`;
	const num = own("wdShellFlag", tok(theme, "Variable"));
	const op = own("wdShellOperator", tok(theme, "Operator"));
	let cmdPos = true;
	return rows.map((row) => {
		let active = false; // an hljs colour is open
		let out = "";
		for (const part of row.split(/(\x1b\[[0-9;]*m)/)) {
			if (part.startsWith("\x1b[")) {
				const p = part.slice(2, -1);
				if (/^(?:38;|3[0-7]$|9[0-7]$)/.test(p)) active = true;
				else if (p === "39" || p === "" || p === "0") active = false;
				out += part;
				continue;
			}
			if (!part) continue;
			if (active) {
				// hljs painted this (a string, a keyword, a variable): it still
				// moves the command position — an operator re-arms it, a word
				// consumes it.
				const t = part.trim();
				if (t) cmdPos = SHELL_OP.test(t);
				out += part;
				continue;
			}
			out += part.replace(SHELL_TOKEN, (w) => {
				if (SHELL_OP.test(w)) {
					cmdPos = true;
					return op(w);
				}
				if (cmdPos && (programs.has(w) || WRAPPERS.has(w))) {
					cmdPos = WRAPPERS.has(w);
					return kw(w);
				}
				if (SHELL_FLAG.test(w)) return num(w);
				cmdPos = WRAPPERS.has(w) && cmdPos;
				return plain(w);
			});
		}
		// A row ending in `\` continues the command; any other row starts one.
		cmdPos = !/\\\s*$/.test(row.replace(/\x1b\[[0-9;]*m/g, ""));
		return out;
	});
}
