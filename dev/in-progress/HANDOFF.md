# HANDOFF — published; first Windows run is next. pi 0.84.4, pi-mcp-adapter 2.29.0, @playwright/mcp 0.0.79.

Read `dev/README.md` (the workshop map), then `dev/internals/README.md` (the engineering book —
the only memory), then this. State is the code plus the book; history tells you how something
changed, not what it is.

## Where war-dogs stands

Published: https://github.com/radenadam/pi-war-dogs (public, `main`, MIT). The first commit is a
clean slate — no pre-publish history, `dev/in-progress/` empty; this handoff is the first thing
to land in it. `./dev/ci.sh` was ALL GREEN before publish (25 agent scenarios, inject, undo,
off=stock acceptance; typecheck and format clean). The install one-liners in the README are
verified: bash from GitHub on Linux (clone → `npm install` → clean boot, default browser
present), PowerShell on the maintainer's Windows machine (clone + `npm install` succeeded;
the boot has NOT been seen yet — that is the next session's first job).

## Done this session (do not redo)

- **The default browser.** The bundled `@playwright/mcp` (pinned exact) is registered at
  runtime as the MCP server `playwright` through the adapter's `registerMcpServer` on the
  facade (`mcp/index.ts registerDefaultBrowser`). A user's own `playwright` entry wins by the
  adapter's own throw; `war-dogs.playwright: false` turns it off; Chrome comes from the one
  probe (`util/chrome.ts`, shared with WebFetch), else Playwright's `chrome` channel lookup.
  Only the CLI, `--browser` and `--executable-path` are passed — headless, sandbox and profile
  are playwright-mcp's own decisions (demonstrated from Chrome's argv; the ledger). Why not
  `programmaticConfig` or a written mcp.json: Design decisions → MCP. Verified: headless
  boots (none / user override / opt-out / mcp off), real-model drives from main and from a
  child, prompt parity, the acceptance harness, `/mcp` panel in tmux.
- **`EXCHANGE_REACH`** (`prompt/child-base.ts`) replaced with the maintainer's text verbatim.
- **Install lines `cd` into the folder.** `npm install --prefix <dir>` failed on Windows (npm
  read `package.json` from the cwd); the ledger has the entry. Do not reintroduce `--prefix`.
- **Web search under extra providers** was questioned and settled: `kimi-websearch` resolves
  through `ctx.modelRegistry.getProviderAuth("kimi-coding")` — pi's resolver, by provider id,
  never a scan of auth.json — and was driven with dummy anthropic/openai/google entries present.

## The Linux tree vs the publish

The maintainer's Linux folder (`~/.pi/agent/extensions/war-dogs`) keeps its old git history and
has NO `origin`; today's changes (default browser, reach text, README, book, this file) are
UNCOMMITTED there. The published repo was built from a clean export
(`rsync --exclude .git --exclude node_modules --exclude 'dev/in-progress/*'`) in a temp dir and
pushed with `gh repo create`. Content is identical except this folder. Decide where future
commits originate (simplest: `git remote add origin https://github.com/radenadam/pi-war-dogs`
on Linux and reconcile once); until then, keep the two in step by hand.

## NEXT — the first Windows run (the maintainer's PowerShell, clone at `$HOME\.pi\agent\extensions\war-dogs`)

Nothing in the tree has ever run on Windows. The instruments that can run there:
`npm run typecheck`, `npm run format:check`, and the headless boot in PowerShell —
`'{"id":"1","type":"get_state"}' | pi --mode rpc --no-session` (silence on stderr = clean load).
`ci.sh`, the acceptance harness, inject/undo tests and the mock rig are bash+tmux and cannot.
Then `pi` → `/war-dogs on` and look, in this order:

1. **Boot and the switch.** The pager surface (`main view` header), banner, footer,
   `MCP: 1 server enabled`; `/war-dogs off` back to stock and on again (settings.json written
   with Windows paths; the theme save/restore).
2. **The terminal.** Alt screen, mouse reporting (click a fold, scroll), `?7l` autowrap, the
   APC markers — all assume a VT terminal; Windows Terminal should pass, conhost may not. Exit
   paths must restore the terminal (ctrl+c, `/exit`, an uncaught throw).
3. **The default browser.** Chrome is usually NOT on `PATH` on Windows, so this is the
   `--browser chrome` fallback (Playwright's Program Files lookup) — the path never exercised.
   `command` is `process.execPath` (node.exe) spawning `cli.js`: check the spawn, then a
   navigate + snapshot through the `mcp` gateway, from main and from a child agent.
4. **The skins and shells.** `bash` on Windows (pi's own choice of shell via `shellPath`),
   `powershell` beside it under `stockTools`; `read`/`write`/`edit` with backslash paths.
5. **WebFetch.** The render tier's daemon: PATHEXT probe, the `os.tmpdir()` state files, the
   daemon lock (reads `/proc` on Linux, degrades to pid liveness elsewhere — first real test).
6. **Agents.** Spawn one, the station, a run view, a stop; transcripts beside sessions.
7. **Attachments.** A pasted image path with backslashes and drive letters.

Anything hard-coded POSIX found on the way is a finding with its line; fix at the cause, add
the mechanism to the ledger, and push as a normal commit (the repo accrues history now).

## Open, small

- GitHub shows the licence as "Other": `LICENSE` is MIT plus extra attribution lines, so the
  detector does not match. A `NOTICE` file for the attribution would make the badge say MIT.
- The maintainer's personal Linux `~/.pi/agent/mcp.json` still has the cdp-endpoint
  `playwright` entry; it overrides the default by design — delete it to inherit the default.
- macOS pass and the agent review remain as PRs.

## Instruments and discipline

- `./dev/ci.sh` (needs tmux, pi, a model). Generators: `node dev/reference/tools/dump-
  definitions.mjs`, `node dev/reference/build-agent-reference.mjs` (~4 min, port 18931, no real
  model).
- Never edit `ci.sh` while it runs. Never `pkill -f` a pattern your own shell carries. `rm -rf`
  may be blocked by a hook on the maintainer's machine — use `mktemp -d` and leave temp dirs.
- No change to a surface ships without a drive of it (harness for mechanics, the real model for
  what the user sees). Every `pi update` runs the whole Upgrade Contract. Changes to what the
  model is told are proposed to the maintainer first, plain words, no em dashes.
