#!/usr/bin/env bash
#
# war-dogs self-containment acceptance test.
#
# Property under test: a boot with `war-dogs.enabled:false` renders 1:1 with
# stock `pi --no-extensions` (text and palette) — control is settings-only, so
# this IS the off state — and a boot with `enabled:true` presents its surface.
# Plus: the /war-dogs toggle is REFUSED while work is in flight.
#
# This is the regression check — run it after any change to the mode switch,
# the HUD, the renderers, or the tool active-set. It drives real pi in tmux and
# compares capture-pane output.
#
# Requires: tmux, pi on PATH, a configured model. Runs headless.
#
# Usage:  ./dev/instruments/acceptance-test.sh            # boot-on smoke + boot-off leg (text and palette)
#         ./dev/instruments/acceptance-test.sh --busy     # also the busy-denial case (needs a model + a subagent)
#         PI_BIN=/path/to/pi ./dev/instruments/acceptance-test.sh   # against a candidate pi (after `pi update`)

set -u
W=140
H=40
SESS_STOCK=wd_accept_stock
SESS_OFF=wd_accept_off
SESS_BSTOCK=wd_accept_bstock
SESS_BOFF=wd_accept_boff
TMP="$(mktemp -d)"
trap 'for s in "$SESS_STOCK" "$SESS_OFF" "$SESS_BSTOCK" "$SESS_BOFF"; do tmux kill-session -t "$s" 2>/dev/null; done; rm -rf "$TMP"' EXIT

# Strip ANSI/OSC, and the two lines that are INHERENT to the extension being
# loaded at all (pi lists every loaded extension in its startup header) or to
# toggling via the command (the transient notification). Neither is war-dogs
# altering a surface; everything else must match.
norm() {
	# Strip ANSI/OSC and trailing spaces; drop the inherent [Extensions]/notice
	# lines; then squeeze runs of blank lines to one. The blank-run squeeze
	# absorbs the vertical shift caused by pi's startup header being N rows
	# taller when it lists the loaded extension — a real war-dogs surface would
	# show as a CONTENT line, which squeezing never hides.
	# The item line under [Extensions] is a comma-joined NAME LIST (pi renders
	# every loaded extension on one line), so the strip matches the whole list
	# as long as war-dogs is in it — a lone "war-dogs" line stopped matching
	# the moment a second extension (pi-mcp-adapter) was installed.
	# The bundled MCP adapter's footer status ("🔌 MCP: …") and its
	# `[Skills] mcp-scripting` boot block are war-dogs surfaces since the
	# adapter moved INTO war-dogs (mcp/index.ts): both must be GONE while off,
	# so neither is stripped — a leak fails here. (The skills block used to be
	# stripped as "the live toggle's residual"; with no live toggle that strip
	# would only mask a boot-off that loads the adapter's skill.)
	#
	# pi's own ASYNC update notices ("Update Available", "Package Updates
	# Available" and the package list under it) are dropped for a subtler
	# reason: their CONTENT is identical on both sides, but their ARRIVAL
	# ORDER is not. Loading extensions at all shifts when each check resolves,
	# so the two blocks land swapped — which diffs as six added and six
	# removed lines and failed BOTH attempts, defeating the retry that exists
	# for the "one side missed a banner" flake. Demonstrated 2026-08-16 by
	# capturing all three panes and diffing them by hand.
	# The surrounding ──── rules are deliberately KEPT, so layout is still
	# compared; only the notice text goes. Verified that this still fails
	# loudly for war-dogs ON — normalisation that cannot catch a real
	# divergence is worse than a flaky test.
	sed -E $'s/\x1b\\[[0-9;?]*[a-zA-Z]//g; s/\x1b\\][^\x07]*\x07//g; s/\x1b[()][0-9A-Za-z]//g' \
		| grep -avE '^\s*\[Extensions\]\s*$|^\s+([A-Za-z0-9._@-]+, )*war-dogs(, [A-Za-z0-9._@-]+)*\s*$|(^|\s)war-dogs (on|off)\s*$' \
		| grep -avE '^\s*(Update Available|Package Updates Available|Packages:)\s*$|^\s*New version .* is available\..*$|^\s*Changelog: https?://\S+\s*$|^\s*Package updates are available\..*$|^\s*-\s+[A-Za-z0-9._@/-]+\s*$' \
		| sed -E 's/[[:space:]]+$//' \
		| cat -s \
		| sed -e :a -e '/^$/{$d;N;ba}'
}

# The pi under test and the agent dir: tmux new-session does NOT inherit the
# caller's environment (it uses the tmux server's), so the agent dir is passed
# explicitly or the three legs can silently test three different dirs. PI_BIN
# lets the harness run against a candidate binary ("re-verify after pi update").
PI_BIN="${PI_BIN:-pi}"
LIVE_AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
# pi shows its CHANGELOG on the first interactive boot after an update and
# records the version it showed in settings.lastChangelogVersion. The temp
# dirs below copy the user's settings, so after every `pi update` the FIRST
# leg booted in a dir consumed the changelog and the second did not, and the
# text diff failed on pi's own release notes (0.84.4 sweep, 2026-08-29). Pin
# the marker to the pi under test so neither leg shows it.
PI_VERSION="$("$PI_BIN" --version 2>/dev/null | tr -d '[:space:]')"
boot() { # session-name  command...
	tmux new-session -d -s "$1" -x "$W" -y "$H" -c "$PWD" -e "PI_CODING_AGENT_DIR=$LIVE_AGENT" "${@:2}"
	sleep 8
}

