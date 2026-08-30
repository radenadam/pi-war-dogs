/**
 * attachments: war-dogs' own image-attachment pipeline. No third-party
 * paster — the store, the paste handling and the optimization are all here,
 * and the only image machinery used is pi's own exported resizeImage
 * (photon-in-a-worker, the same pipeline pi's read tool uses), so the
 * extension adds zero image dependencies.
 *
 * One input experience for drag/drop, CTRL+V and typed paths, one wire
 * format:
 *
 *   input:   [^image N] refs at the cursor. Drag/drop arrives as a
 *            bracketed paste of path(s) — bare, shell-quoted/escaped or
 *            file:// — and is rewritten in flight, inside its own paste
 *            markers; CTRL+V and typed paths are rewritten by the editor
 *            sync and again at submit.
 *   submit:  prepareOutgoing() re-reads what changed on disk, attaches
 *            images in ref-occurrence order and appends one footnote
 *            definition per image at the bottom:
 *            [^image 1]: /path/to/file
 *            plus, when they apply, pi's dimension note for a downscaled
 *            image and one `[^image N] omitted: …` line for one the wire
 *            refused (nothing pi's own processImage would refuse is sent).
 *   context: the only added text is that footer. A widget above the editor
 *            shows pending attachments and broken refs; it never enters
 *            the context.
 *
 * prepareOutgoing() is the single submit engine: the `input` handler here
 * uses it for main, and visual/pager/mod.ts calls it for messages routed
 * to a focused subagent — which is what makes images reach children too.
 *
 * Integrity is self-enforcing: a def and an attachment are produced only
 * for refs that survive to submit intact. Ids at or below the highest ever
 * submitted are permanent (history must not be contradicted); newer ids
 * that no longer appear anywhere are garbage-collected and reused.
 *
 * This is a pi-coupled FEATURE, so it lives in tools/, not tools/library/
 * (which stays pi-free); the pure helpers it leans on are in
 * tools/library/image.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	defLinePattern,
	detectImageMimeType,
	expandHomePath,
	imagePathPattern,
	pastedImagePaths,
} from "./library/image.ts";
import type { ImageMime } from "./library/image.ts";

/**
 * Absolute or ~/ image path in typed text — on Windows also `C:\`, `C:/` and
 * UNC; the dialect is decided once in tools/library/image.ts. There is no
 * left boundary (an earlier note described a lookbehind the code does not
 * carry): pi's paste-image key inserts the clipboard file wherever the caret
 * is, so a path glued to a word still converts, and the guard against prose
 * like `docs/diagram.png` is the on-disk check — a span attaches only if the
 * absolute path it names exists and sniffs as an image.
 */
const IMAGE_PATH_RE = imagePathPattern();
/** A footnote definition line the pipeline itself wrote. */
const FOOTER_DEF_RE = /^\[\^image \d+\]: /;
/**
 * The trailing footer block, for idempotent requeue. Its lines are defs,
 * refusal notices, and the dimension note pi's own read tool emits for a
 * resized image. The DIVIDER (or the
 * legacy zero-width-space line) is REQUIRED: with a bare `\n` alternative the
 * block matched after any newline, so a message whose last line merely looked
 * like a def — "please add this line to the docs:\n[^image 7]: /tmp/foo.png" —
 * had that line silently deleted before it reached the model (demonstrated).
 * Three historic shapes are accepted: `---` + defs (round 15, current),
 * `---` + ZWSP + defs (round 14) and ZWSP + defs (round 13).
 */
const FOOTER_BLOCK_RE =
	/(?:\n\n---\n(?:​\n)?|\n​\n)(?:(?:\[\^image \d+\](?:: | omitted: )[^\n]*|\[Image: [^\n]*)\n?)+$/;
/** An intact ref, tolerant of incidental spacing: [^image 1]. */
const REF_RE = /\[\^image\s*(\d+)\s*\]/g;
/**
 * Anything shaped like a ref, including broken ones. The CARET is what makes
 * it a footnote ref and is therefore required: with it optional the warning
 * fired on ordinary prose ("the [image processing pipeline] docs", "![image](x)"),
 * which trains the user to ignore the one warning that matters.
 */
const REFISH_RE = /\[\^\s*image\b[^\]\n]{0,12}\]?/g;
/** Refuse to slurp arbitrarily large files into memory. */
const MAX_READ_BYTES = 64 * 1024 * 1024;

const WIDGET_ID = "war-dogs-attachments";
const WIDGET_PLACEMENT = "aboveEditor" as const;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export interface ImagePart {
	type: "image";
	mimeType: string;
	data: string;
}

interface Attachment {
	id: number;
	placeholder: string;
	path: string;
	mimeType: ImageMime;
	data: string; // base64
	/** True once pi's resizeImage has accepted this attachment's bytes. */
	optimized?: boolean;
	/** Why these bytes could not be prepared for the wire (pi's own wording). */
	refusal?: string;
	/** pi's dimension note for a downscaled image (formatDimensionNote). */
	note?: string;
	/** Freshness stamps, so an overwritten file is re-read instead of cached. */
	size?: number;
	mtimeMs?: number;
}

/** The attachment registry, keyed by footnote placeholder and by id. */
class FootnoteStore {
	private nextId = 1;
	private byPlaceholder = new Map<string, Attachment>();

	clear() {
		this.byPlaceholder.clear();
		this.nextId = 1;
	}

	list(): Attachment[] {
		return [...this.byPlaceholder.values()];
	}

	byId(id: number): Attachment | undefined {
		for (const a of this.byPlaceholder.values()) if (a.id === id) return a;
		return undefined;
	}

	byPath(path: string): Attachment | undefined {
		for (const a of this.byPlaceholder.values()) if (a.path === path) return a;
		return undefined;
	}

	add(input: { path: string; mimeType: ImageMime; data: string; size?: number; mtimeMs?: number }): Attachment {
		return this.addWithId(input, this.nextId);
	}

	/** Register with a fixed id — resume rebuild must reproduce history's numbering. */
	addWithId(
		input: { path: string; mimeType: ImageMime; data: string; size?: number; mtimeMs?: number },
		id: number,
	): Attachment {
		const a: Attachment = { ...input, id, placeholder: `[^image ${id}]` };
		this.byPlaceholder.set(a.placeholder, a);
		this.nextId = Math.max(this.nextId, id + 1);
		return a;
	}

