#!/usr/bin/env bash
#
# Colour catalogue, step 2: render every theme variant with REAL pi against a
# real transcript and capture the pager in comparable states, then build the
# HTML page (ansi2html.mjs). Nothing of yours is touched: a private agent dir
# under --out carries copies of auth.json/models-store.json, the variants as
# its themes, and a settings.json naming one variant per boot.
#
#   node dev/generators/gallery/make-variants.mjs                       # writes /tmp/wd-gallery/themes/*.json
#   dev/generators/gallery/run.sh --session <file.jsonl> [--themes DIR] [--out DIR] [--width 140] [--height 40]
#   xdg-open <out>/index.html         # or: cat <out>/captures/g1-quiet--rest-bottom.ans
#
# States per variant: rest-bottom (as loaded, follow), rest-up (one page up),
# open-focus (from rest-up: the cluster whose header contains $OPEN_CLUSTER
# opened with its first member's panel, and the thinking beat containing
# $OPEN_THINK opened) and open-read (the cluster containing $OPEN_READ opened
# with its first member — a numbered-gutter panel), open-write / open-edit (the
# clusters containing $OPEN_WRITE / $OPEN_EDIT, found by paging up from the
# bottom, opened with their first member). The grep strings are
# env overrides so any transcript works; geometry is identical across variants
# since only colours differ. Requires tmux, pi on PATH (or PI_BIN).
set -u
SESSION=""; THEMES=/tmp/wd-gallery/themes; OUT=/tmp/wd-gallery/out; W=140; H=40
OPEN_CLUSTER="${OPEN_CLUSTER:-executed 1 bash}"; OPEN_THINK="${OPEN_THINK:-thought for}"; OPEN_READ="${OPEN_READ:-read 4 files}"; OPEN_WRITE="${OPEN_WRITE:-wrote 1 file}"; OPEN_EDIT="${OPEN_EDIT:-edited 1 file}"
while [ $# -gt 0 ]; do case "$1" in
	--session) SESSION=$2; shift 2;; --themes) THEMES=$2; shift 2;; --out) OUT=$2; shift 2;;
	--width) W=$2; shift 2;; --height) H=$2; shift 2;;
	*) echo "unknown arg $1"; exit 2;; esac; done
