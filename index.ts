/**
 * war-dogs — a pi customisation: subagents, a full-screen pager, extra
 * tools and a re-skinned HUD.
 *
 * INSTALL: copy this folder to ~/.pi/agent/extensions/ . That is all.
 * The theme ships inside it and registers itself.
 *
 * LAYOUT — the dependency arrow points ONE way:
 *
 *   util/     pure helpers, no pi knowledge
 *   agents/   the subagent RUNTIME. never imports visual/
 *   tools/    what the MODEL can call: schema + execute
 *   visual/   what you SEE: tool renderers, the pager, the HUD
 *
 * The rule that keeps it legible: `tools/` is what a tool DOES,
 * `visual/tools/` is what it LOOKS LIKE. Every tool obeys it, including
 * the built-in read/edit/bash overrides — appearance plus exactly three
 * model-facing changes (bash's `description` argument, bash's `background`
 * mode, edit's batch-error wording; dev/internals/README.md load-bearing).
 *
 * MASTER SWITCH: war-dogs is all-or-nothing and SETTINGS-ONLY (see mode.ts).
 * This file is the orchestrator: when `war-dogs.enabled` is true at load it
 * registers every surface (`installOnce`) and activates the HUD/pager/MCP at
 * session_start; when false it registers NOTHING, so off is stock pi in fact.
 * `/war-dogs [on|off]` writes the setting and reloads — every state is a boot
 * state — and is refused while any work is in flight.
 *
 * Each feature is registered inside its own try/catch so one failure cannot
 * take down the rest, and each can be dropped from the bundle via
 * settings.json (see settings.ts).
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setChildToolFactory, setContinueNotice, setModelRegistry } from "./agents/session.ts";
import { abortCause, loadKnownRuns, registry, settle, setOwnerSession } from "./agents/run.ts";
import { features, setProjectTrusted, unconsentedProjectResources, warDogsBlock } from "./settings.ts";
import {
	bootEnabled,
	busyState,
	ensureThemeLoader,
	installThemes,
	setCompacting,
	writeEnabledSetting,
	envEnabledOverride,
	piVersionWarning,
} from "./mode.ts";
import { childAgentTool, makeAgentTool, setMainContextSource, setSchemaEnums } from "./tools/agent.ts";
import { armRedelivery, clearDeliveries, flushDeliveries, setIdleSource } from "./tools/delivery.ts";
import { registerAskCommand } from "./tools/ask.ts";
import { disablePeers, enablePeers } from "./agents/peers.ts";
import { renderResultMessage as renderAgentResultMessage, renderPeerMessage } from "./visual/tools/subagent.ts";
import { renderBatchResultMessage } from "./visual/tools/bash.ts";
import type { SchemaEnums } from "./tools/agent.ts";
import { loadAgents, reportAgentDiagnostics } from "./agents/config.ts";
import {
	childToolNames,
	decideShells,
	mainShells,
	setChildExtraTools,
	setChildExtraToolsSource,
	setMainShells,
} from "./agents/childtools.ts";
import { runningJobs } from "./tools/bash-background.ts";
import { noticeForMain, noticeForRun } from "./tools/interrupted.ts";
import webfetchTool from "./tools/webfetch.ts";
import websearchTool from "./tools/websearch.ts";
import * as attachments from "./tools/attachments.ts";
import * as bashTool from "./tools/bash.ts";
import * as powershellTool from "./tools/powershell.ts";
import * as editTool from "./tools/edit.ts";
import * as readTool from "./tools/read.ts";
import * as writeTool from "./tools/write.ts";
import * as banner from "./visual/hud/banner.ts";
import * as footer from "./visual/hud/footer.ts";
import * as loader from "./visual/hud/loader.ts";
import * as pager from "./visual/pager/mod.ts";
import { registerToolDef } from "./visual/pager/toolmap.ts";
import { appendStamp, stampLine, withStamp } from "./util/stamp.ts";
import { registerPrompt } from "./prompt/index.ts";
import { performUndo, registerUndo } from "./tools/undo.ts";
import { registerInject } from "./prompt/inject.ts";
import { registerCanvasCommand } from "./tools/canvas.ts";
import * as mcp from "./mcp/index.ts";
import * as path from "node:path";

/**
 * The custom tools that don't exist in stock pi (absent while off: never
 * registered). The bundled MCP adapter's tools (`mcp`, `mcpScript`, and the
 * per-server direct tools that appear after its async init) join this set
 * dynamically through mcp/index.ts, which records every name the adapter
 * registers.
 */
