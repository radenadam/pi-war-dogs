/**
 * `read` — pi's built-in, re-registered with our renderer AND our text path
 * (2026-08-21, the tool-prompt rewrite; proposal §5):
 *
 *   - line numbers baked into the result, cat -n style (`%6d\t`), numbering
 *     the file's REAL lines so offset, the metadata line, and the visible
 *     numbers agree; the renderer strips them for display (its own gutter);
 *   - a bracketed metadata line on EVERY read (house grammar): range read,
 *     the file's total lines and size, and the offset to continue from;
 *   - an explicit `limit` honored exactly, past the cap, clamped to the end
 *     of the file (today pi re-cuts even an explicit ask to 2000/50 KB);
 *   - the default cap stays pi's numbers (2000 lines / 50 KB), line-aligned.
 *
 * Images and every error path delegate to pi's own execute, so those texts
 * stay byte-stock. promptSnippet/promptGuidelines are re-declared from the
 * factory (createReadTool does NOT carry them — an override never inherits
 * prompt metadata, and without re-declaring the tool silently vanishes from
 * the system prompt's Available tools list).
 *
 * The CRLF flag the proposal floated was PROBED OUT: pi's edit normalizes
 * line endings (an LF oldText matches a CRLF file; a literal CRLF oldText
 * FAILS), so the flag would have been redundant where it mattered and a trap
 * where it didn't.
 */

import { createReadTool, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { renderCall, renderResult, setInnerRenderer } from "../visual/tools/read.ts";
import { reg } from "./register.ts";
import { stockToolOptions } from "../settings.ts";

/** pi's own caps (core/tools/truncate.js defaults), applied line-aligned. */
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
/** pi's image extension set (core/tools/read.js). */
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

function fmtSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const numbered = (lines: string[], start: number): string =>
	lines.map((l, i) => `${String(start + i).padStart(6)}\t${l}`).join("\n");

/** The read skin for a given cwd — the parent registers it; a child is handed one built for ITS cwd. */
export function build(cwd: string): ToolDefinition<any, any, any> {
	// The same options pi hands its own read tool (settings.images.autoResize).
	const opts = stockToolOptions().read;
	const read = createReadTool(cwd, opts);
	const meta = createReadToolDefinition(cwd, opts);
	setInnerRenderer((...a: any[]) => (meta as any).renderResult?.(...a));
	return {
		...read,
		description:
			"Read a file.\n\n" +
			"Text returns with a line number prefixed to each line, cat -n style; the numbers are added by the tool and are not part of the file. Reading an image file (jpg, png, gif, webp, bmp) returns the image itself. Prefer read over cat or sed for examining files.\n\n" +
			"Reads are capped at 2000 lines or 50 KB, whichever comes first, cut at a line boundary. Every result ends with a bracketed line naming the range read, the file's total lines and size, and, when more remains, the offset to continue from.\n\n" +
			"A read with an explicit limit returns exactly that many lines, even past the cap. A limit larger than the file returns the whole file.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to read (relative or absolute)." }),
			offset: Type.Optional(Type.Number({ description: "Line number to start from (1-indexed)." })),
			limit: Type.Optional(
				Type.Number({
					description:
						"Number of lines to return, even past the cap; larger than the file returns the whole file. Without it, the cap applies.",
				}),
			),
		}),
		promptSnippet: meta.promptSnippet,
		promptGuidelines: meta.promptGuidelines,
		renderCall,
		renderResult,
		async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
			const stock = () => (read.execute as any)(toolCallId, params, signal, onUpdate, ctx);
			const p = typeof params?.path === "string" ? params.path : "";
			if (!p) return stock();
			const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
			if (IMAGE_EXTS.has(path.extname(abs).toLowerCase())) return stock();
			let raw: string;
			try {
				raw = await fs.readFile(abs, "utf8");
			} catch {
				// Missing file, permissions, directories: pi's error text, byte-stock.
				return stock();
			}
			if (raw === "") {
				return { content: [{ type: "text", text: "[Read 0 lines, 0 B]" }] };
			}
			const lines = raw.split("\n");
			// A trailing newline is a line ENDING, not an extra empty line.
			if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
			const totalLines = lines.length;
			const totalBytes = Buffer.byteLength(raw, "utf8");
			const start = Number(params?.offset) > 0 ? Math.floor(Number(params.offset)) : 1;
			if (start > totalLines) {
				throw new Error(`Offset ${start} is beyond end of file (${totalLines} lines total)`);
			}
			const startIdx = start - 1;
			const askedLimit = Number(params?.limit) > 0 ? Math.floor(Number(params.limit)) : undefined;
			let endIdx: number;
			if (askedLimit !== undefined) {
				// Honored exactly, clamped to the end of the file. No cap.
				endIdx = Math.min(startIdx + askedLimit, totalLines);
			} else {
				// The default cap, line-aligned: whole lines until either limit.
				endIdx = startIdx;
				let bytes = 0;
				while (endIdx < totalLines && endIdx - startIdx < MAX_LINES) {
					const lb = Buffer.byteLength(lines[endIdx], "utf8") + 1;
					if (bytes + lb > MAX_BYTES) {
						if (endIdx === startIdx) {
							// A single line over the whole budget: pi's recovery
							// contract, wording kept (the recipe teaches itself).
							return {
								content: [
									{
										type: "text",
										text: `[Line ${start} is ${fmtSize(lb - 1)}, exceeds ${fmtSize(MAX_BYTES)} limit. Use bash: sed -n '${start}p' ${p} | head -c ${MAX_BYTES}]`,
									},
								],
							};
						}
						break;
					}
					bytes += lb;
					endIdx++;
				}
			}
			const body = lines.slice(startIdx, endIdx);
			const shownBytes = Buffer.byteLength(body.join("\n"), "utf8");
			const covered = start === 1 && endIdx >= totalLines;
			let metaLine: string;
			if (covered) {
				metaLine = `[Read ${totalLines} lines, ${fmtSize(totalBytes)}]`;
			} else if (endIdx < totalLines) {
				metaLine = `[Read lines ${start}-${endIdx} of ${totalLines} (${fmtSize(shownBytes)} of ${fmtSize(totalBytes)}). Continue with offset=${endIdx + 1}.]`;
			} else {
				metaLine = `[Read lines ${start}-${endIdx} of ${totalLines} (${fmtSize(shownBytes)} of ${fmtSize(totalBytes)}).]`;
			}
			return { content: [{ type: "text", text: `${numbered(body, start)}\n\n${metaLine}` }] };
		},
	} as never;
}

export function register(pi: ExtensionAPI, cwd: string) {
	return reg(pi, build(cwd));
}
