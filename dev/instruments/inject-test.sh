#!/usr/bin/env bash
# The inject feature and the project-trust gate, on the wire (2026-08-28).
# Boots real pi in -p mode against the mock model from a PRIVATE agent dir
# that carries inject/ files, in three projects — trusted (store true),
# refused (store false) and never-asked (store null, none of pi's own
# trust-requiring resources) — plus --approve in the refused one, and a
# --continue turn in the trusted one. Reads the mock's DUMP and asserts
# what rode: order, once-per-session, per-turn repetition, and the gate
# (README "Injected messages", "Trust"; the ledger's shortcut-trust entry).
# Needs: node, pi on PATH, a free port. No real model is used.
set -u
cd "$(dirname "$0")/../.."
WD=$(pwd)
PORT=${PORT:-18912}
R=$(mktemp -d)
AG="$R/agent"
mkdir -p "$AG/extensions" "$AG/inject" "$R/cwd-t/.pi/inject" "$R/cwd-u/.pi/inject" "$R/cwd-n/.pi/inject"
ln -sfn "$WD" "$AG/extensions/war-dogs"
printf '{}' > "$AG/auth.json"
printf '{"providers":{"mock":{"baseUrl":"http://127.0.0.1:%s/v1","api":"openai-completions","apiKey":"x","models":[{"id":"mock","name":"Mock","reasoning":true,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":100000,"maxTokens":8000}]}}}' "$PORT" > "$AG/models.json"
printf '{"defaultProvider":"mock","defaultModel":"mock","war-dogs":{"enabled":true}}' > "$AG/settings.json"
printf '{"%s": true, "%s": false}' "$R/cwd-t" "$R/cwd-u" > "$AG/trust.json"
printf 'GLOBAL START\n' > "$AG/inject/SESSION_START.md"
printf 'GLOBAL TURN\n' > "$AG/inject/PER_TURN.md"
for d in cwd-t cwd-u cwd-n; do
	printf 'PROJECT START\n' > "$R/$d/.pi/inject/SESSION_START.md"
	printf 'PROJECT TURN\n' > "$R/$d/.pi/inject/PER_TURN.md"
done

DUMP="$R/dump.jsonl"
PORT=$PORT WORDS=3 INTERVAL=5 DUMP="$DUMP" node dev/instruments/mock-llm.mjs > "$R/mock.log" 2>&1 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 1

run() { # $1 cwd, then pi args
	local d="$1"; shift
	(cd "$R/$d" && PI_CODING_AGENT_DIR="$AG" timeout 120 pi -p "$@" < /dev/null > /dev/null 2> "$R/err.txt")
	if grep -q 'war-dogs' "$R/err.txt"; then echo "✗ stderr carried war-dogs lines:"; cat "$R/err.txt"; return 1; fi
}
run cwd-t "one" || exit 1
run cwd-t -c "two" || exit 1
run cwd-u "three" || exit 1
run cwd-n "four" || exit 1
run cwd-u --approve "five" || exit 1
# A never-asked project under a global `defaultProjectTrust: "always"` (pi's
# fallback after the store; 2026-08-30): the project rides.
printf '{"defaultProvider":"mock","defaultModel":"mock","war-dogs":{"enabled":true},"defaultProjectTrust":"always"}' > "$AG/settings.json"
run cwd-n "six" || exit 1
kill $MOCK 2>/dev/null; trap - EXIT

# Each request's user-role texts after the prompt, first line each, as one
# string per request; the session brief is a fixed prefix on a first turn.
AG="$AG" node - "$DUMP" <<'EOF'
const fs = require("node:fs");
const reqs = fs.readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => JSON.parse(l).body);
const first = (m) => (typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")).split("\n")[0];
const tail = (r) => {
	const us = r.messages.filter((m) => m.role === "user").map(first);
	// after the LAST prompt (the -c run carries the earlier turn too)
	const i = us.map((t, k) => (/^(one|two|three|four|five|six)$/.test(t) ? k : -1)).filter((k) => k >= 0).pop();
	return us.slice(i + 1).map((t) => (t.startsWith("[session brief") ? "BRIEF" : t)).join(" | ");
};
const want = [
	["trusted, first turn", "BRIEF | GLOBAL START | PROJECT START | GLOBAL TURN | PROJECT TURN"],
	["trusted, --continue (session-starts once, per-turns again)", "GLOBAL TURN | PROJECT TURN"],
	["refused (store false): global only", "BRIEF | GLOBAL START | GLOBAL TURN"],
	["never asked (store null, no pi resources): global only", "BRIEF | GLOBAL START | GLOBAL TURN"],
	["refused + --approve: project rides for the run", "BRIEF | GLOBAL START | PROJECT START | GLOBAL TURN | PROJECT TURN"],
	["never asked + defaultProjectTrust always: project rides", "BRIEF | GLOBAL START | PROJECT START | GLOBAL TURN | PROJECT TURN"],
];
if (reqs.length !== want.length) { console.log(`✗ expected ${want.length} requests, got ${reqs.length}`); process.exit(1); }
let fail = 0;
want.forEach(([name, exp], k) => {
	const got = tail(reqs[k]);
	const ok = got === exp;
	if (!ok) fail = 1;
	console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n    want: ${exp}\n    got:  ${got}`}`);
});
// The first turn's persisted entries carry provenance in details, not text.
const sess = fs.readdirSync(`${process.env.AG}/sessions`, { recursive: true }).filter((f) => f.endsWith(".jsonl"));
const entries = sess.flatMap((f) => fs.readFileSync(`${process.env.AG}/sessions/${f}`, "utf8").trim().split("\n").map((l) => JSON.parse(l)));
const inj = entries.filter((e) => e.type === "custom_message" && e.customType === "inject");
const provenance = inj.every((e) => e.details && e.details.kind && e.details.scope && e.details.path && e.display === true);
console.log(`${provenance ? "✓" : "✗"} ${inj.length} persisted inject entries, each with details {kind, scope, path} and display:true`);
if (!provenance) fail = 1;
process.exit(fail);
EOF
RC=$?
[ $RC -eq 0 ] && echo "━━ INJECT: ALL GREEN" || echo "━━ INJECT: FAILURES (rig kept at $R)"
exit $RC
