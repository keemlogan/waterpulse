-- 20_clean.sql — 원본 표(STRING) → 정리본 표(Parquet · 연도 파티션). 원본 파일은 건드리지 않는다.
-- 정제 규칙(허브 T30 규칙표 전부):
--   R1 댐 시각에 연도가 없음("07-14 01시 ")       → 조회 기간 q_from의 연도를 붙임
--   R2 24시 표기(댐 "24시", 관측소 "24:00")       → 다음 날 00시로
--   R3 쉼표 숫자("1,857.835"), 숫자·글자 섞임      → 쉼표 빼고 DOUBLE
--   R4 유입량 0 이하(저수량 변화로 계산한 값)      → inflow_le0 표시(값은 그대로, 학습에서 따로 처리)
--   R5 불가능한 유입량(예: 4,223만 ㎥/s)           → 댐 상위 0.1%의 10배 넘고 앞뒤 시간의 10배 넘으면 inflow NULL + inflow_outlier 표시
--   R6 관측소 01~24시 표기                          → R2와 같은 처리
--   R7 시험용 관측소                                → 제외
--   R8 ASOS 강수 빈칸                               → 품질 표시도 빈칸이면 0mm, 품질 표시 9면 결측(NULL)
--   R9 자료가 없는 시간                             → 댐 시간 자료는 1시간 격자에 맞춰 빈 시간을 is_gap 행으로 드러냄
-- 설계 메모:
--   * 시각(ts)은 'yyyy-MM-dd HH:mm' 문자열(KST 그대로)로 저장하고, 2006-01-01 00:00부터 센 시간 번호 hidx를 함께 둔다.
--     VM 시간대가 America/Los_Angeles(서머타임 있음)라 unix_timestamp/from_unixtime·TIMESTAMP를 쓰면 3월·11월에 시각이 밀리거나 겹친다.
--     그래서 시각 계산은 문자열과 date_add(하루 단위, 서머타임 무관)만 쓴다. "N시간 뒤"는 hidx + N으로 찾는다.
--   * 열 순서는 표 정의와 SELECT를 같게 한다(Impala 2.2는 Parquet 열을 위치로 맞춘다). Hive가 쓴 Parquet은 표 정의 순서를 따른다.
--   * 한글 문자열 비교는 VM 인코딩 설정에 흔들리지 않게 UTF-8 바이트(unhex)로 쓴다: EC8B9CED9798 = '시험'.
-- 환경: Hive 1.1.0-cdh5.4.3 (MapReduce on YARN). 실행: hive -f 20_clean.sql

ADD JAR /usr/lib/hive-hcatalog/share/hcatalog/hive-hcatalog-core.jar;
USE wp;
SET hive.exec.dynamic.partition=true;
SET hive.mapred.mode=nonstrict;
SET hive.exec.dynamic.partition.mode=nonstrict;
SET hive.exec.max.dynamic.partitions=2000;
SET hive.exec.max.dynamic.partitions.pernode=2000;
SET parquet.compression=SNAPPY;

-- ───────── 1시간 격자 (2006-01-01 00:00 ~ 2026-10-10 23:00, 7,588일 × 24 = 182,112칸) ─────────
DROP TABLE IF EXISTS hours;
CREATE TABLE hours (hidx INT, ts STRING, year INT) STORED AS PARQUET;
INSERT OVERWRITE TABLE hours
SELECT dd.i * 24 + hh.h AS hidx,
       concat(date_add('2006-01-01', dd.i), ' ', lpad(CAST(hh.h AS STRING), 2, '0'), ':00') AS ts,
       CAST(substr(date_add('2006-01-01', dd.i), 1, 4) AS INT) AS year
FROM (SELECT 1 AS one FROM raw_dam_codes LIMIT 1) t
LATERAL VIEW posexplode(split(space(7587), ' ')) dd AS i, x
LATERAL VIEW posexplode(split(space(23), ' ')) hh AS h, y;

