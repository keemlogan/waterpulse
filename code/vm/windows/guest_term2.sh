#!/bin/bash
DISPLAY=:0 nohup gnome-terminal --geometry=160x50 -t 'versions' -x bash -c 'grep -v -e SLF4J -e Subversion -e checksum -e Compiled -e protoc -e Revision -e repository /tmp/wp_check.txt | sed -n 1,48p; exec bash' >/dev/null 2>&1 &
