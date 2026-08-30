# war-dogs

war-dogs is a single extension that turns [pi](https://github.com/earendil-works/pi-coding-agent) into a full-screen coding cockpit. It rides on pi's own agent loop and never changes what that loop does; it adds tools and re-skins what you see. Turn it on and you get a scrollback **pager** that becomes the reading surface, in-process **agents** with a live station and a chat view per run, a fetch-and-render **WebFetch** and a direct **Kimi web search**, unified **image attachments**, the bundled **MCP adapter**, a **canvas** for deliverables, and a re-coloured HUD with a mascot banner.

It is a copy-pasteable folder, not a package. Drop it into `~/.pi/agent/extensions/`; pi's loader runs the TypeScript directly, with no build step, and everything it needs travels in `node_modules/`.

One principle governs the whole thing: **war-dogs is all or nothing, and off by default.** Copying the folder in is not enough — you switch it on with one setting. On is the full experience. **Off is pi exactly as `pi --no-extensions` renders it** — the screen, the palette, and what the model is told, byte for byte — because when war-dogs is off it registers nothing at all with pi, so there is nothing to diverge. There is no partial mode: the feature keys tune what "on" includes, but the master switch is one bit.

This README is the whole manual — everything a power user needs. It reads in order: getting started, the screen, the keys, agents, the tools, what the model is told, the master switch, the complete configuration reference, portability, troubleshooting, and limits. If you maintain or extend the code, the engineering book is `dev/internals/README.md`.

---

# Getting started

## Requirements

- **pi** 0.83 or newer (verified through 0.84.4). war-dogs prints one stderr line if the installed pi is outside the range it was tested against, and otherwise runs.
- **Node ≥ 22.19** (`engines` in `package.json`).
- **A configured model.** Agents, the WebFetch scout, and `/ask` all use whatever model your session runs.
- **A system Chrome or Chromium** for WebFetch's render tier and for the default browser the model drives through MCP. One probe serves both: `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `chrome` on `PATH`, else Playwright's own lookup of a Chrome installed where it is not on `PATH` (macOS, Windows). Nothing is downloaded; without one, WebFetch's fast static tier still works, the render tier returns a typed error, and a browser call fails with Playwright's message.
- **`poppler`** (`pdftotext`, `pdfinfo`) for reading PDFs. Optional; without it a PDF fetch reports an error status.

## Install and activate

One command, into pi's extensions directory (`git` and `npm` on `PATH`):

```sh
# bash / zsh
git clone https://github.com/radenadam/pi-war-dogs ~/.pi/agent/extensions/war-dogs && npm install --prefix ~/.pi/agent/extensions/war-dogs
```

```powershell
# PowerShell
git clone https://github.com/radenadam/pi-war-dogs "$HOME\.pi\agent\extensions\war-dogs"; npm install --prefix "$HOME\.pi\agent\extensions\war-dogs"
```

Or copy a folder you already have (`node_modules/` included) into `~/.pi/agent/extensions/`. If pi's agent directory is elsewhere (`PI_CODING_AGENT_DIR`), use that path.

Then switch it on, either way:

- **In the terminal:** run `pi`, type `/war-dogs on`, and it reloads into the cockpit.
- **By hand:** add this to `~/.pi/agent/settings.json` and start pi:

```json
{ "war-dogs": { "enabled": true, "theme": "canopy" } }
```

`npm install` is what a clone needs once — `node_modules/` is gitignored, and the folder's `.npmrc` sets `legacy-peer-deps` exactly as pi's own package manager does. A copied folder with `node_modules/` needs it only on another OS or architecture (see [Portability](#portability-and-uninstall)).

**If you already installed pi-mcp-adapter as a pi package,** run `pi remove npm:pi-mcp-adapter`. war-dogs bundles its own copy; until you remove the package one, war-dogs yields to yours and tells you so once (see [MCP](#mcp)).

**Do not set pi's own `"theme"` to a war-dogs palette by hand.** `/war-dogs on` writes it there for you (saving your previous theme under `war-dogs._prevTheme`) and `/war-dogs off` puts yours back; set by hand, the war-dogs palette would be your off palette too.

## The stance

war-dogs is centred on its maintainer's stack — **Kimi-first, Chrome-assumed** — and is public as a gift, not as a neutral product. Every divergence from that stack degrades with an honest line rather than pretending, and feature work is judged against the maintainer's needs first. Everyone is welcome to use it and build on it; nobody is the design centre. Where a default assumes Kimi or Chrome, this manual says so.

## The first minutes

Run `pi` in a project. At the top sits the **mascot banner** — the box-soldier beside the WAR DOGS word art — with two lines beside it: the war-dogs and pi versions, the model and its thinking level, and the session id (and name, once you `/name` it). The transcript below is now the **pager**: a full-screen surface that owns scrolling, folding and selection, with pi's editor and a re-coloured footer at the bottom, and an activity strip under the footer whenever agents or background jobs are running.

- **Scroll** with the wheel or PgUp/PgDn. Every tool call rests as one dot-marked sentence; **click it** to open its evidence, click again to fold. `ctrl+o` expands or collapses everything.
- **Ask for an agent in plain words** ("use an agent to count the .ts files in this repo"). Its run tree stays on the surface while it works; click the run row to open its own chat view and talk to it directly.
- `alt+s` opens the **station**, the family tree of this session's agents. `ctrl+s` goes back a level.
- `/mcp` opens the MCP panel; `/canvas` serves your deliverables over HTTP.
- `/war-dogs off` returns you to stock pi; `/war-dogs on` brings the cockpit back.

---

# The screen

The resting screen shows the **conversation**, not the raw API traffic. Everything is told apart by a glyph in the left gutter and a colour tier, never by spacing — there is always exactly one blank line before each beat.

- **Voice** — the model's own words. A `●` in the gutter, text at the bright tier. An errored or aborted turn turns the dot red.
- **Your prompt** — your text on a subtly filled box, with a `❯` in the theme's accent. Image references and skill invocations you typed hang as attached rows just under the box.
- **Machinery** — tool calls. Collapsed, each is one line with no gutter glyph at rest: `executed bash • find, wc`, `Read util/shell.ts (214 lines)`, `Wrote 6 lines to notes.txt`, `Edited x (+3 −1)`, `Fetched github.com — ok · ~8k tokens`, `Searched "q" — 6 of 11 results`, `started agent • title`, `called mcp browser_tabs @ playwright`. Numbers live in the sentence; a dot marks success (green) or error (red); a running act blinks. The raw command, path or URL never rests on the surface — click to see it.
- **Thinking** — one row at rest (`thought for N lines`); click to read it. Respects pi's `hideThinkingBlock`.
- **Clusters** — consecutive machinery folds into one summary line (`thought 2 times, executed 2 bashes, called 1 mcp · 1 failed`). Click the summary to open the group. When a turn settles, the new cluster headers flash briefly so your eye catches where the working rows went.

**Folding.** A left-click opens or closes a beat. Adding is text-gated (you must click the lit text); removing is row-wide (anywhere on an open panel folds it). `ctrl+o` is all-or-nothing.

**The wire view.** The pretty surface hides the model's bookkeeping — the trailing timestamp stamp every message carries, the provenance line on deliveries, an agent id, a prompt's attachment footer. To see exactly what the model read, `ctrl`+click a tool act, a delivery, or your prompt box: that one beat flips to its verbatim wire text, and `ctrl`+click again flips it back. `ctrl+r` is the whole-surface escape hatch: normal ↔ raw source.

**Colour.** Two reading whites carry the surface: your prompt and the model's prose in one neutral white, everything at rest in one muted grey; opening a panel brightens it. The theme's identity hue paints the accents — the `❯`, headings, links, inline code, the scrollbar, the editor frame. Theme identity lives in accents and backgrounds only; the whites are identical across all palettes. Pick a palette with `war-dogs.theme` (`canopy`, `canopy-cobalt`, `dune`, `oxide`) or through `/settings → Theme` while on.

---

# Keys and mouse

Active whenever war-dogs is on. Anything not listed falls through to pi, so every stock key behaves as it does without war-dogs. When you are typing, typing wins — the scroll and station keys yield to the editor.

| Key | Effect |
|---|---|
| Wheel / PgUp / PgDn / Home / End | Scroll / top / bottom (yield to a typed editor) |
| `shift`+wheel | Scroll horizontally |
| Left-click | Fold or unfold a beat; open a run row |
| Drag / right-click | Select text / copy the selection (native selection needs `shift`+drag — see [Limits](#known-limitations)) |
| `ctrl`+click | On a path or URL: open it in the system viewer. Anywhere else on a tool act, a delivery or your prompt box: toggle that beat's **wire view** |
| `ctrl+o` | Expand / collapse everything |
| `ctrl+r` | Normal ↔ raw-source view |
| `alt+s` | Open the **station** (the agent family tree) |
| `ctrl+s` | Back one level (a run's parent, or main; from the station, the view it was opened from) |
| `↑` `↓` then `Enter` (station) | Move the run selection / open the selected run |
| `alt+up` (run view) | Pull that run's queued messages back into the editor |
| `Esc` (main) | pi's own interrupt — and if the turn your prompt just started has done nothing yet (no tool ran, no reply landed), your prompt comes **back** into the editor, as typed, so an accidental submit is undone |
| `Esc` (run view) | Interrupt that run's current turn only (it stays alive and idle) |
| `alt+x` (run view) | Interrupt the run and stop its team |
| `ctrl+alt+x` (run view) | Stop the run and report at once |
| `alt+Enter` (run view) | Queue a follow-up for that run, after its current turn |

`ctrl+q` does nothing; there is no live "pager off" toggle.

---

# Agents

An **agent** is a full pi session of its own, built in-process, running on the same model, provider and auth as yours. Nothing from your conversation reaches it except what you write to it. You reach agents through one tool, `agent`, with seven actions:

- **run** — start an agent on a task. Returns a receipt at once; the reply arrives later in the conversation, marked `[agent result …]`.
- **message** — steer a working agent at its next tool boundary, or continue an idle one (its transcript is intact, so it picks up where it left off).
- **ask** — put a question to an agent out of band. Its own model answers from its transcript so far, without interrupting its work and without recording the exchange.
- **wait** — hold until an agent is idle and return its latest reply.
- **status** — read where an agent stands (state, elapsed, last tools, the head of its latest output). Read-only.
- **stop** — interrupt an agent and everything under it. It stays continuable with `message`.
- **list** — show this session's agents as a tree, and any peer sessions.

Every run and message returns immediately; there is no foreground mode. Replies are **delivered** into the conversation — at your next tool boundary if you are working, or as a new turn if you are idle. Several finishing together arrive as one delivery. Agents started in one batch of calls work at the same time.

An agent has budgets, all of which only ever shrink as they are handed down: **depth** (how many levels of sub-agents it may start; 0 by default, so an agent gets no `agent` tool unless you grant depth), **concurrency** (how many it may run at once; 8 by default, the rest queue), an optional **timeout** (none unless set), and a **reach** (`team`, only the agents it started, or `session`, the whole session). A lead agent's reply travels only when its turn ends and none of its own agents is still working.

## The station and run views

`alt+s` opens the **station**: the family tree of this session's agents, each run with its task line and its configuration in muted values. Arrow-select or `ctrl`+hover a run to see its full configuration; click a run to open it.

A **run view** is that agent's own chat. The palette turns identity-blue so a child conversation never reads as main. Type to talk to the agent directly; `alt+up` pulls its queued messages back to the editor. Inside a run view the interrupt keys apply to that run only: `Esc` interrupts its turn (it stays alive and idle, and your next message is treated as your follow-up, which becomes its reply to whoever started it), `alt+x` also stops its team, `ctrl+alt+x` stops it outright, and `alt+Enter` queues a follow-up. `ctrl+s` returns you a level.

## Named agents

Save an agent you want to reuse as a markdown file — in `~/.pi/agent/subagents/*.md` (global) or `<project>/.pi/subagents/*.md` (project, read only when the project is [trusted](#trust-and-project-settings)). The body is the agent's system prompt; the frontmatter carries any run parameter except `title`, `message` and `agent`, plus three keys of its own: `name` (defaults to the filename), `description` (all a chooser reads), and `extensions` (extension paths loaded into the agent — not a run parameter). A file with no body is ignored, and the reason is named on stderr. Saved agents appear by name in the `agent` tool's own description; a file you add mid-session is live on the next call.

## Peers

Other pi sessions on this machine, with war-dogs on, appear in `list` as `session_…` and take messages the same way. A peer has its own user and its own work; its reply, if any, arrives in your conversation from its id. Peers are live-sessions-only (no inbox), same-machine, and gated by the `peers` feature key. `stop` refuses a peer — it belongs to its own user.

## /ask and /ask!

`/ask <question>` puts a question to the conversation on screen (the run view's agent, or your own session's model) out of band; the answer is shown to you but never enters any model's context. `/ask @<id> <question>` targets any agent or peer. `/ask!` additionally hands the question-and-answer to your own model as a hidden message, so your model learns what you asked. Every ask path retries under pi's own retry settings.

## What an agent is built with

Deliberately, an agent gets: your model and thinking level; war-dogs' own tools (`webfetch`, `kimi-websearch`, the active MCP tools, and `agent` itself while depth remains); the file skins (`read`, `write`, `edit`) and the `bash` shell skin, built for its own working directory; and your project's context files (`AGENTS.md` and friends). It gets **no** skills, prompt templates or extensions. pi's stock `grep`/`find`/`ls` are trimmed from agents just as from your own session (`bash` with `rg`/`fd` covers them; `stockTools: true` brings them back).

Its system prompt is, in order of precedence: a `systemPrompt` on the call → a named agent's body → your `SUBAGENT_SYSTEM.md` (project when trusted, then global) → **the same base prompt your own session runs on, verbatim**. Your `SYSTEM.md` is main's alone and never reaches an agent; to set an agent default, write `SUBAGENT_SYSTEM.md`.

On top of whichever base wins, every agent gets one short **exchange block** (wrapped in `<agent-exchange>` tags so it reads as the tool's voice, not your prompt's): what a subagent is, how the first line of every message tells it who wrote and whether this turn's output goes back to the agent that started it, and that communication is one way. Turn that block off with `"agent": { "exchange": false }` if you want custom prompts left entirely alone. The agent's own numbers — its depth, concurrency, timeout and reach — are stated in its `agent` tool's parameter descriptions, not in prose.

Every message you type into an agent's view reaches it prefixed with `[from your user • …]`, the rest of the line stating whether your turn stays with you or, mid-task, still belongs to the agent that started it. That prefix is wire-only; the pretty surface drops it.

## Agent configuration

In precedence order: the call's own arguments → a named agent's frontmatter → the `agent` block in `settings.json` (the older name `subagent` is still read; a project block merges over a global one per key) → the built-in defaults. The full key list is in the [configuration reference](#the-agent-block). Ceilings (`maxDepth`, `maxTimeout_s`, `maxConcurrent`) are settings-only, because a ceiling the model can raise is not a ceiling.

---

# Tools

war-dogs adds two tools of its own — WebFetch and a Kimi web search — re-skins pi's file and shell tools so their calls render as war-dogs acts, and bundles the MCP adapter with a browser the model can drive out of the box. (The `agent` tool has its own section above.) When war-dogs is off, none of them register.

## WebFetch

`webfetch` returns a **typed verdict**, never just bytes: `ok`, `login-wall`, `consent-wall`, `paywall-hard`, `bot-wall`, `not-found`, `error`, and more, decided the same way on every tier. A fast **static** tier (~300 ms) handles most pages; a **render** tier drives one shared headless Chrome per machine for the rest; `auto` escalates from one to the other on the page's own signals. Both tiers run the same extractor (HTML to structured markdown with tables, fenced code and resolved links), decode character sets, and cut long pages at a reading limit (2000 lines / 50 KB) with the whole page saved to disk and an honest resume line. Every degradation is stated in the text the model reads. The SSRF guard covers every hop on both tiers.

With `war-dogs.expect` set, a **scout** — a headless `pi -p` on this machine's model — fetches and judges candidate URLs against your criteria and returns verdicts plus only the useful content. `npm run fetch -- <url>` is the same engine for you at the shell.

## Kimi web search

`kimi-websearch` calls Kimi's `/v1/search` directly, with `site:`, `-term`, quotes and `after:`/`before:` emulated client-side. Every failure — no key, an upstream error, a malformed date — is a truthful error to the model. The key travels only in the `Authorization` header.

## MCP

war-dogs ships [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) (MIT, Nico Bailon) and installs it: the `mcp` gateway tool, `mcpScript`, per-server direct tools, `/mcp` and `/mcp-auth`, the MCP prompt commands, the `MCP:` footer status, the `mcp-scripting` skill, and `--mcp-config`. Server configuration is the adapter's own (`.mcp.json`, `~/.config/mcp/mcp.json`, `<agentDir>/mcp.json`, or `/mcp setup`). What war-dogs adds is the master switch (MCP goes off with it), reach for agents (they get the adapter's tools, and their transcripts render them properly), the yield behaviour if you have the adapter installed as a pi package as well, and a default browser.

**The default browser.** With no configuration at all, `/mcp` lists one server, `playwright`: the bundled [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) (pinned in `package.json`, run with the node that runs pi — no `npx`, no download), driving the Chrome the requirements name. The model reaches it through the `mcp` gateway (`called mcp browser_navigate @ playwright`), agents included; Chrome launches on the first call, not at boot. It is headed when you have a display and headless when you do not (a server, a container — Playwright decides), and it keeps a persistent profile under `~/.cache/ms-playwright-mcp/` so logins survive between sessions. It is registered at runtime, never written to a file, so:

- **To use your own**, define a server named `playwright` in any of the adapter's files (or via `/mcp setup`); yours replaces the default outright — flags, `directTools`, a `--cdp-endpoint`, anything. Any other name runs beside it.
- **To turn it off**, `{ "war-dogs": { "playwright": false } }` (or turn `mcp` off, which takes everything MCP with it).

## The file skins

`read`, `write` and `edit` are pi's own file tools, re-skinned so their calls render as war-dogs acts. Only `read` changes behaviour — it numbers its output and states its caps; `write` is pi's unchanged, and `edit` is pi's plus one line of wording when a batch of edits is rejected. Everything else is pi's, byte for byte.

## The shell skins

`bash` is pi's bash, re-skinned, with two optional parameters: `description` (a short phrase shown in the act instead of the raw command) and `background: true` (the command runs detached from the turn — `Esc` does not kill it — and its output and exit code arrive later as their own delivery). On a pi where PowerShell is the shell (Windows), `powershell` gets the same treatment and the same two parameters. pi runs `powershell` on Windows only; the foreground execute of both is pi's, byte for byte.

---

# Image attachments

Drag-and-drop, `ctrl+V` (pi inserts a clipboard-file path), and typed paths all become `[^image N]` references in the editor, mid-sentence, caret intact. At submit, each referenced image is re-read, resized through pi's own pipeline, and attached; a `[^image N]: /path` footer is appended behind a divider (wire-only on screen). The same engine routes images to an agent when you type at its view. An image pi's pipeline cannot decode is never sent, and the reference says so in one line.

---

# Canvas

The place for deliverables. There is no model-facing canvas tool: the model simply `write`s human-facing artifacts to `canvas/` under the working directory (self-contained HTML for people, raw markdown/CSV/SVG for machines), taught by the base prompt. war-dogs adds two things on those files — a file written under `canvas/` reads as a `created canvas • <title>` act you can `ctrl`+click to open, and **`/canvas`** serves the `canvas/` folder over HTTP (GET/HEAD only, traversal refused), printing the localhost and LAN URLs with the exposure named. The server dies with pi and closes on any reload. `war-dogs.canvas.port` pins the port.

---

# What the model is told

With the `prompt` feature on, war-dogs replaces pi's stock system prompt with its own **base** — pure conduct — assembled through pi's own builder, so your `AGENTS.md` context files, skills and the working-directory line survive exactly as they would under any custom prompt. A **session brief** (machine, runtime, references, model facts) rides the first turn once per session as a message you can fold open.

**A user `SYSTEM.md` wins whole.** When you have a project `.pi/SYSTEM.md` (trusted) or a global `<agentDir>/SYSTEM.md`, war-dogs' base and brief stand down entirely — your prompt is the prompt.

**Memory** (on by default) lets the model keep notes with the file tools it already has; war-dogs contributes a prompt-block reminder and a per-turn index of the store. Turn it on with a top-level `"memory": { "enabled": true }` or `/memory on`; `memory.indexBudget` caps the injected index. The global store is `<agentDir>/memory/`; a project store `<cwd>/.pi/memory/` is used only when the project is trusted.

**Injected messages** are your own text, handed to the model verbatim. Put `SESSION_START.md` (rides once per session) and `PER_TURN.md` (rides every turn) in an `inject/` folder — global (`<agentDir>/inject/`) and project (`<cwd>/.pi/inject/`, trusted only); both ride when present. Each is a real persisted message the model re-reads every later turn, so keep `PER_TURN.md` short. The `inject` feature key gates it.

---

# The master switch

`/war-dogs [on|off]` (and `/war-dogs status`). Control is **settings-only**: the command writes `war-dogs.enabled` into `<agentDir>/settings.json` and reloads, so every on and every off is a clean boot state, not a live apply. This is the whole design — a boot with war-dogs on registers everything; a boot with war-dogs off registers nothing, which is why off equals stock in fact, not in emulation.

**The switch is refused while any work is in flight** — the model streaming, a message queued, a compaction summarising, or any agent run unsettled at any depth — because mid-flight is where incoherent states live. For the same reason `/new`, `/fork` and `/resume` ask before tearing down in-flight agents. Wait, or stop the runs from the station.

**What off leaves behind:** the theme files war-dogs copied into `<agentDir>/themes` (harmless — off reads the same directory as stock), and the `/war-dogs` command itself in the slash list (the way back on). Nothing else; a reload rebuilds every surface from the boot state.

`WAR_DOGS_ENABLED=0|1` forces the switch for one invocation (a clean boot state either way), for kill-switch scripts and `pi -p` runs without editing settings.

---

# Configuration reference

Everything war-dogs reads. All of it is optional; with only `war-dogs.enabled: true` you get every default. Settings live in `<agentDir>/settings.json` (your agent dir, `~/.pi/agent` or wherever `PI_CODING_AGENT_DIR` points); a project's `<cwd>/.pi/settings.json` merges over it per key, but **only when the project is [trusted](#trust-and-project-settings)**.

## The `war-dogs` block

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | The master switch. war-dogs does nothing until this is `true`. |
| `theme` | `"canopy"` | The palette: `canopy`, `canopy-cobalt`, `dune`, `oxide`. A string names it and keeps the theme feature on; `false` turns the feature off (stock theme). `/war-dogs on` writes this into pi's `settings.theme` for you. |
| `stockTools` | `false` | Restore pi's stock `grep`/`find`/`ls` (and `powershell` beside `bash`) for your session and for agents. By default they are trimmed — `bash` with `rg`/`fd` covers them. |
| `canvas.port` | derived | Pin the `/canvas` HTTP port. By default it is derived from the canvas path so bookmarks survive restarts. |
| `expect` | — | The WebFetch scout: `profiles`, `maxUrls`, `timeoutMs`, and `profile` (a pinned profile name). See the header of `tools/library/webfetch/scout.ts`. |
| `_prevTheme` | — | Written by `/war-dogs on` to remember your theme, restored on off. Not something you set. |

### Feature keys

Each toggles part of "on"; all default **on**. Set any to `false` to drop just that piece.

| Key | Turns off |
|---|---|
| `pager` | The full-screen surface, station and run views. Tools, HUD and MCP still load into pi's own scrollback. |
| `subagent` | The `agent` tool and everything about agents. |
| `tools` | war-dogs' extra tools (`webfetch`, `kimi-websearch`). |
| `toolRenderers` | The re-skinned rendering of tool calls (they render as pi's own). |
| `banner` | The mascot banner. |
| `footer` | The re-coloured footer and the activity strip. |
| `loader` | The spinner and the "Generated in" entries. |
| `attachments` | Image attachments (alias: `paster`). |
| `theme` | The war-dogs palette (a string here names it and keeps it on). |
| `mcp` | The bundled MCP adapter entirely. |
| `playwright` | The default browser (the bundled `@playwright/mcp` as the MCP server `playwright`). A server of your own named `playwright` replaces it without this key. |
| `prompt` | The war-dogs base prompt and the session brief (pi's stock prompt is back; a user `SYSTEM.md` wins either way). |
| `canvas` | The `/canvas` serve command (the pager's canvas act rides `pager`). |
| `inject` | Reading and injecting `inject/SESSION_START.md` and `inject/PER_TURN.md`. |
| `peers` | The peer socket and registry — this session becomes unaddressable and reaches no peers. |

Example: `{ "war-dogs": { "banner": false, "theme": "oxide" } }`.

## The `agent` block

Defaults and ceilings for agents (the older name `subagent` is still read; a project block merges over a global one per key). Per-call arguments and named-agent frontmatter override these.

| Key | Default | Meaning |
|---|---|---|
| `depth` | `0` | Levels of sub-agents an agent may start. 0 gives it no `agent` tool. |
| `concurrency` | `8` | How many agents may work at once; the rest queue. |
| `reach` | `team` | Whom an agent may `message`/`wait`/`stop`: `team` (only agents it started) or `session` (the whole session and main). |
| `timeout_s` | none | Per-turn timeout in seconds. None unless set. |
| `model` | your session's | Default model for agents. |
| `effort` | your session's | Default thinking level. |
| `tools` / `excludeTools` | — | Default tool allowlist / removals. |
| `cwd` | your session's | Default working directory. |
| `systemPrompt` / `appendSystemPrompt` | — | Default base / appended prompt. |
| `maxDepth` | — | Ceiling on depth; no call or file can exceed it. |
| `maxTimeout_s` | — | Ceiling on timeout. |
| `maxConcurrent` | — | Ceiling on concurrency. |
| `discloseTokens` | `false` | Put token counts back on the agent's `[agent stats]` line. |
| `discloseCost` | `false` | Put dollar cost back on it. |
| `exchange` | `true` | The `<agent-exchange>` block appended to every agent's prompt. Set `false` to leave custom prompts untouched. |

## Memory (top-level block)

| Key | Default | Meaning |
|---|---|---|
| `memory.enabled` | `true` | The memory feature; set `false` to turn it off. `/memory on|off` toggles it live (per turn, no reload). |
| `memory.indexBudget` | `25000` | Per-store cap on the injected index, in characters. |

## Trust and project settings

A project's `<cwd>/.pi/settings.json` — and every other project resource war-dogs reads (`.pi/subagents/`, `.pi/inject/`, `.pi/memory/`, `war-dogs.expect` profiles that spawn a command) — is honoured **only when the project is trusted**. war-dogs mirrors pi exactly: an untrusted or undecided project's settings are ignored, and pi's `--approve`/`--no-approve` flags and its trust store decide. A project that pi never had a reason to prompt about, but which holds war-dogs' own resources, gets one warning at session start naming `/trust`. This is the single gate; nothing project-scoped bypasses it.

## Environment variables

| Variable | Effect |
|---|---|
| `WAR_DOGS_ENABLED` | Force the master switch for one invocation: `0`/`false` off, `1`/`true` on, else defer to settings. |
| `WAR_DOGS_MEMORY` | Force the memory feature the same way. |
| `WAR_DOGS_DELIVERY_WINDOW_MS` | The window (ms) background results batch into before delivery (default 1500; `0` delivers each at once). |
| `PI_WARDOGS_TRACE` | A file path; arms the pager's per-frame layout trace (for debugging geometry). |
| `PI_CODING_AGENT_DIR` | pi's own agent-dir override; war-dogs follows it, relocating the whole install (themes, transcripts, caches). |
| `WEBFETCH_CACHE_TTL_MS` | WebFetch cache lifetime (default 60000; explicit `0` disables). |
| `WEBFETCH_CONCURRENCY` | Render-tier concurrency (default 4, floor 1). |
| `WEBFETCH_DAEMON_IDLE_MS` | Idle time before the render daemon exits (default 600000). |
| `BWF_DEBUG` | Verbose WebFetch logging. |

## pi's own settings that interact

war-dogs honours pi's settings; these are the ones worth knowing about. `theme` is written by `/war-dogs on|off`. `defaultTools` sets your session's active set (the four skins replace the built-ins by name; agents get their own set). `images.autoResize`/`images.blockImages` govern the attachment pipeline as they govern pi. `hideThinkingBlock`, `steeringMode`, `followUpMode`, `markdown.*`, `compaction.*`, `retry.*` apply to main and agents alike. `externalEditor` (`ctrl+g`) works: the pager wraps pi's TUI stop/start and restores its terminal modes around the editor. `shellCommandPrefix` rides both foreground and background jobs. `defaultProjectTrust` feeds the trust gate. `tuiMode: fullscreen` is supported (pi owns the alt screen; the pager composes inside it). Two documented divergences: WebFetch bypasses `httpProxy` (its SSRF guard pins DNS itself), and inline terminal images under the pager are unverified.

---

# Portability and uninstall

**Copy the whole folder, `node_modules/` included**, into another machine's `~/.pi/agent/extensions/`; nothing in `settings.json` is required. A folder copy is **same OS, same architecture** — three runtime packages resolve a platform-gated native binary, so a copy on another platform needs one `npm install` (or `npm rebuild`) there. Until then the render tier fails loudly (naming the missing `@esbuild/<platform>`) and MCP OAuth storage is unavailable; everything else works.

For a copy you will not develop in, `npm ci --omit=dev` is smaller and runs identically — only `npm run typecheck` is unavailable, because the pi type declarations are devDependencies.

**Cross-platform status.** war-dogs is developed and driven on Linux. It reasons about other platforms at each site — the file opener picks `xdg-open`/`open`/`cmd start` and reports a missing one instead of crashing; `~/` expands through the home directory; the peer transport is a Unix socket on POSIX and a named pipe on Windows; background jobs are process-grouped on POSIX and killed by pid on Windows — but the peer transport end to end, the native binaries, inline terminal images and the terminal escapes have not yet had a real Windows or macOS pass. Treat non-Linux as "should work, unverified."

**To uninstall, delete the folder;** pi is stock on the next start. Left behind, none of it required by pi: `<agentDir>/themes/{canopy,canopy-cobalt,dune,oxide,visor}.json` (installed on the first on; delete freely); agent transcripts beside their sessions and in the legacy `<agentDir>/subagent-runs/`; the WebFetch render cache and lock under `${XDG_CACHE_HOME:-~/.cache}/war-dogs/` and saved fetch bodies under the system temp dir; the MCP adapter's caches and any `mcp.json` you wrote, plus OAuth credentials in the system keyring; the default browser's profile under `~/.cache/ms-playwright-mcp/`; peer registry entries under `<agentDir>/peers/` and the socket dir under the system temp; and the `war-dogs` block in `settings.json`.

---

# Troubleshooting

**pi exits with `Tool "mcp" conflicts with …`.** pi-mcp-adapter is installed as a pi package as well as bundled here. `pi remove npm:pi-mcp-adapter`.

**`[war-dogs] <name> failed to load: …` on stderr.** One feature's registration threw; the rest is up. Reproduce with `echo '{"id":"1","type":"get_state"}' | pi --mode rpc --no-session`; silence there is a clean load.

**`/war-dogs on` reloads into pi's dark theme with `Failed to load theme …`.** A war-dogs theme file could not be written into `<agentDir>/themes` (usually permissions). Fix the permissions and `/reload`, or copy `visual/theme/*.json` there yourself.

**`/mcp` is not a command pi knows.** war-dogs is off, and MCP is part of war-dogs. `/war-dogs on`.

**`Can't switch war-dogs while <reason> — try again when idle.`** The busy guard. Wait, or stop the run from the station.

**Render fetches fail with `no Chrome/Chromium binary found`.** Install a system Chrome/Chromium on `PATH`. The static tier keeps working.

**Moving the mouse types junk into the shell** after a crash or `ctrl+z`, or long lines clip at the right edge. All exit paths are hooked; if you land there anyway, run `printf '\e[?7h\e[?1049l\e[?1006l\e[?1003l'` or `reset`.

**The surface is frozen after a `pi update`** — turning war-dogs off fixes it. pi changed its internal layout; see the Upgrade Contract in `dev/internals/README.md`, which is re-verified after every pi update.

---

# Known limitations

Each is the documented consequence of a mechanism, not a bug awaiting a fix.

- **`/war-dogs` stays listed while off** — it is the way back on, the one thing registered unconditionally.
- **`pager: false` is a degradation, not a mode.** No station, no run views, no fold-and-cluster surface; agents still run and land on disk, rendered in pi's own scrollback.
- **Mouse mode replaces native selection.** While the pager is open, native selection needs its modifier (`shift`+drag in most terminals) and middle-click paste is unavailable inside the pager. Off restores stock.
- **Emoji and complex scripts can be one column off.** Terminals disagree with pi-tui on the width of `U+FE0F` emoji and of Indic/Myanmar clusters; a row carrying them can draw a column short or clip its tail. Autowrap is off while the pager owns the screen so such a row clips rather than scrolling the frame.
- **Replies are not delivered in `pi -p`/JSON sessions or to a child below the top level** — there is no conversation to wake. Those sessions hold for replies with `wait`.
- **The first flatten of a very large session blocks briefly** (a few seconds on a multi-megabyte transcript); steady-state rendering is a millisecond or two.

---

# Going deeper

The engineering book — how it works, the mechanics, the debugging instruments, the Upgrade Contract to re-run after every `pi update`, and the ledger of load-bearing invariants — is **`dev/internals/README.md`**; `dev/README.md` maps the rest of the workshop. `dev/internals/SYSTEM-PROMPT.md` is a system prompt that turns any capable model into a war-dogs expert — give it that file and file access to this folder, and ask it anything. Run `./dev/ci.sh` before any change lands.

war-dogs is MIT-licensed. It bundles pi-mcp-adapter (MIT, Nico Bailon).
