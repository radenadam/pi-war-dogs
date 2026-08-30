# `bash` and `powershell` — the shell skins

`bash` is pi's bash tool in behaviour — same snippet, same guideline, same foreground execute, built with the same per-tool options pi uses (`stockToolOptions()`: `shellPath`, `shellCommandPrefix`) — re-skinned with war-dogs' own description and two optional parameters. `powershell` is the same treatment of pi's PowerShell tool, on a pi where PowerShell is the shell (Windows). Only the `background: true` branch of execute is war-dogs'; everything else is pi's. Source: `tools/bash.ts`, `tools/powershell.ts`, `tools/bash-background.ts` (jobs, receipt, delivery), `settings.ts stockToolOptions()`, and pi's own `dist/core/tools/bash.js`.

## What to know

- **Foreground is pi's, unchanged.** The command runs in the session's shell at the session cwd, with the user's `shellCommandPrefix` prepended when set, and pi injects `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` into the environment.
- **`background: true` is war-dogs' own** — a real background mode pi lacks. The command runs detached from the turn (Esc does not kill it), the call returns a receipt at once, and the output and exit code arrive later as their own delivery.
- **The description ends with a capability-truth line** probed once per process (`which`/`where`, silent when absent): `rg and fd are installed; prefer them over grep and find.` — only what is true on this machine, never a conditional the model must resolve.
- **Children get the child form** (`build(cwd, { child: true })`): the same description and `description` param, no `background` — a child always runs foreground, because a background result has no parent ExtensionAPI to deliver through.

## In — what the model is given

- **Description:** war-dogs' own (two paragraphs — capability, then the output cap and timeout, restating pi's numbers). **promptSnippet / promptGuidelines:** pi's verbatim. All in `definitions.md`.

| parameter | required | type | what it does |
|---|---|---|---|
| `command` | yes | string | The shell command to run. |
| `timeout` | no | number | Seconds before the foreground command is killed (pi's). |
| `description` | no | string | One short sentence naming what the command does; the UI shows it in place of the raw command. |
| `background` | no | boolean | Run detached: the call returns a receipt with a run id, and the output and exit code arrive in a separate message when the command exits. (Main only; children never get this parameter.) |

## Out — foreground (pi's execute)

The result text is stdout and stderr merged, truncated to the last 2000 lines or 50 KB, whichever comes first. When truncated, the full output is saved to a temp file and the text ends with one of:
- `[Showing lines <a>-<b> of <total>. Full output: <path>]`
- `[Showing lines <a>-<b> of <total> (50.0 KB limit). Full output: <path>]`
- `[Showing last <size> of line <n> (line is <size>). Full output: <path>]`

Failure paths (thrown, so `isError: true`):
- Non-zero exit: `<output>\n\nCommand exited with code <n>` (the status alone when there was no output).
- Timed out: `<output>\n\nCommand timed out after <n> seconds`.
- Aborted (Esc): `<output>\n\nCommand aborted by <who>` — the user · the agent that started it · its timeout · the end of the turn that started it (`agents/run.ts abortedBy`; pi's own text is the bare `Command aborted`).

The `Took` footer the UI shows is render-only.

## Out — background (`tools/bash-background.ts`)

The job is `spawn`ed with pi's shell config (same shell as foreground), in its own process group (killed as a group on stop), `env = process.env` (no `PI_*` injection on this path), stdout+stderr captured up to 256 KB. No timeout applies; Esc does not kill it. It is **session-scoped**: any `session_shutdown` (quit, `/new`, `/fork`, `/resume`, `/reload`) sends SIGTERM to every running job, because pi invalidates the `pi` handle the job would deliver through.

The **title** used in every text is the call's `description` when present, else the command's first line cut to 60 chars.

**Receipt** (returned at once):
```
Started "<title>" in the background. The output and exit code will arrive in a separate message as soon as the command exits.

[run id: bash_<12 chars>]
```

**Delivered on exit** — a `bash-result` custom message the model reads as a `user` message:
```
[background bash result, delivered by the bash tool; not sent by the user]

Background bash "<title>" <state>:

<output | (no output)>

[run id: bash_…]
```
`<state>` is one of:
- `finished in <N>s (exit 0)`
- `failed in <N>s (exit <code>)`
- `was stopped after <N>s (<SIGNAL>)` — a signal from outside (red)
- `was stopped by the session ending (/reload) after <N>s:` + `Its output was not delivered.` — a job killed at a session end has no live `pi` to deliver through; its manifest (`<runsRoot>/jobs/<id>.json`) keeps the cause, and main is told once at that session's next start (`pi exiting` after a quit or crash)
- `failed to start: <spawn error message>`

`<output>` is the captured text trimmed and capped for the model at 200 lines: the first 120, then `… [<omitted> lines omitted of <total>. Full output: <tmp>/wd-bash-<id>.txt]`, then the last 80. The full output is saved to that file when the cap fires.

Background results are not deliverable in print mode (`pi -p` ends when the top-level turn returns).

## `powershell`

The same contract as `bash`, on Windows only, minus the rg/fd line: `tools/powershell.ts` spreads pi's `createPowerShellTool` (execute, snippet and guidelines pi's), swaps in war-dogs' description (`Execute a PowerShell command in the current working directory and return its stdout and stderr.` plus the cap-and-timeout sentence), and adds `description` and, on main, `background`. A background job runs through pi's `getPowerShellConfig()`; its receipt is bash's, its delivery reads `Background powershell "<title>" <state>:` under `[background powershell result, delivered by the powershell tool; not sent by the user]`, its manifest carries `tool: "powershell"`, and a session end reports `Background powershell "<title>" was stopped by the session ending (/reload) after Ns:`. An abort reads `Command aborted by <who>` like bash. On Windows it is active beside `bash` (pi itself activates only `read, bash, edit, write` by default; war-dogs adds `powershell` there unless `settings.defaultTools` is set, which then wins as written), children are handed the child form (no `background`) and the agent tool's enum offers it; off Windows it is trimmed, pi refuses the tool (`The powershell tool is only available on Windows.`) and the skin throws that same text. The session brief names both shells on Windows: `Shell: the bash tool runs C:\Program Files\Git\bin\bash.exe (a POSIX bash on Windows: inside it, Windows paths read /c/Users/..., not C:\Users\...); the powershell tool runs Windows PowerShell.`