-- ───────── 댐 시간 자료 ─────────
DROP TABLE IF EXISTS clean_dam_hourly;
CREATE TABLE clean_dam_hourly (
  damcode STRING, ts STRING, hidx INT,
  inflow DOUBLE, inflow_raw DOUBLE, outflow DOUBLE, storage DOUBLE, storage_pct DOUBLE, level_m DOUBLE, rain_mm DOUBLE,
  inflow_le0 BOOLEAN, inflow_outlier BOOLEAN, is_gap BOOLEAN, fix_hour24 BOOLEAN, fix_comma BOOLEAN)
PARTITIONED BY (year INT)
STORED AS PARQUET;

WITH p0 AS (                                  -- R1 연도 붙이기: 날짜 dt와 시 h로 나눔
  SELECT r.*, concat(substr(q_from, 1, 4), '-', substr(obsrdt, 1, 5)) AS dt,
         CAST(regexp_extract(obsrdt, '^\\d\\d-\\d\\d (\\d+)', 1) AS INT) AS h
  FROM raw_dam_hourly r
),
p AS (                                        -- R2 24시 → 다음 날 00시, R3 쉼표 숫자
  SELECT q_damcode AS damcode,
         CASE WHEN h = 24 THEN concat(date_add(dt, 1), ' 00:00')
              ELSE concat(dt, ' ', lpad(CAST(h AS STRING), 2, '0'), ':00') END AS ts,
         CAST(regexp_replace(inflowqy, ',', '') AS DOUBLE) AS inflow_raw,
         CAST(regexp_replace(totdcwtrqy, ',', '') AS DOUBLE) AS outflow,
         CAST(regexp_replace(rsvwtqy, ',', '') AS DOUBLE) AS storage,
         CAST(regexp_replace(rsvwtrt, ',', '') AS DOUBLE) AS storage_pct,
         CAST(regexp_replace(lowlevel, ',', '') AS DOUBLE) AS level_m,
         CAST(regexp_replace(rf, ',', '') AS DOUBLE) AS rain_mm,
         h = 24 AS fix_hour24,
         (inflowqy LIKE '%,%' OR totdcwtrqy LIKE '%,%' OR rsvwtqy LIKE '%,%' OR rsvwtrt LIKE '%,%' OR lowlevel LIKE '%,%' OR rf LIKE '%,%') AS fix_comma
  FROM p0
),
d AS (                                        -- 같은 댐·같은 시각이 둘이면 하나만(개수는 품질표에서 셈)
  SELECT * FROM (
    SELECT p.*, ROW_NUMBER() OVER (PARTITION BY damcode, ts ORDER BY inflow_raw DESC) AS rn FROM p
  ) z WHERE rn = 1
),
q AS (                                        -- R5 기준값: 댐별 양수 유입 상위 0.1%
  SELECT damcode, percentile_approx(inflow_raw, 0.999) AS p999 FROM d WHERE inflow_raw > 0 GROUP BY damcode
),
n AS (                                        -- R5 앞뒤 시간
  SELECT d.*, q.p999,
         LAG(inflow_raw) OVER (PARTITION BY d.damcode ORDER BY ts) AS prev_in,
         LEAD(inflow_raw) OVER (PARTITION BY d.damcode ORDER BY ts) AS next_in
  FROM d LEFT OUTER JOIN q ON d.damcode = q.damcode
),
r AS (                                        -- R9 댐별 첫·마지막 시각
  SELECT damcode, MIN(ts) AS mn, MAX(ts) AS mx FROM d GROUP BY damcode
),
g AS (                                        -- R9 격자: 댐마다 첫~마지막 사이 모든 시간
  SELECT r.damcode, hr.ts, hr.hidx FROM r CROSS JOIN hours hr WHERE hr.ts >= r.mn AND hr.ts <= r.mx
)
INSERT OVERWRITE TABLE clean_dam_hourly PARTITION (year)
SELECT g.damcode, g.ts, g.hidx,
       CASE WHEN n.inflow_raw > 10 * n.p999 AND n.inflow_raw > 10 * greatest(nvl(n.prev_in, 0), nvl(n.next_in, 0)) THEN NULL ELSE n.inflow_raw END AS inflow,
       n.inflow_raw, n.outflow, n.storage, n.storage_pct, n.level_m, n.rain_mm,
       nvl(n.inflow_raw <= 0, false) AS inflow_le0,
       nvl(n.inflow_raw > 10 * n.p999 AND n.inflow_raw > 10 * greatest(nvl(n.prev_in, 0), nvl(n.next_in, 0)), false) AS inflow_outlier,
       n.ts IS NULL AS is_gap,
       nvl(n.fix_hour24, false) AS fix_hour24,
       nvl(n.fix_comma, false) AS fix_comma,
       CAST(substr(g.ts, 1, 4) AS INT) AS year
