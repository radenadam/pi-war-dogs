#!/usr/bin/env node
// Colour catalogue, step 1: write theme VARIANTS derived from a base war-dogs
// theme (canopy by default) into an output dir, one JSON per variant. Each
// variant is a set of token/var overrides exploring the two axes the
// maintainer named — the model's PROSE at rest, and the on-demand EXPANDED
// panels — with no code change: everything the pager paints comes from theme
// tokens, so a remap is a faithful preview of a real theme.
//
//   node dev/generators/gallery/make-variants.mjs [--base visual/theme/canopy.json] [--out /tmp/wd-gallery/themes]
//
// Add or edit variants below; run.sh renders every JSON it finds in --out.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(opt("--base", path.join(here, "..", "..", "..", "visual", "theme", "canopy.json")));
const out = path.resolve(opt("--out", "/tmp/wd-gallery/themes"));
fs.mkdirSync(out, { recursive: true });
const src = JSON.parse(fs.readFileSync(base, "utf8"));

// ---- the two axes, as reusable overrides -----------------------------------
// PROSE axis (the rest view). `wdProse` is the body colour of the model's
// prose — pi paints paragraphs in the TERMINAL's default fg (its markdown
// theme has no body painter), so "" is what you see today, terminal-dependent.
// `wdProseBold` is bold's own tier; `wdCodeBg` puts a pill behind inline code.
const PROSE = {
	// as shipped: terminal-default body, white headings, bright-green code spans
	current: {},
	// paper: a soft neutral body, bold one tier brighter, code spans as quiet
	// green pills, headings and bullets in the accent — one family
	paper: {
		colors: {
			wdProse: "#dcdfd8",
			wdProseBold: "#f8f8f2",
			wdCodeBg: "#262e24",
			mdCode: "#b9d0ad",
			mdHeading: "greenBright",
			mdLink: "blueBase",
			mdListBullet: "greenBase",
			mdQuote: "secondary",
		},
	},
	// white pill: the brightest body, bold pure white, code pills, accent headings
	whitePill: {
		colors: {
			wdProse: "text",
			wdProseBold: "#ffffff",
			wdCodeBg: "#2b3129",
			mdCode: "#c3d3bd",
			mdHeading: "greenBright",
			mdLink: "blueBase",
			mdListBullet: "muted",
			mdQuote: "secondary",
		},
	},
	// ivory pill: warm body and bold, headings warm white, code pills
	ivoryPill: {
		vars: { headingBright: "#f7f3e8" },
		colors: {
			wdProse: "#e9e5d8",
			wdProseBold: "#fff8ea",
			wdCodeBg: "#2b2f2a",
			mdCode: "#b9d0ad",
			mdHeading: "headingBright",
			mdLink: "blueBase",
			mdListBullet: "muted",
			userMessageText: "#e9e5d8",
		},
	},
	// 2026-08-22 candidates ("prose not cohesive with the palette"): the body
	// gets a PALETTE white instead of the terminal's default.
	// evidence: prose = the evidence tier (#c9d1c4, L*83, green-leaning) — one
	// tinted reading white for everything read; bold one tier up (text).
	evidence: { colors: { wdProse: "#c9d1c4", wdProseBold: "#f8f8f2" } },
	// tinted: the evidence tier's hue at L*91 (#e0e8db) — brighter, still
	// tinted; a THIRD reading white between text (97) and evidence (83).
	tinted: { colors: { wdProse: "#e0e8db", wdProseBold: "#f8f8f2" } },
	// plain: prose = text (#f8f8f2), the neutral brightest tier.
	plain: { colors: { wdProse: "#f8f8f2", wdProseBold: "#ffffff" } },
};
// HEADINGS axis (2026-08-22, "cleaner than six colours"): paintHeadings
// repaints each level with wdHeading1..6; a level set to the PROSE white
// reads as a bold prose line. Each entry is a function of the prose hex so
// "3+ = prose" follows the prose candidate it is crossed with.
const HEAD = {
	// as shipped: a six-step lightness ramp of the identity hue
	ramp6: () => ({}),
	// two tiers: H1–H2 in the identity hue, H3–H6 bold in the prose white
	two: (prose) => ({
		colors: {
			wdHeading1: "#79b4f2",
			wdHeading2: "#79b4f2",
			wdHeading3: prose,
			wdHeading4: prose,
			wdHeading5: prose,
			wdHeading6: prose,
		},
	}),
	// three steps, all in the hue: bright / base / deep, 3–6 collapsed
	three: () => ({
		colors: {
			wdHeading1: "#79b4f2",
			wdHeading2: "#5f9ce0",
			wdHeading3: "#4b83c3",
			wdHeading4: "#4b83c3",
			wdHeading5: "#4b83c3",
			wdHeading6: "#4b83c3",
		},
	}),
	// one colour: every level the identity hue, bold — level is structure only.
	// #7ab4f2, not #79b4f2: paintHeadings bails when every level EQUALS
	// mdHeading (reads as "no heading keys") and then pi's `###` prefixes
	// stay; one step off is invisible and keeps the strip. Shipping this look
	// means teaching the pass to strip whenever the keys are present.
	one: () => ({
		colors: {
			wdHeading1: "#7ab4f2",
			wdHeading2: "#7ab4f2",
			wdHeading3: "#7ab4f2",
			wdHeading4: "#7ab4f2",
			wdHeading5: "#7ab4f2",
			wdHeading6: "#7ab4f2",
		},
	}),
};
// uniform hue + a superscript LEVEL MARK (wdHeadingMark; surface.ts
// paintHeadings): `Title one¹`, `Section two²` … every level one colour.
for (const [name, markColor] of [
	["supHue", "#79b4f2"],
	["supMuted", "muted"],
]) {
	HEAD[name] = () => ({
		colors: {
			wdHeading1: "#79b4f2",
			wdHeading2: "#79b4f2",
			wdHeading3: "#79b4f2",
			wdHeading4: "#79b4f2",
			wdHeading5: "#79b4f2",
			wdHeading6: "#79b4f2",
			wdHeadingMark: markColor,
		},
	});
}
// EXPANDED axis (details on demand): the evidence tier, the field, the FIELD
// syntax palette (wdSyntax*, distinct from prose's syntax*), and the tinted
// diff (wdDiffAddBg/RemoveBg on: syntax-highlighted rows on green/red tints).
const OPEN = {
	current: {},
	// deep green field (your g7), evidence in a reading white, a cool bright
	// palette for code, tinted diff
	field: {
		vars: { fieldBg: "#1f2d24" },
		colors: {
			wdEvidence: "#c9d1c4",
			toolTitle: "#c9d1c4",
			toolDiffContext: "#c9d1c4",
			wdSyntaxKeyword: "#8ec4ff",
			wdSyntaxString: "#a8e08a",
			wdSyntaxNumber: "#f0c674",
			wdSyntaxComment: "#7f8b7c",
			wdSyntaxFunction: "#ffd58a",
			wdSyntaxType: "#9fd0ff",
			wdSyntaxVariable: "#dfe6dc",
			wdSyntaxOperator: "#b9c2bb",
			wdSyntaxPunctuation: "#98a094",
			wdDiffAddBg: "#2b4d35",
			wdDiffRemoveBg: "#5c3131",
			wdShellCommand: "#f2f5ee",
			wdShellFlag: "#a9c7c2",
			wdShellOperator: "#8fa08c",
		},
	},
	// the shipped field, evidence brighter still, a more saturated palette
	vivid: {
		vars: { fieldBg: "#232a21" },
		colors: {
			wdEvidence: "#d5dbd0",
			toolTitle: "#d5dbd0",
			toolDiffContext: "#d5dbd0",
			wdSyntaxKeyword: "#7fb3ff",
			wdSyntaxString: "#9bd77a",
			wdSyntaxNumber: "#f2b96b",
			wdSyntaxComment: "#7d8f7a",
			wdSyntaxFunction: "#e8c07a",
			wdSyntaxType: "#86c5ff",
			wdSyntaxVariable: "#cfd8cb",
			wdSyntaxOperator: "#a7b0a3",
			wdSyntaxPunctuation: "#8a9486",
			wdDiffAddBg: "#2c5236",
			wdDiffRemoveBg: "#5e3333",
			wdShellCommand: "#f4f7f0",
			wdShellFlag: "#a3cbc6",
			wdShellOperator: "#8a9a86",
		},
	},
	// a warm dark field with a warm palette — the panel reads as a different material than the page
	warm: {
		vars: { fieldBg: "#2a2620" },
		colors: {
			wdEvidence: "#d8d2c4",
			toolTitle: "#d8d2c4",
			toolDiffContext: "#d8d2c4",
			wdSyntaxKeyword: "#e0a86e",
			wdSyntaxString: "#b8c98a",
			wdSyntaxNumber: "#d9b36a",
			wdSyntaxComment: "#8b8578",
			wdSyntaxFunction: "#f0c48a",
			wdSyntaxType: "#c9b7e8",
			wdSyntaxVariable: "#d8d2c4",
			wdSyntaxOperator: "#a39d90",
			wdSyntaxPunctuation: "#8f8a7e",
			wdDiffAddBg: "#3c4b2c",
			wdDiffRemoveBg: "#5c3434",
			wdShellCommand: "#f6f0e4",
			wdShellFlag: "#c9b7a0",
			wdShellOperator: "#948d80",
		},
	},
};
// ---- the catalogue: name -> [prose, open] -----------------------------------
const VARIANTS = {
	"h0-current": ["current", "current"],
	"h1-paper": ["paper", "current"],
	"h2-whitepill": ["whitePill", "current"],
	"h3-ivorypill": ["ivoryPill", "current"],
	"h4-field": ["current", "field"],
	"h5-paper-field": ["paper", "field"],
	"h6-whitepill-vivid": ["whitePill", "vivid"],
	"h7-ivorypill-warm": ["ivoryPill", "warm"],
	"h8-paper-vivid": ["paper", "vivid"],
	// 2026-08-22 prose × headings candidates (render with --only p)
	"p0-current": ["current", "current", "ramp6"],
	"p1-evidence-two": ["evidence", "current", "two"],
	"p2-evidence-three": ["evidence", "current", "three"],
	"p3-tinted-two": ["tinted", "current", "two"],
	"p4-tinted-three": ["tinted", "current", "three"],
	"p5-plain-two": ["plain", "current", "two"],
	"p6-evidence-one": ["evidence", "current", "one"],
	"p7-evidence-sup": ["evidence", "current", "supHue"],
	"p8-evidence-supmuted": ["evidence", "current", "supMuted"],
};
// --only <prefix>: write only the variants whose name starts with it.
const only = opt("--only", "");

for (const [name, [p, o, h = "ramp6"]] of Object.entries(VARIANTS)) {
	if (only && !name.startsWith(only)) continue;
	const t = JSON.parse(JSON.stringify(src));
	t.name = name;
	const proseHex = PROSE[p].colors?.wdProse || "#f8f8f2";
	for (const ov of [PROSE[p], OPEN[o], HEAD[h](proseHex)]) {
		Object.assign(t.vars, ov.vars ?? {});
		Object.assign(t.colors, ov.colors ?? {});
	}
	fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(t, null, 2));
	console.log("wrote", path.join(out, `${name}.json`), `(prose=${p}, open=${o}, headings=${h})`);
}