	remove(placeholder: string) {
		this.byPlaceholder.delete(placeholder);
	}

	setNextId(n: number) {
		this.nextId = n;
	}

	/** Attachments referenced in `text`, in first-occurrence order, deduped. */
	matching(text: string): Attachment[] {
		const out: Attachment[] = [];
		for (const m of text.matchAll(REF_RE)) {
			const a = this.byId(Number(m[1]));
			if (a && !out.includes(a)) out.push(a);
		}
		return out;
	}
}

const store = new FootnoteStore();
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let unsubTerminal: (() => void) | undefined;
let pasteBuffer: string | undefined;
let registered = false;
/** Highest id ever submitted to history; ids at or below it are permanent. */
let submittedMaxId = 0;
/** The live context, for user-facing notices from the submit engine. */
let uiCtx: ExtensionContext | null = null;
/** True once the id space has been anchored to the CURRENT session. */
let rebuilt = false;

/** Whether the attachments feature is wired up (war-dogs on at boot, feature on). */
export function attachmentsReady(): boolean {
	return registered;
}

function expandHome(p: string): string {
	// os.homedir(), not $HOME: Windows sets USERPROFILE and no HOME (2026-08-30).
	return expandHomePath(p, os.homedir());
}

interface ImageBytes {
	mimeType: ImageMime;
	data: string;
	size: number;
	mtimeMs: number;
}

/**
 * Paths that were read and REJECTED, keyed by path and stamped with the
 * size/mtime that failed.
 *
 * The editor is re-scanned every 1.5s, and a `.png` that is not an image (a
 * truncated download, a renamed file, a directory, a 0-byte placeholder)
 * failed the sniff every single time — a full synchronous read on the UI
 * thread per tick for as long as it sits in the prompt (measured: 20MB,
 * 5–14ms, forever). Successes were already cached by the store's freshness
 * stamps; this is the same cache for failures. A file that later becomes a
 * real image changes size or mtime, which invalidates the entry.
 */
const failedReads = new Map<string, { size: number; mtimeMs: number }>();

/**
 * Read + sniff one path. Undefined = not an image we can take (and the
 * failure is negative-cached).
 */
function readImage(p: string): ImageBytes | undefined {
	let st: fs.Stats;
	try {
		st = fs.statSync(p);
	} catch {
		return undefined;
	}
	if (!st.isFile() || st.size > MAX_READ_BYTES) return undefined;
	const failed = failedReads.get(p);
	if (failed && failed.size === st.size && failed.mtimeMs === st.mtimeMs) return undefined;
	try {
		const bytes = fs.readFileSync(p);
		const mimeType = detectImageMimeType(bytes);
		if (!mimeType) {
			failedReads.set(p, { size: st.size, mtimeMs: st.mtimeMs });
			return undefined;
		}
		failedReads.delete(p);
		return { mimeType, data: bytes.toString("base64"), size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		failedReads.set(p, { size: st.size, mtimeMs: st.mtimeMs });
		return undefined;
	}
}

/**
 * Re-read an attachment whose file has changed on disk, keeping its id (and
 * therefore any ref already typed) intact.
 *
 * Attachments are keyed by PATH, so a screenshot tool that overwrites the same
 * file used to re-send the FIRST capture for the rest of the session — the
 * model got an image that was not the file on disk, with the widget still
 * showing the ref as normally attached. The freshness check used to live in
 * attachPath alone, which is only reached while the RAW PATH is still in the
 * text: the moment the path became a ref (instantly for drag/drop, one tick
 * for typing) the bytes froze for the session. So prepareOutgoing calls this
 * for every matched ref too — one stat per attached image per submit.
 */
function refreshAttachment(a: Attachment): Attachment {
	let st: fs.Stats;
	try {
		st = fs.statSync(a.path);
	} catch {
		// Unreadable or gone now: keep the bytes we already have rather than
		// dropping a ref the user has already typed.
		return a;
	}
	if (a.size === st.size && a.mtimeMs === st.mtimeMs) return a;
	const fresh = readImage(a.path);
	if (!fresh) return a;
	a.data = fresh.data;
	a.mimeType = fresh.mimeType;
	a.size = fresh.size;
	a.mtimeMs = fresh.mtimeMs;
	// New bytes: resize again, and forget the old verdict/note.
	a.optimized = false;
	a.refusal = undefined;
	a.note = undefined;
	return a;
}

/** Read + sniff a path; register it (or refresh the entry). Undefined = not an image we can take. */
function attachPath(rawPath: string): Attachment | undefined {
	const p = expandHome(rawPath);
	const existing = store.byPath(p);
	if (existing) return refreshAttachment(existing);
	const img = readImage(p);
	if (!img) return undefined;
	return store.add({ path: p, ...img });
}

/** Register a path under a FIXED id (footer adoption, history rebuild). */
function attachPathWithId(rawPath: string, id: number): Attachment | undefined {
	const p = expandHome(rawPath);
	const existing = store.byPath(p);
	if (existing && existing.id === id) return refreshAttachment(existing);
	const img = readImage(p);
	if (!img) return undefined;
	return store.addWithId({ path: p, ...img }, id);
}

/**
 * Run each attachment through pi's own resizeImage once (2000×2000 / 4.5MB
 * caps, EXIF-aware, photon in a worker — identical to what pi's read tool does
 * to images), and mirror pi's own REFUSAL semantics.
 *
 * pi's `processImage` treats a null from resizeImage as "do not send this
 * image": it returns ok:false and puts `[Image omitted: …]` in the model's
 * text. war-dogs used to swallow the failure and ship the original bytes,
 * which is how a file with valid magic but undecodable content (a truncated
 * screenshot, a half-written file) reached the provider — the request came
 * back 400, and because the message is already persisted, EVERY later request
 * in that session failed the same way (demonstrated live). So a refusal now
 * drops the image and the def, says so in one line of text, and shows up in
 * the widget.
 *
 * The verdict is remembered on the attachment (cleared whenever the file's
 * bytes are re-read), so a resubmit does not re-run the resize and the widget
 * can warn without being async.
 */
async function optimizedData(a: Attachment): Promise<Attachment> {
	if (a.optimized || a.refusal) return a;
	let r: Awaited<ReturnType<typeof resizeImage>>;
	try {
		r = await resizeImage(Buffer.from(a.data, "base64"), a.mimeType);
	} catch (e) {
		a.refusal = `could not be processed (${e instanceof Error ? e.message : String(e)})`;
		return a;
	}
	if (!r) {
		// null is ambiguous by construction (image-resize-core.js): photon
		// missing, a decode failure, or bytes that will not come under the cap.
		// pi names only the last one, and a model told that about a 40-byte
		// corrupt file spent its turn advising a downscale (observed live), so
		// the line names the whole set — in one line, still.
		a.refusal = "could not be decoded or reduced below the inline image size limit";
		return a;
	}
	a.data = r.data;
	a.mimeType = r.mimeType as ImageMime;
	// What pi's read tool tells the model when it downscales — without it,
	// anything the model says about pixel coordinates is silently wrong.
	// undefined when the image was not resized at all.
	a.note = formatDimensionNote(r);
	a.optimized = true;
	return a;
}

/**
 * Rewrite raw image file paths in typed text to refs. Covers pi's CTRL+V
 * clipboard files and any absolute or ~/ image path that exists on disk.
 * Footer definition lines are left untouched.
 */
function rewriteImagePaths(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			if (FOOTER_DEF_RE.test(line)) return line;
			return line.replace(IMAGE_PATH_RE, (raw) => attachSpan(raw));
		})
		.join("\n");
}

