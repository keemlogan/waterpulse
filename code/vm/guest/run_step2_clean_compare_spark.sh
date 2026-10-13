#!/bin/bash
# run_step2_clean_compare_spark.sh — 2단계: Hive 정제(Parquet·연도 파티션) → 품질표 → 효율 비교(Impala·Hive) → Spark 첫 예측(YARN)
# 1단계(run_step1_raw.sh)가 끝난 뒤 실행. 출력 원문은 ~/waterpulse/logs/step2_*.txt
# "### CAPTURE: 이름" 줄마다 터미널을 캡처하고, 표시된 곳에서는 브라우저 화면(Hue·YARN)도 캡처한다.
set -eu -o pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
L=$HOME/waterpulse/logs; mkdir -p "$L"

echo "### CAPTURE: Hive_정제_시작"
hive -f "$HERE/hive/20_clean.sql" 2>&1 | tee "$L/step2_clean.txt"
echo "### CAPTURE: Hive_정제_끝_파티션"
hive -e "USE wp; SHOW PARTITIONS clean_dam_hourly; SELECT year, COUNT(*) FROM clean_dam_hourly GROUP BY year ORDER BY year;" 2>&1 | tee "$L/step2_partitions.txt"
hdfs dfs -ls /user/hive/warehouse/wp.db/clean_dam_hourly | tee -a "$L/step2_partitions.txt"
echo "### CAPTURE: 정제_전후_한줄_비교"
hive -e "ADD JAR /usr/lib/hive-hcatalog/share/hcatalog/hive-hcatalog-core.jar; USE wp;
SELECT q_damcode, q_from, obsrdt, inflowqy, rsvwtqy FROM raw_dam_hourly WHERE q_damcode = '1012110' AND q_from = '2023-01-01' AND obsrdt LIKE '12-31 2%' ;
SELECT damcode, ts, hidx, inflow, storage, fix_hour24, fix_comma FROM clean_dam_hourly WHERE damcode = '1012110' AND ts >= '2023-12-31 21:00' AND ts <= '2024-01-01 01:00' ORDER BY ts;" 2>&1 | tee "$L/step2_before_after.txt"

echo "### CAPTURE: 품질표"
hive -f "$HERE/hive/21_quality.sql" 2>&1 | tee "$L/step2_quality.txt"

echo "### CAPTURE: 비교용_표_만들기"
hive -f "$HERE/hive/30_compare_tables.sql" 2>&1 | tee "$L/step2_compare_tables.txt"
bash "$HERE/impala/31_compare.sh" 2>&1 | tee "$L/step2_compare.txt"

echo "### CAPTURE: Hive_Impala_같은_행_대조"
Q="SELECT damcode, ts, hidx, inflow, outflow, storage, level_m, is_gap FROM wp.clean_dam_hourly WHERE year = 2023 AND damcode = '1012110' AND ts = '2023-07-15 12:00'"
echo "[Hive]";   hive -e "$Q" 2>/dev/null | tee "$L/step2_rowcheck_hive.txt"
echo "[Impala]"; impala-shell -B -q "$Q" 2>/dev/null | tee "$L/step2_rowcheck_impala.txt"

# Spark 1.3 HiveContext가 Hive 메타스토어를 보려면 hive-site.xml이 Spark 설정 폴더에 있어야 한다
[ -e /etc/spark/conf/hive-site.xml ] || sudo ln -s /etc/hive/conf/hive-site.xml /etc/spark/conf/hive-site.xml
echo "### CAPTURE: Spark_YARN_제출"
spark-submit --master yarn-client --num-executors 2 --executor-memory 1g --driver-memory 1g \
  "$HERE/spark/40_first_forecast.py" 1012110 6 2>&1 | tee "$L/step2_spark.txt"
echo "### CAPTURE: 브라우저_YARN_ResourceManager_http://localhost:8088/cluster/apps"
echo "### CAPTURE: 브라우저_Hue_Impala_SELECT_*_FROM_wp.mart_first_forecast"
impala-shell -q "INVALIDATE METADATA wp.mart_first_forecast; SELECT * FROM wp.mart_first_forecast" 2>&1 | tee "$L/step2_mart_impala.txt"
echo "끝: 2단계"
