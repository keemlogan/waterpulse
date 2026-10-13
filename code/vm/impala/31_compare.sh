#!/bin/bash
# 31_compare.sh — 효율 비교. 한 번에 한 가지만 바꿔서 잰다.
#   ① 형식   : Impala · cmp_text_nopart      ↔ cmp_parquet_nopart
#   ② 파티션 : Impala · cmp_parquet_nopart   ↔ clean_dam_hourly(연도 파티션)
#   ③ 엔진   : 같은 표 clean_dam_hourly · Hive ↔ Impala
#   (참고)   : Hive · 원본 JSON 표 raw_dam_hourly
# 샘플이 작아 걸린 시간은 오차가 크다. 그래서 Impala PROFILE의 읽은 바이트(BytesRead)와 HDFS 용량을 같이 남긴다.
# 결과: ~/waterpulse/logs/compare_results.tsv (표 · 질의 · 엔진 · 회차 · 초 · 읽은 바이트)
set -u
L=$HOME/waterpulse/logs; mkdir -p "$L"
OUT=$L/compare_results.tsv
printf "table\tquery\tengine\trun\tseconds\tbytes_read\n" > "$OUT"

# 질의 두 개: Q1 = 2023년 7월 소양강 시간별 유입량(좁은 범위), Q2 = 댐·연도별 평균·최대 유입(전체 훑기)
q1() { echo "SELECT ts, inflow FROM wp.$1 WHERE year = 2023 AND damcode = '1012110' AND ts >= '2023-07-01' AND ts < '2023-08-01' ORDER BY ts"; }
q2() { echo "SELECT damcode, year, AVG(inflow) AS avg_in, MAX(inflow) AS max_in FROM wp.$1 WHERE NOT is_gap GROUP BY damcode, year ORDER BY damcode, year"; }

echo "### CAPTURE: Impala_메타데이터_통계"
impala-shell -q "INVALIDATE METADATA" >/dev/null 2>&1
for t in cmp_text_nopart cmp_parquet_nopart clean_dam_hourly; do
  impala-shell -q "COMPUTE STATS wp.$t" 2>&1 | tail -3
done
# Impala 2.2의 COMPUTE STATS는 파티션 표의 InputFormat을 Impala 전용 클래스로 바꿔 Hive가 못 읽게 만든다 → 메타스토어에서 되돌림
bash "$(dirname "$0")/32_fix_metastore_after_stats.sh"
impala-shell -q "SHOW TABLE STATS wp.clean_dam_hourly" 2>&1

run_impala() {   # run_impala <표> <질의이름> <SQL>
  for i in 1 2 3; do
    impala-shell -p -q "$3" > "$L/impala_${1}_${2}_$i.txt" 2>&1
    sec=$(grep -o 'Fetched [0-9]* row(s) in [0-9.]*s' "$L/impala_${1}_${2}_$i.txt" | tail -1 | sed 's/.* in \([0-9.]*\)s/\1/')
    # 스캔 노드들의 BytesRead 합. 프로필에는 같은 값이 "Averaged Fragment"(평균)와 "Instance"(실제) 두 곳에 나오므로
    # Instance 블록 안의 값만 더한다(10/13 실측: 전부 더하면 정확히 2배가 됨).
    bytes=$(awk '/Averaged Fragment|Coordinator Fragment/{inst=0} /^ *Instance /{inst=1} inst' "$L/impala_${1}_${2}_$i.txt" \
            | grep -o 'BytesRead: [^)]*([0-9]*)' | sed 's/.*(\([0-9]*\))/\1/' | awk '{s+=$1} END {print s+0}')
    printf "%s\t%s\timpala\t%s\t%s\t%s\n" "$1" "$2" "$i" "${sec:-NA}" "$bytes" >> "$OUT"
  done
}
run_hive() {     # run_hive <표> <질의이름> <SQL>
  for i in 1 2 3; do
    hive -e "$3" > "$L/hive_${1}_${2}_$i.txt" 2>&1
    sec=$(grep -o 'Time taken: [0-9.]* seconds, Fetched' "$L/hive_${1}_${2}_$i.txt" | tail -1 | sed 's/Time taken: \([0-9.]*\).*/\1/')
    bytes=$(grep -o 'HDFS Read: [0-9]*' "$L/hive_${1}_${2}_$i.txt" | awk '{s+=$3} END {print s+0}')
    printf "%s\t%s\thive\t%s\t%s\t%s\n" "$1" "$2" "$i" "${sec:-NA}" "$bytes" >> "$OUT"
  done
}

echo "### CAPTURE: 비교1_형식_text_vs_parquet"
for t in cmp_text_nopart cmp_parquet_nopart; do run_impala $t Q1 "$(q1 $t)"; run_impala $t Q2 "$(q2 $t)"; done
echo "### CAPTURE: 비교2_파티션_없음_vs_연도"
run_impala clean_dam_hourly Q1 "$(q1 clean_dam_hourly)"; run_impala clean_dam_hourly Q2 "$(q2 clean_dam_hourly)"
echo "### CAPTURE: 비교3_엔진_Hive_vs_Impala"
run_hive clean_dam_hourly Q1 "$(q1 clean_dam_hourly)"; run_hive clean_dam_hourly Q2 "$(q2 clean_dam_hourly)"
echo "(참고) Hive 원본 JSON 표"
run_hive raw_dam_hourly Qraw "ADD JAR /usr/lib/hive-hcatalog/share/hcatalog/hive-hcatalog-core.jar; SELECT q_damcode, COUNT(*) FROM wp.raw_dam_hourly GROUP BY q_damcode"

echo "### CAPTURE: 비교_결과표_가운데값"
column -t -s $'\t' "$OUT"
echo "--- 표·질의·엔진별 가운데 값(3회)"
awk -F'\t' 'NR > 1 {k = $1 "\t" $2 "\t" $3; v[k] = v[k] " " $5; b[k] = $6} END {for (k in v) {n = split(v[k], a, " "); asort(a); printf "%s\t%s s\t%s B\n", k, a[int((n + 1) / 2)], b[k]}}' "$OUT" | sort | column -t -s $'\t'

echo "### CAPTURE: 비교_HDFS_용량"
W=/user/hive/warehouse/wp.db
hdfs dfs -du -s -h /etl/waterpulse/raw/dam_hourly $W/cmp_text_nopart $W/cmp_parquet_nopart $W/clean_dam_hourly
hdfs dfs -count /etl/waterpulse/raw/dam_hourly $W/cmp_text_nopart $W/cmp_parquet_nopart $W/clean_dam_hourly