/**
 * One matched path-shaped span → its ref(s), or the span unchanged.
 *
 * A filename may legally contain `,` or `;`, so the whole span is tried
 * first (fixtures/comma,file.png attaches). But `,` and `;` are also how
 * people SEPARATE paths, and the greedy match then spanned both — the
 * resulting path exists nowhere, nothing attached, and two raw paths stayed
 * in the prompt (this is also what made an earlier auditor conclude `pi -p`
 * never attaches). So on a miss the span is split on `,`/`;` boundaries and
 * each part attached on its own; the separators are preserved verbatim.
 */
function attachSpan(raw: string): string {
	const whole = attachPath(raw);
	if (whole) return whole.placeholder;
	if (!/[,;]/.test(raw)) return raw;
	const parts = raw.split(/([,;]\s*)/);
	let attached = false;
	const out = parts.map((part, i) => {
		if (i % 2 === 1) return part; // the separator itself
		const a = part ? attachPath(part) : undefined;
		if (!a) return part;
		attached = true;
		return a.placeholder;
	});
	return attached ? out.join("") : raw;
}

/**
 * Rewrite image paths inside a bracketed-paste payload (drag/drop). Unlike
 * typed text, paste payloads carry quoting: '…'/"…" around paths with
 * spaces, "\ " escapes, file:// URIs. Splices placeholders over the exact
 * source spans; null when nothing attached (payload passes through
 * byte-identical).
 */
function replacePastedPaths(payload: string): string | null {
	const candidates = pastedImagePaths(payload);
	if (!candidates.length) return null;
	// TWO passes. Ids are allocated in the order attachPath is called, so
	// attaching while splicing (which must run right-to-left to keep the
	// earlier spans valid) numbered a multi-file drop BACKWARDS: dropping
	// red/blue/green produced [^image 1] [^image 4] [^image 3]. Attach in
	// reading order, then splice in reverse with the ids already allocated.
	const attached = candidates.map((c) => ({ c, a: attachPath(c.path) }));
	let out = payload;
	let any = false;
	for (const { c, a } of [...attached].reverse()) {
		if (!a) continue;
		out = out.slice(0, c.start) + a.placeholder + out.slice(c.end);
		any = true;
	}
	return any ? out : null;
}

/**
 * The drag/drop terminal handler: buffers a bracketed paste (which can
 * arrive split across reads), rewrites image paths inside it, and passes
 * everything else through byte-identical — a paste with no attachable
 * image reaches the editor exactly as it arrived.
 */
function pasteHandler(onAccept: () => void) {
	return (data: string): { consume?: boolean; data?: string } | undefined => {
		let prefix = "";
		const wasBuffered = pasteBuffer !== undefined;
		if (pasteBuffer === undefined) {
			const start = data.indexOf(PASTE_START);
			if (start === -1) return undefined;
			prefix = data.slice(0, start);
			pasteBuffer = data.slice(start + PASTE_START.length);
			if (!pasteBuffer.includes(PASTE_END)) return prefix ? { data: prefix } : { consume: true };
		} else {
			pasteBuffer += data;
			if (!pasteBuffer.includes(PASTE_END)) return { consume: true };
		}
		const end = pasteBuffer.indexOf(PASTE_END);
		const content = pasteBuffer.slice(0, end);
		const remaining = pasteBuffer.slice(end + PASTE_END.length);
		pasteBuffer = undefined;
		const replaced = replacePastedPaths(content);
		if (replaced === null) {
			// Untouched: re-emit the reconstructed paste only if we consumed chunks.
			return wasBuffered ? { data: `${PASTE_START}${content}${PASTE_END}${remaining}` } : undefined;
		}
		onAccept();
		// Re-emit INSIDE the bracketed-paste markers. Handing the editor a bare
		// payload routes it through the raw key path instead of handlePaste, so
		// a long drop lost its `[paste #N +M lines]` collapse (12 literal lines
		// in the prompt box, demonstrated), its atomic undo and pi's own
		// control-character filter.
		return { data: `${prefix}${PASTE_START}${replaced}${PASTE_END}${remaining}` };
	};
}

/** The lowest id no ref in this session can already mean. */
function freshId(): number {
	return Math.max(submittedMaxId, 0, ...store.list().map((a) => a.id)) + 1;
}

/** Tell the user something about an attachment (widget rows are the other half). */
function notify(message: string, level: "info" | "warning" | "error" = "warning") {
	try {
		if (uiCtx?.hasUI) uiCtx.ui.notify(`[attachments] ${message}`, level);
	} catch {}
}

