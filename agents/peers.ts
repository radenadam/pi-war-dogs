/**
 * PEERS: other pi sessions on this machine, addressable by session id
 * (the agent contract, dev/internals/README.md; shipped 2026-08-24).
 *
 * The shape chosen (the peers ledger in dev/internals/README.md): REGISTRY
 * IN FILES, TRANSPORT OVER A SOCKET. Every live tui/rpc session with
 * war-dogs on writes `<agentDir>/peers/<sessionId>.json` (id, pid,
 * socket path, cwd, name) and listens on a per-session Unix socket
 * (a named pipe on Windows); discovery is reading the directory, and a
 * stale entry is a dead pid or a failed connect, never a heartbeat.
 * Delivery into the receiving conversation uses the SAME rule as every
 * delivery: at its next tool boundary mid-turn, as a new turn when idle
 * (tools/delivery.ts). v1 is live-sessions-only — no on-disk inbox; a
 * message to a gone session is refused in one honest line.
 *
 * Storm control is not optional (the research's Claude Code finding:
 * bursts reported sent while dropped): a per-sender rate limit and an
 * identical-repeat dedupe answer with the truth instead of dropping.
 *
 * Frames are NDJSON, one request line, one response line:
 *   {type:"message", from, text}   -> {ok, delivered?, reason?}
 *   {type:"ask", from, question}   -> {ok, answer?, reason?}
 *   {type:"status"}                -> {ok, state, name?, cwd, lastText?}
 * `from` = {session, name?, cwd, by: "agent" | "user"}.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { features } from "../settings.ts";
import { agentDir } from "./run.ts";
import { askWrapper, completeWithRetry } from "./ask.ts";
import { getModelRegistry, piAiCompat, sharedModelRuntime } from "./session.ts";
import { appendStamp } from "../util/stamp.ts";
import { sendDelivery } from "../tools/delivery.ts";

export interface PeerEntry {
	sessionId: string;
	pid: number;
	socketPath: string;
	cwd: string;
	name?: string;
	startedAt: number;
}

export interface PeerFrom {
	session: string;
	name?: string;
	cwd?: string;
	by: "agent" | "user";
	/** The asker is THIS session's own user (the /ask command, no hop). */
	local?: boolean;
	/** A CHILD of the receiving session is the sender (2026-08-28, A14): named, so the reply path is its id and the rate limit is its own. */
	agent?: string;
}

function peersDir(): string {
	return path.join(agentDir(), "peers");
}

function socketPathFor(sessionId: string): string {
	const short = sessionId.replace(/-/g, "").slice(0, 12);
	if (process.platform === "win32") return `\\\\.\\pipe\\wd-agent-${short}`;
	// Socket paths cap at ~104 bytes; a short 0700 dir keeps us well inside
	// it and same-user by filesystem permission. $XDG_RUNTIME_DIR first (the
	// OS's own per-user 0700 dir), tmp otherwise — and the dir is VERIFIED
	// (2026-08-28, the stress report's A13): a pre-created world-writable
	// `/tmp/wd-peers-<uid>/` let any local user connect and ask the session's
	// model over its whole transcript. Not ours by owner or mode: refuse,
	// and enablePeers says so once.
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const runtime = process.env.XDG_RUNTIME_DIR;
	const base = runtime && fs.existsSync(runtime) ? runtime : os.tmpdir();
	const dir = path.join(base, `wd-peers-${uid}`);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const st = fs.lstatSync(dir);
	if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o777) !== 0o700)
		throw new Error(
			`${dir} is not a private directory of this user (owner ${st.uid}, mode ${(st.mode & 0o777).toString(8)})`,
		);
	return path.join(dir, `${short}.sock`);
}

/* ---------------- this session's registration ---------------- */

let server: net.Server | undefined;
let ownId: string | undefined;
let ownEntryFile: string | undefined;
let livePi: ExtensionAPI | undefined;
let liveCtx: any;

