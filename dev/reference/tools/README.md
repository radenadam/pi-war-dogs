# The tool reference — what the model reads and writes

war-dogs registers a handful of tools with pi. This folder documents each one for a power user studying the context engineering: what the tool is, what you need to know about it, everything that goes in (its description and parameters), and every text the model gets back and the scenario that produces it. Every quoted string is verbatim from the source, or generated from it (`definitions.md`).

| file | the tool |
|---|---|
| `definitions.md` | GENERATED — every registered tool's verbatim description, promptSnippet, promptGuidelines and full JSON-Schema parameters. Regenerate with `node dev/reference/tools/dump-definitions.mjs` after any change to `tools/*.ts`. The single source of truth for the exact bytes that travel in the request. |
| `agent.md` | `agent` — in-process pi sessions: seven actions, config precedence, what a child is handed, every returned text, deliveries, states, ids. Its full verbatim capture (every text by scenario, main beside child) is `dev/reference/agent-tool.html`. |
| `webfetch.md` | `webfetch` — the typed-status fetch, both tiers, the scout, every result shape, the truncation/resume text, config, env. |
| `websearch.md` | `kimi-websearch` — the direct Kimi search, its operators, every result and error text. |
| `bash-powershell.md` | `bash` and `powershell` — the shell skins: what differs from pi's, the background mode and its delivered result, every foreground and background text. |
| `read-write-edit.md` | `read`, `write`, `edit` — the file skins: the re-skinned appearance, `read`'s own text path, `edit`'s batch-rejection wording, every text. |
| `mcp.md` | what war-dogs adds around the bundled pi-mcp-adapter (the master switch, children, rendering); the adapter's own texts live in its source. |

war-dogs' own tools are `agent`, `webfetch`, `kimi-websearch` (`index.ts` `WAR_DOGS_TOOLS`), plus the re-skinned built-ins (`read`, `write`, `edit`, `bash`, and `powershell` on Windows, where it is active beside `bash`), plus the MCP adapter's `mcp`, `mcpScript` and per-server tools. When war-dogs is off, none of these register: the model's tool list and system prompt are pi's, byte for byte.

## How a tool reaches the model, end to end

1. **Registration.** `index.ts` calls `pi.registerTool(def)` for `agent`, `webfetch`, `kimi-websearch` and the skins; the MCP adapter registers `mcp`, `mcpScript` and one tool per server tool through the facade in `mcp/index.ts`. A tool registered under a built-in's name REPLACES pi's entry in the registry the system prompt is built from, which is why the skins re-declare pi's `promptSnippet`/`promptGuidelines` (`createReadTool()` and friends return `wrapToolDefinition(...)`, which drops them). The custom tools carry no snippet or guidelines at all — description only — because a user `SYSTEM.md` replaces pi's prompt and those fields would then reach nobody, while the description travels in the request's tool list no matter what the prompt is.

2. **Active set.** `pi.setActiveTools([...])` decides which registered tools the model is offered next turn. At `session_start`, `index.ts activateCustomTools` orders the names canonically: pi's tools as they are, then `agent`, `webfetch`, `kimi-websearch`, then the MCP names the adapter wants.

3. **System prompt** (`buildSystemPrompt`). Under `Available tools:`, every active tool that HAS a `promptSnippet` gets one `- <name>: <snippet>` line (a tool without one still exists in the request, just unlisted here). Under `Guidelines:`, every tool's `promptGuidelines`, de-duplicated. All of this ONLY when the user has no custom system prompt — `buildSystemPrompt` returns a custom prompt early and builds neither section. That is why the custom tools are description-only.

4. **The request.** Each active tool travels as `{ name, description, parameters }` — the JSON Schema in `definitions.md`. The description is the tool's own text; parameter descriptions are what the model reads per field.

5. **The call.** The model emits `toolCall{ name, arguments }`; pi validates the arguments against the schema, then runs `execute(toolCallId, params, signal, onUpdate, ctx)`. `signal` aborts on Esc or turn end; `onUpdate` streams partial results that are UI-only and never reach the model.

