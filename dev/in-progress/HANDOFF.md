# HANDOFF — reconciled and re-verified on Linux; next: macOS and the agent review. pi 0.84.4, pi-mcp-adapter 2.29.0, @playwright/mcp 0.0.79.

Read `dev/README.md` (the workshop map), then `dev/internals/README.md` (the engineering book —
the only memory), then this. State is the code plus the book; history tells you how something
changed, not what it is.

## Where war-dogs stands

Published: https://github.com/radenadam/pi-war-dogs (public, `main`, MIT; linear history, every
commit `Raden Muhammad Adam <radenadam39@gmail.com>`). `./dev/ci.sh` was ALL GREEN on Linux
before publish (25 agent scenarios, inject, undo, off=stock acceptance); the whole Windows pass
since is pushed (`main` = `origin/main`). The Linux folder has no `origin` and its own
pre-publish history; reconciling it is the next session's first job — the exact recipe is in
NEXT at the bottom (never merge or rebase the two histories).

## The Windows machine (the maintainer's)

Windows 11, Windows Terminal, Windows PowerShell 5.1 (no pwsh), Git for Windows at
`C:\Program Files\Git` (bash NOT on PATH; pi finds it by its own Program Files lookup —
`dist/utils/shell.js getShellConfig`), Chrome at `C:\Program Files\Google\Chrome` (NOT on PATH),
no `rg`/`fd`, no tmux. pi is installed through `pi-node`: node 22 and pi live under
`%LOCALAPPDATA%\pi-node\current`, `pi` is a `.ps1` shim (plus `pi.cmd`) that runs
`node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js`; `npm root -g` points there.
The jiti probe recipe works with `file:///C:/…` URLs and forward-slash paths.

