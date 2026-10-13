#!/bin/bash
# run_step1_raw.sh <묶음 tar 경로> — 1단계: 원본 적재 + Hive 원본 표 + 검사. 출력은 ~/waterpulse/logs/step1_*.txt
# "### CAPTURE: 이름" 줄이 나올 때마다 그 화면(터미널)을 캡처한다.
set -eu -o pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
TAR=${1:?사용법: run_step1_raw.sh <묶음 tar 경로>}
mkdir -p "$HOME/waterpulse/logs"
L="$HOME/waterpulse/logs"
bash "$HERE/guest/10_load_raw.sh" "$TAR" 2>&1 | tee "$L/step1_load.txt"
echo "### CAPTURE: Hive_원본표_DDL"
hive -f "$HERE/hive/10_raw_tables.sql" 2>&1 | tee "$L/step1_ddl.txt"
echo "### CAPTURE: Hive_원본표_COUNT_검사"
hive -f "$HERE/hive/11_raw_check.sql" 2>&1 | tee "$L/step1_check.txt"
echo "--- 기대 행 수(10_load_raw.sh)"
cat "$HOME"/waterpulse/expected_rows_*.tsv