export function ownSessionId(): string | undefined {
	return ownId;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/** Delivery guard state, per sender. */
const lastFrom = new Map<string, { at: number; text: string }>();
const RATE_MS = 1_500;
const DEDUPE_MS = 30_000;
const MAX_TEXT = 200_000;

function fromLabel(from: PeerFrom | undefined): string {
	if (from?.local) return "your user";
	if (from?.agent) return `${from.agent}, an agent of this session`;
	const id = from?.session ? `session_${from.session}` : "an unknown session";
	const who = from?.by === "user" ? "typed by its user" : "from its agent";
	const name = from?.name ? ` ("${from.name}")` : from?.cwd ? ` (${from.cwd})` : "";
	return `${id}${name}; ${who}`;
}

async function handleFrame(frame: any): Promise<Record<string, unknown>> {
	if (!livePi || !liveCtx) return { ok: false, reason: "this session is not receiving" };
	if (frame?.type === "status") {
		let lastText = "";
		let lastStop = "";
		try {
			// pi's own context (2026-08-28, A8): the fold and the branch applied,
			// never an abandoned branch's or pre-fold text.
			const msgs = liveCtx.sessionManager?.buildSessionContext?.()?.messages ?? [];
			// The OUTCOME belongs to the last assistant message, the text to
			// the last one that actually said something — the same discipline
			// as lastAssistantOutcome (agents/session.ts): an interrupted or
			// errored turn may carry no text at all, and reporting only the
			// text made a peer's interruption invisible to whoever waited on
			// it (maintainer, 2026-08-24).
			for (let i = msgs.length - 1; i >= 0; i--) {
				const e = { message: msgs[i] };
				if (e.message?.role !== "assistant") continue;
				if (!lastStop && e.message.stopReason) lastStop = String(e.message.stopReason);
				const t = (e.message.content ?? [])
					.filter((b: any) => b?.type === "text")
					.map((b: any) => String(b.text ?? ""))
					.join("\n")
					.trim();
				if (t) {
					lastText = t.slice(0, 600);
					break;
				}
			}
		} catch {}
		let working = false;
		try {
			working = liveCtx.isIdle ? !liveCtx.isIdle() : false;
		} catch {}
		// The registry entry carries the name this session had at
		// session_start; a /name after that reached nobody (2026-08-29: a
		// peer named "peer-b" listed by its cwd). Every status frame — list
		// and wait send one — re-syncs the entry, so the next label is right.
		const name = liveCtx.sessionManager?.getSessionName?.() ?? undefined;
		syncOwnEntry(name);
		return {
			ok: true,
			state: working ? "working" : "idle",
			name,
			cwd: process.cwd(),
			lastText,
			lastStop,
		};
	}
	if (frame?.type === "message") {
		const text = String(frame.text ?? "");
		if (!text.trim()) return { ok: false, reason: "empty message" };
		// Refused, never silently sliced (2026-08-28, A16): every other cap
		// in this tool states itself, and a sender can act on a reason.
		if (text.length > MAX_TEXT)
			return { ok: false, reason: `message too long: ${text.length} characters; the limit is ${MAX_TEXT}` };
		const key = String(frame.from?.agent ?? frame.from?.session ?? "?");
		const prev = lastFrom.get(key);
		const now = Date.now();
		if (prev && now - prev.at < RATE_MS) return { ok: false, reason: `rate-limited; resend in ${RATE_MS}ms` };
		if (prev && prev.text === text && now - prev.at < DEDUPE_MS)
			return { ok: false, reason: "duplicate of a message already delivered; not delivered again" };
		lastFrom.set(key, { at: now, text });
		// A conversation message, not a job result: delivered directly with
		// the same rule as every delivery (steer at the next tool boundary,
		// a new turn when idle), never through the background-results batch
		// queue, whose "N jobs" shape would strip the attribution.
		try {
			// The delivery-turn rule (tools/delivery.ts sendDelivery): a user
			// message through the hook when idle, a steering custom message
			// mid-turn.
			sendDelivery(livePi, {
				customType: "peer-message",
				content: appendStamp(
					// The reply path is TAUGHT in the provenance (2026-08-27,
					// the exchange ruling): the receiver should not have to
					// derive how to answer. Pretty display trims the clause
					// (visual/tools/subagent.ts parsePeerMessage).
					`[message from ${fromLabel(frame.from)}${frame.from?.agent ? `; reply by messaging ${frame.from.agent}` : frame.from?.session ? `; reply by messaging session_${frame.from.session}` : ""}]\n\n${text}`,
				),
				display: true,
				details: { peer: frame.from?.session, by: frame.from?.by },
			});
		} catch (e) {
			return { ok: false, reason: `delivery failed: ${String((e as Error)?.message ?? e)}` };
		}
		return { ok: true, delivered: true };
	}
	if (frame?.type === "ask") {
		const question = String(frame.question ?? "").trim();
		if (!question) return { ok: false, reason: "empty question" };
		try {
			const compat = await piAiCompat();
			const model = liveCtx.model;
			if (!model) return { ok: false, reason: "no model to answer with" };
			const runtime = sharedModelRuntime(getModelRegistry()) as any;
			const auth = await runtime?.getAuth?.(model).catch?.(() => undefined);
			// pi's own context, converted (A8): the fold's summary reaches the
			// model as the user message pi would send, not as a skipped role.
			const messages: any[] = convertToLlm((liveCtx.sessionManager?.buildSessionContext?.()?.messages ?? []) as never);
			let systemPrompt: string | undefined;
			try {
				systemPrompt = liveCtx.getSystemPrompt?.();
			} catch {}
			const wrapper = askWrapper(fromLabel(frame.from));
			const answerMsg = await completeWithRetry(
				compat,
				model,
				{
					...(systemPrompt ? { systemPrompt } : {}),
					messages: [
						...messages,
						{ role: "user", content: [{ type: "text", text: `${wrapper}\n\n${question}` }], timestamp: Date.now() },
					],
					tools: [],
				},
				{
					...(auth?.auth?.apiKey ? { apiKey: auth.auth.apiKey } : {}),
					...(auth?.auth?.headers ? { headers: auth.auth.headers } : {}),
				},
			);
			if (answerMsg?.stopReason === "error")
				return { ok: false, reason: answerMsg?.errorMessage ?? "the model provider returned an error" };
			const answer = (answerMsg?.content ?? [])
				.filter((b: any) => b?.type === "text")
				.map((b: any) => String(b.text ?? ""))
				.join("\n")
				.trim();
			return { ok: true, answer };
		} catch (e) {
			return { ok: false, reason: String((e as Error)?.message ?? e) };
		}
	}
	return { ok: false, reason: `unknown frame type "${String(frame?.type ?? "")}"` };
}

/**
 * Register this session as a peer: the socket server, then the registry
 * file naming it. Called from activate() (tui/rpc only); idempotent per
 * session id; a previous registration is closed first (the factory
 * re-runs on /new, /fork, /resume with the module state intact).
 */
export function enablePeers(pi: ExtensionAPI, ctx: any): void {
	// The feature key (2026-08-25): off = this session neither registers
	// nor listens. listPeers below is gated too, so it does not reach out
	// either — off is off in both directions.
	if (!peersFeatureOn()) {
		disablePeers();
		return;
	}
	const sid = String(ctx?.sessionManager?.getSessionId?.() ?? "");
	if (!sid) return;
	disablePeers();
	livePi = pi;
	liveCtx = ctx;
	ownId = sid;
	let sock: string;
	try {
		sock = socketPathFor(sid);
	} catch (e) {
		console.error(`[war-dogs] peers: ${String((e as Error)?.message ?? e)} — peers disabled for this session.`);
		return;
	}
	try {
		if (process.platform !== "win32" && fs.existsSync(sock)) fs.unlinkSync(sock);
	} catch {}
	server = net.createServer((conn) => {
		let buf = "";
		conn.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			void (async () => {
				let res: Record<string, unknown>;
				try {
					res = await handleFrame(JSON.parse(line));
				} catch (e) {
					res = { ok: false, reason: String((e as Error)?.message ?? e) };
				}
				try {
					conn.end(JSON.stringify(res) + "\n");
				} catch {}
			})();
		});
		conn.on("error", () => {});
	});
	server.on("error", () => {});
	try {
		server.listen(sock);
		if (process.platform !== "win32") fs.chmodSync(sock, 0o600);
	} catch {
		server = undefined;
		return;
	}
	try {
		fs.mkdirSync(peersDir(), { recursive: true });
		// Sweep dead entries while we are here (discovery stays clean).
		for (const f of fs.readdirSync(peersDir())) {
			try {
				const e = JSON.parse(fs.readFileSync(path.join(peersDir(), f), "utf8")) as PeerEntry;
				if (!pidAlive(e.pid)) fs.unlinkSync(path.join(peersDir(), f));
			} catch {}
		}
		ownEntryFile = path.join(peersDir(), `${sid}.json`);
		const entry: PeerEntry = {
			sessionId: sid,
			pid: process.pid,
			socketPath: sock,
			cwd: process.cwd(),
			name: ctx?.sessionManager?.getSessionName?.() ?? undefined,
			startedAt: Date.now(),
		};
		fs.writeFileSync(ownEntryFile, JSON.stringify(entry));
	} catch {}
}

