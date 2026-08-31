/**
 * The bottom of the screen: pi's footer, re-coloured, plus the subagent
 * activity strip that renders below it (2026-08-27; above the editor before).
 *
 * Footer content is deliberately at parity with the built-in (path,
 * branch, session, token stats, context %, model, thinking) — only the
 * paint differs. The strip is a separate pi widget but the same visual
 * region, so both live here rather than being split by which API
 * happens to draw them.
 *
 * The strip renders zero lines when nothing is running, and its ticker
 * only fires while a run is live, so an idle session pays nothing.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
// Runtime imports resolve via pi's extension alias map (same as pager.ts).
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { RUN_GLYPHS } from "../glyphs.ts";
import { activeElapsedOf, registry, runsForOwner } from "../../agents/run.ts";
import { runningJobList, runningJobs } from "../../tools/bash-background.ts";
import { fmtSecs } from "../../util/format.ts";
import { BLUE, SUB_FAILED, SUB_OK, shortenHome } from "../../util/paint.ts";
/**
 * The strip's own spinner — the classic ASCII line `|/-\` (maintainer,
 * 2026-08-20), distinct from the tree rows' braille. ASCII, not the
 * box-drawing `─╲│╱`: those glyphs differ in stroke weight per frame (`─`
 * thin, `│` full), which at 120 ms read as a green/dim BLINK rather than a
 * turn (maintainer's screenshot). Its own cadence too — a quarter turn per
 * ~250 ms, half the braille's rate; SPIN_MS drove it too fast.
 */
const STRIP_SPIN = ["|", "/", "-", "\\"];
const STRIP_SPIN_MS = 250;
const stripSpin = () => STRIP_SPIN[Math.floor(Date.now() / STRIP_SPIN_MS) % STRIP_SPIN.length];
import { fmtTokens } from "../../util/format.ts";
import { stripAnsi } from "../../util/ansi.ts";
import { findSettings } from "../../settings.ts";

/**
 * Is auto-compaction on? The footer used to hardcode `true`, so it asserted
 * " (auto)" even for a user who had turned compaction off — pi's own footer
 * reads live state (`setAutoCompactEnabled(session.autoCompactionEnabled)`).
 *
 * There is genuinely no extension API for it: `AgentSession.autoCompactionEnabled`
 * is not reachable from ExtensionContext, ContextUsage carries only
 * tokens/window/percent, and no event announces the flip. But the state is
 * NOT hidden — the getter delegates to `settingsManager.getCompactionEnabled()`,
 * i.e. `compaction.enabled` in settings.json (default true), and the setter
 * calls save(), so the file is authoritative the moment the user toggles it.
 *
 * Cached on a short TTL because this runs on the RENDER PATH, where a
 * per-frame filesystem call is exactly what runsource.ts exists to avoid.
 */
const AUTO_COMPACT_TTL_MS = 3_000;
let autoCompactAt = 0;
let autoCompactCache = true;
function autoCompactEnabled(): boolean {
	const now = Date.now();
	if (autoCompactAt && now - autoCompactAt < AUTO_COMPACT_TTL_MS) return autoCompactCache;
	autoCompactAt = now;
	autoCompactCache =
		findSettings((cfg) => {
			const c = cfg?.compaction as { enabled?: unknown } | undefined;
			return c && typeof c === "object" && typeof c.enabled === "boolean" ? c.enabled : undefined;
		}) ?? true;
	return autoCompactCache;
}

/**
 * Is the current model authenticated by an OAuth subscription login?
 *
 * pi's footer asks `session.modelRuntime.isUsingOAuth(provider)`; the
 * extension's public door to the same answer is `ctx.modelRegistry`, whose
 * `isUsingOAuth(model)` forwards `model.provider` to that runtime — so pass
 * the MODEL, not the provider string. Guarded: this is the render path, and
 * a footer that throws takes its whole line with it.
 */
function isUsingOAuth(ctx: ExtensionContext): boolean {
	try {
		return !!ctx.modelRegistry?.isUsingOAuth?.(ctx.model as never);
	} catch {
		return false;
	}
}

