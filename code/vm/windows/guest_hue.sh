#!/bin/bash
OUT=/tmp/wp_hue.txt; : > $OUT
{ echo '===== \$ sudo service hue start ====='; sudo service hue start; echo "[exit=$?]"; sleep 20; echo '===== \$ sudo service hue status ====='; sudo service hue status; for i in 1 2 3 4 5 6; do c=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8888/); echo "try $i hue_http=$c"; [ "$c" != 000 ] && break; sleep 10; done; } >> $OUT 2>&1
DISPLAY=:0 nohup firefox http://localhost:8888 >/dev/null 2>&1 &