FROM g LEFT OUTER JOIN n ON g.damcode = n.damcode AND g.ts = n.ts;

-- ───────── 댐 일 자료 ─────────
DROP TABLE IF EXISTS clean_dam_daily;
CREATE TABLE clean_dam_daily (
  damcode STRING, day STRING, inflow DOUBLE, outflow DOUBLE, storage DOUBLE, storage_pct DOUBLE, level_m DOUBLE, rain_mm DOUBLE,
  inflow_le0 BOOLEAN, fix_comma BOOLEAN)
PARTITIONED BY (year INT)
STORED AS PARQUET;

INSERT OVERWRITE TABLE clean_dam_daily PARTITION (year)
SELECT q_damcode, obsryymtde,
       CAST(regexp_replace(inflowqy, ',', '') AS DOUBLE), CAST(regexp_replace(totdcwtrqy, ',', '') AS DOUBLE),
       CAST(regexp_replace(rsvwtqy, ',', '') AS DOUBLE), CAST(regexp_replace(rsvwtrt, ',', '') AS DOUBLE),
       CAST(regexp_replace(lowlevel, ',', '') AS DOUBLE), CAST(regexp_replace(prcptqy, ',', '') AS DOUBLE),
       nvl(CAST(regexp_replace(inflowqy, ',', '') AS DOUBLE) <= 0, false),
       (inflowqy LIKE '%,%' OR totdcwtrqy LIKE '%,%' OR rsvwtqy LIKE '%,%' OR rsvwtrt LIKE '%,%' OR lowlevel LIKE '%,%' OR prcptqy LIKE '%,%'),
       CAST(substr(obsryymtde, 1, 4) AS INT)
FROM raw_dam_daily;

-- ───────── 시험용 관측소 목록 (R7) ─────────
DROP TABLE IF EXISTS test_stations;
CREATE TABLE test_stations STORED AS PARQUET AS
SELECT 'rain' AS kind, excllncobsrvtcode AS stn, obsrvtnm FROM raw_stations_rain
  WHERE instr(obsrvtnm, decode(unhex('EC8B9CED9798'), 'UTF-8')) > 0
UNION ALL
SELECT 'level' AS kind, walobsrvtcode AS stn, obsrvtnm FROM raw_stations_level
  WHERE instr(obsrvtnm, decode(unhex('EC8B9CED9798'), 'UTF-8')) > 0;

-- ───────── 비 관측소 (R2·R3·R6·R7) ─────────
DROP TABLE IF EXISTS clean_rain_hourly;
CREATE TABLE clean_rain_hourly (
  damcode STRING, stn STRING, ts STRING, hidx INT, rain_mm DOUBLE, cum_mm DOUBLE, fix_hour24 BOOLEAN, fix_comma BOOLEAN)
PARTITIONED BY (year INT)
STORED AS PARQUET;

