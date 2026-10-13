#!/bin/bash
# WaterPulse: log guest Firefox into Hue without keystrokes.
# Reads Firefox's own csrftoken cookie and opens an auto-submitting login form.
# usage: guest_hue_gui_login.sh <next-path>   (e.g. /filebrowser/view/user/training)
export DISPLAY=:0
NEXT=${1:-/filebrowser/view/user/training}
PROF=~/.mozilla/firefox/training.default
# close firefox so the WAL is checkpointed into cookies.sqlite
pkill -x firefox; for i in $(seq 1 20); do pgrep -x firefox >/dev/null || break; sleep 0.5; done
rm -f /tmp/wp_ck.sqlite*; cp -f $PROF/cookies.sqlite /tmp/wp_ck.sqlite
# CentOS 6 sqlite3 (3.6) cannot open WAL-mode files: flip header bytes 18-19 (2->1) on the copy only
printf '\x01\x01' | dd of=/tmp/wp_ck.sqlite bs=1 seek=18 count=2 conv=notrunc 2>/dev/null
TOKEN=$(sqlite3 /tmp/wp_ck.sqlite "select value from moz_cookies where name='csrftoken' and host like '%localhost%' order by lastAccessed desc limit 1;")
echo "csrftoken_len=${#TOKEN}"
[ -z "$TOKEN" ] && { echo "no csrftoken in firefox profile"; exit 1; }
cat > /tmp/wp_hue_login.html <<EOF
<html><body onload="document.forms[0].submit()">
<form method="post" action="http://localhost:8888/accounts/login/">
<input type="hidden" name="username" value="training">
<input type="hidden" name="password" value="training">
<input type="hidden" name="csrfmiddlewaretoken" value="$TOKEN">
<input type="hidden" name="next" value="$NEXT">
</form></body></html>
EOF
nohup firefox -new-tab file:///tmp/wp_hue_login.html >/dev/null 2>&1 &
exit 0