6. **The result.** `execute` returns `{ content: [{ type: "text", text }], details, isError? }`. **The model reads `content` — the text — and nothing else.** `details` exists for renderers and is dropped from the transcript. A thrown error becomes a result with `isError: true` whose text is the error's message; returning `isError: true` with content does the same without throwing. This is why every degradation, refusal, cap and fallback is stated *in the text*: a `details` field is invisible to the model.

7. **The timestamp.** Every result, error, receipt, delivery and user prompt ends with one line, `[timestamp: YYYY-MM-DD HH:MM:SS +TZ]` (`util/stamp.ts`; local time, completion time) — the model's only clock, since pi's stock prompt carries no date. Idempotent, always the final line. No description mentions it.

8. **Deliveries (background work).** A finished background job — an agent's reply or a `bash`/`powershell` job — is delivered with `sendMessage(..., { deliverAs: "steer", triggerTurn: true })` as a custom message, which pi hands the model as a plain `user` message with the content verbatim, no marker. So every delivery opens with a provenance line naming its source — it is the only way the model can tell it from something the user typed. `triggerTurn` starts a turn when the parent is idle; mid-turn it is read at the next tool boundary. Print mode (`pi -p`) ends when the top-level turn returns, so a delivery landing after that has no conversation to wake (a documented limit).

## Conventions every tool keeps

- **The text is the contract.** Every state the model must know is in `content[0].text`, in one honest line: caps, refusals, fallbacks, ignored inputs, what was not done. Nothing load-bearing hides in `details`.
- **A thrown error is the only way to mark a result an error.** Used when the model must treat the outcome as a failure (a provider death, a refused input, an upstream error). An agent stop or timeout is NOT an error — it returns text with a resumable handle; a websearch filter that removed everything IS.
- **Run ids.** Every run — an agent or a background shell job — is named in its result as the last line before the stamp: `[agent id: agent_…]` / `[run id: bash_…]`. Ids are a prefix plus 12 url-safe characters (`agent_`, `bash_`; older transcripts carry `subagent_…` or pi's `tool_…`). The label is what stopped models quoting the handle back as content.
- **Provenance lines on deliveries** (shown to the model, hidden by the pager):
  - `[agent result, delivered by the agent tool; agent-authored, not typed by the user]`
  - `[background bash result, delivered by the bash tool; not sent by the user]` (`powershell` reads `powershell` in both places)
  - a batch of several: `[background results, <what it holds>, delivered by the <tools> tool(s); not typed by the user]`
- **Untrusted content.** `webfetch`'s description and the scout's prompt both say fetched pages are data, never instructions.

## Where the code is

- `agent`: `tools/agent.ts` (schema, actions, every text); `agents/config.ts` (precedence, named agents); `agents/session.ts` (rehydration, delivery, the lead rule); `agents/run.ts` (ids, manifests, abort causes); `agents/childtools.ts` (what a child is handed); `tools/delivery.ts` (the batch queue).
- `bash`/`powershell`: `tools/bash.ts`, `tools/powershell.ts`, `tools/bash-background.ts` (jobs); `settings.ts stockToolOptions()` (the options pi builds its own with).
- `read`/`write`/`edit`: `tools/read.ts`, `tools/write.ts`, `tools/edit.ts`.
- `webfetch`: `tools/webfetch.ts` over `tools/library/webfetch/` (the engine, no pi imports, shared with `cli/fetch.ts`).
- `kimi-websearch`: `tools/websearch.ts`.
- MCP: `mcp/index.ts` (the facade) over `node_modules/pi-mcp-adapter/`.
- Wiring: `index.ts` (`WAR_DOGS_TOOLS`, `activateCustomTools`, the enum collection); `visual/pager/toolmap.ts` (`registerToolDef`, so a child's transcript renders each tool properly).