const WAR_DOGS_TOOLS = ["agent", "webfetch", "kimi-websearch"];

/**
 * Upper bound on how long shutdown waits for one child to unwind. Bounded
 * rather than open-ended: a wedged child must not stop pi from exiting.
 * The timer is CANCELLED once the race is decided — left pending it holds
 * the event loop for the rest of its two seconds after the child has
 * already settled, which is quit latency for nothing (it is not unref'd,
 * because while the race is live the timer is the thing capping the wait).
 */
const SHUTDOWN_GRACE_MS = 2_000;
const grace = () => {
	let timer: ReturnType<typeof setTimeout>;
	const promise = new Promise<void>((resolve) => (timer = setTimeout(resolve, SHUTDOWN_GRACE_MS)));
	return { promise, cancel: () => clearTimeout(timer) };
};

export default async function (pi: ExtensionAPI) {
	const on = features();
	const cwd = process.cwd();

	const safe = (name: string, fn: () => void) => {
		try {
			fn();
		} catch (e) {
			console.error(`[war-dogs] ${name} failed to load:`, e);
		}
	};

	// Whether the registration has run for this factory run. war-dogs registers
	// NOTHING that touches the screen, the model or the slash list unless it is
	// ON at load: pi cannot unregister, so the only way `off` is byte-for-byte
	// stock is to never have registered. A boot with war-dogs off therefore
	// makes ZERO such calls — the extension is inert. (pi re-runs this factory
	// on /new, /fork and /resume against a fresh Extension object, so the flag
	// is per run, not per process.)
	let installed = false;

	/**
	 * Register every war-dogs surface — tools, renderers, pager, HUD, MCP,
	 * attachments, and the theme files (for /settings pickability). Called
	 * once per factory run, at load, only when war-dogs is on; activate()
	 * then turns on what this registered once pi's session exists.
	 */
	const installOnce = async () => {
		if (installed) return;
		installed = true;
		// The version guard: one stderr line when pi is outside the tested
		// range (mode.ts). Only when ON — a boot-off prints nothing, so off
		// stays stock on stderr too.
		try {
			const warn = piVersionWarning();
			if (warn) console.error(warn);
		} catch {}
		if (on.theme) {
			await ensureThemeLoader();
			// Copy the theme files into pi's dir so they are pickable via
			// /settings while on (non-destructive; nothing deleted — mode.ts).
			installThemes();
		}
		// agents/ cannot import tools/ (a cycle), so the child subagent tool is
		// injected here instead.
		setChildToolFactory((rec) => childAgentTool(rec));
		// A run continued after its agents died with a session end reads the
		// notice ahead of its turn (2026-08-29; main has had this since 08-28).
		setContinueNotice((runId) => noticeForRun(runId));
		// The shell answer first: the agent tool's session_start handler bakes
		// its `tools` enum from it (agents/childtools.ts decideShells).
		setMainShells(decideShells().shells);
		if (on.subagent) safe("agent", () => registerAgentTool(pi));
		// /ask and /ask! — the user's out-of-band question (tools/ask.ts).
		if (on.subagent) safe("ask", () => registerAskCommand(pi));
		if (on.tools) safe("tools", () => registerTools(pi));
		// The inherent system prompt + session brief (prompt/): the base swap
		// and the first-turn brief ride before_agent_start; a user SYSTEM.md
		// stands both down. installOnce-only, so a boot-off never touches the
		// prompt (prompt parity is the proof).
		if (on.prompt) safe("prompt", () => registerPrompt(pi));
		// The user's injected messages (prompt/inject.ts): inject/SESSION_START.md
		// once per session and inject/PER_TURN.md every turn, global and
		// trusted-project, verbatim; four before_agent_start handlers, one
		// message each, registered AFTER the prompt's so the brief lands first.
		if (on.inject) safe("inject", () => registerInject(pi));
		// /canvas — the user-side serve of <cwd>/canvas/ (tools/canvas.ts).
		if (on.canvas) safe("canvas", () => registerCanvasCommand(pi));
		if (on.toolRenderers)
			safe("tool renderers", () => {
				// The four skins of pi's built-ins; into the toolmap too, so a
				// subagent transcript renders them with the real renderers.
				const skins: ToolDefinition<any, any, any>[] = [
					readTool.register(pi, cwd),
					editTool.register(pi, cwd),
					writeTool.register(pi, cwd),
					bashTool.register(pi, cwd),
					powershellTool.register(pi, cwd),
				];
				for (const d of skins) registerToolDef(d);
				// Children get the skins (2026-08-22; read since 2026-08-21),
				// built for the CHILD's cwd at build time and stamped: one
				// contract for parent and child — numbered reads, the shell with
				// a `description`, edit's atomic-batch wording, every result
				// carrying the clock. The shell in its CHILD form: no `background`
				// (a job's result delivers through the parent's ExtensionAPI,
				// which a child session does not have). A custom tool under a
				// built-in's name replaces the stock one in the child's
				// registry, exactly as it does here. The bash skin only where
				// main HAS bash (one shell per platform, activateCustomTools):
				// excludeTools already drops the name from a child, and not
				// handing the skin keeps its registry honest too.
				setChildExtraToolsSource("skins", (childCwd) =>
					[
						readTool.build(childCwd),
						...(mainShells().bash ? [bashTool.build(childCwd, { child: true })] : []),
						writeTool.build(childCwd),
						editTool.build(childCwd),
					].map((d) => withStamp(d) as never),
				);
			});
		// Esc takes an accidental prompt back (tools/undo.ts). Registered FIRST
		// among the input handlers, so it remembers the prompt as typed — the
		// attachment and stamp transforms run after it.
		if (on.pager) safe("undo", () => registerUndo(pi));
		if (on.pager) safe("pager", () => pager.register(pi));
		if (on.loader) safe("loader", () => loader.register(pi));
		if (on.attachments) safe("attachments", () => attachments.register(pi));
		// The user's prompt carries the [at …] stamp too (util/stamp.ts) — the
		// other half of the model's clock: when the user spoke, beside when
		// each tool ran. Registered AFTER attachments so pi's input pipeline
		// hands this handler the attachment-transformed text (transforms
		// compose: runner.js emitInput threads currentText through handlers).
		// Idempotent (appendStamp replaces an existing trailing stamp), so a
		// /fork-restored message re-submits with a fresh time, not two lines.
		safe("stamp", () =>
			pi.on("input", async (event) => {
				if (event.source === "extension") return { action: "continue" as const };
				const text = event.text ?? "";
				if (!text.trim()) return { action: "continue" as const };
				// A SKILL invocation is a prompt (2026-08-22): pi expands
				// `/skill:name args` AFTER this event — `<skill …>…</skill>\n\n` +
				// args — so the stamp rides the args and lands last on the wire.
				// pi finds the name at the first literal SPACE, so the no-args
				// form gets the stamp after a space, not a newline (a newline
				// made the name `name\n\n[timestamp…]` — unknown skill, raw text
				// sent). Other slash texts (prompt templates substitute their
				// args mid-body; commands never reach here) stay untouched.
				const lead = text.trimStart();
				if (lead.startsWith("/skill:")) {
					const stamped = lead.includes(" ") ? appendStamp(lead) : `${lead} ${stampLine()}`;
					return { action: "transform" as const, text: stamped, images: event.images };
				}
				if (lead.startsWith("/")) return { action: "continue" as const };
				return { action: "transform" as const, text: appendStamp(text), images: event.images };
			}),
		);
		if (on.mcp) {
			try {
				await mcp.register(pi, { onToolRegistered: (def) => registerToolDef(def), playwright: on.playwright });
				setChildExtraToolsSource("mcp", () => mcp.childToolDefs());
			} catch (e) {
				console.error("[war-dogs] mcp failed to load:", e);
			}
		}
	};

	// Register at LOAD when war-dogs is on for this session — BEFORE pi fires
	// session_start — so the pager's own session_start handler (which wires
	// onTerminalInput: scroll, fold, keys) is in place when it fires. Doing this
	// live instead (registering after session_start) opened the pager but left
	// it deaf — the freeze. Because on/off is settings-only (the command writes
	// the setting and reloads), "on this session" is exactly the boot state, so
	// this is the only place registration happens.
	if (bootEnabled()) await installOnce();

	// ---- master switch ----

	/**
	 * Put the custom tools into the model's active set in CANONICAL ORDER:
	 * pi's own tools as they are, then ours in registration order. The MCP
	 * names are asked for at call time — the adapter registers direct tools
	 * after an async init, so the set is not known at load — and only what the
	 * adapter itself wants active is added, never a tool it deactivated; MCP
	 * names in FIRST-REGISTRATION order (allToolNames is append-only), because
	 * `wanted` is a Set that re-orders when a name leaves and re-enters during
	 * that init, which reordered the prompt's tool list (demonstrated). Unknown
	 * names are ignored by pi, so adding all is safe.
	 */
	const activateCustomTools = () => {
		try {
			const cur = pi.getActiveTools();
			const ours = new Set([...WAR_DOGS_TOOLS, ...mcp.allToolNames()]);
			const wanted = new Set(mcp.wantedToolNames());
			const active = [
				...new Set([
					...cur.filter((n) => !ours.has(n)),
					...WAR_DOGS_TOOLS,
					...mcp.allToolNames().filter((n) => wanted.has(n)),
				]),
			];
			// Pi's stock nav tools are TRIMMED while on (2026-08-27, maintainer):
			// bash with rg/fd covers grep/find/ls, and four overlapping schemas
			// are a per-request tax plus noise in the agent tool's grantable
			// enum. `war-dogs.stockTools: true` restores them everywhere.
			// ONE SHELL PER PLATFORM (the maintainer's rule; the first Windows
			// run, 2026-08-30): powershell on Windows, bash elsewhere, both only
			// when the user chose so with pi's own knobs (`--tools`/`-t` on the
			// command line, `defaultTools` in a settings file) — then pi's set
			// stands as written. The mechanism: pi registers `powershell` on
			// every platform but activates only read, bash, edit, write by
			// default (sdk.js), activates every tool an extension registers (our
			// powershell skin included; probed), and refuses to RUN powershell
			// off Windows. So on Windows bash is REPLACED by powershell at its
			// seat (the splice covers a pi that stops auto-activating the skin);
			// elsewhere powershell is trimmed as the dead tool it is. Two earlier
			// cuts were wrong on a real Windows pi: the first trimmed powershell
			// beside a present bash (Git Bash is always present there, so the
			// platform's shell vanished), the second kept both (redundant).
			// Off stays stock: a boot-off never runs this.
			const keepStock = warDogsBlock().stockTools === true;
			const onWindows = process.platform === "win32";
			// The answer was decided at load (agents/childtools.ts decideShells,
			// published in installOnce before the agent tool's enum is built);
			// here it is enforced on pi's active set and confirmed.
			const userChoseTools = decideShells().explicit;
			const shellTrim: string[] = [];
			if (!userChoseTools) {
				if (onWindows) {
					// powershell takes bash's seat, so the order mirrors pi's own
					// (read, <shell>, edit, write) instead of the skin's late
					// registration; bash goes.
					const at = active.indexOf("bash");
					if (at >= 0) {
						const rest = active.filter((n) => n !== "powershell");
						rest.splice(rest.indexOf("bash"), 1, "powershell");
						active.splice(0, active.length, ...rest);
					}
				} else shellTrim.push("powershell");
			}
			const trim = new Set([...(keepStock ? [] : ["grep", "find", "ls"]), ...shellTrim]);
			const final = active.filter((n) => !trim.has(n));
			// Children follow (agents/childtools.ts): the shell main has is the
			// shell a child is handed and the agent tool's enum offers.
			setMainShells({ bash: final.includes("bash"), powershell: final.includes("powershell") });
			pi.setActiveTools(final);
		} catch {}
	};

	// The MAIN theme is PI'S: `/war-dogs on|off` writes `settings.theme`
	// (mode.ts writeEnabledSetting, save/restore) and reloads, so pi applies the
	// war-dogs palette to chrome AND content consistently — no in-memory apply,
	// which raced pi's reload and left content stale-cached in the old palette.
	// Only the pager's `visor` sub-theme is still an object (mod.ts), scoped to
	// the subagent view rather than pi's global theme.

	/**
	 * Turn on what installOnce registered, now that pi's session exists:
	 * HUD, attachments, the pager, and the active tool set. Runs inside pi's
	 * session_start (every boot: startup, /new, /resume, /fork, /reload) —
	 * there is no other entry, and no reverse: off is a reload with nothing
	 * installed. The MCP adapter needs nothing here: pi delivers session_start
	 * to it directly, and BEFORE this (its handler was registered during
	 * installOnce, ours after), so activateCustomTools() sees its init done.
	 */
	const activate = (ctx: ExtensionContext) => {
		if (on.banner) safe("banner", () => banner.enable(ctx));
		if (on.footer) safe("footer", () => footer.enable(ctx));
		if (on.loader) safe("loader", () => loader.enable(ctx));
		if (on.attachments) safe("attachments", () => attachments.enable(ctx));
		if (on.pager) safe("pager", () => pager.enable(ctx));
		if (on.mcp) safe("mcp", () => mcp.noticeIfYielded(ctx));
		activateCustomTools();
	};

	pi.registerCommand("war-dogs", {
		description: "Turn war-dogs mode on or off (pager, subagents, HUD, extra tools). Usage: /war-dogs [on|off]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			// The PROCESS state — what this factory run registered — not a
			// re-read of settings.json: "on" means the cockpit is up right now.
			const cur = installed;
			// The prompt undo's rewind (tools/undo.ts): war-dogs dispatches this
			// itself after an aborted turn; the command context is the one that
			// can navigate the session tree.
			if (arg === "undo") {
				await performUndo(ctx);
				return;
			}
			if (arg === "status" || arg === "?") {
				ctx.ui.notify(`war-dogs is ${cur ? "on" : "off"}`, "info");
				return;
			}
			const want = arg === "on" ? true : arg === "off" ? false : !cur;
			if (want === cur) {
				ctx.ui.notify(`war-dogs already ${cur ? "on" : "off"}`, "info");
				return;
			}
			// The env override pins the boot state; writing settings and
			// reloading would come straight back as it is. Say so instead of
			// looping through a no-op reload.
			const pinned = envEnabledOverride();
			if (pinned !== undefined && pinned !== want) {
				ctx.ui.notify(
					`WAR_DOGS_ENABLED=${process.env.WAR_DOGS_ENABLED} pins war-dogs ${pinned ? "on" : "off"} for this process — unset it (or restart without it) to switch.`,
					"warning",
				);
				return;
			}
			// Refused in flight: mid-turn is where incoherent states live. The
			// host runs commands even while streaming, so the guard lives here.
			const busy = busyState(ctx);
			if (busy.busy) {
				ctx.ui.notify(`Can't switch war-dogs while ${busy.why} — try again when idle.`, "warning");
				return;
			}
			// Control is settings-only: write war-dogs.enabled and RELOAD, so the
			// new state is a clean boot (register-everything or register-nothing)
			// rather than a live apply that froze the pager and left residuals.
			if (!writeEnabledSetting(want)) {
				ctx.ui.notify(
					`Couldn't write settings.json — set "war-dogs": { "enabled": ${want} } yourself, then /reload.`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(`war-dogs ${want ? "on" : "off"} — reloading…`, "info");
			try {
				await (ctx as any).reload?.();
			} catch {
				ctx.ui.notify(`Set war-dogs.enabled = ${want}. Run /reload to apply.`, "info");
			}
		},
	});

	// Compaction is invisible to ctx.isIdle(); mirror it for the busy guard.
	// pi emits session_compact ONLY on success (agent-session.js: manual and
	// auto paths alike) — an Esc, a summariser failure or an extension cancel
	// end in a compaction_end no extension sees. Mirroring the pair alone left
	// the flag stuck and the toggle refused for the rest of the process,
	// across /new (demonstrated). The event carries the compaction's
	// AbortSignal, so the abort edge closes at the source; the two remaining
	// edges below prove pi is no longer compacting: pi queues user input
	// during compaction, so an `input` cannot arrive mid-compaction, and a
	// new session cannot be mid-compaction.
	pi.on("session_before_compact", async (e: any) => {
		setCompacting(true);
		try {
			e?.signal?.addEventListener?.("abort", () => setCompacting(false), { once: true });
		} catch {}
	});
	pi.on("session_compact", async () => setCompacting(false));
	pi.on("input", async () => {
		setCompacting(false);
	});

	// A session switch or fork tears down every in-flight subagent run with
	// it (pi aborts the session before session_shutdown; the runs settle
	// "failed/aborted"). Background runs exist so the user can do other work
	// meanwhile, and "other work" plausibly includes /new — so refuse, the
	// way the mode toggle refuses, until the runs are settled or aborted
	// (the station's ✕, alt+s). TUI only: RPC/print drivers get pi's stock
	// behaviour.
	const runsInFlight = () =>
		[...registry.values()].filter((rec) => rec.run.status === "working" || rec.run.status === "queued");
	// Not a refusal any more (2026-08-28, the maintainer's ruling): ONE
	// confirm dialog naming what dies — agents AND background bash jobs —
	// then the switch proceeds or not. The model is told afterwards
	// (session_start below: the runs that died "stopped by the session ending (…)").
	// RPC/print drivers have no dialog: they proceed, and the notice at the
	// next start is their only word. /reload is pi's own before extension
	// commands and cannot be intercepted; it gets the notice alone.
	const guardSwitch = async (_e: unknown, ctx: any) => {
		try {
			if (!ctx?.hasUI) return undefined;
			const live = runsInFlight();
			const jobs = runningJobs();
			if (!live.length && !jobs) return undefined;
			const what = [
				live.length
					? `${live.length} agent${live.length === 1 ? "" : "s"} (${live
							.map((r) => r.run.title || r.run.id)
							.slice(0, 3)
							.join(", ")}${live.length > 3 ? ", …" : ""})`
					: "",
				jobs ? `${jobs} background bash job${jobs === 1 ? "" : "s"}` : "",
			]
				.filter(Boolean)
				.join(" and ");
			const ok = await ctx.ui.confirm("Abort running work?", `This will abort ${what}. Proceed?`);
			return ok ? undefined : { cancel: true };
		} catch {
			return undefined;
		}
	};
	pi.on("session_before_switch", guardSwitch as never);
	pi.on("session_before_fork", guardSwitch as never);

	// Quitting stops everything: a run left marked "running" outlives the
	// process, reappears after a restart, and has no controller left to
	// stop it.
	pi.on("session_shutdown", async (e: any) => {
		// The reason is what the station shows later: pi has NOT exited on
		// "new" | "resume" | "fork" | "reload".
		// One grammar with every other stop (2026-08-29, the maintainer: three
		// words for one thing): a session end STOPS the run.
		const why =
			e?.reason && e.reason !== "quit" ? `stopped by the session ending (/${e.reason})` : "stopped by pi exiting";
		const running = [...registry.values()].filter((rec) => rec.run.status === "working" || rec.run.status === "queued");
		await Promise.all(
			running.map(async (rec) => {
				try {
					// The reason rides the abort (2026-08-28, A19): the run's own
					// completion path settles first and used to record a bare
					// "stopped" where the station should say what happened.
					rec.controller.abort(abortCause("parent", why));
				} catch {}
				// The in-flight prompt() MUST finish unwinding before settle()
				// runs, because settle() disposes the session and dispose()
				// detaches the subscription that persists turns. Tearing down
				// mid-unwind threw away whatever the child was streaming, so a
				// run interrupted by quitting came back with only its prompt.
				// AgentSession.abort() is async (it awaits waitForIdle), which
				// is exactly the wait that was being skipped.
				const cap = grace();
				try {
					await Promise.race([rec.session?.abort?.() ?? Promise.resolve(), cap.promise]);
				} catch {}
				cap.cancel();
				// A stop, not a failure (2026-08-29): the run is continuable and
				// every reader — list, status, the station, the receipt's colour
				// — must say so; the reason travels in `error` as before.
				settle(rec, "stopped", why);
			}),
		);
	});

	/** cwds already told about held project resources — once per process, not per /new. */
	const trustNoticeShown = new Set<string>();
	pi.on("session_start", async (_e, ctx) => {
		setCompacting(false); // a session cannot start mid-compaction
		// Mirror pi's project trust for our settings reads (settings.ts).
		try {
			setProjectTrusted(!!(ctx as any).isProjectTrusted?.());
		} catch {}
		// OFF at boot: nothing was installed, and nothing happens here either —
		// war-dogs registers and touches nothing, which is what makes off
		// byte-for-byte stock.
		if (!installed) return;
		// A project pi never asked about (none of ITS trust-requiring
		// resources, so no prompt and a shortcut TRUE — settings.ts) that
		// carries war-dogs' own: say once why they do not ride and what
		// allows them. Undecided only; a refusal is the user's word.
		try {
			const held = unconsentedProjectResources();
			if (held.length && !trustNoticeShown.has(process.cwd())) {
				trustNoticeShown.add(process.cwd());
				ctx.ui.notify(
					`war-dogs: ${path.join(process.cwd(), ".pi")} has ${held.map((d) => d + "/").join(", ")} but this project is not trusted — ` +
						`pi did not ask because it saw nothing of its own. /trust allows it (or --approve for one run).`,
					"warning",
				);
			}
		} catch {}
		setModelRegistry((ctx as any).modelRegistry);
		// Establish WHERE runs live before the pager reads them.
		try {
			const sm = (ctx as any)?.sessionManager;
			setOwnerSession(sm?.getSessionId?.() ?? null, sm?.getSessionFile?.() ?? null);
		} catch {
			setOwnerSession(null, null);
		}
		// Index runs from earlier sessions once (station/tree read it).
		try {
			loadKnownRuns();
		} catch {}
		// THIS session's runs that died with a switch, a reload or an exit
		// and were never reported (2026-08-28, the maintainer's ruling: the
		// model is told what was aborted and why, once, at its next prompt).
		// Same owner only: after /new the dead runs belong to the old session.
		if (on.subagent) {
			try {
				reportInterruptedRuns(pi, (ctx as any)?.sessionManager?.getSessionId?.() ?? null);
			} catch {}
		}
		if (on.subagent) {
			try {
				reportAgentDiagnostics();
			} catch {}
		}
		try {
			activate(ctx as ExtensionContext);
		} catch {}
	});
}

/**
 * What the subagent schema can offer as an enum, discovered from the live
 * session. Named agents are readable from disk at any time, but the model
 * list and the tool names only exist once pi has a session — which is why
 * the tool is registered twice (see registerSubagent).
 */
function collectEnums(ctx: any): SchemaEnums {
	const agents = [...loadAgents().keys()];

	// scopedModels mirrors what the user actually enabled (/scoped-models);
	// the full catalogue is the fallback. Offering the catalogue when a
	// scope exists would put models in the schema the session cannot use.
	const models: string[] = [];
	try {
		for (const entry of (ctx?.scopedModels ?? []) as any[]) {
			const id = entry?.model?.id ?? entry?.id;
			if (id) models.push(String(id));
		}
		if (!models.length) {
			for (const m of (ctx?.modelRegistry?.getAvailable?.() ?? []) as any[]) {
				if (m?.id) models.push(String(m.id));
			}
		}
	} catch {}

	// What a CHILD can be given, not what the PARENT has. pi.getAllTools()
	// is the parent's set — it offers the model tool names from every other
	// installed extension, none of which reach a child (children load no
	// extensions), and pi drops an unknown allowlist name in silence, so the
	// run came back looking like a subagent that had simply chosen not to use
	// its tools. See agents/childtools.ts childToolNames().
	let tools: string[] = [];
	try {
		// The MCP names come from the adapter's own record rather than from
		// the live child-tool source: that source reports what the adapter
		// WANTS ACTIVE right now, and this runs before activate() has turned
		// MCP on, so it is empty here every time — which would
		// quietly drop `mcp`/`mcpScript` from the enum on a machine whose
		// children can use them.
		tools = [...childToolNames(ctx?.cwd ?? process.cwd()), ...mcp.allToolNames()];
	} catch {}

	return { agents, models: [...new Set(models)], tools: [...new Set(tools)] };
}

function registerAgentTool(pi: ExtensionAPI) {
	let owner: string | null = null;
	// Whether replies can be DELIVERED. False until session_start names the
	// mode: the load-time publish serves print/json runs (where
	// session_start may never fire), and a delivery there would land after
	// the top-level turn with no conversation to wake — those sessions hold
	// for replies with wait, and the description says so (canDeliver).
	let canDeliver = false;

	// A delivered reply arrives as an `agent-result` custom message,
	// rendered in the transcript's language. A boot with war-dogs off never
	// registers this renderer, so pi draws its stock box. The old
	// `subagent-result` name keeps the same renderer so transcripts from
	// before the 2026-08-24 rename still draw.
	pi.registerMessageRenderer("agent-result", renderAgentResultMessage);
	pi.registerMessageRenderer("subagent-result", renderAgentResultMessage);
	// A peer session's message, delivered over the socket (agents/peers.ts).
	pi.registerMessageRenderer("peer-message", renderPeerMessage);
	// Two or more jobs finishing inside one delivery window arrive as ONE
	// `background-results` message (tools/delivery.ts).
	pi.registerMessageRenderer("background-results", renderBatchResultMessage);
	// A steered delivery is held until pi consumes it and re-sent after an
	// aborted turn (tools/delivery.ts armRedelivery).
	armRedelivery(pi);

	const publish = () => {
		const def = withStamp(
			makeAgentTool({
				parentId: null,
				get ownerSession() {
					return owner;
				},
				get canDeliver() {
					return canDeliver;
				},
				pi,
			} as never),
		);
		registerToolDef(def);
		// Old transcripts recorded the tool as "subagent" — render alias
		// only, never model-facing.
		registerToolDef({ ...def, name: "subagent" } as never);
		pi.registerTool(def);
	};

	// Registered once at load so the tool exists even if session_start never
	// fires (print/json runs), then again with the enums filled in. Same
	// name, so the second call replaces the first; pi refreshes tools in
	// place, so this needs no /reload.
	publish();

	pi.on("session_start", async (_e, ctx) => {
		owner = (ctx as any)?.sessionManager?.getSessionId?.() ?? null;
		// Deliveries need a live conversation (tui/rpc); print/json hold
		// for replies with wait — see the field comment above.
		canDeliver = (ctx as any)?.mode === "tui" || (ctx as any)?.mode === "rpc";
		// Bare status leads with the session's OWN window fill (draft 10:
		// the leader's window is the one that must last).
		try {
			setMainContextSource(() => (ctx as any)?.getContextUsage?.());
		} catch {}
		// The delivery-turn rule (tools/delivery.ts): idle-time deliveries
		// go through pi's prompt path so the prompt hook runs.
		try {
			setIdleSource(() => (ctx as any)?.isIdle?.() === true);
		} catch {}
		// A receiving session is a PEER: registry file + socket
		// (agents/peers.ts). BEFORE publish, so the description can state
		// this session's own id. Print/json sessions can send, not receive.
		try {
			// The peers feature key (2026-08-25): off = no socket, no registry
			// entry, not addressable — agents unaffected (peers.ts also gates
			// the client side, so an off session neither receives nor reaches).
			if (canDeliver && features().peers) enablePeers(pi, ctx);
			else disablePeers();
		} catch {}
		try {
			setSchemaEnums(collectEnums(ctx));
			publish();
		} catch {}
	});
	// The registry entry and socket die with the session, not the process:
	// a /new re-registers under the new id via session_start above. The
	// delivery window is flushed into THIS transcript then cleared here too
	// (2026-08-28, A20: only the bash skin did it, so `tools: false` left
	// agent replies unflushed); both calls are idempotent.
	pi.on("session_shutdown", async () => {
		try {
			flushDeliveries();
			clearDeliveries();
		} catch {}
		disablePeers();
	});
}

function registerTools(pi: ExtensionAPI) {
	// Each register call returns its ToolDefinition; publishing it into
	// the toolmap is what lets a SUBAGENT transcript render these with the
	// real renderers instead of pi's "tool name + raw JSON" fallback.
	const defs = [webfetchTool(pi), websearchTool(pi)];
	for (const def of defs) registerToolDef(def);
	// Legacy render aliases: transcripts from before the lowercase rename
	// recorded "WebFetch"/"Kimi-WebSearch" as the tool name — keep those
	// rendering with the real renderers instead of raw JSON. Render-only:
	// the toolmap feeds child-transcript rendering, never the model.
	for (const [oldName, newName] of [
		["WebFetch", "webfetch"],
		["Kimi-WebSearch", "kimi-websearch"],
	] as const) {
		const def = defs.find((d) => d.name === newName);
		if (def) registerToolDef({ ...def, name: oldName } as never);
	}
	// Children load no extensions, so these must be handed to them as
	// customTools or their names resolve to nothing. See agents/childtools.ts.
	setChildExtraTools(defs);
	// The powershell skin for a child, where main has powershell (Windows;
	// agents/childtools.ts mainShells); keyed, since the factory re-runs per
	// session and the answer is known only after the active set.
	setChildExtraToolsSource("powershell", (cwd) =>
		mainShells().powershell ? [withStamp(powershellTool.build(cwd, { child: true })) as never] : [],
	);
}

/**
 * The notice for what died with this session since it was last seen — its
 * runs and its background bash jobs — one message at the model's next
 * prompt (pi's nextTurn delivery), in the delivery shape the renderers know,
 * each item marked reported on its manifest so it is told once
 * (tools/interrupted.ts builds it; a continued run gets the same for its
 * own dead agents through agents/session.ts).
 */
function reportInterruptedRuns(pi: ExtensionAPI, owner: string | null): void {
	const notice = noticeForMain(owner);
	if (!notice) return;
	pi.sendMessage(notice as never, { deliverAs: "nextTurn" } as never);
}
