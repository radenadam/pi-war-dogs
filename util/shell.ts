/**
 * Derive PROGRAM NAMES from a shell command, for the bash beat's fallback
 * sentence: when the model gave no
 * `description`, the beat reads `Ran tsc` / `Ran find, wc` — never the raw
 * command line. The parse is a heuristic, not a shell: it only has to name
 * what ran, and a miss costs one odd word in a UI sentence while the fold
 * still holds the truth.
 *
 * Rules (spec + the obvious closure of it):
 *  - one program per segment of the `|` / `&&` / `||` / `;` / newline chain,
 *    split quote- and $(...)-aware so separators inside strings don't split;
 *  - assignments (`FOO=1`), redirects and flags are skipped;
 *  - wrapper programs (`sudo`, `env`, `timeout`, `nice`, `xargs`, ...) are
 *    skipped so the wrapped program surfaces (`timeout 30 tsc` -> tsc);
 *  - noise segments (`cd`, `export`, `exit`, control-flow tails) yield
 *    nothing at all — `cd x && make` -> make;
 *  - paths are basenamed (`/usr/bin/git` -> git), names dedupe in order.
 *
 * Pure module: no pi imports, probe it in isolation.
 */

/** Builtins whose whole segment names nothing that "ran". */
const SEGMENT_NOISE = new Set([
	"cd",
	"export",
	"unset",
	"set",
	"source",
	".",
	":",
	"exit",
	"return",
	"wait",
	"shift",
	"true",
	"false",
	// Condition builtins. `if [ -f x ]; then cp x y; fi` rested as
	// `executed bash • [, cp` — a bare `[` reads as noise in a sentence,
	// and the test names nothing that "ran" to a person reading the beat.
	"[",
	"[[",
	"test",
	"done",
	"fi",
	"esac",
	"for",
	"case",
	"function",
	// Group/arith/def syntax and builtins that name nothing that "ran".
	// `{ echo a; echo b; } > out` rested as `executed bash • echo, }` —
	// the closer rides on the last segment, and `}` is not a program.
	"{",
	"}",
	"((",
	"))",
	"select",
	"trap",
	"local",
	"declare",
	"readonly",
	"eval",
]);

/** Wrappers to skip so the program they wrap surfaces instead. */
export const WRAPPERS: ReadonlySet<string> = new Set([
	"sudo",
	"doas",
	"env",
	"timeout",
	"nice",
	"nohup",
	"time",
	"command",
	"builtin",
	"exec",
	"stdbuf",
	"unbuffer",
	"xargs",
	"if",
	"elif",
	"while",
	"until",
	"do",
	"then",
	"else",
]);

/** Wrapper flags that consume the NEXT token as their value. */
const VALUE_FLAGS = new Set(["-u", "-g", "-n", "-k", "-s", "-p"]);

/** `timeout`'s duration operand: `30`, `2.5`, `30s`, `5m`. */
const DURATION = /^\d+(\.\d+)?[smhd]?$/i;

/**
 * Split a command into pipeline/chain segments, respecting single quotes,
 * double quotes, backslash escapes, backticks and `$(...)` nesting.
 */
/**
 * Is this `&` file-descriptor plumbing rather than a background separator?
 *
 * `2>&1`, `>&2`, `<&0` (a `>`/`<` immediately before) and `&>file` /
 * `&>>file` (a `>` immediately after) are part of a redirect token. Treating
 * them as separators split the fd number into its own segment, whose
 * "program" was the bare number: `npx tsc -p . 2>&1 | head -30` read as
 * three programs and the collapsed act rested as `executed bash • npx, 1,
 * head`. `2>&1` is one of the most common forms a model emits, so this was
 * the most-seen defect on the surface. `&&` is matched earlier and never
 * reaches here.
 */
function isRedirectAmp(cur: string, next: string | undefined): boolean {
	const prev = cur.replace(/\s+$/, "").slice(-1);
	return prev === ">" || prev === "<" || next === ">";
}

/** Set by splitSegments: whether the LAST segment it pushed was ended by a background `&`. */
let lastEndedByAmp = false;