Instruments that run here: `npm run typecheck`, `npm run format:check`, the headless boot
(PowerShell's pipe adds a BOM — for the reply go through `cmd /c 'echo {…} | pi.cmd …'`, the
book's Debugging section), `npm run fetch`, jiti probes, and the Windows acceptance rig
(`dev/instruments/win/`, see below). `ci.sh`, the Linux acceptance harness, inject/undo and
the mock rig are bash+tmux and do not.

## Done on Windows this session (2026-08-30)

- **Boot**: clean headless load, no stderr; interactive boot with the pager surface, banner,
  footer, `MCP: 1 server enabled` (the maintainer's screenshot).
- **Line endings**: Git for Windows' system `core.autocrlf=true` checked the tree out CRLF
  (prettier failed on 103 files; runtime-read `.md` would carry CR). `.gitattributes`
  (`* text=auto eol=lf`) committed; the ledger entry says how to renormalise a checkout.
- **Image attachments — the first Windows defect, fixed**: every path scanner was a POSIX
  literal, so pi's clipboard file `C:\…\Temp\pi-clipboard-<uuid>.png` stayed a raw path
  (the maintainer's first observation), a drop never attached, and history rebuild would have
  parsed no defs. The dialect now lives in `tools/library/image.ts` (`absPathLead` and
  friends); probe green for both dialects. Also: `ctrl+v` is Windows Terminal's own paste;
  pi's paste-image key is `alt+v` on Windows (`core/keybindings.js`) — README says so now.
  ON SCREEN NOT YET SEEN after the fix — the maintainer's `/reload` + alt+v is the next step.
- **Default browser**: the `--browser chrome` fallback (Chrome off PATH) drives Chrome from
  Program Files — MCP initialize → navigate a `data:` URL → snapshot → close in ~3 s, headless
  (`%TEMP%\wd-probe\pw-handshake.mjs` style, no model). Not yet driven by a model.
- **WebFetch**: static tier OK (2 s); render tier OK with the daemon (tsx cli → daemon → headless
  Chrome from Program Files; state under `~/.cache/war-dogs`; `--daemon-status`/`--daemon-stop`
  work). The "47 s per render" seen first was NOT the network: two budget-length timers in
  `render.ts` stayed armed after the work won and held the CLI open until the 45 s budget
  expired (preload + `getActiveResourcesInfo()` → `{"Timeout":2}`). Fixed (`withDeadline`);
  the runner now exits ~5 s after launch. The machine's DNS was half-broken that hour
  (example.com ENOTFOUND everywhere, 1.1.1.1 reachable), so cache-hit timing on a real
  hostname is still to be measured.
- **Shells**: bash skin runs Git Bash (`/usr/bin/bash`, MINGW64, cwd as `/c/Users/…`);
  powershell skin runs 5.1; `read` with a backslash path numbers and stamps correctly.
- **Peers**: the registry entry and the named pipe `\\.\pipe\wd-agent-<id>` exist for the live
  session. Not driven end to end (needs a second session and a model).

## Also done on Windows (later the same day, with the maintainer's eyes)

- On screen: alt+v → `[^image 1]`, a drop, ctrl+click, the image reaching the model, the switch
  off/on, folds, wheel, exit paths, an agent run with station and view — all hold.
- ctrl+g: pi prints "Launching external editor…" after `ui.stop()` at the cursor `?1049l`
  restored (the stale frame's editor line); with a GUI editor (notepad, pi's Windows default)
  that overwrote the footer and scrolled. The stop wrap now parks the cursor below the frame
  like the SIGTSTP path (ledger, "The external editor is a TUI stop"). Linux `--editor` harness
  leg to re-run on the next Linux session.
- ONE SHELL PER PLATFORM (the maintainer's rule, after two wrong cuts): pi activates only
  `read, bash, edit, write` by default and auto-activates every extension-registered tool, so
  the powershell skin was active and the first guard trimmed it beside bash — the maintainer's
  first Windows session never had PowerShell; a second cut kept both, ruled redundant. Now on
  Windows powershell REPLACES bash at its seat, off Windows powershell is trimmed, and an
  explicit `--tools`/`-t` or `defaultTools` leaves pi's set as written. Children, the agent
  enum and the brief's Shell line follow main's shells (`setMainShells`). Ledger entry "ONE
  SHELL PER PLATFORM". Probes: the `-e` tools-dump extension (stock / on / `--tools`) and
  `shell-probe2.mjs`-style jiti probe of childtools + brief, both described in the ledger.
  NOT YET SEEN: the maintainer's model actually calling `powershell` in a session, and a
  child doing so; the `agent` doctrine and the scout still say "bash" in comments only (the
  scout's own `pi -p` passes `--tools bash` explicitly, so it keeps Git Bash on Windows by
  design).
- WebFetch on a real hostname: render 6.9 s fresh, 3.8 s cached, static 2.9 s.
- `dev/reference/tools/dump-definitions.mjs` runs on Windows now (`npm root -g` fallback, file
  URL for the jiti import) — but `definitions.md` is MACHINE-DEPENDENT (path separators in the
  agent description, the rg/fd line, the named-agent list), so regenerate it on Linux, not here.

## The Windows acceptance rig, and the verdict (later still, 2026-08-30)

`dev/instruments/win/` (node-pty ConPTY + headless xterm; the book's Debugging section) runs
14 scenarios, ALL GREEN from the repo: agent_enum, exit_quit, exit_ctrl_d, exit_ctrl_c2,
off_is_stock (text + SGR set vs `--no-extensions`), powershell_main (+ fold click + trace),
bg_powershell, agent_child (+ station + run view), browser_mcp, webfetch_search, peers (two
sessions, a message delivered), drop_space (a pasted `"…\my shot.png"` → `[^image 1]` → the
model saw magenta), ctrl_g, switch. Two more fixes fell out of it: the agent tool's `tools`
enum was baked before the shell answer existed (now decided at load, `decideShells`), and the
bash description's rg/fd line ignored pi's own `<agentDir>/bin` (pi downloads rg/fd there and
puts it first on the shell's PATH). README says "Windows is supported on Windows Terminal".
The run-status glyphs are one decision now (visual/glyphs.ts): classic `✳ ✔` everywhere,
text-safe `✻ ✓` under Windows Terminal (win32 or WT_SESSION, so WSL too), and a
`war-dogs.glyphs` settings block for taste, width-1 enforced (the ledger entry beside the
emoji-width one).

## Pushed, identity fixed, conhost seen (2026-08-31)

Everything above is on GitHub: `main` = `origin/main`, 14 commits, linear. TWO THINGS THE
NEXT SESSION MUST KNOW:

- **The history was REWRITTEN after the first push**: the Windows session committed as the
  wrong email, so the 11 Windows-pass commits were filter-branched to
  `Raden Muhammad Adam <radenadam39@gmail.com>` (the package.json author — the only identity
  this repo uses) and force-pushed. Every hash after `b2d9320` changed. Any clone taken from
  GitHub during 2026-08-31 before the rewrite is stale — re-clone or hard-reset it.
  The Windows clone's `.git/config` now pins the identity; DO THE SAME on any other machine
  before committing (`git config user.name "Raden Muhammad Adam"`,
  `git config user.email "radenadam39@gmail.com"`).
- conhost: the maintainer ran pi + war-dogs in a classic command-line window; looks fine.
  Windows is done end to end.

## Reconciled and re-verified on Linux — DONE (2026-08-31)

The Linux folder now tracks `origin/main`: identity set in `.git/config`, the pre-publish
history closed with a final commit on `master` (`pre-publish history closes here…`), then
`checkout -B main origin/main`; nothing uncommitted was lost (verified: no file newer than
the publish evening), `node_modules/` survived (deps unchanged since publish). The stale
publish-day export under `/tmp/wd-publish.*` predates the history rewrite — never push from
it. Re-verify: `./dev/ci.sh` ALL GREEN (25 scenarios, inject, undo, acceptance incl. the
editor leg); `definitions.md` regenerates on Linux byte-identical except the date stamp
(discarded, not committed).

**The one CI failure was the instruments, not the code — the `shellps` first run.** The
shell rework's intermediate cuts left three stale names in the Linux-side instruments:
`setShellIsPowershell` in the scenario, `isShellPowershell` and an ungated bash hand in the
harness's "mirrored from index.ts" wiring. Invisible on Windows (the mock suite is
bash+tmux) and silent at run time (`childExtraTools`'s `safeCall` swallows a throwing
source into "no tools"). All three fixed against the real `setMainShells`/`mainShells`
API; `shellps` green end to end; the mechanism is appended to the ONE SHELL PER PLATFORM
ledger entry (instruments are readers of this API; keyed sources are last-write-wins).

## NEXT — the Linux session: reconcile, then re-verify

(Items 1 and 2 are the DONE section above.)
3. macOS pass and the agent review remain as PRs.

## Open, small

- GitHub shows the licence as "Other": `LICENSE` is MIT plus extra attribution lines. A
  `NOTICE` file for the attribution would make the badge say MIT.
- The maintainer's personal Linux `~/.pi/agent/mcp.json` still has the cdp-endpoint
  `playwright` entry; it overrides the default by design — delete it to inherit the default.
- macOS pass and the agent review remain as PRs.

## Instruments and discipline

- `./dev/ci.sh` (needs tmux, pi, a model). Generators: `node dev/reference/tools/dump-
  definitions.mjs`, `node dev/reference/build-agent-reference.mjs` (~4 min, port 18931, no real
  model).
- Never edit `ci.sh` while it runs. Never `pkill -f` a pattern your own shell carries. On the
  maintainer's machines a hook blocks delete commands in tool calls (`rm -rf`, `Remove-Item`,
  even a variable named `rd`) — use `mktemp -d`/`%TEMP%` and leave temp dirs; renormalise a
  checkout with `git rm --cached -r . && git reset --hard`, never by deleting files.
- No change to a surface ships without a drive of it (harness for mechanics, the real model for
  what the user sees). Every `pi update` runs the whole Upgrade Contract. Changes to what the
  model is told are proposed to the maintainer first, plain words, no em dashes.