/**
 * Re-register the defs of a message that was RESTORED into the editor, before
 * its footer is stripped.
 *
 * pi puts a previous user message — refs plus our footer — straight into the
 * editor on `/fork` and on `/tree` navigation (interactive-mode
 * `editor.setText(result.selectedText)`), AFTER the rebuild has run against an
 * empty editor. Nothing else re-registers those ids, so the footer was stripped
 * against an empty store and the model received a bare `[^image 1]` with no
 * image and no path — the one thing the user could plainly read in the prompt
 * box, deleted (demonstrated). Now the text teaches the store:
 *
 *  - the id already means that exact path  → nothing to do;
 *  - the id is free                        → register the file under it, so the
 *                                            numbering the user sees survives;
 *  - the id means a DIFFERENT file (the entered branch owns it) → the ref is
 *    renumbered in THIS message to a fresh id and the file registered there,
 *    because the visible ref must never quietly mean the other file;
 *  - the file cannot be read               → the def line is kept verbatim.
 *
 * The housekeeping tick calls this with `renumber:false` — registering a free
 * id is non-destructive and stops the widget crying "broken or unknown ref"
 * over a message it is about to attach perfectly well — and leaves the
 * collision case, the only one that rewrites text, to submit.
 */
function adoptFooterDefs(text: string, renumber = true): { text: string; preserved: string[] } {
	const block = FOOTER_BLOCK_RE.exec(text);
	if (!block) return { text, preserved: [] };
	const DEF_LINE_RE = defLinePattern();
	const preserved: string[] = [];
	const renames = new Map<number, number>();
	let fresh = freshId();
	for (const line of block[0].split("\n")) {
		const d = DEF_LINE_RE.exec(line);
		if (!d) continue; // omitted/dimension lines: the pipeline rewrites them
		const id = Number(d[1]);
		const rawPath = (d[2] ?? "").trim();
		const held = store.byId(id);
		if (held && held.path === expandHome(rawPath)) continue;
		if (!held) {
			if (attachPathWithId(rawPath, id)) continue;
			if (renumber) preserved.push(line);
			continue;
		}
		if (!renumber) continue;
		const to = fresh++;
		renames.set(id, to);
		if (!attachPathWithId(rawPath, to)) preserved.push(`[^image ${to}]: ${rawPath}`);
	}
	if (!renames.size) return { text, preserved };
	const renumbered = text.replace(REF_RE, (whole, n) => {
		const to = renames.get(Number(n));
		return to === undefined ? whole : `[^image ${to}]`;
	});
	return { text: renumbered, preserved };
}

/**
 * The submit engine, shared by main (the `input` handler below) and the
 * subagent path (visual/pager/mod.ts): rewrite paths to refs, anchor the
 * ids history is about to reference, attach images in ref-occurrence
 * order, and append the footnote definitions.
 *
 * The defs sit behind a blank line and a `---` thematic break — the wire is
 * byte-identical to what the war-dogs prompt box displays. (Round 15: the
 * old zero-width-space guard between prompt and defs is GONE by maintainer
 * decision; see the note in the body for the accepted stock-pi cost.
 * FOOTER_BLOCK_RE still strips the legacy ZWSP shape from older requeued
 * messages.)
 *
 * Any footer block already present (a requeued/restored message) is
 * stripped first, so re-submitting is idempotent instead of stacking defs.
 */
export async function prepareOutgoing(
	text: string,
	existing: ImagePart[] = [],
): Promise<{ text: string; images: ImagePart[] }> {
	if (!attachmentsReady()) return { text, images: existing };
	// Learn from the message's OWN footer before removing it.
	const adopted = adoptFooterDefs(text);
	const stripped = adopted.text.replace(FOOTER_BLOCK_RE, "");
	const rewritten = rewriteImagePaths(stripped);
	const refs = store.matching(rewritten);
	if (!refs.length && !adopted.preserved.length) return { text: rewritten, images: existing };

	// These ids are now part of history; anchor them permanently.
	for (const a of refs) submittedMaxId = Math.max(submittedMaxId, a.id);

	const images: ImagePart[] = [...existing];
	const footer: string[] = [];
	for (const a of refs) {
		// Re-validate against disk FIRST: the ref may have been sitting in the
		// prompt while the file it names was overwritten.
		const img = await optimizedData(refreshAttachment(a));
		if (img.refusal) {
			// pi's semantics: no bytes, and the model is told why.
			footer.push(`${a.placeholder} omitted: ${img.refusal}`);
			notify(`${path.basename(a.path)}: ${img.refusal}; not attached`);
			continue;
		}
		images.push({ type: "image", mimeType: img.mimeType, data: img.data });
		footer.push(`${a.placeholder}: ${a.path}`);
		// One short line, pi's own wording, only when it was actually resized.
		if (img.note) footer.push(img.note);
	}
	// Defs this pipeline could not reproduce are kept verbatim rather than
	// deleted: the path the user can read in the prompt box must not vanish.
	footer.push(...adopted.preserved);
	// Blank line, `---` (a thematic break — safe: setext headings need
	// the dashes DIRECTLY under a paragraph), then the defs. The old
	// zero-width-space guard is GONE by maintainer decision (round 15):
	// the wire must equal war-dogs' own display byte-for-byte. Known,
	// demonstrated cost: STOCK pi's markdown (mode off, --no-extensions)
	// consumes the defs as footnote definitions and rewrites the ref
	// inline as `^image N (/path)` — accepted.
	return { text: footer.length ? `${rewritten}\n\n---\n${footer.join("\n")}` : rewritten, images };
}

/* ---------------- widget + housekeeping ---------------- */

function brokenRefs(text: string): string[] {
	const intactIds = new Set(store.list().map((a) => a.id));
	const out = new Set<string>();
	for (const m of text.matchAll(REFISH_RE)) {
		const tok = m[0];
		const exact = /^\[\^image\s*(\d+)\s*\]$/.exec(tok);
		if (exact && intactIds.has(Number(exact[1]))) continue;
		out.add(tok);
	}
	return [...out];
}

