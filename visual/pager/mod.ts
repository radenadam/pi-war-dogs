/**
 * Pager wiring: overlay lifecycle and mouse/key routing. The pager is the
 * PERMANENT reading surface while war-dogs is on — it opens when the session
 * starts and closes only at session_shutdown (there is no pager toggle;
 * closing it would lose the station and other pager-only affordances; off is
 * a reload with nothing registered). The orchestrator in index.ts calls
 * enable() at session_start.
 *
 * KEYS (while open)
 *   alt+s   station (relative to this view)   ctrl+s  back one level
 *   ctrl+r  normal <-> raw source             ctrl+o  expand/collapse all tools
 *   ↑/↓ + Enter  station only: move the run selection / open its chat
 *                (Enter yields to the editor when text is typed)
 *
 * alt+s rather than ctrl+shift+s: on xterm-256color without the kitty
 * keyboard protocol, ctrl+shift+s emits the SAME byte as ctrl+s and cannot be
 * told apart. alt+s (\x1bs) is unambiguous everywhere and is unbound in pi.
 *
 * Mouse: plain wheel scrolls vertically, shift+wheel horizontally (SGR bit 2
 * is shift), so the axis never depends on cursor position.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import { matchesKey } from "@earendil-works/pi-tui";
import { enterAltScreen, exitAltScreen, parkBelowStaleFrame, piOwnsAlt, writeRaw } from "./altscreen.ts";
import { clearFocusedRun, getFocusedRun, setCurrentSessionId } from "./state.ts";
import { promptRun } from "../../agents/session.ts";
import { warDogsTheme } from "../../mode.ts";
import { onStream } from "../../agents/stream.ts";
import { attachmentsReady, editorPrepend, prepareOutgoing } from "../../tools/attachments.ts";
import { markMainInterrupted } from "../../tools/delivery.ts";
import type { ImagePart } from "../../tools/attachments.ts";
import { abortCause, abortRun, interruptRun, knownRuns, registry, sessionFor } from "../../agents/run.ts";
import {
	PagerComponent,
	BACK_KEY,
	CTRL_O,
	CTRL_R,
	END,
	HOME,
	MOUSE_DISABLE,
	MOUSE_ENABLE,
	PGDN,
	PGUP,
	SGR_MOUSE,
	STATION_KEY,
	TAIL_CHILDREN,
	buildRawLines,
	setAgentWorking,
} from "./surface.ts";

let pager: PagerComponent | null = null;
let closePager: ((sync?: boolean) => void) | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Whether the session WANTS the surface open. enable() arms a 120ms timer
 * before opening (pi must finish its first render); a session_shutdown inside
 * that window (a /reload right after boot) would find nothing to close and the
 * timer would then open the pager anyway — the same race a live off once lost
 * (demonstrated: on⏎off⏎ back to back, the pager fully live while off).
 * openPager consults this after the delay.
 */
let wantOpen = false;
/** Set only on the process-exit path, so exitAltScreen can park the cursor below pi's stale frame. */
let finalExit = false;

/**
 * alt+up in a subagent chat view: pull that run's queued messages back into
 * the editor for editing, exactly as main's app.message.dequeue does. Mirrors
 * pi's restoreQueuedMessagesToEditor — clear the child session's steer/
 * follow-up queues, join with "\n\n", prepend to whatever is already typed,
 * and leave the current turn running (no abort on this path).
 */
function dequeueRun(runId: string, ctx: ExtensionContext, say: (m: string) => void) {
	const s = sessionFor(runId);
	const cleared = s?.clearQueue?.() as { steering?: string[]; followUp?: string[] } | undefined;
	const all = [...(cleared?.steering ?? []), ...(cleared?.followUp ?? [])];
	if (!all.length) {
		say("No queued messages to restore");
		return;
	}
	const queuedText = all.join("\n\n");
	// Through the live component (attachments.ts owns that reach): the public
	// round-trip expands [paste #N] blocks and drops the paste registry.
	if (!editorPrepend(queuedText)) {
		let current = "";
		try {
			current = ctx.ui.getEditorText() ?? "";
		} catch {}
		const combined = [queuedText, current].filter((t) => t.trim()).join("\n\n");
		try {
			ctx.ui.setEditorText(combined);
		} catch {}
	}
	// The queue is now empty, so the "Steering: …" indicator clears on the next
	// frame; nudge a render so it happens immediately.
	try {
		pager?.refreshLight();
	} catch {}
	say(`Restored ${all.length} queued message${all.length > 1 ? "s" : ""} to editor`);
}

