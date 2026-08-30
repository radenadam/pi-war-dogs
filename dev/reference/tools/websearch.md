# `kimi-websearch`

A direct search of the live web through Kimi's search microservice, with no model in the middle. One POST to `{baseUrl}/v1/search` (body `{"text_query": <query>}`, `Authorization: Bearer <apiKey>` from pi's `kimi-coding` provider auth, 30 s timeout) returns raw structured results — title, site, date, snippet, url — which the model judges itself and reads in full before relying on. Kimi-first: the key comes from the `kimi-coding` provider, and `/v1/search` is undocumented internal surface that may change. Source: `tools/websearch.ts` (all of it).

## What to know

- **No LLM in the loop.** Unlike `webfetch`'s scout, this is a raw API call; the results are the service's, returned as-is for the model to weigh.
- **Operators.** Whatever the service honours is passed through untouched. The ones it silently ignores are applied client-side against the returned results: `-site:host` (excludes a host or its subdomains), `-term` (excludes a whole word, so `-c++` works), `after:YYYY-MM-DD` and `before:YYYY-MM-DD` (date bounds, `before` inclusive to end of day). Undated results are kept — a missing date is not evidence of age.
- **A malformed date is a refusal, never a silent no-op.** If a date operator cannot be parsed the tool errors rather than dropping the filter and returning results the user did not ask for.
- **The description tells the model to read the page itself** before relying on what a snippet suggests — stated as substance, never naming a fetch tool that might be off.

## In — what the model is given

- **Description, promptSnippet, promptGuidelines:** verbatim in `definitions.md`. The snippet is `Search the live web with kimi-websearch for raw structured results with dates`.

| parameter | required | type | what it does |
|---|---|---|---|
| `query` | yes | string | The search query, with any of the operators above. |
| `max_results` | no | number | How many results to return. Default 6; non-finite falls back to 6; clamped to 1–20. |

## Out — every text the model gets back

**Results** (the query is echoed as the model typed it):
```
Search results for "<query>" (<returned> of <total>[, <n> removed by client-side filters]):

1. <title | (no title)> | <site_name>[, <date>]
   <url>
   <snippet, whitespace-normalised, untruncated>

2. …
```

**Errors** (thrown, so `isError: true`):
- No results: `Kimi-WebSearch: no results for "<query>". Try rephrasing the query.`
- Everything filtered out: `Kimi-WebSearch: all <total> results for "<query>" were removed by filters (<the operators>). Loosen the filters or rephrase.`
- Empty query after operators: `Kimi-WebSearch: query is empty after removing filter operators`
- Unparseable date: `Kimi-WebSearch: unparseable date operator <tok>, <tok> — use YYYY-MM-DD (e.g. after:2026-08-01). Nothing was searched; the date filter would have been silently dropped.`
- No context / no key: `Kimi-WebSearch requires an extension context` · `No API key resolved for provider "kimi-coding"`
- Upstream: `Kimi-WebSearch HTTP <status>: <first 300 chars>[ (the /v1/search microservice may be gone)]` (the hint on 404/405) · `Kimi-WebSearch: non-JSON response: <first 300 chars>`
- Interrupted: `Search aborted by <who>: "<query>" was not searched.` (who: the user · the agent that started it · its timeout · the end of the turn that started it)
- Timed out: `Kimi-WebSearch: timed out after 30s.`

`details` (render-only, never read by the model): `query`, `returned`, `total`, `results[{title,url,site,date}]`, or `query`/`filteredOut` on the error shapes. The pager's one-line act reads `returned`/`total` from it (`Searched "q" — 6 of 11 results`).

## Constants

`PROVIDER_ID "kimi-coding"`, `SEARCH_PATH "/v1/search"`, `TIMEOUT_MS 30_000`, `DEFAULT_MAX_RESULTS 6`, hard cap 20. The key travels only in the `Authorization` header.