/**
 * The editor's text as the pipeline SEES it — raw image paths resolved to
 * their refs — with nothing written back.
 *
 * This used to call `ctx.ui.setEditorText(rewritten)` on the housekeeping
 * tick, which was destructive twice over. pi's setEditorText is
 * `editor.setText()`, and setText (a) clears the paste registry and (b)
 * places the caret at the END of the buffer. So on the very tick that
 * converted a path — i.e. the normal CTRL+V flow, where pi inserts a
 * clipboard path AT THE CURSOR — the user's caret jumped to the end
 * mid-sentence, and any collapsed `[paste #N +M lines]` block was
 * permanently expanded into the buffer (the read side is getExpandedText).
 *
 * There is no non-destructive write: setText takes no cursor placement,
 * ctx.ui.getEditorComponent() returns the FACTORY rather than the live
 * component (so the public API cannot read getCursor()), and getEditorText()
 * only ever hands back expanded text, so a collapsed paste is not even
 * detectable from here.
 *
 * So the write is GUARDED instead of abandoned — see syncTrailingPaths().
 * Producing this view always REGISTERS what it finds, so the widget lists a
 * pending attachment even on the ticks that decline to write, and
 * prepareOutgoing() re-runs the same rewrite at submit either way.
 */
function editorView(ctx: ExtensionContext): string {
	try {
		const text = editorScanText(ctx);
		if (isHostCommandLine(text)) return text;
		// A message pi RESTORED into the editor (fork, /tree) carries its own
		// defs; learn the free ids from them so the widget shows what will
		// actually happen at submit.
		adoptFooterDefs(text, false);
		return rewriteImagePaths(text);
	} catch {
		return "";
	}
}

/**
 * A buffer pi will dispatch ITSELF instead of sending to the model: its bash
 * mode (`!cmd`, `!!cmd`) and its slash commands.
 *
 * pi handles both BEFORE the `input` event (interactive-mode's submit handler
 * and agent-session's `_tryExecuteExtensionCommand`), so war-dogs never sees
 * them at submit — but the 1.5s editor sync happily rewrote an image path that
 * was an ARGUMENT to one, and the command then ran on `[^image 3]`:
 * "ls: cannot access '[^image': No such file or directory" (demonstrated live).
 * The whole buffer is one command in both cases, so testing the first line is
 * enough; an absolute path is not a command (`/home/adam/x.png` has no
 * whitespace after the first segment, so it fails the command shape).
 */
function isHostCommandLine(text: string): boolean {
	const first = text.trimStart().split("\n", 1)[0] ?? "";
	if (first.startsWith("!")) return true;
	const m = /^\/([A-Za-z][\w:-]*)(?:\s|$)/.exec(first);
	if (!m) return false;
	// Not every slash text is a command (2026-08-22, maintainer: a path pasted
	// after `/skill:name …` or `/test abc` stayed a raw path): pi DISPATCHES
	// only its hard-coded built-ins and extension commands; a `/skill:name`,
	// a prompt template and an unknown `/word` all reach the model as a
	// prompt — which is exactly where a pasted image must become its ref.
	// pi's own registry (`getCommands`, with each command's source) is the
	// oracle for the extension/template split; the built-ins are pi's
	// interactive-mode list (Upgrade Contract).
	const name = m[1];
	if (name.startsWith("skill:")) return false;
	if (PI_BUILTIN_COMMANDS.has(name)) return true;
	try {
		const hit = ((uiCtx as any)?.getCommands?.() ?? []).find((c: any) => c?.name === name);
		return !!hit && hit.source === "extension";
	} catch {
		return true;
	}
}

/** pi 0.83/0.84's interactive-mode built-ins — `text === "/…"` in interactive-mode.js — plus its generic aliases (`thinking` joined in 0.84, the 0.84.3 sweep). */
const PI_BUILTIN_COMMANDS = new Set([
	"new",
	"thinking",
	"compact",
	"copy",
	"export",
	"import",
	"login",
	"logout",
	"model",
	"name",
	"quit",
	"exit",
	"reload",
	"resume",
	"scoped-models",
	"session",
	"settings",
	"share",
	"tree",
	"trust",
	"fork",
	"clone",
	"changelog",
	"debug",
	"hotkeys",
	"help",
	"clear",
	"mcp",
	"mcp-auth",
	"war-dogs",
]);

/** The attachment behind a `[^image N]` ref, for the pager (ctrl+click opens it). */
export function attachmentPath(id: number): string | undefined {
	return store.byId(id)?.path;
}

/**
 * The live EditorComponent, found by walking the TUI we captured from our own
 * widget factory.
 *
 * `ctx.ui.getEditorComponent()` returns the FACTORY, not the instance, so this
 * walk is the only route to the component — and the component is what makes a
 * caret-preserving rewrite possible at all. Everything below degrades safely:
 * no TUI, no editor, or a missing field and we simply do not write.
 */
let liveTui: any = null;
function findEditor(node: any, depth = 0): any {
	if (!node || depth > 6) return null;
	if (
		typeof node.getCursor === "function" &&
		typeof node.setText === "function" &&
		typeof node.getExpandedText === "function"
	) {
		return node;
	}
	const kids = Array.isArray(node.children) ? node.children : [];
	for (const k of kids) {
		const found = findEditor(k, depth + 1);
		if (found) return found;
	}
	return null;
}

/** The live editor component, or null when it is out of reach. */
function liveEditor(): any {
	const ed = liveTui ? findEditor(liveTui) : null;
	return ed && typeof ed.getText === "function" ? ed : null;
}

/**
 * The editor text the pipeline reasons about: the live component's own
 * MARKER-form text plus the contents of its collapsed pastes.
 *
 * `ctx.ui.getEditorText()` returns the EXPANDED text, which is a different
 * string from the one every write goes through (`ed.getText()`), and that
 * mismatch is a bug factory: a ref living inside a collapsed `[paste #N]`
 * block was counted as carried by the rebuild and renumbered in the store,
 * while the rewrite — operating on marker text — found nothing to change, so
 * the ref the user could actually see kept naming an id the entered session
 * already owned (demonstrated). Reading BOTH halves here, and transforming
 * both in rewriteLiveEditor, keeps the scan and the write over the same text.
 */
function editorScanText(ctx?: ExtensionContext): string {
	const ed = liveEditor();
	if (ed) {
		try {
			const marker = String(ed.getText() ?? "");
			const pastes = ed.pastes instanceof Map ? [...ed.pastes.values()].join("\n") : "";
			return pastes ? `${marker}\n${pastes}` : marker;
		} catch {}
	}
	try {
		return ctx?.ui.getEditorText() ?? "";
	} catch {
		return "";
	}
}