/** Open the reading surface. No-op if already open. */
async function openPager(ctx: ExtensionContext) {
	if (pager) return;
	if (ctx.mode !== "tui") return;
	if (!wantOpen) return;
	{
		const notify = (msg: string) => {
			// A run view draws its own footer, so pi's status line is not on
			// screen there: the pager's notice row carries it (surface.ts).
			if (pager?.inChildView()) {
				pager.setNotice(msg, 2500);
				return;
			}
			try {
				ctx.ui.setStatus("pager", msg);
				if (statusTimer) clearTimeout(statusTimer);
				statusTimer = setTimeout(() => {
					try {
						ctx.ui.setStatus("pager", undefined);
					} catch {}
				}, 2500);
				(statusTimer as any)?.unref?.();
			} catch {}
		};
		let tuiRef: TUI | null = null;
		let detachedHeads: any[] = [];
		let handle: { hide?: () => void } | null = null;
		let tornDown = false;
		let hooks: { exit: () => void; tstp: () => void; cont: () => void } | null = null;
		let tuiWraps: { stop: (...a: unknown[]) => void; start: (...a: unknown[]) => void } | null = null;
		// Idempotent: reached from ctx.ui.custom()'s finally (pi resolved our
		// promise), from closePager (session_shutdown) and from the
		// process-exit hook. Whoever gets there first does the work.
		const teardown = () => {
			if (tornDown) return;
			tornDown = true;
			try {
				pager?.dispose();
			} catch {}
			if (hooks) {
				try {
					process.removeListener("exit", hooks.exit);
					process.removeListener("SIGTSTP", hooks.tstp);
					process.removeListener("SIGCONT", hooks.cont);
				} catch {}
				hooks = null;
			}
			if (tuiWraps && tuiRef) {
				try {
					const t = tuiRef as unknown as { stop?: (...a: unknown[]) => void; start?: (...a: unknown[]) => void };
					t.stop = tuiWraps.stop;
					t.start = tuiWraps.start;
				} catch {}
				tuiWraps = null;
			}
			writeRaw(tuiRef, MOUSE_DISABLE);
			if (tuiRef && detachedHeads.length) {
				try {
					((tuiRef as any).children as any[]).unshift(...detachedHeads);
				} catch {}
				detachedHeads = [];
			}
			exitAltScreen(tuiRef, finalExit);
			try {
				ctx.ui.setStatus("pager", undefined);
			} catch {}
			onStream(undefined);
			pager = null;
			closePager = null;
		};
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					tuiRef = tui;
					// Close OUR entry, never "the top one". pi's done() →
					// hideOverlay() pops the LAST overlay in the stack — the
					// adapter's /mcp panel or any other extension's overlay
					// pushed after ours (demonstrated: their overlay vanished
					// with its promise never resolving, ours stayed drawn).
					// done() is precise only while we ARE the top; otherwise
					// the OverlayHandle splices by identity and the promise
					// stays pending (pi itself leaves it pending on /reload).
					// `sync`: tear down NOW, in this tick. done() settles our promise
					// on a microtask, and on a quit pi prints "To resume this
					// session" and exits before that runs — the line went to the
					// alt screen and only the exit hook restored the modes
					// (demonstrated: prompt drawn inside the stale frame).
					closePager = (sync = false) => {
						const stack = ((tui as any).overlayStack ?? []) as any[];
						const top = stack[stack.length - 1];
						if (!sync && top && top.component === pager) {
							done(undefined);
							return;
						}
						try {
							handle?.hide?.();
						} catch {}
						teardown();
					};
					const kids = ((tui as any).children ?? []) as any[];
					let headKids: any[] = [];
					if (kids.length > TAIL_CHILDREN) {
						headKids = kids.slice(0, kids.length - TAIL_CHILDREN);
					}
					pager = new PagerComponent(tui, theme, () => buildRawLines(ctx), notify, headKids);
					// The subagent view's own canvas (round 9): visor, the
					// identity-blue theme, self-installed with the others.
					try {
						pager.setSubTheme((warDogsTheme("visor") as never) ?? null);
					} catch {}
					// Live theme identity, checked per frame: a /settings theme
					// change never reaches the pager's invalidate on its own.
					pager.setThemeSource(() => ({
						base: ((ctx.ui as any).theme as never) ?? null,
						visor: (warDogsTheme("visor") as never) ?? null,
					}));
					pager.setEditorTextGetter(() => {
						try {
							return ctx.ui.getEditorText();
						} catch {
							return "";
						}
					});
					pager.refresh();
					// Repaint per token batch, the way pi drives main. The
					// poll timer can only SAMPLE the stream, which is what
					// made a subagent view step in chunks.
					onStream((runId) => {
						if (getFocusedRun() === runId) {
							try {
								tui.requestRender();
							} catch {}
						}
					});
					writeRaw(tui, MOUSE_ENABLE);
					// Detach the reading surface from pi's root: pi's own
					// frames shrink to the tiny tail, so its full redraws
					// can no longer overflow the terminal's synchronized-
					// output window (the residual flicker). The pager holds
					// the refs and keeps rendering them.
					if (headKids.length) {
						(tui as any).children.splice(0, headKids.length);
						detachedHeads = headKids;
					}
					enterAltScreen(tui);
					// The alt screen and mouse reporting are OUR terminal state;
					// pi restores only what it enabled itself. Two exits bypass
					// every hook above: an uncaught exception (pi calls
					// process.exit(1) without session_shutdown) and ctrl+z
					// (pi stops its TUI and SIGTSTPs the group). Both left the
					// shell in the alt screen with mouse tracking on — moving
					// the mouse typed junk into the prompt (demonstrated). The
					// exit hook restores the modes on any process exit; the
					// SIGTSTP hook restores them, then really stops (SIGSTOP —
					// a listener replaces node's default stop), and SIGCONT
					// re-enters. Registered here so SIGCONT runs before pi's
					// per-suspend once() redraw.
					const restoreModes = () => {
						try {
							// Under pi's own fullscreen (0.84+) the alt screen is pi's to
							// leave; only the mouse modes and autowrap (?7 — see
							// MOUSE_ENABLE) are ours.
							fs.writeSync(
								1,
								piOwnsAlt(tui) ? "\x1b[?7h\x1b[?1006l\x1b[?1003l" : "\x1b[?7h\x1b[?1049l\x1b[?1006l\x1b[?1003l",
							);
						} catch {}
					};
					hooks = {
						exit: () => {
							if (!tornDown) restoreModes();
						},
						tstp: () => {
							restoreModes();
							try {
								fs.writeSync(1, parkBelowStaleFrame());
							} catch {}
							try {
								process.kill(process.pid, "SIGSTOP");
							} catch {}
						},
						cont: () => {
							if (tornDown) return;
							try {
								if (!piOwnsAlt(tui)) fs.writeSync(1, "\x1b[?1049h");
							} catch {}
							writeRaw(tui, MOUSE_ENABLE);
							try {
								tui.requestRender(true);
							} catch {}
						},
					};
					process.on("exit", hooks.exit);
					process.on("SIGTSTP", hooks.tstp);
					process.on("SIGCONT", hooks.cont);
					// The EXTERNAL EDITOR (ctrl+g, `externalEditor`; 2026-08-30, the
					// pi-settings review): pi stops its TUI, runs the editor, starts
					// the TUI again — and restores only what it enabled. The pager's
					// alt screen, mouse reporting and autowrap stayed on around the
					// editor (tmux: alternate_on 1, mouse_any_flag 1 while it ran).
					// pi emits no event for this, so the TUI's own stop/start are
					// wrapped on the instance the pager holds: stop restores the
					// modes like ctrl+z, start re-enters like SIGCONT. Removed at
					// teardown. (Upgrade Contract: pi-tui's `TUI.stop`/`TUI.start`.)
					try {
						const t = tui as unknown as { stop?: (...a: unknown[]) => void; start?: (...a: unknown[]) => void };
						const origStop = t.stop;
						const origStart = t.start;
						if (typeof origStop === "function" && typeof origStart === "function") {
							// Arguments forwarded whole: pi-tui's stop takes options.
							t.stop = function (this: unknown, ...a: unknown[]) {
								origStop.apply(this, a);
								if (!tornDown) {
									restoreModes();
									// Park the cursor below pi's stale primary frame, as the
									// SIGTSTP hook does: pi prints "Launching external editor…"
									// right after this, at the cursor `?1049l` restored — the
									// editor line of that frame — so with a GUI editor (notepad,
									// pi's Windows default) the lines overwrote the footer and
									// scrolled the frame up two rows per press (the maintainer's
									// screenshot, 2026-08-30). Under pi's own alt screen the
									// primary is pi's to manage.
									if (!piOwnsAlt(tui)) {
										try {
											fs.writeSync(1, parkBelowStaleFrame());
										} catch {}
									}
								}
							};
							t.start = function (this: unknown, ...a: unknown[]) {
								origStart.apply(this, a);
								if (!tornDown) hooks?.cont();
							};
							tuiWraps = { stop: origStop, start: origStart };
						}
					} catch {}
					return pager as unknown as Component & { dispose?(): void };
				},
				{
					overlay: true,
					overlayOptions: () => ({
						anchor: "top-left",
						width: "100%",
						maxHeight: "100%",
						nonCapturing: true,
					}),
					onHandle: (h: any) => {
						handle = h;
					},
				} as never,
			);
		} finally {
			teardown();
		}
	}
}