/** Rewrite this session's registry entry when its name changed (a /name after boot). */
function syncOwnEntry(name: string | undefined): void {
	if (!ownEntryFile) return;
	try {
		const e = JSON.parse(fs.readFileSync(ownEntryFile, "utf8")) as PeerEntry;
		if ((e.name ?? undefined) === (name ?? undefined)) return;
		e.name = name;
		fs.writeFileSync(ownEntryFile, JSON.stringify(e));
	} catch {}
}

/** Close the socket and remove the registry entry. Safe to call twice. */
export function disablePeers(): void {
	try {
		server?.close();
	} catch {}
	server = undefined;
	if (ownEntryFile) {
		try {
			fs.unlinkSync(ownEntryFile);
		} catch {}
	}
	ownEntryFile = undefined;
	ownId = undefined;
	livePi = undefined;
	liveCtx = undefined;
}

/**
 * The local frame path: a CHILD (same process) messaging or asking the
 * session that owns it goes straight to the handler, no socket.
 */
export async function localPeerFrame(frame: Record<string, unknown>): Promise<any> {
	return handleFrame(frame);
}

/* ---------------- the client side ---------------- */

/** Whether the peers feature is on (settings `war-dogs.peers`, default true). */
function peersFeatureOn(): boolean {
	try {
		return features().peers;
	} catch {
		return true;
	}
}

