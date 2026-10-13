-- 10_raw_tables.sql — 원본 선반(/etl/waterpulse/raw)에 Hive 표 이름표만 붙인다(schema-on-read).
-- * 모든 칸을 STRING으로 둔다. "1,857.835" 같은 쉼표 숫자를 숫자 칸으로 읽으면 Hive가 조용히 NULL을 만든다(시뮬레이션에서 13만 칸 사라짐).
--   숫자 변환·시각 보정은 정제 단계(20_clean.sql)가 한다.
-- * EXTERNAL 표라 표를 지워도 원본 파일은 남는다.
-- * 원본은 JSON Lines(.gz). Impala 2.2는 JSON SerDe 표를 읽지 못하므로 원본 표는 Hive 전용이다.
-- 환경: Hive 1.1.0-cdh5.4.3. 실행: hive -f 10_raw_tables.sql

ADD JAR /usr/lib/hive-hcatalog/share/hcatalog/hive-hcatalog-core.jar;
CREATE DATABASE IF NOT EXISTS wp;
USE wp;

-- 댐 시간 자료 (K-water 수문 운영 정보 hourlist). obsrdt = "07-14 01시 " (연도 없음, 01~24시)
DROP TABLE IF EXISTS raw_dam_hourly;
CREATE EXTERNAL TABLE raw_dam_hourly (
  q_damcode STRING, q_from STRING, q_to STRING,
  obsrdt STRING, inflowqy STRING, totdcwtrqy STRING, rsvwtqy STRING, rsvwtrt STRING, lowlevel STRING, rf STRING)
ROW FORMAT SERDE 'org.apache.hive.hcatalog.data.JsonSerDe'
LOCATION '/etl/waterpulse/raw/dam_hourly';

-- 댐 일 자료 (delist). obsryymtde = "2023-01-01"
DROP TABLE IF EXISTS raw_dam_daily;
CREATE EXTERNAL TABLE raw_dam_daily (
  q_damcode STRING, q_from STRING, q_to STRING,
  obsryymtde STRING, inflowqy STRING, totdcwtrqy STRING, rsvwtqy STRING, rsvwtrt STRING, lowlevel STRING, prcptqy STRING)
ROW FORMAT SERDE 'org.apache.hive.hcatalog.data.JsonSerDe'
LOCATION '/etl/waterpulse/raw/dam_daily';

-- 비 관측소 시간 자료 (hourrflist). obsrdt = "2023-01-01 01:00" (01~24시 표기)
DROP TABLE IF EXISTS raw_rain_hourly;
CREATE EXTERNAL TABLE raw_rain_hourly (
  q_damcode STRING, q_stn STRING, q_from STRING, q_to STRING,
  obsrdt STRING, hourrf STRING, acmtlrf STRING, no STRING)
ROW FORMAT SERDE 'org.apache.hive.hcatalog.data.JsonSerDe'
LOCATION '/etl/waterpulse/raw/rain_hourly';

-- 강 수위 관측소 시간 자료 (hourwallist). obsrdt 형식은 비와 같다
DROP TABLE IF EXISTS raw_level_hourly;
CREATE EXTERNAL TABLE raw_level_hourly (
  q_damcode STRING, q_stn STRING, q_from STRING, q_to STRING,
  obsrdt STRING, hourwal STRING, flux STRING, no STRING)
ROW FORMAT SERDE 'org.apache.hive.hcatalog.data.JsonSerDe'
LOCATION '/etl/waterpulse/raw/level_hourly';

-- 기상청 ASOS 시간 자료 (getWthrDataList). tm = "2023-01-01 00:00" (00~23시). 열 이름은 원본 키를 소문자로.
DROP TABLE IF EXISTS raw_asos_hourly;
CREATE EXTERNAL TABLE raw_asos_hourly (
  q_stn STRING, q_from STRING, q_to STRING, tm STRING, rnum STRING, stnid STRING, stnnm STRING,
  ta STRING, taqcflg STRING, rn STRING, rnqcflg STRING, ws STRING, wsqcflg STRING, wd STRING, wdqcflg STRING,
  hm STRING, hmqcflg STRING, pv STRING, td STRING, pa STRING, paqcflg STRING, ps STRING, psqcflg STRING,
  ss STRING, ssqcflg STRING, icsr STRING, dsnw STRING, hr3fhsc STRING, dc10tca STRING, dc10lmcsca STRING,
  clfmabbrcd STRING, lcsch STRING, vs STRING, gndsttcd STRING, dmstmtphno STRING, ts STRING, tsqcflg STRING,
  m005te STRING, m01te STRING, m02te STRING, m03te STRING)
ROW FORMAT SERDE 'org.apache.hive.hcatalog.data.JsonSerDe'
LOCATION '/etl/waterpulse/raw/asos_hourly';

-- 기준 정보(meta) — 댐 목록·제원, 관측소 목록, ASOS 지점
DROP TABLE IF EXISTS raw_dam_codes;
CREATE EXTERNAL TABLE raw_dam_codes (damcode STRING, damnm STRING)
ROW FORMAT SERDE 'org.apache.hive.hcatalog.data.JsonSerDe'
LOCATION '/etl/waterpulse/raw/meta/dam_codes';

DROP TABLE IF EXISTS raw_dam_specs;
CREATE EXTERNAL TABLE raw_dam_specs (
  competde STRING, damfom STRING, damdgr STRING, damnm STRING, dgrar STRING, floodadjstcpcty STRING,
  fyeruswtrsuplyplanqy STRING, hg STRING, lt STRING, nrmltal STRING, ordtmfwal STRING, planfwal STRING,
  rsvwtar STRING, strwrkde STRING, totrsvwtcpcty STRING, validrsvwtcpcty STRING, vl STRING, wollyupvlal STRING)
ROW FORMAT SERDE 'org.apache.hive.hcatalog.data.JsonSerDe'
LOCATION '/etl/waterpulse/raw/meta/dam_specs';

DROP TABLE IF EXISTS raw_stations_rain;
CREATE EXTERNAL TABLE raw_stations_rain (q_damcode STRING, excllncobsrvtcode STRING, obsrvtnm STRING)
ROW FORMAT SERDE 'org.apache.hive.hcatalog.data.JsonSerDe'
LOCATION '/etl/waterpulse/raw/meta/stations_rain';

DROP TABLE IF EXISTS raw_stations_level;
CREATE EXTERNAL TABLE raw_stations_level (q_damcode STRING, obsrvtnm STRING, walobsrvtcode STRING)
ROW FORMAT SERDE 'org.apache.hive.hcatalog.data.JsonSerDe'
LOCATION '/etl/waterpulse/raw/meta/stations_level';

DROP TABLE IF EXISTS raw_asos_stations;
CREATE EXTERNAL TABLE raw_asos_stations (stnid STRING, stnnm STRING, seen STRING)
ROW FORMAT SERDE 'org.apache.hive.hcatalog.data.JsonSerDe'
LOCATION '/etl/waterpulse/raw/meta/asos_stations';

SHOW TABLES;