/** Open the pager surface (called at session_start while war-dogs is on). */
export function enable(ctx: ExtensionContext) {
	if (ctx.mode !== "tui") return;
	wantOpen = true;
	// Small delay so pi has finished its first render and tui.children holds
	// the chat containers the surface detaches. openPager itself no-ops if the
	// surface is already up.
	const t = setTimeout(() => {
		void openPager(ctx).catch(() => {});
	}, 120);
	(t as any)?.unref?.();
}

export function register(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		try {
			setCurrentSessionId((ctx as any).sessionManager?.getSessionId?.() ?? null);
		} catch {
			setCurrentSessionId(null);
		}
		ctx.ui.onTerminalInput((data) => {
			if (!pager) return undefined;
			// onTerminalInput runs BEFORE pi's focused component sees anything.
			// While a selector (/model, /resume, /tree, /scoped-models), the
			// adapter's /mcp panel or an extension dialog holds focus, every
			// key belongs to it — the pager's ctrl+s/ctrl+r/ctrl+o/PgUp
			// bindings swallowed their save/reconnect/cycle keys (demonstrated).
			// The pager is a non-capturing overlay: focus is the editor
			// whenever nothing else is up. Mouse reports keep flowing to us
			// (a selector has no mouse handling to lose).
			const focused = (pager as any)?.tui?.focusedComponent;
			const editorFocused = !focused || typeof focused.insertTextAtCursor === "function";
			if (!editorFocused && !data.startsWith("\x1b[<") && !data.startsWith("\x1b[M")) return undefined;
			// A bracketed paste is one event and never a mouse report; a
			// paste whose TEXT contained "ESC [ <" used to be swallowed whole
			// as clicks (demonstrated). Mouse reports are tested ANCHORED —
			// StdinBuffer delivers complete sequences per event.
			if (data.startsWith("\x1b[200~")) return undefined;
			if (data.startsWith("\x1b[<") || data.startsWith("\x1b[M")) {
				let net = 0;
				let hNet = 0;
				for (const m of data.matchAll(SGR_MOUSE)) {
					const btn = Number(m[1]);
					const col = Number(m[2]);
					const row = Number(m[3]);
					if (btn & 64) {
						// SGR bit 2 is shift. Shift+wheel scrolls horizontally,
						// plain wheel always vertically — so the axis never
						// depends on where the cursor happens to be, even when
						// deep content fills the screen edge to edge.
						const delta = (btn & 3) === 1 ? 3 : (btn & 3) === 0 ? -3 : 0;
						if (btn & 4) hNet += delta * 2;
						else net += delta;
					} else if ((btn & 3) === 0 && btn & 16 && !(btn & 32) && m[4] === "M") {
						pager.handleCtrlClick(row, col);
					} else if ((btn & 3) === 0 && !(btn & 32) && m[4] === "M") {
						pager.handleMousePress(row, col);
					} else if ((btn & 3) === 2 && !(btn & 32) && m[4] === "M") {
						pager.copySelectionNow(row); // right-click = copy selection, or the input bar
					} else if (btn & 32 && (btn & 3) === 0) {
						pager.handleMouseDrag(row, col);
					} else if (btn & 32 && (btn & 3) === 3) {
						pager.handleMouseMove(row, col, !!(btn & 16)); // hover tracking (ctrl = detail)
					} else if (m[4] === "m") {
						pager.handleMouseRelease();
					}
				}
				// Legacy X10 fallback (ESC [ M + 3 bytes), in case SGR is off.
				if (data.startsWith("\x1b[M") && data.length >= 6) {
					const btn = data.charCodeAt(3) - 32;
					if (btn & 64) net += (btn & 3) === 1 ? 3 : (btn & 3) === 0 ? -3 : 0;
				}
				if (net !== 0) pager.scrollLines(net);
				if (hNet !== 0) pager.hScroll(hNet);
				return { consume: true }; // swallow all mouse reports while open
			}
			// PgUp/PgDn/Home/End scroll the surface — unless the editor holds
			// text, when they are the editor's own cursor keys (line start/end,
			// page moves in a long prompt) and were dead with the pager open.
			// Same yield rule as Enter and the station arrows: typing wins.
			let editorHasText = false;
			if (PGUP.test(data) || PGDN.test(data) || HOME.test(data) || END.test(data)) {
				try {
					editorHasText = !!(ctx.ui.getEditorText() ?? "").trim();
				} catch {}
			}
			if (!editorHasText) {
				if (PGUP.test(data)) {
					pager.pageUp();
					return { consume: true };
				}
				if (PGDN.test(data)) {
					pager.pageDown();
					return { consume: true };
				}
				if (HOME.test(data)) {
					pager.toTop();
					return { consume: true };
				}
				if (END.test(data)) {
					pager.toBottom();
					return { consume: true };
				}
			}
			if (CTRL_O.test(data)) {
				pager.toggleAll();
				return { consume: true };
			}
			if (CTRL_R.test(data)) {
				pager.toggleRaw();
				return { consume: true };
			}
			if (STATION_KEY.test(data)) {
				// Station only — never a cycle. Subagent transcripts are
				// reached by clicking a run, and the station is always
				// relative to the session you press this in.
				pager.toggleStation();
				return { consume: true };
			}
			// Station keyboard nav (round 28): ↑/↓ move the selection, Enter
			// opens the selected run's chat. Enter yields to the editor when
			// something is typed — submitting a message always wins.
			if (pager.inStation()) {
				// ↑/↓ move the run selection ONLY when there is one to move and
				// nothing is typed — an empty station, or an editor with text,
				// keeps pi's history recall / cursor movement (the same yield
				// rule Enter uses below).
				let typedNow = "";
				try {
					typedNow = ctx.ui.getEditorText() ?? "";
				} catch {}
				const navigable = pager.stationRowCount() > 0 && !typedNow.trim();
				if (navigable && /^(?:\x1b\[A|\x1bOA)$/.test(data)) {
					pager.stationNav(-1);
					return { consume: true };
				}
				if (navigable && /^(?:\x1b\[B|\x1bOB)$/.test(data)) {
					pager.stationNav(1);
					return { consume: true };
				}
				if ((data === "\r" || data === "\n") && pager.stationHasSel()) {
					let typed = "";
					try {
						typed = ctx.ui.getEditorText() ?? "";
					} catch {}
					if (!typed.trim()) {
						pager.stationEnter();
						return { consume: true };
					}
				}
			}
			if (BACK_KEY.test(data)) {
				// One step back. Consumed even at main so it never leaks
				// through to the editor as a control character.
				pager.back();
				return { consume: true };
			}
			// alt+up: dequeue a subagent's queued messages into the editor, like
			// main. Only when a run view is focused — in main view it falls
			// through so pi's own dequeue handles main's queue. matchesKey is
			// pi's own parser, so every terminal variant (CSI, kitty, legacy) is
			// covered.
			// A TRANSIENT status, never notify(): notify() lands as a status
			// LINE in main's transcript (the 2026-08-24 lesson, and the
			// maintainer's 2026-08-28 screenshot: "interrupted; …" under
			// main's answer; 2026-08-29: alt+up's "No queued messages to
			// restore" from a run view landed in main the same way).
			const say = (m: string) => {
				// The run view's own notice row: pi's statuses are not drawn
				// there (2026-08-29, the keys gave no visible feedback).
				if (pager?.inChildView()) {
					pager.setNotice(m, 3000);
					return;
				}
				try {
					ctx.ui.setStatus("wd-run", m);
					const t = setTimeout(() => {
						try {
							ctx.ui.setStatus("wd-run", undefined);
						} catch {}
					}, 3000);
					(t as { unref?: () => void }).unref?.();
				} catch {}
			};
			if (matchesKey(data, "alt+up")) {
				const viewing = getFocusedRun();
				if (!viewing) return undefined;
				dequeueRun(viewing, ctx, say);
				return { consume: true };
			}
			// THE USER'S HAND ON A CHILD (2026-08-28, the maintainer's design),
			// run view only; in main view every one of these falls through to
			// pi (Esc is main's own interrupt and never touches agents). Esc:
			// interrupt the viewed run's current turn, its team keeps working,
			// the run stays alive and idle. alt+x: the same, and its team is
			// stopped. ctrl+alt+x: stop the run itself, the station's ✕
			// (ctrl+x alone is pi's copy key and stays pi's).
			{
				const viewing = getFocusedRun();
				// Esc in MAIN while pi works is the user's interrupt (pi's own; the
				// key falls through): from here on nothing wakes main on its own —
				// every delivery rides the next prompt (tools/delivery.ts).
				if (!viewing && matchesKey(data, "escape")) {
					try {
						if ((ctx as any).isIdle?.() === false) markMainInterrupted();
					} catch {}
					return undefined;
				}
				if (viewing && (matchesKey(data, "escape") || matchesKey(data, "alt+x") || matchesKey(data, "ctrl+alt+x"))) {
					if (matchesKey(data, "ctrl+alt+x")) {
						const ok = abortRun(viewing, abortCause("stopped", "stopped by the user"));
						say(ok ? "stopped" : "already idle");
						return { consume: true };
					}
					const team = matchesKey(data, "alt+x");
					const { result, teamStopped } = interruptRun(viewing, { team });
					// The notice says what happened, counted (2026-08-29: alt+x read
					// "its agents stopped" for a run with none).
					const stopped = teamStopped ? `; ${teamStopped} agent${teamStopped === 1 ? "" : "s"} of its own stopped` : "";
					say(
						result === "interrupted"
							? `interrupted; it is idle and continues when messaged${stopped}`
							: teamStopped
								? `idle${stopped}`
								: "nothing to interrupt: it is idle",
					);
					return { consume: true };
				}
			}
			// alt+Enter in a run view: a FOLLOW-UP for that run (after its
			// current turn), the key main has for its own queue (2026-08-28).
			// Enter keeps steering. Consumed here so pi's main follow-up never
			// sees it.
			if (matchesKey(data, "alt+enter")) {
				const viewing = getFocusedRun();
				if (!viewing) return undefined;
				let text = "";
				try {
					text = ctx.ui.getEditorText() ?? "";
				} catch {}
				if (!text.trim()) return { consume: true };
				try {
					ctx.ui.setEditorText("");
				} catch {}
				void (async () => {
					const prepared = attachmentsReady() ? await prepareOutgoing(text, []) : { text, images: [] as ImagePart[] };
					// The provenance line and the stamp are composed in sendToRun,
					// where the turn's receiver is known (2026-08-30).
					await promptRun(viewing, prepared.text, prepared.images, { from: { kind: "user" }, followUp: true });
				})().catch((e) => {
					try {
						ctx.ui.notify(`Agent failed: ${String((e as Error)?.message ?? e)}`, "error");
					} catch {}
				});
				return { consume: true };
			}
			return undefined;
		});
	});

	// While a subagent chat view is open, typed text belongs to THAT agent.
	// The input bar itself still belongs to main: slash commands pass
	// straight through to the host, since every pi command (/model,
	// /compact, /new, /tree) operates on the host session.
	pi.on("input", async (event, ctx) => {
		// The USER's typed input only (2026-08-29): pi also emits `input` for
		// a prompt an extension sends through `sendUserMessage` — since the
		// delivery-turn rule that is every idle-time delivery — and routing
		// those to the open run view handed main's background-bash result to
		// a child as "[from your user]" (the maintainer's screenshot).
		if ((event as { source?: string }).source === "extension") return;
		const viewing = getFocusedRun();
		const text = event.text ?? "";
		if (!text.trim()) return;
		if (text.trimStart().startsWith("/")) return;
		// Submitting RE-ARMS follow: expanding a panel parks the view, and
		// without this a later prompt streamed its reply off-screen. Real
		// prompts only; delivered background results never yank the view.
		try {
			pager?.toBottom();
		} catch {}
		if (!viewing) return;
		// A stale id — from a torn-down view or a previous session — must
		// fall through to main rather than swallowing the prompt.
		if (!registry.has(viewing) && !knownRuns.has(viewing)) {
			clearFocusedRun();
			return;
		}
		// Fire and forget: awaiting would block pi's input pipeline for the
		// whole subagent turn. Failures are surfaced, or a dropped message
		// looks identical to one that produced nothing.
		//
		// Routed through the SAME submit engine as main (prepareOutgoing):
		// paths become refs, images attach, the footnote footer is appended —
		// this is what makes a pasted image reach a subagent. The attachments
		// input handler itself never sees this message, because returning
		// "handled" here short-circuits pi's input chain.
		void (async () => {
			const existing = (event.images ?? []) as ImagePart[];
			const prepared = attachmentsReady() ? await prepareOutgoing(text, existing) : { text, images: existing };
			// The child's clock too: a run-directed message is a user prompt to
			// that child, stamped like main's (the routing short-circuits pi's
			// input pipeline, so main's stamp handler never sees it). Every
			// message after the task opens with its sender (the agent
			// contract, 2026-08-24): typed here, that is the user — and since
			// 2026-08-30 the line also states where this turn's final output
			// goes, which sendToRun decides, so it composes the line and the
			// stamp itself.
			await promptRun(viewing, prepared.text, prepared.images, { from: { kind: "user" } });
		})().catch((e) => {
			try {
				ctx.ui.notify(`Agent failed: ${String((e as Error)?.message ?? e)}`, "error");
			} catch {}
		});
		return { action: "handled" as const };
	});

	// Full refresh at content boundaries; light refresh for streaming
	// chunks (the always-fresh tail picks those up without invalidating
	// the historical component cache).
	for (const ev of ["message_end", "tool_execution_end", "agent_end"] as const) {
		pi.on(ev as any, async () => {
			if (pager) pager.refresh();
		});
	}
	// Wholesale replacements: neither grows nor dips, so the follow-hold
	// must not smooth them (see PagerComponent.contentReplaced).
	for (const ev of ["session_tree", "session_compact"] as const) {
		pi.on(ev as any, async () => {
			if (pager) pager.contentReplaced();
		});
	}
	// WORKING vs STATIC (round 23): the flatten cannot see the agent loop,
	// so its edges are mirrored here. agent_settled — not agent_end — is
	// "pi will not continue on its own": the moment the turn's machinery
	// collapses into clusters (agent_end still fires mid-retry/compaction).
	pi.on("agent_start", async () => {
		setAgentWorking(true);
		if (pager) pager.refresh();
	});
	pi.on("agent_settled", async () => {
		setAgentWorking(false);
		// turnSettled, not refresh: the working window closing SHRINKS the
		// surface, and the follow-hold read that shrink as the streaming
		// handoff dip it exists to smooth — 1.5s frozen, then a jump.
		if (pager) pager.turnSettled();
	});
	pi.on("tool_execution_update" as any, async () => {
		if (pager) pager.refreshLight();
	});
	// Assistant streaming. Without this NOTHING marks the surface dirty
	// while main is producing text or thinking, so flattenLive() kept
	// early-returning until its 150ms cache lapsed: main was SAMPLED at
	// ~7fps instead of following the token stream the way stock pi does.
	// That is both the "less smooth than stock" feel and the reason
	// content arrived in bursts that shoved the followed view several
	// lines at a time. refreshLight (not refresh) because a streaming
	// chunk only ever changes the tail — the historical component cache
	// stays valid, which is what keeps this O(tail) per token.
	pi.on("message_update" as any, async () => {
		if (pager) pager.refreshLight();
	});

	pi.on("session_shutdown", async (e: any) => {
		// /reload hides the overlay without resolving ctx.ui.custom(), so the
		// finally above may never run. Clear the cross-extension handles here
		// unconditionally. On a real quit pi has already stopped its TUI:
		// exitAltScreen then parks the cursor below the stale primary frame
		// instead of restoring a renderer nobody will render with again.
		finalExit = !e?.reason || e.reason === "quit";
		wantOpen = false;
		setAgentWorking(false);
		clearFocusedRun();
		onStream(undefined);
		closePager?.(true);
		finalExit = false;
	});
}