/** Live peers from the registry, this session excluded, dead pids swept. */
export function listPeers(): PeerEntry[] {
	if (!peersFeatureOn()) return [];
	const out: PeerEntry[] = [];
	try {
		for (const f of fs.readdirSync(peersDir())) {
			try {
				const e = JSON.parse(fs.readFileSync(path.join(peersDir(), f), "utf8")) as PeerEntry;
				if (e.sessionId === ownId) continue;
				if (!pidAlive(e.pid)) {
					try {
						fs.unlinkSync(path.join(peersDir(), f));
					} catch {}
					continue;
				}
				out.push(e);
			} catch {}
		}
	} catch {}
	return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** Resolve a session id (full, `session_` prefixed, or a ≥8-char fragment). */
export function findPeer(id: string): PeerEntry | undefined {
	const bare = id.replace(/^session_/, "");
	const all = listPeers();
	const own = ownId ? [{ sessionId: ownId } as PeerEntry] : [];
	const exact = all.find((p) => p.sessionId === bare);
	if (exact) return exact;
	if (bare.length < 8) return undefined;
	const cands = [...all, ...own].filter((p) => p.sessionId.includes(bare));
	return cands.length === 1 && cands[0].sessionId !== ownId ? (cands[0] as PeerEntry) : undefined;
}

/** One request frame, one response line, bounded. */
export function sendToPeer(entry: PeerEntry, frame: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
	return new Promise((resolve, reject) => {
		const conn = net.connect(entry.socketPath);
		let buf = "";
		let done = false;
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				conn.destroy();
			} catch {}
			fn();
		};
		const timer = setTimeout(
			() => finish(() => reject(new Error(`session_${entry.sessionId} did not answer within ${timeoutMs / 1000}s`))),
			timeoutMs,
		);
		(timer as { unref?: () => void }).unref?.();
		conn.on("connect", () => conn.write(JSON.stringify(frame) + "\n"));
		conn.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			try {
				const res = JSON.parse(buf.slice(0, nl));
				finish(() => resolve(res));
			} catch (e) {
				finish(() => reject(e as Error));
			}
		});
		conn.on("error", () => finish(() => reject(new Error(`session_${entry.sessionId} is no longer running`))));
	});
}
