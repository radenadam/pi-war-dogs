#!/usr/bin/env bash
# The one-command verification gate: every instrument this repo owns, one
# exit code. Run before any commit that touches behaviour, and always
# before a release. Requirements: node >= 22.19, tmux, pi on PATH, and a
# configured model in ~/.pi/agent (the acceptance harness boots real pi).
#
#   ./dev/ci.sh            everything
#   ./dev/ci.sh quick      typecheck + format + headless boot only
set -u
cd "$(dirname "$0")/.."
FAIL=0
step() { echo; echo "━━ $1"; }
run() { "$@" || { echo "✗ FAILED: $*"; FAIL=1; }; }

step "typecheck"
run npm run --silent typecheck

step "format"
run npm run --silent format:check

step "headless boot (mock rig; silence on stderr = clean load)"
CI_AG=$(mktemp -d)/agent
mkdir -p "$CI_AG/extensions"
ln -sfn "$(pwd)" "$CI_AG/extensions/war-dogs"
printf '{}' > "$CI_AG/auth.json"
printf '{"providers":{"mock":{"baseUrl":"http://127.0.0.1:18901/v1","api":"openai-completions","apiKey":"x","models":[{"id":"mock","name":"Mock","reasoning":true,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":100000,"maxTokens":8000}]}}}' > "$CI_AG/models.json"
printf '{"defaultProvider":"mock","defaultModel":"mock","war-dogs":{"enabled":true}}' > "$CI_AG/settings.json"
BOOT_ERR=$(echo '{"id":"1","type":"get_state"}' | PI_CODING_AGENT_DIR="$CI_AG" timeout 60 pi --mode rpc --no-session 2>&1 >/dev/null | grep 'war-dogs' || true)
if [ -n "$BOOT_ERR" ]; then echo "✗ FAILED: boot errors:"; echo "$BOOT_ERR"; FAIL=1; else echo "clean"; fi

if [ "${1:-}" = "quick" ]; then
	[ $FAIL -eq 0 ] && echo "━━ QUICK: ALL GREEN" || echo "━━ QUICK: FAILURES"
	exit $FAIL
fi

step "agent scenario suite (mock model; a thrown scenario is a failure)"
# A stray mock on the port (a dev session's, left behind) makes every scenario
# run against the WRONG mock and bigreply fail on nothing (2026-08-29/30, four
# times). Refuse to start on a busy port: name it, stop.
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':18901 '; then
	echo "✗ FAILED: port 18901 is busy — a stray dev/instruments/mock-llm.mjs? kill it by pid (never pkill -f a pattern your own shell carries)"
	exit 1
fi
PORT=18901 WORDS=60 INTERVAL=10 node dev/instruments/mock-llm.mjs >/tmp/wd-ci-mock.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null' EXIT
sleep 1
# The hygiene scenario's fixtures: a named agent that names war-dogs itself
# (refused with a note) and the two append files (only the child one rides).
mkdir -p "$CI_AG/subagents"
printf -- '---\ndescription: probe\nextensions: ["war-dogs"]\n---\nYou are a probe agent. Answer briefly.\n' > "$CI_AG/subagents/wd.md"
printf 'MAIN-APPEND-MARK\n' > "$CI_AG/APPEND_SYSTEM.md"
printf 'CHILD-APPEND-MARK\n' > "$CI_AG/SUBAGENT_APPEND_SYSTEM.md"
# A second rig with agent.concurrency 1 (the timers scenario queues behind one run).
CI_AG1=$(mktemp -d)/agent
mkdir -p "$CI_AG1/extensions"
ln -sfn "$(pwd)" "$CI_AG1/extensions/war-dogs"
cp "$CI_AG/auth.json" "$CI_AG/models.json" "$CI_AG1/"
printf '{"defaultProvider":"mock","defaultModel":"mock","war-dogs":{"enabled":true},"agent":{"concurrency":1}}' > "$CI_AG1/settings.json"
CI_CWD=$(mktemp -d)
for sc in smoke usersteer queuedmsg tailrace claims3 flushrace stops hygiene leadrule reachself timers interruptflow leadinterrupt leadaltx parallelbatch userstop idlekeys leadsteer leadsessionend bgsessionend bgprefix shellps batchline provenance; do
	echo "── scenario $sc"
	EXTRA=""
	AGDIR="$CI_AG"
	[ "$sc" = flushrace ] && EXTRA="WAR_DOGS_DELIVERY_WINDOW_MS=8000"
	[ "$sc" = timers ] && AGDIR="$CI_AG1"
	if ! env PI_CODING_AGENT_DIR="$AGDIR" WD_CWD="$CI_CWD" SETTLE_MS=1500 $EXTRA timeout 240 \
		node dev/instruments/agent-harness.mjs "$sc" > "/tmp/wd-ci-$sc.log" 2>&1; then
		echo "✗ FAILED: scenario $sc (log: /tmp/wd-ci-$sc.log)"
		tail -5 "/tmp/wd-ci-$sc.log"
		FAIL=1
	fi
done
kill $MOCK_PID 2>/dev/null
# Reap it: kill is asynchronous, and the big mock below raced it for the port
# (EADDRINUSE, then bigreply ran against the small mock — 2026-08-29, twice).
wait $MOCK_PID 2>/dev/null || true
trap - EXIT
# The reply cap needs a mock that streams past 200k characters.
PORT=18901 WORDS=40000 INTERVAL=0 node dev/instruments/mock-llm.mjs >/tmp/wd-ci-mock-big.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null' EXIT
sleep 1
echo "── scenario bigreply"
if ! env PI_CODING_AGENT_DIR="$CI_AG" WD_CWD="$CI_CWD" SETTLE_MS=1500 timeout 240 node dev/instruments/agent-harness.mjs bigreply > /tmp/wd-ci-bigreply.log 2>&1 \
	|| ! grep -q 'reply truncated: first 200000' /tmp/wd-ci-bigreply.log; then
	echo "✗ FAILED: scenario bigreply (log: /tmp/wd-ci-bigreply.log)"
	FAIL=1
fi
kill $MOCK_PID 2>/dev/null
wait $MOCK_PID 2>/dev/null || true
trap - EXIT

step "inject + trust gate on the wire (mock; real pi -p, five requests)"
run ./dev/instruments/inject-test.sh

step "Esc takes the prompt back (mock; real pi in tmux, three cases)"
run ./dev/instruments/undo-test.sh

step "off = stock (acceptance harness; needs a real configured model)"
run ./dev/instruments/acceptance-test.sh

echo
[ $FAIL -eq 0 ] && echo "━━ CI: ALL GREEN" || echo "━━ CI: FAILURES ABOVE"
exit $FAIL