// Width math + slicing come from pi-tui (ANSI- and wide-char-aware);
// only the ellipsis behavior is local.
function truncateToWidth(text: string, width: number, ellipsis: string): string {
	if (visibleWidth(text) <= width) return text;
	return sliceByColumn(text, 0, Math.max(0, width - visibleWidth(ellipsis)), true) + ellipsis;
}

interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

let stripTui: any = null;
/** An /ask in flight (tools/ask.ts): rendered as a strip row in the strip's own style, not a plain status. */
let askProgress: string | undefined;
export function setAskProgress(text?: string): void {
	askProgress = text;
	try {
		stripTui?.requestRender?.();
	} catch {}
}
let stripTimer: ReturnType<typeof setInterval> | null = null;
let ownerSession: string | null = null;

/**
 * Install the re-coloured footer and the subagent activity strip (a pi
 * widget below the editor — different API, same visual region). Called by
 * the orchestrator at session_start while war-dogs is on; pi itself resets
 * footer and widgets before every session switch or reload. Footer reads
 * live ctx on every render, so model / thinking changes need no handler —
 * the next frame picks them up.
 */
export function enable(ctx: ExtensionContext) {
	if (ctx.mode !== "tui") return;
	try {
		ownerSession = (ctx as any)?.sessionManager?.getSessionId?.() ?? null;
	} catch {}
	try {
		// BELOW the footer (maintainer, 2026-08-27; it sat above the editor
		// since 2026-08-20, and between editor and footer before that). pi
		// has no belowFooter widget placement, but the footer is OURS: the
		// strip rows are appended to the footer's own render output, so the
		// pager (which composites the footer) and stock scrollback both get
		// them for free, and the widget with its stacking caveats is gone.
		// Tick only while something is live — a subagent run, a background
		// bash job, or an /ask in flight. When nothing runs the strip is
		// zero rows, so an idle session pays only this predicate.
		stripTimer ??= setInterval(() => {
			let live = runningJobs() > 0 || askProgress !== undefined;
			for (const rec of registry.values()) {
				if (live) break;
				if (rec.run.status === "working" || rec.run.status === "queued") live = true;
			}
			if (live) {
				try {
					stripTui?.requestRender?.();
				} catch {}
			}
		}, STRIP_SPIN_MS);
		(stripTimer as { unref?: () => void }).unref?.();
	} catch {}
	installFooter(ctx);

	function installFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			stripTui = tui;
			const render = (width: number): string[] => {
				// ---- usage totals across all session entries (stock logic) ----
				const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
				let latestCacheHitRate: number | undefined;
				for (const entry of ctx.sessionManager.getEntries()) {
					let usage: UsageLike | undefined;
					if (entry.type === "message") {
						const msg = entry.message as { role?: string; usage?: UsageLike };
						if (msg.role === "assistant" && msg.usage) {
							usage = msg.usage;
							const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
							latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
						} else if (msg.role === "toolResult" && msg.usage) {
							usage = msg.usage;
						}
					} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
						usage = entry.usage as UsageLike;
					}
					if (usage) {
						totals.input += usage.input;
						totals.output += usage.output;
						totals.cacheRead += usage.cacheRead;
						totals.cacheWrite += usage.cacheWrite;
						totals.cost += usage.cost.total;
					}
				}

				// ---- context usage ----
				const contextUsage = ctx.getContextUsage();
				const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const contextPercentValue = contextUsage?.percent ?? 0;
				// pi's test is `!== null` ALONE (footer.js:99): a session that has
				// not reported usage yet reads 0.0%, not "?". The "?" belongs to
				// the one state pi keeps it for — a percent that is explicitly
				// null, i.e. unknown after a compaction.
				const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

				// ---- line 1: path + branch + session name ----
				// pi's own ~ rule (boundary-checked) rather than a prefix match.
				const pwd = shortenHome(ctx.sessionManager.getCwd());
				const branch = footerData?.getGitBranch?.();
				let line1 = theme.fg("dim", pwd);
				if (branch) line1 += theme.fg("dim", " (") + theme.fg("accent", branch) + theme.fg("dim", ")");
				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) line1 += theme.fg("dim", " • ") + theme.fg("muted", sessionName);

				// ---- line 2 left: stats ----
				// Not one flat colour (maintainer's verdict — a uniformly muted
				// line read as "all green"): the traffic numbers (↑↓) sit a
				// tier up from the cache bookkeeping, cost keeps its warning
				// amber, context keeps its traffic-light. Texture, not rainbow.
				const traffic = (s: string) => theme.fg("toolOutput", s);
				const book = (s: string) => theme.fg("dim", s);
				const statsParts: string[] = [];
				if (totals.input) statsParts.push(traffic(`↑${fmtTokens(totals.input)}`));
				if (totals.output) statsParts.push(traffic(`↓${fmtTokens(totals.output)}`));
				if (totals.cacheRead) statsParts.push(book(`R${fmtTokens(totals.cacheRead)}`));
				if (totals.cacheWrite) statsParts.push(book(`W${fmtTokens(totals.cacheWrite)}`));
				if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
					statsParts.push(book(`CH${latestCacheHitRate.toFixed(1)}%`));
				}
				// Kimi Coding is subscription-backed on an API key; every other
				// subscription arrives as an OAuth login, and pi's footer asks the
				// runtime (`isUsingOAuth`) for exactly that. Without the second
				// clause an OAuth account lost BOTH the "(sub)" marker and — at
				// cost 0, which is the normal case on a subscription — the whole
				// cost segment, so the footer no longer said whether this session
				// is billed per token. `ModelRegistry.isUsingOAuth` is public and
				// takes the MODEL (it forwards model.provider to the runtime);
				// guarded because a footer must never throw on the render path.
				const usingSubscription = ctx.model ? ctx.model.provider === "kimi-coding" || isUsingOAuth(ctx) : false;
				if (totals.cost || usingSubscription) {
					statsParts.push(
						theme.fg("warning", `$${totals.cost.toFixed(3)}`) + (usingSubscription ? theme.fg("dim", " (sub)") : ""),
					);
				}
				const autoIndicator = autoCompactEnabled() ? " (auto)" : "";
				const contextDisplay =
					contextPercent === "?"
						? `?/${fmtTokens(contextWindow)}${autoIndicator}`
						: `${contextPercent}%/${fmtTokens(contextWindow)}${autoIndicator}`;
				const contextColor = contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "success";
				statsParts.push(theme.fg(contextColor, contextDisplay));
				// pi's experimental marker (footer.js:149-151). It is the only sign
				// that PI_EXPERIMENTAL=1 changed the agent's behaviour, so a
				// re-skin that drops it hides a live flag.
				if (process.env.PI_EXPERIMENTAL === "1") {
					statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
				}
				const statsLeft = statsParts.join(theme.fg("dim", " "));

				// ---- line 2 right: model + thinking (DEFCON-colored) ----
				const modelName = ctx.model?.id || "no-model";
				let right = theme.fg("accent", modelName);
				if (ctx.model?.reasoning) {
					const level = ctx.thinkingLevel || "off";
					const levelText = level === "off" ? "thinking off" : level;
					// One flat colour, not a per-level one. The level already
					// reads as text; colouring it made the same hue mean
					// "thinking is medium" here and "you are in a subagent"
					// two rows down, and a colour that means two things means
					// neither.
					right += theme.fg("dim", ` • ${levelText}`);
				}
				if ((footerData?.getAvailableProviderCount?.() ?? 0) > 1 && ctx.model) {
					const withProvider = theme.fg("dim", `(${ctx.model.provider}) `) + right;
					if (visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width) right = withProvider;
				}

				// ---- compose stats line with right alignment ----
				let statsLine: string;
				const leftW = visibleWidth(statsLeft);
				const rightW = visibleWidth(right);
				if (leftW + 2 + rightW <= width) {
					statsLine = statsLeft + " ".repeat(width - leftW - rightW) + right;
				} else if (leftW + 2 < width) {
					const avail = width - leftW - 2;
					const truncRight = truncateToWidth(right, avail, "");
					statsLine = statsLeft + " ".repeat(Math.max(1, width - leftW - visibleWidth(truncRight))) + truncRight;
				} else {
					statsLine = truncateToWidth(statsLeft, width, theme.fg("dim", "..."));
				}

				// ---- extension statuses (pi renders ctx.ui.setStatus lines — the
				// MCP adapter's `🔌 MCP: …`, the pager's transient notices) ----
				// RIGHT-ALIGNED ON THE PATH LINE, above the model status, not on a
				// third row of their own (maintainer: the footer took three lines).
				// When path and status cannot share the row (a deep cwd), neither
				// eats the other: the path keeps its line and the status takes the
				// next, still right-aligned. NOT wrapped in dim — the colours are
				// the extensions' own; dimming them all made every status read as
				// one grey run.
				const allStatuses = footerData?.getExtensionStatuses?.();
				// Non-MCP statuses — the pager's transient notices ("Opened link",
				// "Can't open …") — get their OWN line under the stats row
				// (maintainer, 2026-08-20: they crowded the MCP status).
				const noticeLine = allStatuses
					? Array.from(allStatuses.entries())
							.filter(([key]) => key !== "mcp" && key !== "mcp-auth")
							.map(([, text]) => String(text).replace(/\s+/g, " ").trim())
							.filter(Boolean)
							.join("  ")
					: "";
				const statuses = allStatuses
					? new Map(Array.from(allStatuses.entries()).filter(([key]) => key === "mcp" || key === "mcp-auth"))
					: undefined;
				// The MCP adapter's status arrives pre-painted in the accent with a
				// 🔌 in front (`🔌 MCP: 1 server enabled`); the maintainer wants it
				// quiet and glyph-free — the emoji went (also the one thing on this
				// row pi-tui measures wrong, see "Emoji cost one column"), and the
				// text wears `dim`. Only that key is normalised; other extensions'
				// statuses keep their own paint.
				const statusLine =
					statuses && statuses.size > 0
						? Array.from(statuses.entries())
								.sort(([a], [b]) => a.localeCompare(b))
								.map(([key, text]) => {
									const t = String(text).replace(/\s+/g, " ").trim();
									if (key !== "mcp") return t;
									const plain = stripAnsi(t)
										.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D]+\s*/u, "")
										.trim();
									return theme.fg("dim", plain);
								})
								.join(" ")
						: "";
				const lines: string[] = [];
				const l1W = visibleWidth(line1);
				const stW = visibleWidth(statusLine);
				if (statusLine && l1W + 2 + stW <= width) {
					lines.push(line1 + " ".repeat(width - l1W - stW) + statusLine);
				} else {
					lines.push(truncateToWidth(line1, width, theme.fg("dim", "...")));
					if (statusLine) {
						const st = stW > width ? truncateToWidth(statusLine, width, theme.fg("dim", "...")) : statusLine;
						lines.push(" ".repeat(Math.max(0, width - visibleWidth(st))) + st);
					}
				}
				lines.push(statsLine);
				if (noticeLine) lines.push(truncateToWidth(noticeLine, width, theme.fg("dim", "...")));
				// The activity strip, BELOW everything (maintainer, 2026-08-27):
				// agents, background bashes, and an /ask in flight.
				try {
					lines.push(...new StatusStrip(theme, () => ownerSession).render(width));
				} catch {}
				return lines;
			};

			return {
				render,
				invalidate() {},
			};
		});
	}
}