/**
 * Where the caret lands on a line after that line's paths become refs.
 *
 * Replacements never add or remove newlines, so the caret's LINE never moves —
 * only its column, by the length delta of every ref substituted before it. A
 * caret sitting INSIDE a path being replaced lands just after the new ref.
 */
function newColFor(oldLine: string, col: number): number {
	let delta = 0;
	for (const m of oldLine.matchAll(IMAGE_PATH_RE)) {
		const start = m.index ?? 0;
		const end = start + m[0].length;
		const replaced = attachSpan(m[0]); // idempotent: dedupes by path
		if (replaced === m[0]) continue;
		if (end <= col) delta += replaced.length - m[0].length;
		else if (start < col) return start + replaced.length;
	}
	return col + delta;
}

/**
 * Convert raw image paths in the editor to refs, ANYWHERE in the buffer,
 * without disturbing the caret or the paste registry.
 *
 * Turning a 45-character `/tmp/pi-clipboard-<uuid>.png` into `[^image 1]` is
 * the point of the feature — a raw path eats the prompt and makes what you are
 * typing unreadable — and it has to work mid-sentence, because that is where
 * people paste. Drag/drop never needed this (its handler rewrites the bytes
 * before the editor sees them); CTRL+V does, because pi reads the clipboard
 * itself and calls insertTextAtCursor with the temp path.
 *
 * pi's public setEditorText is `editor.setText()`, which clears the paste
 * registry and drops the caret at the END of the buffer. Both are repaired
 * here: the text is read via the component's own getText() — the MARKER form,
 * so a collapsed `[paste #N +M lines]` block is never expanded in the first
 * place — and the paste map, its counter and the caret are snapshotted and
 * restored around the write.
 *
 * LOAD-BEARING: `state.cursorLine` / `setCursorCol` / `pastes` / `pasteCounter`
 * are pi-tui internals (see the Upgrade Contract). Every one is optional here:
 * if any is missing the write is skipped entirely rather than done badly.
 */
function syncEditorPaths(): void {
	// Never touch a buffer pi is going to dispatch itself (see isHostCommandLine).
	rewriteLiveEditor(
		(raw) => (isHostCommandLine(raw) ? raw : rewriteImagePaths(raw)),
		newColFor,
		(content, raw) => (isHostCommandLine(raw) ? content : rewriteImagePaths(content)),
	);
}

/**
 * Prepend text to the live editor the safe way (marker form, paste registry
 * and caret kept — the caret moves down by the inserted lines). For the
 * pager's alt+up in a run view, which mirrors pi's dequeue: the public
 * getEditorText()/setEditorText() round-trip EXPANDS `[paste #N]` blocks and
 * clears the registry (demonstrated: 31 pasted lines unfolded on screen).
 * Returns false when no live editor is in reach — the caller falls back.
 */
export function editorPrepend(text: string): boolean {
	const ed = liveEditor();
	if (!ed || !ed.state) return false;
	let raw = "";
	try {
		raw = ed.getText() ?? "";
	} catch {
		return false;
	}
	const joined = raw.trim() ? `${text}\n\n${raw}` : text;
	if (joined === raw) return true;
	const newLines = joined.split("\n");
	if (!raw) {
		// rewriteLiveEditor declines an EMPTY buffer (there is no caret or paste
		// registry worth preserving), so it used to return false here and the
		// caller fell back to setEditorText — a "no live editor" answer that was
		// not true. An empty buffer needs no repair: write it and place the
		// caret at the end.
		try {
			ed.setText(joined);
			ed.state.cursorLine = newLines.length - 1;
			const col = (newLines[newLines.length - 1] ?? "").length;
			if (typeof ed.setCursorCol === "function") ed.setCursorCol(col);
			else ed.state.cursorCol = col;
			return true;
		} catch {
			return false;
		}
	}
	const added = newLines.length - raw.split("\n").length;
	let before = { line: 0, col: 0 };
	try {
		before = ed.getCursor?.() ?? before;
	} catch {}
	let wrote = false;
	rewriteLiveEditor(
		() => {
			wrote = true;
			return joined;
		},
		(_line, col) => col,
	);
	// The caret's LINE moves down by everything inserted above it, and its
	// column is clamped against the line it ACTUALLY lands on. rewriteLiveEditor
	// clamped against the line at the old index — a shorter one — and then the
	// line moved underneath it, so the column could be short (or past the end).
	if (wrote && added > 0) {
		try {
			const line = Math.min(before.line + added, newLines.length - 1);
			ed.state.cursorLine = line;
			const col = Math.min(before.col, (newLines[line] ?? "").length);
			if (typeof ed.setCursorCol === "function") ed.setCursorCol(col);
			else ed.state.cursorCol = col;
		} catch {}
	}
	return wrote;
}

/**
 * Apply `transform` to the live editor's MARKER-form text, keeping the paste
 * registry and the caret (`colFor(oldLine, col)` says where the caret lands
 * on its line). Shared by the path→ref conversion and the ref renumbering
 * that a session switch can require (see rebuildFromHistory).
 */
function rewriteLiveEditor(
	transform: (raw: string) => string,
	colFor: (oldLine: string, col: number) => number,
	transformPastes?: (content: string, raw: string) => string,
): void {
	const ed = liveEditor();
	if (!ed || !ed.state) return;
	let raw: string;
	try {
		raw = ed.getText();
	} catch {
		return;
	}
	if (!raw) return;
	const rewritten = transform(raw);
	// The registry is transformed too: a ref (or a raw path) inside a collapsed
	// `[paste #N]` block is invisible in the marker text but very much part of
	// the message that gets submitted.
	const pastes = ed.pastes instanceof Map ? new Map<number, string>(ed.pastes) : null;
	let pastesChanged = false;
	if (pastes && transformPastes) {
		for (const [id, content] of pastes) {
			try {
				const next = transformPastes(String(content), raw);
				if (next !== content) {
					pastes.set(id, next);
					pastesChanged = true;
				}
			} catch {}
		}
	}
	if (rewritten === raw) {
		// Nothing to write: swap the registry in place rather than putting the
		// editor through setText for no reason.
		if (pastesChanged && pastes) {
			try {
				ed.pastes = pastes;
			} catch {}
		}
		return;
	}
	try {
		const cur = ed.getCursor?.() ?? { line: 0, col: 0 };
		const oldLines = raw.split("\n");
		const targetCol = colFor(oldLines[cur.line] ?? "", cur.col);
		const counter = ed.pasteCounter;
		ed.setText(rewritten);
		// setText cleared these; the text we wrote still carries the markers.
		if (pastes) {
			ed.pastes = pastes;
			ed.pasteCounter = counter;
		}
		const newLines = rewritten.split("\n");
		const line = Math.min(cur.line, newLines.length - 1);
		ed.state.cursorLine = line;
		const col = Math.min(targetCol, (newLines[line] ?? "").length);
		if (typeof ed.setCursorCol === "function") ed.setCursorCol(col);
		else ed.state.cursorCol = col;
	} catch {
		/* a shape we do not recognise: leave the editor alone */
	}
}