[ -f "$SESSION" ] || { echo "need --session <file.jsonl>"; exit 2; }
PI_BIN="${PI_BIN:-pi}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WD="$(cd "$HERE/../../.." && pwd)"
REAL="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
AG="$OUT/agent"; CAP="$OUT/captures"; CWD="$OUT/cwd"
mkdir -p "$AG/extensions" "$AG/themes" "$CAP" "$CWD"
cp "$REAL/auth.json" "$AG/" 2>/dev/null; cp "$REAL/models-store.json" "$AG/" 2>/dev/null; cp "$REAL/models.json" "$AG/" 2>/dev/null
ln -sfn "$WD" "$AG/extensions/war-dogs"
cp "$WD/visual/theme/visor.json" "$AG/themes/"
cp "$THEMES"/*.json "$AG/themes/"
SESS_ABS="$(cd "$(dirname "$SESSION")" && pwd)/$(basename "$SESSION")"
S=wd_gallery
capture() { tmux capture-pane -t $S -e -p > "$CAP/$1--$2.ans"; }
wait_ready() { for i in $(seq 1 100); do tmux capture-pane -t $S -p 2>/dev/null | head -1 | grep -q "main view" && return 0; sleep 0.2; done; return 1; }
settle() { sleep "${1:-0.6}"; }
VARS=()
for t in "$THEMES"/*.json; do
	name=$(basename "$t" .json); VARS+=("$name")
	python3 - "$REAL/settings.json" "$AG/settings.json" "$name" <<'PY'
import json,sys
src,dst,name=sys.argv[1:4]
try: s=json.load(open(src))
except Exception: s={}
s.pop("packages",None); s["theme"]=name
wd=s.get("war-dogs") if isinstance(s.get("war-dogs"),dict) else {}
wd.update({"theme":name,"mcp":False,"enabled":True}); s["war-dogs"]=wd
json.dump(s,open(dst,"w"))
PY
	tmux kill-session -t $S 2>/dev/null
	tmux new-session -d -s $S -x "$W" -y "$H" -c "$CWD" -e PI_CODING_AGENT_DIR="$AG" "$PI_BIN --session '$SESS_ABS'"
	if ! wait_ready; then echo "!! $name: pager never opened"; tmux capture-pane -t $S -p | tail -5; continue; fi
	sleep 1.5
	capture "$name" rest-bottom
	tmux send-keys -t $S -l $'\e[5~'; settle; capture "$name" rest-up
	# open-focus: from the rest-up window, open the bash cluster (its header,
	# then its first member's panel) and the thinking beat above it — the
	# on-demand look for a tool panel and an open thinking block together.
	plain() { tmux capture-pane -t $S -p | sed 's/\x1b\[[0-9;]*m//g'; }
	rowof() { plain | grep -n -m1 -- "$1" | cut -d: -f1; }
	click() { tmux send-keys -t $S -l $'\e[<0;'"$2"';'"$1"$'M\e[<0;'"$2"';'"$1"$'m'; settle 0.5; }
	# open a cluster row and, when it is a real cluster (its header survives
	# the click — a SOLO summary opens the act itself), its first member.
	open_at() { click "$1" 6; if [ -n "$(rowof "$2")" ]; then click $(($1+1)) 8; fi; }
	rc=$(rowof "$OPEN_CLUSTER"); rt=$(rowof "$OPEN_THINK")
	if [ -n "$rc" ]; then open_at "$rc" "$OPEN_CLUSTER"; fi
	if [ -n "$rt" ] && [ -n "$rc" ] && [ "$rt" -lt "$rc" ]; then click "$rt" 6; fi
	settle; capture "$name" open-focus
	# open-read: fold those back (row-wide clicks on the open panels are not
	# needed — reload the window instead: End, PgUp) and open the read cluster
	# plus its first member: the numbered gutter on the field.
	tmux send-keys -t $S -l $'\x0f'; settle; tmux send-keys -t $S -l $'\x0f'; settle   # expand-all, collapse-all: resets per-item overrides
	tmux send-keys -t $S -l $'\e[4~'; settle; tmux send-keys -t $S -l $'\e[5~'; settle
	rr=$(rowof "$OPEN_READ")
	if [ -n "$rr" ]; then open_at "$rr" "$OPEN_READ"; fi
	settle; capture "$name" open-read
	# open-write / open-edit: the cluster naming a write / an edit, wherever it
	# is — page up from the bottom until its header is on screen, open it and
	# its first member: the numbered body / the diff on the field.
	find_open() { # $1 pattern, $2 state
		tmux send-keys -t $S -l $'\x0f'; settle; tmux send-keys -t $S -l $'\x0f'; settle
		tmux send-keys -t $S -l $'\e[4~'; settle 0.4
		local r=""; for i in 1 2 3 4 5 6 7 8; do r=$(rowof "$1"); [ -n "$r" ] && break; tmux send-keys -t $S -l $'\e[5~'; settle 0.4; done
		if [ -n "$r" ]; then open_at "$r" "$1"; fi
		settle; capture "$name" "$2"
	}
	find_open "$OPEN_WRITE" open-write
	find_open "$OPEN_EDIT" open-edit
	echo "== $name captured"
	tmux kill-session -t $S 2>/dev/null
done
python3 - "$CAP/manifest.json" "$SESS_ABS" "$W" "$H" "$THEMES" "$($PI_BIN --version 2>/dev/null)" "${VARS[@]}" <<'PY'
import json,sys,datetime,os
out,sess,w,h,themes,ver,*names=sys.argv[1:]
vs=[]
for n in names:
    t=json.load(open(os.path.join(themes,n+".json")))
    keys=["headingBright","secondary","muted","fieldBg"]
    summary=" ".join(f"{k}={t['vars'].get(k)}" for k in keys if k in t["vars"])+"  |  "+" ".join(f"{k}={t['colors'].get(k)}" for k in ["wdProse","wdProseBold","wdCodeBg","mdCode","mdHeading","wdEvidence","wdSyntaxKeyword","wdSyntaxString","wdDiffAddBg"] if t["colors"].get(k))
    vs.append({"name":n,"summary":summary})
json.dump({"variants":vs,"states":["rest-bottom","rest-up","open-focus","open-read","open-write","open-edit"],"session":os.path.basename(sess),"width":int(w),"height":int(h),"piVersion":ver,"generatedAt":datetime.datetime.now().isoformat(timespec="seconds")},open(out,"w"),indent=1)
PY
node "$HERE/ansi2html.mjs" "$CAP" "$OUT/index.html"
echo "open $OUT/index.html   (raw: $CAP/*.ans)"