/* ---------------- subagent activity strip ---------------- */

class StatusStrip {
	constructor(
		private theme: any,
		private owner: () => string | null,
	) {}

	invalidate() {}

	render(width: number): string[] {
		// Guarded: this runs inside pi's render loop, where an exception
		// takes down the whole TUI rather than just this widget. The pager
		// guards its own render for the same reason.
		try {
			return this.draw(width);
		} catch {
			return [];
		}
	}

	private draw(width: number): string[] {
		// A null owner means runsForOwner() returns EVERY indexed run — including
		// runs loaded from other sessions' manifests at startup — so the strip
		// would attribute another conversation's subagents to this one. Show
		// nothing instead. The fix is here and NOT "reset ownerSession on
		// teardown": the value is only read while the strip widget is installed,
		// and clearing it on teardown is what would create this state.
		const owner = this.owner();
		if (!owner) return [];
		const runs = runsForOwner(owner);
		const live = runs.filter((r) => r.status === "working" || r.status === "queued");
		const jobs = runningJobList();
		if (!live.length && !jobs.length && !askProgress) return [];
		const out: string[] = [];
		if (live.length) out.push(this.subagentRow(width, runs, live));
		if (askProgress) out.push(this.askRow(width, askProgress));
		// Background bash jobs get their own row under the subagents' (maintainer,
		// 2026-08-20): the delivered result is an act in the transcript, but
		// until it lands nothing on the surface said a job was running at all.
		// Session-scoped, like the jobs themselves (bash-background.ts).
		if (jobs.length) out.push(this.jobRow(width, jobs));
		return out;
	}