/**
 * Resume-robust rebuild: scan the active branch for footnote defs left by
 * earlier turns and re-register them with their original ids, so historical
 * refs stay attachable and numbering continues without colliding. Defs
 * whose files are gone are skipped; their images remain in history anyway.
 */
function rebuildFromHistory(ctx: ExtensionContext) {
	// Attachments the editor still refers to but history has never seen (a
	// paste that was not submitted yet). They are re-registered after the
	// history pass so the text in the editor keeps meaning what it meant —
	// under their ORIGINAL ids when those are free, and under FRESH ids (with
	// the editor's refs rewritten in place) when the session being entered
	// already owns them. That collision is real: the id space is PER SESSION,
	// and pi replaces the session on /new, /fork and /resume without
	// restarting the process. The watermark below is therefore rebuilt from
	// the entered session alone; carrying the previous session's high-water
	// mark let a pending [^image 1] silently resolve to the resumed session's
	// [^image 1] — a different file — which the model then described
	// (demonstrated live and by probe, 2026-08-17).
	rebuilt = true;
	// The live component's own text (plus its collapsed pastes) — the same
	// string the renumbering write below operates on. Reading pi's EXPANDED
	// view here instead let a ref inside a `[paste #N]` block be renumbered in
	// the store while the text kept the old id (see editorScanText).
	const live = editorScanText(ctx);
	const carried = live ? store.matching(live) : [];
	store.clear();
	submittedMaxId = 0;
	const DEF_RE = defLinePattern("gm");
	const defs = new Map<number, string>();
	let entries: any[] = [];
	try {
		entries = (ctx.sessionManager as any)?.getBranch?.() ?? (ctx.sessionManager as any)?.getEntries?.() ?? [];
	} catch {}
	for (const e of entries) {
		const msg = e?.message ?? e;
		if (msg?.role !== "user") continue;
		const c = msg.content;
		const texts: string[] = Array.isArray(c)
			? c.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? ""))
			: typeof c === "string"
				? [c]
				: [];
		for (const t of texts) {
			for (const m of t.matchAll(DEF_RE)) {
				const id = Number(m[1]);
				if (!defs.has(id)) defs.set(id, m[2].trim());
			}
		}
	}
	for (const [id, rawPath] of [...defs.entries()].sort((a, b) => a[0] - b[0])) {
		submittedMaxId = Math.max(submittedMaxId, id);
		const p = expandHome(rawPath);
		if (store.byPath(p)) continue;
		// file gone / no longer an image: the image still lives in history, the
		// ref just won't re-attach — but the ID stays taken (takenIds below).
		attachPathWithId(p, id);
	}
	// HISTORY, not the store, owns the id space. The store only holds ids whose
	// file could still be read and sniffed, so testing `store.byId` alone made a
	// def whose file was deleted (or is no longer decodable) invisible: a
	// carried pending ref kept that id and the new message defined the same
	// label for a different file, in a transcript that already says otherwise.
	const takenIds = new Set(defs.keys());
	// Put back the still-referenced, not-yet-submitted attachments, under the
	// ids their refs already name — or, when this session's history owns
	// that id, under a fresh one above everything known, rewriting the
	// editor's ref so it keeps pointing at the same file.
	// Two ways to resolve a collision, both keeping ids unique in the session:
	// with a live editor in reach the PENDING ref is renumbered and the text
	// rewritten in place (history keeps its ids); without one — probes,
	// no-TUI drivers — the pending attachment keeps the id the user can see
	// and history's def moves to the fresh id instead. Never the third way,
	// where the visible ref quietly means the other file.
	const canRewrite = !!liveEditor();
	const renames = new Map<number, number>();
	let fresh = Math.max(submittedMaxId, ...takenIds, ...store.list().map((x) => x.id), ...carried.map((x) => x.id)) + 1;
	for (const a of carried) {
		const taken = store.byId(a.id);
		let id = a.id;
		if (takenIds.has(a.id) || taken) {
			if (canRewrite) {
				id = fresh++;
				renames.set(a.id, id);
			} else if (taken) {
				store.remove(taken.placeholder);
				store.addWithId(
					{
						path: taken.path,
						mimeType: taken.mimeType,
						data: taken.data,
						size: taken.size,
						mtimeMs: taken.mtimeMs,
					},
					fresh++,
				);
			}
			// (History owns the id but its file is gone: nothing to move, and the
			// pending attachment keeps the id the user can see.)
		}
		const back = store.addWithId(
			{ path: a.path, mimeType: a.mimeType, data: a.data, size: a.size, mtimeMs: a.mtimeMs },
			id,
		);
		// Carry the optimize verdict: `data` may already be the resized payload,
		// and re-running resizeImage on it at submit would shrink it twice.
		back.optimized = a.optimized;
		back.refusal = a.refusal;
		back.note = a.note;
	}
	if (renames.size) {
		const REF = /\[\^image (\d+)\]/g;
		const renumber = (t: string) =>
			t.replace(REF, (m, n) => (renames.has(Number(n)) ? `[^image ${renames.get(Number(n))}]` : m));
		// The paste registry is renumbered with the text: a ref inside a
		// collapsed block is part of the message even though it is not in view.
		rewriteLiveEditor(
			renumber,
			(line, col) => renumber(line.slice(0, col)).length,
			(content) => renumber(content),
		);
	}
}