function splitSegments(command: string): string[] {
	const segs: string[] = [];
	let cur = "";
	let i = 0;
	let inSingle = false;
	lastEndedByAmp = false;
	let inDouble = false;
	let inBacktick = false;
	let parenDepth = 0;
	const push = () => {
		if (cur.trim()) segs.push(cur);
		cur = "";
	};
	while (i < command.length) {
		const ch = command[i];
		const next = command[i + 1];
		if (ch === "\\" && !inSingle) {
			cur += ch + (next ?? "");
			i += 2;
			continue;
		}
		// An unquoted `#` at token start opens a comment to end of line: no
		// segment, no program, and it does not un-background a trailing `&`.
		if (ch === "#" && !inSingle && !inDouble && !inBacktick && (cur === "" || /\s$/.test(cur))) {
			while (i < command.length && command[i] !== "\n") i++;
			continue;
		}
		// `$(` is consumed as ONE opener wherever it appears, so the `(`
		// never re-increments the depth on the next pass (the double-count
		// that kept `$(date) | tee` from ever splitting).
		if (!inSingle && !inBacktick && ch === "$" && next === "(") {
			parenDepth++;
			cur += "$(";
			i += 2;
			continue;
		}
		if (inSingle) {
			if (ch === "'") inSingle = false;
		} else if (inDouble) {
			if (ch === ")" && parenDepth > 0) parenDepth--;
			else if (ch === '"') inDouble = false;
		} else if (inBacktick) {
			if (ch === "`") inBacktick = false;
		} else if (parenDepth > 0) {
			if (ch === "'") inSingle = true;
			else if (ch === '"') inDouble = true;
			else if (ch === "(") parenDepth++;
			else if (ch === ")") parenDepth--;
		} else {
			if (ch === "'") {
				inSingle = true;
			} else if (ch === '"') {
				inDouble = true;
			} else if (ch === "`") {
				inBacktick = true;
			} else if (ch === "$" && next === "(") {
				parenDepth++;
			} else if (ch === "\n" || ch === ";") {
				push();
				i++;
				continue;
			} else if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
				push();
				i += 2;
				continue;
			} else if (ch === "|") {
				push();
				i += next === "&" ? 2 : 1;
				continue;
			} else if (ch === "&" && !isRedirectAmp(cur, next)) {
				// background `&`: a separator, not part of a token
				const had = cur.trim().length > 0;
				push();
				if (had) lastEndedByAmp = true;
				i++;
				continue;
			}
		}
		if (ch.trim()) lastEndedByAmp = false;
		cur += ch;
		i++;
	}
	push();
	return segs;
}

/**
 * Whether the command's LAST command is backgrounded with a trailing `&`
 * (`sleep 60 &`, `nohup build.sh > log 2>&1 &`) — pi's bash has no background
 * mode; the shell returns at once and the child keeps running detached, so
 * the act has no output to show and the sentence should say why.
 */
export function bashBackgrounded(command: string): boolean {
	if (typeof command !== "string" || !command.trim()) return false;
	splitSegments(stripHeredocs(command));
	return lastEndedByAmp;
}

/**
 * Tokenize one segment on unquoted whitespace. Quoted spans, backtick spans
 * and `$(...)` substitutions stay inside one token, so an assignment like
 * `VAR=$(git rev-parse HEAD)` is ONE (skippable) token, not a program leak.
 */
