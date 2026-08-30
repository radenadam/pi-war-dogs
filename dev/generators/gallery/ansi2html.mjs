#!/usr/bin/env node
// Colour catalogue, step 3: turn the tmux captures (`capture-pane -e`) into ONE
// HTML page — every variant × state side by side, real pixels from real pi —
// plus nothing else: the .ans files stay for `cat` in a terminal.
//
//   node dev/generators/gallery/ansi2html.mjs <captures dir> <out.html>
// Expects <name>--<state>.ans files (run.sh writes them) and a manifest.json.
import fs from "node:fs";
import path from "node:path";

const [dir, outFile] = process.argv.slice(2);
const TERM_BG = "#1a1c1a";
const TERM_FG = "#d0d0d0";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function toHtml(ans) {
	let fg = null,
		bg = null,
		bold = false,
		italic = false,
		ul = false,
		inv = false,
		dim = false;
	let out = "";
	const style = () => {
		let f = fg ?? TERM_FG,
			b = bg ?? "transparent";
		if (inv) [f, b] = [b === "transparent" ? TERM_BG : b, f];
		const s = [`color:${f}`, `background:${b}`];
		if (bold) s.push("font-weight:bold");
		if (italic) s.push("font-style:italic");
		if (ul) s.push("text-decoration:underline");
		if (dim) s.push("opacity:.6");
		return s.join(";");
	};
	let open = false;
	const flushOpen = () => {
		if (open) {
			out += "</span>";
			open = false;
		}
	};
	const re =
		/\x1b\[([0-9;:]*)m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]|([^\x1b]+)/g;
	let m;
	while ((m = re.exec(ans))) {
		if (m[2] !== undefined) {
			flushOpen();
			out += `<span style="${style()}">${esc(m[2])}</span>`;
			continue;
		}
		if (m[1] === undefined) continue; // non-SGR escapes dropped
		const p = m[1] === "" ? [0] : m[1].split(/[;:]/).map(Number);
		for (let i = 0; i < p.length; i++) {
			const c = p[i];
			if (c === 0) {
				fg = bg = null;
				bold = italic = ul = inv = dim = false;
			} else if (c === 1) bold = true;
			else if (c === 2) dim = true;
			else if (c === 3) italic = true;
			else if (c === 4) ul = true;
			else if (c === 7) inv = true;
			else if (c === 22) {
				bold = false;
				dim = false;
			} else if (c === 23) italic = false;
			else if (c === 24) ul = false;
			else if (c === 27) inv = false;
			else if (c === 39) fg = null;
			else if (c === 49) bg = null;
			else if (c === 38 || c === 48) {
				let col = null;
				if (p[i + 1] === 2) {
					col = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`;
					i += 4;
				} else if (p[i + 1] === 5) {
					col = ansi256(p[i + 2]);
					i += 2;
				}
				if (c === 38) fg = col;
				else bg = col;
			} else if (c >= 30 && c <= 37) fg = BASIC[c - 30];
			else if (c >= 90 && c <= 97) fg = BASIC[c - 90 + 8];
			else if (c >= 40 && c <= 47) bg = BASIC[c - 40];
			else if (c >= 100 && c <= 107) bg = BASIC[c - 100 + 8];
		}
	}
	flushOpen();
	return out;
}
const BASIC = [
	"#000",
	"#a00",
	"#0a0",
	"#a50",
	"#00a",
	"#a0a",
	"#0aa",
	"#aaa",
	"#555",
	"#f55",
	"#5f5",
	"#ff5",
	"#55f",
	"#f5f",
	"#5ff",
	"#fff",
];
function ansi256(n) {
	if (n < 16) return BASIC[n];
	if (n < 232) {
		const c = n - 16,
			ch = (v) => (v === 0 ? 0 : 55 + v * 40);
		return `rgb(${ch(Math.floor(c / 36))},${ch(Math.floor((c % 36) / 6))},${ch(c % 6)})`;
	}
	const g = 8 + (n - 232) * 10;
	return `rgb(${g},${g},${g})`;
}

const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const states = manifest.states;
let html = `<!doctype html><meta charset="utf-8"><title>war-dogs colour catalogue</title>
<style>
body{background:#101210;color:#ccc;font-family:system-ui;margin:0;padding:16px}
h1{font-size:18px;margin:0 0 6px} h2{font-size:15px;margin:22px 0 6px;color:#eee}
.note{color:#999;font-size:13px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(2,max-content);gap:14px;align-items:start;overflow-x:auto}
.cap{font:12px/1.25 "JetBrainsMono Nerd Font","JetBrains Mono","Fira Code",ui-monospace,monospace;white-space:pre;background:${TERM_BG};color:${TERM_FG};padding:6px;border:1px solid #333;border-radius:4px}
.lbl{color:#8fce74;font-size:12px;margin-bottom:3px}
.tokens{color:#888;font-size:12px;white-space:pre;margin:4px 0 8px}
</style><body>
<h1>war-dogs colour catalogue</h1>
<div class="note">Real pi ${esc(manifest.piVersion)} · session ${esc(manifest.session)} · ${manifest.width}×${manifest.height} · generated ${esc(manifest.generatedAt)}. Same transcript, same rows, one theme per section: <b>collapsed</b> is the rest view (the model's prose, clusters), <b>expanded</b> is ctrl+o expand-all (every panel and thinking open). Terminal background here is ${TERM_BG} and its default foreground ${TERM_FG} (what "wdProse: \"\"" prose falls back to); yours differ — the .ans files in a terminal are exact.</div>`;
for (const v of manifest.variants) {
	html += `<h2>${esc(v.name)}</h2><div class="tokens">${esc(v.summary)}</div><div class="grid">`;
	for (const st of states) {
		const f = path.join(dir, `${v.name}--${st}.ans`);
		const body = fs.existsSync(f) ? toHtml(fs.readFileSync(f, "utf8")) : "(missing)";
		html += `<div><div class="lbl">${esc(st)}</div><div class="cap">${body}</div></div>`;
	}
	html += `</div>`;
}
html += `</body>`;
fs.writeFileSync(outFile, html);
console.log("wrote", outFile);
