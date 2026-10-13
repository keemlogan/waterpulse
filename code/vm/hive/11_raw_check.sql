-- 11_raw_check.sql — 원본 표 검사. COUNT(*)는 10_load_raw.sh가 출력한 기대 행 수(expected_rows_*.tsv)와 같아야 한다.
-- 대소문자 키(stnId 등)가 소문자 열로 읽히는지도 본다: 0이 나오면 JsonSerDe가 키를 못 맞춘 것.
ADD JAR /usr/lib/hive-hcatalog/share/hcatalog/hive-hcatalog-core.jar;
USE wp;

SELECT * FROM (
  SELECT 'dam_hourly' AS t, COUNT(*) AS rows_total, COUNT(obsrdt) AS rows_with_time FROM raw_dam_hourly
  UNION ALL SELECT 'dam_daily' AS t, COUNT(*) AS rows_total, COUNT(obsryymtde) AS rows_with_time FROM raw_dam_daily
  UNION ALL SELECT 'rain_hourly' AS t, COUNT(*) AS rows_total, COUNT(obsrdt) AS rows_with_time FROM raw_rain_hourly
  UNION ALL SELECT 'level_hourly' AS t, COUNT(*) AS rows_total, COUNT(obsrdt) AS rows_with_time FROM raw_level_hourly
  UNION ALL SELECT 'asos_hourly' AS t, COUNT(*) AS rows_total, COUNT(tm) AS rows_with_time FROM raw_asos_hourly
) u;

-- 대소문자 키 확인: stnId·stnNm·taQcflg·floodadjstCpcty·excllncobsrvtcode
SELECT COUNT(*) AS n, COUNT(stnid) AS stnid_ok, COUNT(stnnm) AS stnnm_ok, COUNT(taqcflg) AS taqcflg_ok FROM raw_asos_hourly;
SELECT COUNT(*) AS n, COUNT(floodadjstcpcty) AS flood_ok, COUNT(planfwal) AS planfwal_ok FROM raw_dam_specs;
SELECT COUNT(*) AS n, COUNT(excllncobsrvtcode) AS code_ok FROM raw_stations_rain;

-- 원본 모양 그대로(정제 전) 한 줄씩
SELECT * FROM raw_dam_hourly LIMIT 3;
SELECT * FROM raw_rain_hourly LIMIT 3;
SELECT q_stn, tm, stnnm, ta, rn, rnqcflg, hm FROM raw_asos_hourly LIMIT 3;

-- 함정 미리보기: 쉼표 숫자, 24시 표기, 0 이하 유입
SELECT COUNT(*) AS comma_storage FROM raw_dam_hourly WHERE rsvwtqy LIKE '%,%';
SELECT COUNT(*) AS hour24_dam FROM raw_dam_hourly WHERE obsrdt LIKE '%24시%';
SELECT COUNT(*) AS hour24_station FROM raw_rain_hourly WHERE obsrdt LIKE '% 24:00';
SELECT COUNT(*) AS inflow_le0 FROM raw_dam_hourly WHERE CAST(regexp_replace(inflowqy, ',', '') AS DOUBLE) <= 0;