function tokenize(segment: string): string[] {
	const toks: string[] = [];
	let cur = "";
	let i = 0;
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let parenDepth = 0;
	while (i < segment.length) {
		const ch = segment[i];
		const next = segment[i + 1];
		if (ch === "\\" && !inSingle && i + 1 < segment.length) {
			cur += segment[i + 1];
			i += 2;
			continue;
		}
		if (!inSingle && ch === "$" && next === "(") {
			parenDepth++;
			cur += "$(";
			i += 2;
			continue;
		}
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else cur += ch;
		} else if (parenDepth > 0) {
			if (ch === "(") parenDepth++;
			else if (ch === ")") parenDepth--;
			cur += ch;
		} else if (inDouble) {
			if (ch === '"') inDouble = false;
			else cur += ch;
		} else if (inBacktick) {
			if (ch === "`") inBacktick = false;
			else cur += ch;
		} else if (ch === "'") {
			inSingle = true;
		} else if (ch === '"') {
			inDouble = true;
		} else if (ch === "`") {
			inBacktick = true;
		} else if (/\s/.test(ch)) {
			if (cur) toks.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
		i++;
	}
	if (cur) toks.push(cur);
	return toks;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * A token can only NAME a program if it LOOKS like one.
 *
 * The derivation must not INVENT nouns (README, the visual language): a
 * command substitution (`$(which node) --version`), an arithmetic body
 * (`(( i++ ))`), a function header (`f() { … }`) and a comment (`#`) all
 * reached the sentence as programs. What "ran" there is either unknowable
 * (only the shell can expand a substitution) or not a program at all, so
 * the SEGMENT names nothing rather than naming something wrong — position
 * zero is where the program lives, and a segment whose head is not a name
 * has no other candidate to promote.
 *
 * Deliberately permissive about real program names: dots, dashes,
 * underscores, `+` (`g++`), `@`, `:` and `~` all occur in ones people run.
 */
const PROGRAM_NAME = /^[A-Za-z0-9_~][A-Za-z0-9_.+@:~-]*$/;
const REDIRECT = /^\d*[<>]|^&>/;
/**
 * A redirect token that is the OPERATOR ALONE, so its target is the next
 * token: `> out.txt`, `2>> err.log`, `&> log`. Self-contained forms like
 * `2>&1` or `>file` leave a remainder and are NOT matched, so they never
 * swallow the following word. Without this, a leading redirect made its
 * TARGET the segment's program — `2> err.log make` rested as
 * `executed bash • err.log`.
 */
const REDIRECT_OP_ONLY = /^(?:\d*[<>]{1,2}|&>{1,2})$/;

/** The one program a segment ran, or undefined when it names nothing. */
function segmentProgram(segment: string): string | undefined {
	const head = segment.trim();
	// Arithmetic evaluation and a comment run nothing. `((` cannot be caught
	// by the token pass: the opener regex below strips it, leaving the bare
	// expression (`i++`) looking exactly like a program name.
	if (head.startsWith("((") || head.startsWith("#")) return undefined;
	// Subshell/group openers wrap the first token: `(cd x; make)`. The
	// CLOSER has to come off too: splitSegments breaks inside plain `(...)`
	// (parenDepth only guards `$(...)`), so the group's `)` rides on the last
	// token of the last segment — `ls && (cd /tmp; pwd) || echo no` rested as
	// `executed bash • ls, pwd), echo`. Only UNQUOTED trailing structure is
	// stripped: `echo ")"` ends with a quote and is untouched.
	const toks = tokenize(segment.replace(/^[\s({!]+/, "").replace(/[\s)};]+$/, ""));
	let lastWrapper = "";
	for (let t = 0; t < toks.length; t++) {
		const tok = toks[t];
		if (!tok) continue;
		if (ASSIGNMENT.test(tok)) continue;
		if (REDIRECT.test(tok)) {
			// A bare operator takes the next token as its target.
			if (REDIRECT_OP_ONLY.test(tok)) t++;
			continue;
		}
		if (tok.startsWith("-")) {
			// A wrapper's value-taking flag consumes its operand too.
			if (lastWrapper && VALUE_FLAGS.has(tok)) t++;
			continue;
		}
		if (lastWrapper === "timeout" && DURATION.test(tok)) {
			lastWrapper = "";
			continue;
		}
		const name = tok.replace(/^["']|["']$/g, "");
		if (SEGMENT_NOISE.has(name)) return undefined;
		if (WRAPPERS.has(name)) {
			lastWrapper = name;
			continue;
		}
		// The program: basename it, drop empty results (a bare path sep).
		const base = name.split("/").filter(Boolean).pop() ?? "";
		// This token IS the segment's program slot — if it does not look like
		// a name, the segment names nothing (see PROGRAM_NAME). Promoting the
		// next token instead would print an ARGUMENT as the program.
		return base && PROGRAM_NAME.test(base) ? base : undefined;
	}
	return undefined;
}

/**
 * Program names for the derived bash sentence, deduped in first-run order.
 * Empty when the command names nothing usable — the caller's floor is
 * "Ran a shell command".
 */
/**
 * Remove heredoc BODIES before segmenting (round 28): `<<EOF … EOF` content
 * is data, not commands, but the newline splitter turned every body line
 * into a segment — an XML heredoc read as "107 commands". The operator and
 * delimiter survive so the carrying segment still parses.
 *
 * A LINE SCANNER, not a regex pair (round 31 audit). The regex form could
 * only match a heredoc that is CLOSED, so an UNTERMINATED one — a command
 * the model truncated, or a delimiter that never arrives — leaked its whole
 * body: `cat <<EOF\nsome text\nno terminator` rested as
 * `executed bash • cat, some, no`. Scanning line by line handles both in one
 * pass: consume body lines up to the delimiter, and when there is no
 * delimiter consume to the end. `<<<` is a here-STRING and never opens one.
 */
function stripHeredocs(command: string): string {
	if (!command.includes("<<")) return command;
	const lines = command.split("\n");
	const out: string[] = [];
	const op = /<<-?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*))/g;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		out.push(line);
		op.lastIndex = 0;
		const delims: string[] = [];
		let m: RegExpExecArray | null = op.exec(line);
		for (; m; m = op.exec(line)) {
			// `<<<` is a here-string: the match can land on either `<` pair.
			if (line[m.index - 1] === "<" || line[m.index + 2] === "<") continue;
			delims.push(m[2] ?? m[3]);
		}
		if (!delims.length) continue;
		// One body per operator on the line (`cat <<A <<B`), in order.
		let j = i + 1;
		for (const d of delims) {
			while (j < lines.length && lines[j].trim() !== d) j++;
			j++;
		}
		i = Math.min(j, lines.length) - 1;
	}
	return out.join("\n");
}

export function bashPrograms(command: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	if (typeof command !== "string" || !command.trim()) return out;
	for (const seg of splitSegments(stripHeredocs(command))) {
		const prog = segmentProgram(seg);
		if (prog && !seen.has(prog)) {
			seen.add(prog);
			out.push(prog);
		}
	}
	return out;
}
