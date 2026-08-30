#!/usr/bin/env bash
# Esc takes an accidental prompt back (tools/undo.ts), driven in tmux against
# the mock model from a private agent dir. Two cases: (1) a prompt whose turn
# was still streaming prose when Esc came — the prompt must be back in the
# editor and gone from the branch on screen; (2) a prompt whose turn ran a
# tool before Esc — the prompt must be KEPT (the model acted on it). Needs
# tmux, pi on PATH, a free port. No real model.
set -u
cd "$(dirname "$0")/../.."
WD=$(pwd)
PORT=${PORT:-18913}
R=$(mktemp -d)
AG="$R/agent"
mkdir -p "$AG/extensions" "$AG/themes" "$R/cwd"
ln -sfn "$WD" "$AG/extensions/war-dogs"
cp "$WD"/visual/theme/*.json "$AG/themes/"
printf '{}' > "$AG/auth.json"
printf '{"providers":{"mock":{"baseUrl":"http://127.0.0.1:%s/v1","api":"openai-completions","apiKey":"x","models":[{"id":"mock","name":"Mock","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":100000,"maxTokens":8000}]}}}' "$PORT" > "$AG/models.json"
printf '{"defaultProvider":"mock","defaultModel":"mock","war-dogs":{"enabled":true},"theme":"canopy"}' > "$AG/settings.json"
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":$PORT "; then echo "✗ port $PORT busy"; exit 1; fi
PORT=$PORT WORDS=600 INTERVAL=25 node dev/instruments/mock-llm.mjs > "$R/mock.log" 2>&1 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null; tmux kill-session -t wd_undo 2>/dev/null' EXIT
sleep 1
tmux kill-session -t wd_undo 2>/dev/null
tmux new-session -d -s wd_undo -x 140 -y 40 -c "$R/cwd" -e "PI_CODING_AGENT_DIR=$AG" pi || { echo "✗ could not start pi"; exit 1; }
sleep 8
FAIL=0
# (1) a streaming turn: Esc 1.5 s in.
tmux send-keys -t wd_undo -l -- "undo me please one"; sleep 0.3; tmux send-keys -t wd_undo Enter; sleep 1.5
tmux send-keys -t wd_undo Escape; sleep 3
S1="$(tmux capture-pane -t wd_undo -p)"
if echo "$S1" | grep -q "❯ undo me please one"; then echo "✗ (1) the prompt box is still on the branch"; FAIL=1; fi
if ! echo "$S1" | tail -8 | grep -q "undo me please one"; then echo "✗ (1) the prompt is not back in the editor"; FAIL=1; fi
if echo "$S1" | grep -q "prompt taken back"; then :; else echo "  (1) note: the status line was not captured (timing); the two checks above are the verdict"; fi
[ $FAIL = 0 ] && echo "✓ (1) Esc mid-stream: the prompt is back in the editor and off the branch"
# Clear the editor (pi's ctrl+u), then (2) a turn that runs a tool before Esc.
tmux send-keys -t wd_undo C-u; sleep 0.3
tmux send-keys -t wd_undo -l -- "fg"; sleep 0.3; tmux send-keys -t wd_undo Enter; sleep 4
tmux send-keys -t wd_undo Escape; sleep 3
S2="$(tmux capture-pane -t wd_undo -p)"
if ! echo "$S2" | grep -q "❯ fg"; then echo "✗ (2) the prompt whose turn ran a tool was taken back"; FAIL=1; fi
if echo "$S2" | tail -8 | grep -q "^fg$"; then echo "✗ (2) the prompt came back into the editor"; FAIL=1; fi
[ $FAIL = 0 ] && echo "✓ (2) Esc after a tool ran: the prompt is kept"
# (3) a background job's result lands while the prompt's turn streams prose:
# the delivery waits in pi's steer queue (a steer is read at a tool boundary),
# pi's Esc clears that queue, and the hold re-sends it with the NEXT prompt —
# so the undo is right to proceed (nothing sits after the leaf) and the reply
# must still arrive. Both are asserted: the prompt is back, then the delivery
# rides the next prompt.
tmux send-keys -t wd_undo C-u; sleep 0.3
tmux send-keys -t wd_undo -l -- "bg"; sleep 0.3; tmux send-keys -t wd_undo Enter; sleep 2.5
tmux send-keys -t wd_undo -l -- "undo me please three"; sleep 0.3; tmux send-keys -t wd_undo Enter; sleep 5
tmux send-keys -t wd_undo Escape; sleep 3
S3="$(tmux capture-pane -t wd_undo -p)"
if echo "$S3" | grep -q "❯ undo me please three"; then echo "✗ (3) the prompt box is still on the branch"; FAIL=1; fi
if ! echo "$S3" | tail -8 | grep -q "undo me please three"; then echo "✗ (3) the prompt is not back in the editor"; FAIL=1; fi
tmux send-keys -t wd_undo C-u; sleep 0.3
tmux send-keys -t wd_undo -l -- "after the undo"; sleep 0.3; tmux send-keys -t wd_undo Enter; sleep 6
# The transcript is the verdict (the screen may be mid-stream): the job's
# result must follow the "after the undo" prompt on disk.
if ! python3 - "$AG" <<'PY'
import glob, json, sys
files = glob.glob(sys.argv[1] + "/sessions/*/*.jsonl")
if not files: sys.exit(1)
rows = [json.loads(l) for l in open(max(files)) if l.strip()]
after = -1
for i, e in enumerate(rows):
    if e.get("type") == "message" and e["message"].get("role") == "user":
        c = e["message"].get("content")
        t = c if isinstance(c, str) else "".join(b.get("text", "") for b in c if b.get("type") == "text")
        if t.startswith("after the undo"): after = i
ok = after >= 0 and any(
    (r.get("type") == "custom_message" and r.get("customType") == "bash-result")
    or (r.get("type") == "message" and r["message"].get("role") == "user" and "background bash result" in json.dumps(r["message"].get("content")))
    for r in rows[after + 1 :]
)
sys.exit(0 if ok else 1)
PY
then echo "✗ (3) the job's reply did not ride the next prompt (transcript)"; FAIL=1; fi
[ $FAIL = 0 ] && echo "✓ (3) Esc with a reply queued: the prompt is back, and the reply rides the next prompt (nothing lost)"
tmux capture-pane -t wd_undo -e -p > "$R/final.raw"
[ $FAIL = 0 ] && echo "━━ UNDO: ALL GREEN" || { echo "━━ UNDO: FAILURES (screen: $R/final.raw)"; echo "$S1" | tail -14; echo "---"; echo "$S2" | tail -14; }
exit $FAIL
