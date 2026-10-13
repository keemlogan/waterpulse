#!/bin/bash
# WaterPulse: guest GUI helper for captures
#   guest_gui.sh clear                -> close terminals/firefox
#   guest_gui.sh term "<title>" "<cmd>" -> big terminal running <cmd>, left open
#   guest_gui.sh firefox "<url>"      -> firefox maximized on <url>
export DISPLAY=:0
case "$1" in
  clear)
    for p in $(pgrep -x gnome-terminal) $(pgrep -f '/usr/lib64/firefox/firefox'); do kill $p 2>/dev/null; done
    ;;
  term)
    nohup gnome-terminal --maximize --zoom=1.2 -t "$2" -x bash -c "$3; exec bash" >/dev/null 2>&1 &
    ;;
  firefox)
    nohup firefox -new-window "$2" >/dev/null 2>&1 &
    ;;
esac
exit 0