INSERT OVERWRITE TABLE clean_rain_hourly PARTITION (year)
SELECT x.damcode, x.stn, x.ts, hr.hidx, x.rain_mm, x.cum_mm, x.fix_hour24, x.fix_comma, CAST(substr(x.ts, 1, 4) AS INT)
FROM (
  SELECT r.q_damcode AS damcode, r.q_stn AS stn,
         CASE WHEN substr(r.obsrdt, 12, 2) = '24' THEN concat(date_add(substr(r.obsrdt, 1, 10), 1), ' 00:00')
              ELSE substr(r.obsrdt, 1, 16) END AS ts,
         CAST(regexp_replace(r.hourrf, ',', '') AS DOUBLE) AS rain_mm,
         CAST(regexp_replace(r.acmtlrf, ',', '') AS DOUBLE) AS cum_mm,
         substr(r.obsrdt, 12, 2) = '24' AS fix_hour24,
         (r.hourrf LIKE '%,%' OR r.acmtlrf LIKE '%,%') AS fix_comma
  FROM raw_rain_hourly r
  LEFT OUTER JOIN (SELECT stn FROM test_stations WHERE kind = 'rain') t ON r.q_stn = t.stn
  WHERE t.stn IS NULL
) x LEFT OUTER JOIN hours hr ON x.ts = hr.ts;

-- ───────── 강 수위 관측소 (R2·R3·R6·R7) ─────────
DROP TABLE IF EXISTS clean_level_hourly;
CREATE TABLE clean_level_hourly (
  damcode STRING, stn STRING, ts STRING, hidx INT, level_m DOUBLE, flow DOUBLE, fix_hour24 BOOLEAN, fix_comma BOOLEAN)
PARTITIONED BY (year INT)
STORED AS PARQUET;

INSERT OVERWRITE TABLE clean_level_hourly PARTITION (year)
SELECT x.damcode, x.stn, x.ts, hr.hidx, x.level_m, x.flow, x.fix_hour24, x.fix_comma, CAST(substr(x.ts, 1, 4) AS INT)
FROM (
  SELECT l.q_damcode AS damcode, l.q_stn AS stn,
         CASE WHEN substr(l.obsrdt, 12, 2) = '24' THEN concat(date_add(substr(l.obsrdt, 1, 10), 1), ' 00:00')
              ELSE substr(l.obsrdt, 1, 16) END AS ts,
         CAST(regexp_replace(l.hourwal, ',', '') AS DOUBLE) AS level_m,
         CAST(regexp_replace(l.flux, ',', '') AS DOUBLE) AS flow,
         substr(l.obsrdt, 12, 2) = '24' AS fix_hour24,
         (l.hourwal LIKE '%,%' OR l.flux LIKE '%,%') AS fix_comma
  FROM raw_level_hourly l
  LEFT OUTER JOIN (SELECT stn FROM test_stations WHERE kind = 'level') t ON l.q_stn = t.stn
  WHERE t.stn IS NULL
) x LEFT OUTER JOIN hours hr ON x.ts = hr.ts;

-- ───────── ASOS (R8) ─────────
DROP TABLE IF EXISTS clean_asos_hourly;
CREATE TABLE clean_asos_hourly (
  stn STRING, ts STRING, hidx INT, rain_mm DOUBLE, rain_missing BOOLEAN, rain_blank_zero BOOLEAN,
  temp_c DOUBLE, humidity DOUBLE, wind_ms DOUBLE, snow_cm DOUBLE, ground_temp_c DOUBLE)
PARTITIONED BY (year INT)
STORED AS PARQUET;

INSERT OVERWRITE TABLE clean_asos_hourly PARTITION (year)
SELECT a.q_stn, a.tm, hr.hidx,
       CASE WHEN rnqcflg = '9' THEN NULL
            WHEN nvl(rn, '') = '' AND nvl(rnqcflg, '') = '' THEN 0.0
            ELSE CAST(regexp_replace(rn, ',', '') AS DOUBLE) END,
       nvl(rnqcflg = '9', false),
       nvl(rn, '') = '' AND nvl(rnqcflg, '') = '',
       CAST(ta AS DOUBLE), CAST(hm AS DOUBLE), CAST(ws AS DOUBLE), CAST(dsnw AS DOUBLE), CAST(ts AS DOUBLE),
       CAST(substr(a.tm, 1, 4) AS INT)
FROM raw_asos_hourly a LEFT OUTER JOIN hours hr ON a.tm = hr.ts;

SHOW PARTITIONS clean_dam_hourly;
