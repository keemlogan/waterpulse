-- 21_quality.sql — 데이터 품질표. 정제 규칙마다 몇 칸을 고쳤는지, 빈 시간이 얼마나 되는지 숫자로 남긴다.
-- 중간 채점 '예외 상황까지 생각했나'의 근거. 결과 표: wp.quality_dam(댐별), wp.quality_summary(자료별)
ADD JAR /usr/lib/hive-hcatalog/share/hcatalog/hive-hcatalog-core.jar;
USE wp;
SET hive.mapred.mode=nonstrict;

DROP TABLE IF EXISTS quality_dam;
CREATE TABLE quality_dam STORED AS PARQUET AS
SELECT c.damcode, k.damnm,
       MIN(CASE WHEN c.is_gap THEN NULL ELSE c.ts END) AS first_ts,
       MAX(CASE WHEN c.is_gap THEN NULL ELSE c.ts END) AS last_ts,
       COUNT(*) AS grid_hours,
       SUM(IF(c.is_gap, 1, 0)) AS gap_hours,
       ROUND(100.0 * SUM(IF(c.is_gap, 1, 0)) / COUNT(*), 2) AS gap_pct,
       MAX(w.raw_rows) - SUM(IF(c.is_gap, 0, 1)) AS dup_removed,
       SUM(IF(c.fix_hour24, 1, 0)) AS fixed_hour24,
       SUM(IF(c.fix_comma, 1, 0)) AS fixed_comma,
       SUM(IF(c.inflow_le0, 1, 0)) AS inflow_le0,
       ROUND(100.0 * SUM(IF(c.inflow_le0, 1, 0)) / SUM(IF(c.is_gap, 0, 1)), 2) AS inflow_le0_pct,
       SUM(IF(c.inflow_outlier, 1, 0)) AS inflow_outliers
FROM clean_dam_hourly c
LEFT OUTER JOIN raw_dam_codes k ON c.damcode = k.damcode
LEFT OUTER JOIN (SELECT q_damcode, COUNT(*) AS raw_rows FROM raw_dam_hourly GROUP BY q_damcode) w ON c.damcode = w.q_damcode
GROUP BY c.damcode, k.damnm;

DROP TABLE IF EXISTS quality_summary;
CREATE TABLE quality_summary STORED AS PARQUET AS
SELECT * FROM (
  SELECT 'dam_hourly' AS dataset, 'raw rows' AS item, COUNT(*) AS n FROM raw_dam_hourly
  UNION ALL SELECT 'dam_hourly' AS dataset, 'clean rows (incl. gap rows)' AS item, COUNT(*) AS n FROM clean_dam_hourly
  UNION ALL SELECT 'dam_hourly' AS dataset, 'R9 gap hours made visible' AS item, SUM(IF(is_gap, 1, 0)) AS n FROM clean_dam_hourly
  UNION ALL SELECT 'dam_hourly' AS dataset, 'R2 hour 24 -> next day 00' AS item, SUM(IF(fix_hour24, 1, 0)) AS n FROM clean_dam_hourly
  UNION ALL SELECT 'dam_hourly' AS dataset, 'R3 comma numbers' AS item, SUM(IF(fix_comma, 1, 0)) AS n FROM clean_dam_hourly
  UNION ALL SELECT 'dam_hourly' AS dataset, 'R4 inflow <= 0 flagged' AS item, SUM(IF(inflow_le0, 1, 0)) AS n FROM clean_dam_hourly
  UNION ALL SELECT 'dam_hourly' AS dataset, 'R5 impossible inflow -> NULL' AS item, SUM(IF(inflow_outlier, 1, 0)) AS n FROM clean_dam_hourly
  UNION ALL SELECT 'dam_daily' AS dataset, 'raw rows' AS item, COUNT(*) AS n FROM raw_dam_daily
  UNION ALL SELECT 'dam_daily' AS dataset, 'R3 comma numbers' AS item, SUM(IF(fix_comma, 1, 0)) AS n FROM clean_dam_daily
  UNION ALL SELECT 'dam_daily' AS dataset, 'R4 inflow <= 0 flagged' AS item, SUM(IF(inflow_le0, 1, 0)) AS n FROM clean_dam_daily
  UNION ALL SELECT 'rain_hourly' AS dataset, 'raw rows' AS item, COUNT(*) AS n FROM raw_rain_hourly
  UNION ALL SELECT 'rain_hourly' AS dataset, 'clean rows' AS item, COUNT(*) AS n FROM clean_rain_hourly
  UNION ALL SELECT 'rain_hourly' AS dataset, 'R6 hour 24:00 -> next day 00:00' AS item, SUM(IF(fix_hour24, 1, 0)) AS n FROM clean_rain_hourly
  UNION ALL SELECT 'rain_hourly' AS dataset, 'R3 comma numbers' AS item, SUM(IF(fix_comma, 1, 0)) AS n FROM clean_rain_hourly
  UNION ALL SELECT 'rain_hourly' AS dataset, 'R7 test stations' AS item, COUNT(*) AS n FROM test_stations WHERE kind = 'rain'
  UNION ALL SELECT 'level_hourly' AS dataset, 'raw rows' AS item, COUNT(*) AS n FROM raw_level_hourly
  UNION ALL SELECT 'level_hourly' AS dataset, 'clean rows' AS item, COUNT(*) AS n FROM clean_level_hourly
  UNION ALL SELECT 'level_hourly' AS dataset, 'R6 hour 24:00 -> next day 00:00' AS item, SUM(IF(fix_hour24, 1, 0)) AS n FROM clean_level_hourly
  UNION ALL SELECT 'level_hourly' AS dataset, 'R3 comma numbers' AS item, SUM(IF(fix_comma, 1, 0)) AS n FROM clean_level_hourly
  UNION ALL SELECT 'level_hourly' AS dataset, 'R7 test stations' AS item, COUNT(*) AS n FROM test_stations WHERE kind = 'level'
  UNION ALL SELECT 'asos_hourly' AS dataset, 'raw rows' AS item, COUNT(*) AS n FROM raw_asos_hourly
  UNION ALL SELECT 'asos_hourly' AS dataset, 'clean rows' AS item, COUNT(*) AS n FROM clean_asos_hourly
  UNION ALL SELECT 'asos_hourly' AS dataset, 'R8 blank rain -> 0 mm' AS item, SUM(IF(rain_blank_zero, 1, 0)) AS n FROM clean_asos_hourly
  UNION ALL SELECT 'asos_hourly' AS dataset, 'R8 rain flag 9 -> missing' AS item, SUM(IF(rain_missing, 1, 0)) AS n FROM clean_asos_hourly
) u;

SELECT * FROM quality_summary;
SELECT * FROM quality_dam ORDER BY damcode;
