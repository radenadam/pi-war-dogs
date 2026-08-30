/**
 * `/canvas` — the user-side serve of `<cwd>/canvas/` (dev/internals/README.md
 * draft 6). Files by default, network only when ASKED: production is the
 * model's ordinary `write`, the model never touches networking, and this
 * command is the one consent gate — typing it is the opt-in, and its own
 * output NAMES the exposure (every device on the network can read every
 * canvas while it runs). The server dies with pi, and a `/reload` closes it
 * too — `/war-dogs off` reaches off THROUGH a reload, so an off boot never
 * inherits a running server (off = stock). The port is STABLE, derived from
 * the canvas path, so bookmarks survive restarts; `war-dogs.canvas.port`
 * overrides. GET/HEAD only; path traversal and symlink escapes are refused
 * by realpath containment; the index page lists the folder.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { warDogsBlock } from "../settings.ts";

let server: http.Server | null = null;
let serverPort = 0;
let serverRoot = "";

/** Stable port from the canvas path: bookmarks survive restarts (contract). */
function derivedPort(root: string): number {
	let h = 0;
	for (const ch of root) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return 41000 + (h % 4000);
}

/** Non-internal IPv4 addresses — when the user asks to serve, reaching a phone is the point. */
function lanAddresses(): string[] {
	const out: string[] = [];
	try {
		for (const list of Object.values(os.networkInterfaces())) {
			for (const it of list ?? []) {
				if (it.family === "IPv4" && !it.internal) out.push(it.address);
			}
		}
	} catch {}
	return out;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".svg": "image/svg+xml",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".md": "text/plain; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The directory index: plain, self-contained, lists the folder (contract). */
function indexPage(root: string, rel: string, entries: fs.Dirent[]): string {
	const rows = entries
		.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
		.map((e) => {
			let size = "";
			try {
				if (!e.isDirectory())
					size = `${Math.max(1, Math.round(fs.statSync(path.join(root, rel, e.name)).size / 1024))} KB`;
			} catch {}
			const href = `${encodeURIComponent(e.name)}${e.isDirectory() ? "/" : ""}`;
			return `<li><a href="${href}">${esc(e.name)}${e.isDirectory() ? "/" : ""}</a> <small>${size}</small></li>`;
		})
		.join("\n");
	return `<!doctype html><meta charset="utf-8"><title>canvas${esc(rel ? `/${rel}` : "")}</title><body style="font-family:sans-serif;max-width:40em;margin:2em auto"><h1 style="font-size:1.2em">canvas${esc(rel ? `/${rel}` : "")}</h1><ul>${rows || "<li><em>empty</em></li>"}</ul></body>`;
}

function handle(root: string, req: http.IncomingMessage, res: http.ServerResponse): void {
	const deny = (code: number, text: string) => {
		res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
		res.end(text);
	};
	try {
		if (req.method !== "GET" && req.method !== "HEAD") return deny(405, "GET only");
		const pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
		const target = path.resolve(root, `.${path.posix.normalize(`/${pathname}`)}`);
		// Containment TWICE: the resolved path, and its realpath (a symlink
		// inside canvas/ must not read files outside it).
		if (target !== root && !target.startsWith(root + path.sep)) return deny(403, "outside canvas/");
		if (!fs.existsSync(target)) {
			return target === root
				? deny(404, "canvas/ does not exist yet — the model creates it with its first deliverable")
				: deny(404, "not found");
		}
		const real = fs.realpathSync(target);
		const realRoot = fs.realpathSync(root);
		if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return deny(403, "outside canvas/");
		const st = fs.statSync(real);
		if (st.isDirectory()) {
			const rel = path.relative(root, target);
			const body = indexPage(root, rel, fs.readdirSync(real, { withFileTypes: true }));
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			return void res.end(req.method === "HEAD" ? undefined : body);
		}
		res.writeHead(200, {
			"content-type": MIME[path.extname(real).toLowerCase()] ?? "application/octet-stream",
			"content-length": String(st.size),
		});
		if (req.method === "HEAD") return void res.end();
		fs.createReadStream(real).pipe(res);
	} catch (e) {
		deny(500, String((e as Error)?.message ?? e));
	}
}

function startServer(root: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const s = http.createServer((req, res) => handle(root, req, res));
		s.once("error", (e) => reject(e));
		s.listen(port, "0.0.0.0", () => {
			server = s;
			serverPort = port;
			serverRoot = root;
			resolve();
		});
	});
}

function closeServer(): void {
	try {
		server?.close();
	} catch {}
	server = null;
}

function urls(): string {
	const lans = lanAddresses().map((ip) => `http://${ip}:${serverPort}/`);
	return `http://localhost:${serverPort}/${lans.length ? ` and ${lans.join(", ")}` : ""}`;
}

export function registerCanvasCommand(pi: ExtensionAPI): void {
	pi.registerCommand("canvas", {
		description: "Serve this project's canvas/ over HTTP — for your browser and other devices (LAN-visible, on demand)",
		handler: async (_args, ctx) => {
			const root = path.join(process.cwd(), "canvas");
			if (server) {
				ctx.ui.notify(`canvas already serving ${serverRoot} at ${urls()}`, "info");
				return;
			}
			const cfg = Number((warDogsBlock().canvas as Record<string, unknown> | undefined)?.port);
			const port = Number.isFinite(cfg) && cfg > 0 ? Math.floor(cfg) : derivedPort(root);
			try {
				await startServer(root, port);
			} catch (e) {
				const code = (e as NodeJS.ErrnoException)?.code;
				ctx.ui.notify(
					`/canvas: ${String((e as Error)?.message ?? e)}${
						code === "EADDRINUSE"
							? ` — port ${port} is taken (another session serving this project?); set war-dogs.canvas.port to override.`
							: ""
					}`,
					"warning",
				);
				return;
			}
			// The exposure is NAMED in the command's own output (the contract's
			// safety ruling): the user typed the command, and this line is what
			// they consented to.
			ctx.ui.notify(
				`canvas/ serving at ${urls()} — every device on your network can read everything under ${root} while this pi runs.`,
				"info",
			);
		},
	});
	// `/war-dogs off` reaches off through a reload; a server surviving it
	// would be an off≠stock residual (module state outlives the runner).
	// Quit closes it too — tidy, though process exit would end it anyway.
	pi.on("session_shutdown", async (e) => {
		const reason = (e as { reason?: string } | undefined)?.reason;
		if (reason === "reload" || reason === "quit") closeServer();
	});
}
