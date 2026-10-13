-- 30_compare_tables.sql — 효율 비교용 표. 같은 내용(정리본 댐 시간 자료)을 형식·파티션만 바꿔 둔다.
--   cmp_text_nopart     : 텍스트(CSV) · 파티션 없음
--   cmp_parquet_nopart  : Parquet(Snappy) · 파티션 없음
--   clean_dam_hourly    : Parquet(Snappy) · 연도 파티션   ← 실제로 쓰는 정리본
-- 비교는 한 번에 한 가지만 바꾼다: ① 형식(text ↔ parquet) ② 파티션(없음 ↔ 연도) ③ 엔진(Hive ↔ Impala, 같은 표).
-- year는 세 표 모두 열로 들고 있어서 같은 질의(WHERE year = 2023 …)를 그대로 돌릴 수 있다.
USE wp;
SET parquet.compression=SNAPPY;

DROP TABLE IF EXISTS cmp_text_nopart;
CREATE TABLE cmp_text_nopart
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
STORED AS TEXTFILE AS
SELECT damcode, ts, hidx, inflow, inflow_raw, outflow, storage, storage_pct, level_m, rain_mm,
       inflow_le0, inflow_outlier, is_gap, fix_hour24, fix_comma, year
FROM clean_dam_hourly;

DROP TABLE IF EXISTS cmp_parquet_nopart;
CREATE TABLE cmp_parquet_nopart STORED AS PARQUET AS
SELECT damcode, ts, hidx, inflow, inflow_raw, outflow, storage, storage_pct, level_m, rain_mm,
       inflow_le0, inflow_outlier, is_gap, fix_hour24, fix_comma, year
FROM clean_dam_hourly;

SELECT * FROM (
  SELECT 'text' AS t, COUNT(*) AS n FROM cmp_text_nopart
  UNION ALL SELECT 'parquet_nopart' AS t, COUNT(*) AS n FROM cmp_parquet_nopart
  UNION ALL SELECT 'parquet_year' AS t, COUNT(*) AS n FROM clean_dam_hourly
) u;