/**
 * Garbage-collect orphaned attachments: a ref deleted from the editor and
 * never submitted frees its id for the next paste. Submitted ids are
 * anchored by history and never reused.
 */
function gcStore(text: string) {
	let maxKept = submittedMaxId;
	// Referenced ids are read the way EVERY other reader reads them — through
	// REF_RE, which tolerates incidental spacing. The exact-substring test used
	// here collected `[^image 2 ]` while the widget still listed it as pending,
	// handed its id to the next paste, and the visible ref silently rebound to
	// a different file (demonstrated).
	const live = new Set([...text.matchAll(REF_RE)].map((m) => Number(m[1])));
	for (const a of store.list()) {
		const referenced = live.has(a.id);
		if (!referenced && a.id > submittedMaxId) {
			store.remove(a.placeholder);
			continue;
		}
		maxKept = Math.max(maxKept, a.id);
	}
	store.setNextId(maxKept + 1);
}

function refreshWidget(ctx: ExtensionContext, text = editorView(ctx)) {
	if (!ctx.hasUI) return;
	const pending = store.matching(text);
	const broken = brokenRefs(text);
	// The widget stays installed even when it has nothing to show (it renders
	// zero lines). That is deliberate: its factory is how we get a handle on the
	// live TUI, and therefore on the editor component — see findEditor().
	const lines = pending.filter((a) => !a.refusal).map((a) => `${a.placeholder} ${path.basename(a.path)}`);
	const warnings: string[] = [];
	// An image the wire refused (undecodable, or not reducible under the cap)
	// is NOT a normal pending attachment — it is the one row the user must see.
	for (const a of pending) {
		if (a.refusal) warnings.push(`⚠ ${a.placeholder} ${path.basename(a.path)}: ${a.refusal}`);
	}
	for (const b of broken) warnings.push(`⚠ ${b} broken or unknown ref; will not attach`);
	const quiet = lines.length;
	lines.push(...warnings);
	ctx.ui.setWidget(
		WIDGET_ID,
		(tui: any, theme: any) => {
			liveTui = tui;
			const body = lines.map((l, i) => theme.fg(i < quiet ? "dim" : "warning", l)).join("\n");
			return new Text(body, 0, 0);
		},
		{ placement: WIDGET_PLACEMENT },
	);
}

function teardown() {
	try {
		unsubTerminal?.();
	} catch {}
	unsubTerminal = undefined;
	pasteBuffer = undefined;
	uiCtx = null;
	// The next enable()/session_start owns the id space again.
	rebuilt = false;
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = null;
	}
	// The store is deliberately NOT cleared here. teardown() owns the
	// listener, the timer and the paste buffer; enable() rebuilds the store
	// from history anyway. Clearing it meant a teardown + enable() in one
	// process (then a live `/war-dogs off` + `on`; now a session switch) with
	// an unsubmitted [^image N] still in the editor orphaned that ref: it
	// attached nothing, no footnote def was written, and the dangling text
	// went to the model. Worse, submittedMaxId survives teardown while
	// gcStore resets nextId from it, so the id was handed to the NEXT paste
	// and the stale ref silently bound to a different image.
}

/* ---------------- wiring ---------------- */

export function register(pi: ExtensionAPI) {
	registered = true;

	pi.on("session_shutdown", async () => {
		teardown();
	});

	// The id space is anchored HERE, not in enable(): enable() returns early
	// without a UI, so a headless run (`pi -p`, `-p --continue`, RPC) attached
	// images — attachmentsReady() is true there — without ever rebuilding the
	// watermark from history. The first attachment of the run took id 1 again
	// and one transcript ended up with two different files under `[^image 1]`
	// (demonstrated). Only the widget, the timer and the paste handler need a
	// UI; the rebuild needs ctx.sessionManager alone.
	//
	// This handler is registered before index.ts's own session_start (which
	// calls enable()), so the store is anchored before anything can attach.
	pi.on("session_start", async (_e, ctx) => {
		try {
			rebuildFromHistory(ctx);
		} catch {}
	});

	// A branch switch enters a DIFFERENT id space with no session replacement:
	// pi emits session_tree and nothing else (no shutdown, no session_start),
	// so the previous branch's watermark survived and a pending `[^image 1]`
	// resolved to the old branch's file. Compaction can drop the defs from the
	// summarised prefix the same way, which moves the watermark down.
	const rebuildNow = async (_e: unknown, ctx: ExtensionContext) => {
		try {
			rebuildFromHistory(ctx);
		} catch {}
	};
	pi.on("session_tree", rebuildNow);
	pi.on("session_compact", rebuildNow);

	pi.on("input", async (event) => {
		if (event.source === "extension") return { action: "continue" };
		const prepared = await prepareOutgoing(event.text, event.images ?? []);
		if (prepared.text === event.text && prepared.images.length === (event.images?.length ?? 0)) {
			return { action: "continue" };
		}
		return { action: "transform", text: prepared.text, images: prepared.images };
	});
}

/**
 * Start the pipeline: rebuild refs from history, install the drag/drop
 * paste handler, and run the widget/gc refresh loop. Called by the
 * orchestrator at session_start while war-dogs is on.
 */
export function enable(ctx: ExtensionContext) {
	uiCtx = ctx;
	// Anchoring happens on session_start (see register), which runs before
	// this; a defence only — the store must be anchored before anything attaches.
	if (!rebuilt) {
		try {
			rebuildFromHistory(ctx);
		} catch {}
	}
	if (!ctx.hasUI) return;
	unsubTerminal?.();
	unsubTerminal = ctx.ui.onTerminalInput(pasteHandler(() => refreshWidget(ctx)));
	// Widget freshness regardless of insertion channel (typed, deleted,
	// CTRL+V), and the paste-time conversion point for raw paths.
	if (refreshTimer) clearInterval(refreshTimer);
	refreshTimer = setInterval(() => {
		try {
			// ONE resolved view per tick: gc must see refs the same way the
			// widget does, or an attachment whose ref is still a raw path in
			// the editor looks unreferenced and gets collected.
			syncEditorPaths();
			const view = editorView(ctx);
			gcStore(view);
			refreshWidget(ctx, view);
		} catch {}
	}, 1500);
	refreshTimer.unref?.();
}
