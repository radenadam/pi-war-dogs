# `read` / `write` / `edit` — the file skins

These are pi's own file tools, re-registered by war-dogs so their calls render as war-dogs acts. In behaviour they are pi's: same schemas, same execute, built with the same per-tool options pi uses (`stockToolOptions()` — `images.autoResize` for `read`). Two things are war-dogs': all three descriptions are rewritten in the one house voice, and two of the three diverge a little further, each documented below. The snippet and guidelines stay pi's verbatim on all three. Source: `tools/read.ts`, `tools/write.ts`, `tools/edit.ts`; pi's own `dist/core/tools/{read,write,edit}.js` for the shared behaviour.

**Why re-register at all:** to attach the renderers. Re-registration forces re-declaring `promptSnippet`/`promptGuidelines`, because `createReadTool()` and friends return `wrapToolDefinition(...)`, which drops that metadata, and an override never inherits it from the built-in. Off re-registers nothing, so pi's own tools are back exactly.

Descriptions, snippets, guidelines and full schemas are verbatim in `definitions.md`.

## `read` — war-dogs owns the text path

`read` returns a file's text with real line numbers; images and every error delegate to pi's execute unchanged.

| parameter | required | type | what it does |
|---|---|---|---|
| `path` | yes | string | The file to read. |
| `offset` | no | number | 1-based line to start at. |
| `limit` | no | number | How many lines to read; honoured exactly, past the default cap, clamped to EOF. |

**Text result:** each line prefixed `cat -n` style (`%6d\t`, the file's real line numbers), then a blank line and one bracketed metadata line:
- `[Read <total> lines, <size>]` — the whole file
- `[Read lines <a>-<b> of <total> (<shown> of <size>). Continue with offset=<n>.]` — more remains
- `[Read lines <a>-<b> of <total> (<shown> of <size>).]` — a window read to the end
- `[Read 0 lines, 0 B]` — an empty file

The default cap is pi's numbers (2000 lines / 50 KB), line-aligned. An explicit `limit` is honoured exactly and past the cap, so `limit` at or above the file's length reads it whole in one call. A single line over the byte budget keeps pi's recovery text: `[Line <n> is <size>, exceeds 50.0 KB limit. Use bash: sed -n '<n>p' <path> | head -c 51200]`.

**Errors:** `Offset <n> is beyond end of file (<total> lines total)` (war-dogs' path, pi's wording); missing files, permissions and directories delegate to pi's execute, byte for byte. **Images:** fully pi's — the image itself as a content block.

Children get this same `read`. The pager's panel strips the number prefixes (its own gutter draws them); the model's text is the numbered form.

## `write` — pi's, unchanged

Writes a whole file; the description states it replaces the entire file and is never a partial change.

| parameter | required | type | what it does |
|---|---|---|---|
| `path` | yes | string | The file to write. Parent directories are created. |
| `content` | yes | string | The full new contents. |

**Text result:** `Successfully wrote <bytes> bytes to <path>`. Aborted → thrown `Operation aborted`; filesystem errors thrown as pi reports them.

## `edit` — pi's, plus one wording change on a rejected batch

Replaces one or more exact-match regions of a file, atomically.

| parameter | required | type | what it does |
|---|---|---|---|
| `path` | yes | string | The file to edit. |
| `edits` | yes | array of `{oldText, newText}` | Each `oldText` must match a unique, non-overlapping region of the ORIGINAL file; the batch applies atomically. The description states the matched-against-the-original semantic outright — the one correctness fact the model cannot guess. |

**Text result:** `Successfully replaced <n> block(s) in <path>.` (`details.diff`, which the UI draws, is render-only.)

**Errors thrown by pi** (→ `isError`):
- `Could not find the exact text in <path>. The old text must match exactly including all whitespace and newlines.` (single edit)
- `Could not find edits[<i>] in <path>. The oldText must match exactly including all whitespace and newlines.` (batch)
- `No changes made to <path>. The replacement produced identical content. …`
- `Edit tool input is invalid. edits must contain at least one replacement.`
- `Could not edit file: <path>. <fs message>.`
- `Operation aborted`

**war-dogs' one addition:** when a call with more than one edit throws, the message gains `\n\nNo edits were applied: batches are atomic (0 of <n>). Fix the failing oldText and resubmit the whole batch.` — because pi applies a batch atomically but names only one failing `oldText`, and models retried edit-by-edit believing the others had landed. A single-edit failure is pi's message untouched.

## Verifying the skins against pi

`dev/internals/README.md`, Debugging → *skins*: load pi's `create*ToolDefinition` (with `stockToolOptions()`) and the four skins through jiti and byte-compare `promptSnippet` and `promptGuidelines` — identical on all four. The sanctioned divergences are only: all four descriptions are ours; `bash` adds `description`/`background` params and the background execute branch; `edit` wraps `execute` for the batch wording; `read` owns its text-path `execute` and its `parameters`.
