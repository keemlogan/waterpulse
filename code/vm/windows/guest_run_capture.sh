#!/bin/bash
# WaterPulse: run a command and pause output at each "### CAPTURE: name" marker so the host can screenshot.
# The section for marker K is captured just before marker K+1 (or the end) is printed,
# so the screen shows that section's output.
# Handshake: writes the section name to /tmp/wp_cap_req and waits (max 60s) until the host deletes it.
# At the end writes /tmp/wp_cap_done containing the exit code.
# usage: guest_run_capture.sh <console-log> <command...>
LOG=$1; shift
rm -f /tmp/wp_cap_req /tmp/wp_cap_done
request() {
  echo "$1" > /tmp/wp_cap_req
  for i in $(seq 1 120); do [ -e /tmp/wp_cap_req ] || break; sleep 0.5; done
  rm -f /tmp/wp_cap_req
}
{ "$@" 2>&1; echo "### EXIT: $?"; } | {
  prev=""
  while IFS= read -r line; do
    case "$line" in
      "### CAPTURE: "*|"### EXIT: "*)
        [ -n "$prev" ] && request "$prev"
        prev="${line#\#\#\# CAPTURE: }"
        case "$line" in "### EXIT: "*) echo "${line#\#\#\# EXIT: }" > /tmp/wp_cap_done.tmp; prev="" ;; esac
        ;;
    esac
    printf '%s\n' "$line"
  done
} | tee "$LOG"
mv -f /tmp/wp_cap_done.tmp /tmp/wp_cap_done 2>/dev/null || echo "?" > /tmp/wp_cap_done
