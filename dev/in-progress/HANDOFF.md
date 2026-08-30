# HANDOFF — first Windows pass under way. pi 0.84.4, pi-mcp-adapter 2.29.0, @playwright/mcp 0.0.79.

Read `dev/README.md` (the workshop map), then `dev/internals/README.md` (the engineering book —
the only memory), then this. State is the code plus the book; history tells you how something
changed, not what it is.

## Where war-dogs stands

Published: https://github.com/radenadam/pi-war-dogs (public, `main`, MIT). `./dev/ci.sh` was ALL
GREEN on Linux before publish (25 agent scenarios, inject, undo, off=stock acceptance; typecheck
and format clean). The Windows clone at `$HOME\.pi\agent\extensions\war-dogs` now carries two
commits past the publish (both pushed? — NO: see "Commits to push"). The Linux folder has no
`origin` and its own uncommitted copies of the publish-day changes; reconcile once
(`git remote add origin …` there, then fetch and rebase or re-clone).

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
book's Debugging section), `npm run fetch`, and jiti probes. `ci.sh`, the acceptance harness,
inject/undo and the mock rig are bash+tmux and do not.

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

## NEXT

1. The maintainer's eyes (batched ask given at the end of the session): `/reload`, then alt+v
   → `[^image 1]`, a drop from Explorer → `[^image 2]`, submit and check the wire footer;
   `/war-dogs off` (settings.json: `theme` restored, `_prevTheme` gone) and on; folds and wheel
   scroll; exit paths (`/exit`, double ctrl+c) leave the shell without mouse junk and off the
   alt screen; an `agent` run, the station, a run view, a stop.
2. Render-tier timing on a healthy network (`npm run fetch -- <url> --tier render --fresh`,
   then again without `--fresh`: the second must be a cache hit in well under a second).
3. A model-driven browser call from main and from a child (`pi -p`), and a peer conversation.
4. PROPOSAL for the maintainer (what the model is told, so not done unilaterally): the session
   brief's `shell` fact reads `process.env.SHELL`, unset on Windows, so a Windows model learns
   nothing about its shell while its `bash` runs Git Bash (MINGW paths, `/c/Users/…`). State
   pi's resolved shell instead (`getShellConfig`'s answer) — one line, all platforms.
5. Windows Terminal drop shape: the probe assumes a bracketed paste with `"…"` around paths
   containing spaces (WT's documented behaviour); confirm with a real drop of such a file.

## Commits to push

`5bd3761` gitattributes, `0640bde` attachments path dialect, and the webfetch render timer fix
(the commit after it) — on the Windows clone's `main`, not yet pushed to origin. Push after the
maintainer's on-screen check of alt+v.

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