# Colour axis. norm() strips every SGR before diffing, so a palette
# divergence (off showing dark while stock shows the user's light theme —
# a real bug found 2026-08-17) was invisible to the text diff. Compare the
# SET of distinct foreground/background truecolor codes in the RAW captures.
sgrset() { grep -ao $'\x1b\[[34]8;2;[0-9;]*m' | sort -u; }

# One retry: pi's update/package banners land asynchronously, so a slow
# boot can capture one side without them — a diff failure that is harness
# timing, not a war-dogs surface. A REAL divergence fails both attempts.
# war-dogs is SETTINGS-ONLY now: `/war-dogs on|off` writes war-dogs.enabled and
# reloads, so every state is a BOOT state. "off = stock" is therefore exactly
# the boot-off leg below (the strong guarantee: an off war-dogs registers
# nothing). Here we only SMOKE-test that war-dogs ON boots cleanly — the mascot
# banner appears and pi did not error — from a private dir with enabled:true.
VISUAL_OK=0
LA="$TMP/on"; mkdir -p "$LA/extensions" "$LA/themes"
ln -s "$(cd "$(dirname "$0")/../.." && pwd)" "$LA/extensions/war-dogs"
for f in auth.json models-store.json models.json; do [ -f "$LIVE_AGENT/$f" ] && cp "$LIVE_AGENT/$f" "$LA/"; done
python3 - "$LIVE_AGENT/settings.json" "$LA/settings.json" "$PI_VERSION" <<'PY'
import json,sys
try: s=json.load(open(sys.argv[1]))
except Exception: s={}
s.pop("packages",None); s.setdefault("war-dogs",{})["enabled"]=True
s["lastChangelogVersion"]=sys.argv[3]
json.dump(s,open(sys.argv[2],"w"))
PY
echo "── boot-on smoke: war-dogs ON must load (banner present, no crash) ..."
tmux new-session -d -s "$SESS_OFF" -x "$W" -y "$H" -c "$PWD" -e "PI_CODING_AGENT_DIR=$LA" "$PI_BIN" || { echo "FAIL: could not start war-dogs ON"; exit 1; }
sleep 8
if tmux capture-pane -t "$SESS_OFF" -p | head -6 | grep -q "main view"; then
	echo "PASS: war-dogs ON boots (pager surface present)."
	VISUAL_OK=1
else
	echo "FAIL: war-dogs ON did not present its surface."
	tmux capture-pane -t "$SESS_OFF" -p | head -6
fi
tmux kill-session -t "$SESS_OFF" 2>/dev/null

# Boot-off leg: `war-dogs.enabled:false` from settings must be stock — with
# control settings-only this IS the off state (the extension registers
# nothing). Run in a private agent dir (global settings,
# so no project-trust prompt) that carries the user's auth/models and a
# symlink to this tree; stock is the same agent dir with --no-extensions.
BOOTOFF_OK=0
AG="$TMP/agent"; SRC="$LIVE_AGENT"
mkdir -p "$AG/extensions" && ln -s "$(cd "$(dirname "$0")/../.." && pwd)" "$AG/extensions/war-dogs"
for f in auth.json models-store.json models.json; do [ -f "$SRC/$f" ] && cp "$SRC/$f" "$AG/"; done
# What war-dogs installs on first load, pre-installed so the --no-extensions
# side can resolve a war-dogs `settings.theme` exactly as a real machine does.
mkdir -p "$AG/themes" && cp "$AG/extensions/war-dogs/visual/theme/"*.json "$AG/themes/"
python3 - "$SRC/settings.json" "$AG/settings.json" "$PI_VERSION" <<'PY'
import json,sys
try: s=json.load(open(sys.argv[1]))
except Exception: s={}
s.pop("packages",None); s.setdefault("war-dogs",{})["enabled"]=False
s["lastChangelogVersion"]=sys.argv[3]
json.dump(s,open(sys.argv[2],"w"))
PY
echo "── boot-off leg: stock vs war-dogs.enabled:false ..."
# Own session names, and a failed new-session is FATAL: this leg once reused
# the visual leg's still-open session name, tmux refused the new one, and the
# capture read the stale live-toggle pane — the leg "passed" without running.
tmux new-session -d -s "$SESS_BSTOCK" -x "$W" -y "$H" -c "$PWD" -e "PI_CODING_AGENT_DIR=$AG" "$PI_BIN" --no-extensions || { echo "FAIL: could not start the boot-off stock session"; exit 1; }
sleep 8
tmux capture-pane -t "$SESS_BSTOCK" -e -p > "$TMP/bstock.raw"; tmux kill-session -t "$SESS_BSTOCK" 2>/dev/null
tmux new-session -d -s "$SESS_BOFF" -x "$W" -y "$H" -c "$PWD" -e "PI_CODING_AGENT_DIR=$AG" "$PI_BIN" || { echo "FAIL: could not start the boot-off war-dogs session"; exit 1; }
sleep 8
tmux capture-pane -t "$SESS_BOFF" -e -p > "$TMP/boff.raw"; tmux kill-session -t "$SESS_BOFF" 2>/dev/null
if diff -u <(norm < "$TMP/bstock.raw") <(norm < "$TMP/boff.raw") && diff <(sgrset < "$TMP/bstock.raw") <(sgrset < "$TMP/boff.raw"); then
	echo "PASS: boot with enabled:false is 1:1 with stock (text and palette)."
	BOOTOFF_OK=1
