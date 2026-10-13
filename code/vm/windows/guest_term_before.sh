#!/bin/bash
DISPLAY=:0 nohup gnome-terminal --geometry=150x45 -t 'before' -x bash -c "echo '== 서비스 상태 (시작 전) =='; sudo service --status-all 2>/dev/null | egrep -i 'hadoop|hive|impala|hue|spark|mysql|sshd'; exec bash" >/dev/null 2>&1 &