	/** The /ask row, same living form as the others: spinner, identity blue head, muted text. */
	private askRow(width: number, text: string): string {
		const t = this.theme;
		const left = `${BLUE(stripSpin())} ${BLUE("?")} ${t.fg("muted", text)}`;
		return truncateToWidth(left, Math.max(0, width), t.fg("dim", "…"));
	}

	private jobRow(width: number, jobs: { id: string; title: string; startedAt: number }[]): string {
		const t = this.theme;
		const now = Date.now();
		const head = `${BLUE(stripSpin())} ${BLUE(String(jobs.length))} ${jobs.length === 1 ? "background bash" : "background bashes"}`;
		const names = jobs
			.slice(0, 3)
			.map((j) => t.fg("muted", j.title) + t.fg("dim", " · ") + t.fg("muted", fmtSecs((now - j.startedAt) / 1000)))
			.join(t.fg("dim", " · "));
		const more = jobs.length > 3 ? t.fg("dim", ` +${jobs.length - 3}`) : "";
		const left = [head, names + more].filter(Boolean).join(t.fg("dim", " · "));
		return truncateToWidth(left, Math.max(0, width), t.fg("dim", "…"));
	}

	private subagentRow(
		width: number,
		runs: ReturnType<typeof runsForOwner>,
		live: ReturnType<typeof runsForOwner>,
	): string {
		const t = this.theme;
		const done = runs.filter((r) => r.status === "idle").length;
		const failed = runs.filter((r) => r.status === "error" || r.status === "stopped").length;
		// Identity blue on the strip's live parts: the strip IS the subagent
		// surface, and blue is the constant identity hue across themes.
		const head = `${BLUE(stripSpin())} ${BLUE(String(live.length))} ${live.length === 1 ? "agent" : "agents"}`;
		const names = live
			.slice(0, 3)
			.map((r) => t.fg("muted", `${r.agent} ${activeElapsedOf(r)}`))
			.join(t.fg("dim", " · "));
		const more = live.length > 3 ? t.fg("dim", ` +${live.length - 3}`) : "";
		const tally = [
			done ? SUB_OK(`${RUN_GLYPHS.idle}${done}`) : "",
			failed ? SUB_FAILED(`${RUN_GLYPHS.error}${failed}`) : "",
		]
			.filter(Boolean)
			.join(" ");
		let left = [head, names + more, tally].filter(Boolean).join(t.fg("dim", " · "));
		const hint = t.fg("dim", "alt+s");
		const ellipsis = t.fg("dim", "…");
		// The strip rides the footer's own rows now, but the rule stands: an
		// over-wide row gets a hard cut at the pane edge that takes the alt+s
		// affordance with it (three long agent names measured 141 columns at
		// every width). Truncate here instead, reserving the hint's columns
		// first, so the cut is ours and marked.
		// visibleWidth is ANSI- and wide-char-aware, so an agent name carrying
		// a wide glyph aligns correctly where a raw .length would drift.
		const room = width - visibleWidth(hint) - 4;
		if (room > 0) {
			left = truncateToWidth(left, room, ellipsis);
			// Right-align the hint when there is room; drop it when there isn't.
			const pad = width - visibleWidth(left) - 6;
			if (pad > 2) return `${left}${" ".repeat(pad)}${hint}`;
		}
		return truncateToWidth(left, Math.max(0, width), ellipsis);
	}
}
