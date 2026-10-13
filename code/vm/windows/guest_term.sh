#!/bin/bash
DISPLAY=:0 nohup gnome-terminal --geometry=160x50 -t 'WaterPulse version check' -x bash -c 'cat /tmp/wp_check.txt | grep -v SLF4J; exec bash' >/dev/null 2>&1 &
