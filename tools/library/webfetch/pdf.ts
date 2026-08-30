/**
 * PDF text extraction — poppler (`pdftotext -layout`), which preserves columns
 * and table alignment far better than a naive stream dump. That matters for the
 * sources this is aimed at: filings, papers, reports. `pdfinfo` supplies page
 * count and title.
 *
 * The browser fetches the bytes (real fingerprint, handles walled PDFs); this
 * turns them into structured text. Synchronous shell-outs on a temp file —
 * simple and robust; the file is always cleaned up.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A MEMORY bound, not a reading limit (truncate.ts owns that, and reports it).
 * At 200_000 a long filing was silently cut and the caller then advertised the
 * capped text as the whole document. When this fires now it is reported.
 */
const MAX_CHARS = 5_000_000;

export interface PdfResult {
	text: string;
	pages: number;
	title?: string;
	truncated: boolean;
	/** Characters pdftotext produced, BEFORE the cap above. */
	extractedChars: number;
}

export function extractPdf(bytes: Buffer): PdfResult {
	const dir = mkdtempSync(join(tmpdir(), "bwf-pdf-"));
	const file = join(dir, "in.pdf");
	try {
		writeFileSync(file, bytes);

		// Metadata: pages + title.
		let pages = 0;
		let title: string | undefined;
		const info = spawnSync("pdfinfo", [file], { encoding: "utf8", timeout: 15_000 });
		if (info.status === 0) {
			for (const l of info.stdout.split("\n")) {
				const mp = l.match(/^Pages:\s+(\d+)/);
				if (mp) pages = Number(mp[1]);
				const mt = l.match(/^Title:\s+(.+)$/);
				if (mt && mt[1].trim()) title = mt[1].trim();
			}
		}

		// Text, layout-preserving. `-q` silences warnings; `-` writes to stdout.
		const out = spawnSync("pdftotext", ["-layout", "-q", file, "-"], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			timeout: 60_000,
		});
		let text = out.status === 0 ? out.stdout : "";
		// pdftotext separates pages with a form-feed; make it a visible page break,
		// and trim trailing spaces poppler leaves from column padding.
		text = text
			.replace(/\f/g, "\n\n----- page break -----\n\n")
			.replace(/[ \t]+\n/g, "\n")
			.trim();

		const extractedChars = text.length;
		const truncated = extractedChars > MAX_CHARS;
		if (truncated) {
			text = text.slice(0, MAX_CHARS);
			const nl = text.lastIndexOf("\n");
			if (nl > MAX_CHARS * 0.9) text = text.slice(0, nl);
			text += `\n\n… [PDF text capped at ${MAX_CHARS} characters; this document produced ${extractedChars}. The remainder was NOT extracted.]`;
		}
		return { text, pages, title, truncated, extractedChars };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
