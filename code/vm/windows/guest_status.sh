#!/bin/bash
# WaterPulse: read-only progress / health check (run over ssh: bash /tmp/guest_status.sh [fsck])
L=~/waterpulse/logs
date
ls -l /tmp/wp_cap_req /tmp/wp_cap_done 2>&1
echo "--- step logs"; ls -l $L
for f in $L/step1_ddl.txt $L/step1_check.txt $L/step2_*.txt; do
  [ -f "$f" ] || continue
  echo "===== $f  (OK lines: $(grep -c '^OK' "$f"))"
  grep -iE 'FAILED|Exception|Error' "$f" | head -5
  tail -25 "$f"
done
echo "--- yarn running"; yarn application -list 2>/dev/null | tail -3
echo "--- hive procs"; ps -eo pid,etime,args | grep -E '[o]rg.apache.hadoop.util.RunJar' | cut -c1-150 | head -5
if [ "$1" = "fsck" ]; then
  echo "===== fsck -list-corruptfileblocks"; sudo -u hdfs hdfs fsck / -list-corruptfileblocks 2>&1 | tail -40
  echo "===== fsck / | grep missing|corrupt"; sudo -u hdfs hdfs fsck / 2>/dev/null | grep -i -E 'missing|corrupt' | head -30
fi