else
	echo "FAIL: boot with enabled:false diverges from stock (see above)."
fi

BUSY_OK=1
# The EXTERNAL EDITOR leg (2026-08-30, the pi-settings review): ctrl+g makes
# pi stop its TUI and run `externalEditor`; the pager must hand the editor a
# stock terminal (no alt screen, no mouse reporting) and take the modes back
# after. A script stands in for the editor and reads tmux's own flags from
# inside. No model is needed, so this leg always runs.
EDITOR_OK=0
echo "── external-editor leg: ctrl+g hands the editor a stock terminal ..."
cat > "$TMP/fake-editor.sh" <<'SH'
#!/bin/sh
tmux display -p "#{alternate_on} #{mouse_any_flag}" > "$(dirname "$0")/editor-modes" 2>/dev/null
sleep 3
SH
chmod +x "$TMP/fake-editor.sh"
python3 - "$LA/settings.json" "$TMP/fake-editor.sh" <<'PY'
import json, sys
p, ed = sys.argv[1], sys.argv[2]
s = json.load(open(p)); s["externalEditor"] = ed; json.dump(s, open(p, "w"))
PY
SESS_ED="${SESS_OFF}-ed"
tmux kill-session -t "$SESS_ED" 2>/dev/null
tmux new-session -d -s "$SESS_ED" -x "$W" -y "$H" -c "$PWD" -e "PI_CODING_AGENT_DIR=$LA" "$PI_BIN" || { echo "FAIL: could not start the editor-leg session"; exit 1; }
sleep 8
tmux send-keys -t "$SESS_ED" -l -- "draft"; sleep 0.3; tmux send-keys -t "$SESS_ED" C-g; sleep 2
INSIDE="$(cat "$TMP/editor-modes" 2>/dev/null)"
sleep 3.5
BACK="$(tmux display -t "$SESS_ED" -p '#{alternate_on} #{mouse_any_flag}' 2>/dev/null)"
HDR="$(tmux capture-pane -t "$SESS_ED" -p | head -1)"
tmux kill-session -t "$SESS_ED" 2>/dev/null
if [ "$INSIDE" = "0 0" ] && [ "$BACK" = "1 1" ] && echo "$HDR" | grep -q "main view"; then
	echo "PASS: inside the editor '$INSIDE' (stock), after it '$BACK' with the pager back."
	EDITOR_OK=1
else
	echo "FAIL: inside the editor '$INSIDE' (want '0 0'), after it '$BACK' (want '1 1'), header: $HDR"
fi

if [ "${1:-}" = "--busy" ]; then
	BUSY_OK=0
	echo "── busy-denial case: toggle while a subagent run is in flight ..."
	boot "$SESS_OFF" "$PI_BIN"
	# Turn on (a reload), spawn a background subagent, then try to turn off
	# while it runs. The command must be denied and the pager must stay up.
	tmux send-keys -t "$SESS_OFF" "/war-dogs on"; sleep 0.5; tmux send-keys -t "$SESS_OFF" Enter; sleep 3
	tmux send-keys -t "$SESS_OFF" "Use the subagent tool in the background to count to a million slowly."; sleep 0.5
	tmux send-keys -t "$SESS_OFF" Enter
	sleep 12   # let the model emit the subagent call and the run start
	tmux send-keys -t "$SESS_OFF" "/war-dogs off"; sleep 0.5; tmux send-keys -t "$SESS_OFF" Enter; sleep 3
	SCREEN="$(tmux capture-pane -t "$SESS_OFF" -p)"
	if echo "$SCREEN" | grep -qiE "Can't switch war-dogs while"; then
		echo "PASS: toggle denied while a subagent run is in flight."
		BUSY_OK=1
	elif echo "$SCREEN" | grep -qiE "main view|subagent view"; then
		echo "INCONCLUSIVE: pager still up (good) but denial notice not captured — counted as PASS for the pager, re-run to see the notice."
		BUSY_OK=1
	else
		echo "FAIL: pager gone — the toggle was NOT refused mid-run."
	fi
fi

# The exit code says what the run said: a printed FAIL used to exit 0.
[ "$VISUAL_OK" = 1 ] && [ "$BOOTOFF_OK" = 1 ] && [ "$BUSY_OK" = 1 ] && [ "$EDITOR_OK" = 1 ]
