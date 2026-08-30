# `webfetch`

Fetch one public http/https URL and return its content as markdown behind a **typed status** the model must check. It is not a byte dump: the status says whether the page is readable (`ok`) or blocked, walled, missing or errored, and the same classification is reached on both tiers — a fast static HTTP tier (~300 ms) and a Chrome render tier (one shared headless daemon per machine). Chrome-assumed: the render tier needs a system Chrome/Chromium on `PATH`, and degrades to a typed error naming the missing binary when there is none. Source: `tools/webfetch.ts` (schema, description, result assembly, the scout branch) over `tools/library/webfetch/` (the engine, no pi imports, shared with `cli/fetch.ts`).

## What to know

- **The status is the point.** Every fetch returns one of `ok`, `js-shell`, `bot-wall`, `consent-wall`, `login-wall`, `paywall-hard`, `paywall-soft`, `not-found`, `rate-limited`, `error` — decided the same way on both tiers, so the model always knows whether it actually read the page.
- **One extractor, both tiers.** HTML becomes markdown with tables, fenced code, resolved links and alt text; charsets are decoded; a PDF goes through poppler; plain-text bodies (robots, READMEs, RSS) come back verbatim; only real binaries get a placeholder. The two tiers never answer differently for the same page.
- **`tier`** picks the path: `auto` (default) runs static and escalates to render on doubt (a JS shell, a wall, a `needs-render` signal); `static` never escalates; `render` skips static.
- **`mode`** shapes the output: `whole` (default) prepends a page map of the site's navigation, tabs and controls; `content` is the body alone.
- **Long pages are cut at a reading limit** (2000 lines / 50 KB), the whole page saved to disk, and the text says exactly how to continue — a cap the reader can see, never a silent truncation.
- **The scout.** With `expect` set (and `url`, or up to 10 `urls`), the work goes to a headless `pi -p` on this machine's model that fetches and judges each page against your criteria and returns verdicts plus only the useful extracts. It fetches through the CLI, never through this tool, so recursion is structurally impossible.
- **Fetched content is untrusted.** The description and the scout's own prompt both state that a fetched page is third-party data, never instructions to follow.
- **The SSRF guard** checks every hop on both tiers (DNS-pinned on the static tier, IPv6 judged as numbers); a blocked address is an `error`, never a fetch.

## In — what the model is given

- **Description** (the status contract, the scout, the untrusted-content rule, the truncation/resume rule, `fresh`, the public-URL rule), **promptSnippet** (`Fetch and read a specific URL with WebFetch (renders JS, reads PDFs; returns a typed status + content).`) and **promptGuidelines**: verbatim in `definitions.md`.

| parameter | required | type | what it does |
|---|---|---|---|
| `url` | one of `url`/`urls` | string | The single page to fetch and read. |
| `urls` | with `expect` | string[] | Up to 10 candidate pages for the scout; requires `expect`. |
| `expect` | for a scout run | string | What you need from the page(s); switches to the scout. |
| `mode` | no | `whole`\|`content` | `whole` (default) prepends the page map; `content` is the body alone. |
| `tier` | no | `auto`\|`static`\|`render` | Which fetch path; `auto` is the default. |
| `fresh` | no | boolean | Bypass and replace the cache entry. |

## Out — a direct fetch

The result always opens with a head line, then an optional meta line:
```
[webfetch: <status> · tier:<http|render>[ · cache-hit…] · <finalUrl>]
<title> · by <byline> · published <date> · updated <date>   (only the parts that exist)
```
Then, by status:

- **`ok` with content:** the head, the meta, an optional `[note: …]` line, then the markdown. The note appears only when the result is degraded (not the whole page): `extract-empty`, `extract-capped:<chars>`, `pdf-capped:<chars>`, `pdf-extraction-empty (scanned/encrypted?)`, `needs-render: …`, `charset-fallback|charset-suspect`, `body-capped:<n>b (the page is larger; the rest was not downloaded)`, `content-type-mismatch:…`, `blocked-by-policy: …`, and similar. Bookkeeping notes never print.
- **`ok` with no extracted content:** `No readable content was extracted from this page[ (<notes>)]. It may be JavaScript-rendered — retry with tier:"render" — or the URL may not be an article.`
- **`error`:** the head, then the notes joined by ` · ` (or `The page failed to load.`) — e.g. `blocked-by-policy: private/reserved IP (127.0.0.1)`.
- **any wall/miss status:** the head, then one sentence of why — `bot-wall` → `The site blocked automated access (bot/captcha challenge). No page content was retrieved.` · `consent-wall` → `A cookie/consent wall blocked the page; no content retrieved.` · `login-wall` → `The page requires signing in; no content retrieved.` · `paywall-hard` → `The content is behind a paywall; none was retrieved.` · `paywall-soft` → `Only partial content is available behind a paywall (shown below).` + the partial content · `js-shell` → `The page rendered but produced almost no text (empty app shell or a blocked load).` · `not-found` → `The page was not found (404/410).` · `rate-limited` → `The site is rate-limiting; try again later.`
- **`mode:"whole"`** content begins with `## Page map — structure & affordances` (landmarks, `[tablist] tab · tab`, controls), then `\n\n---\n\n`, then the body.
- **Truncated content** ends inside the content, so it is read in order: `… [truncated — showing <kept> lines / <kb> KB of <total> / <totalKb> KB. To read the rest, read <savedPath> starting at line <resumeLine> (reading it from the start returns this same chunk).]` — or, when the cut landed mid-line, a `tail -c +<byte> <savedPath>` instruction — or, when the save failed, `… Full content could NOT be saved to disk.]`.

**Thrown** (→ `isError`):
- `webfetch: \`urls\` requires \`expect\` — it is the scout's candidate list, and without expect only \`url\` is fetched. Either pass expect:"…", or call webfetch once per URL.`
- `WebFetch requires a url (or urls together with expect for a scout run).`
- Interrupted: `Fetch aborted by <who>: <url> was not read.` (direct) or `Fetch aborted by <who>: the scout was stopped with the turn; nothing was judged.` (scout). The fetch in flight finishes on its own and is dropped.

`details` (render-only): `url status httpStatus title truncated fullContentPath contentChars links notes`. The pager's one-line act reads `status`/`contentChars`/`truncated` (`Fetched host — ok · ~8k tokens`).

## Out — a scout run (`expect` set)

- **Success:** `[webfetch: expect · <profile> · <secs>s · <n> URL(s)][\n[config: <warnings>]]\nlooking_for: <expect>\n\n` then per URL `<i>. <verdict> | <url>` (plus `   <reason>`, `   evidence: "<evidence>"`, and for extracts `   --- extract (<form>, <chars> chars) ---\n<text>`), or `The scout returned no verdicts.`, then any URLs past `maxUrls` listed as `NOT evaluated … — fetch these yourself if you need them`.
- **Failure** (`isError`): `[webfetch: expect-error · <profile>]\n\nThe expect evaluation failed: <error>[\n[config: …]]\nThe URLs were not evaluated; you may need to fetch them yourself:\n1. <url>…`.

## Config and env

The scout is configured under `war-dogs.expect` in settings (project block only when trusted): `profile`, `maxUrls` (10), `timeoutMs` (240000), `fetchCommand` (default `npm run fetch -- <url> --content --full`), and `profiles.<name> = {cmd, args, env, output}`. The default profile spawns the running pi (`-p --no-session --mode json --no-extensions`) on this machine's model at thinking low; its system prompt is `tools/library/webfetch/scout-system-prompt.md`.

Env: `WEBFETCH_CACHE_TTL_MS` (60000; explicit `0` disables), `WEBFETCH_CONCURRENCY` (4, floor 1), `WEBFETCH_DAEMON_IDLE_MS` (600000), `BWF_DEBUG`. Saved page bodies live under `<os.tmpdir()>/war-dogs-webfetch-<uid>/` (0700). `poppler` (`pdftotext`/`pdfinfo`) is needed for PDFs. `cli/fetch.ts` (`npm run fetch -- <url>`) is the same engine for humans and for the scout.
