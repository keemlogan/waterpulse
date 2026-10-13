# -*- coding: utf-8 -*-
# 40_first_forecast.py — 첫 예측 숫자(중간발표). 하둡의 정리본 표를 Spark가 읽어 YARN에서 계산한다.
#   질문: 소양강댐 6시간 뒤 유입량을 맞히는 데, "지금 그대로"(기준선)와 "지난 3시간 평균" 중 무엇이 오차가 작은가?
#   - "N시간 뒤"는 행 순서가 아니라 시간 번호 hidx + N으로 찾는다(Parquet 행은 시간순이 아니다 — 시뮬레이션에서 겪은 버그).
#   - 큰물 때(6시간 뒤 유입이 상위 10%)만 따로도 잰다.
#   - 결과는 Hive 표 wp.mart_first_forecast(Parquet)에 남겨 Impala·웹이 읽게 한다.
# 환경: Spark 1.3.0(CDH 5.4.3), Python 2.6 — f-string·dict comprehension·'{}'.format 쓰지 않음.
# 실행: spark-submit --master yarn-client --num-executors 2 --executor-memory 1g 40_first_forecast.py [댐코드] [시간]
from __future__ import print_function
import sys
from pyspark import SparkContext
from pyspark.sql import HiveContext

DAM = sys.argv[1] if len(sys.argv) > 1 else '1012110'
H = int(sys.argv[2]) if len(sys.argv) > 2 else 6

sc = SparkContext(appName='WaterPulse-first-forecast-%s-%dh' % (DAM, H))
sq = HiveContext(sc)

# [WaterPulse PC 수정] Spark 1.3은 같은 Hive 표를 4번 자기 조인하면 AnalysisException("resolved attributes ... missing from")을 낸다.
# 그래서 댐 한 곳의 행을 한 번만 읽고, 역할(t·f·p1·p2)마다 열 이름이 다른 임시 표를 따로 만들어 조인한다(계산은 같다).
from pyspark.sql.types import StructType, StructField, IntegerType, StringType, DoubleType
base = sq.sql("SELECT year, ts, hidx, inflow FROM wp.clean_dam_hourly WHERE damcode = '%s' AND inflow IS NOT NULL" % DAM).rdd.map(lambda r: (r[0], r[1], r[2], r[3])).cache()
for role in ('t', 'f', 'p1', 'p2'):
    schema = StructType([StructField(role + '_year', IntegerType(), True), StructField(role + '_ts', StringType(), True),
                         StructField(role + '_hidx', IntegerType(), True), StructField(role + '_in', DoubleType(), True)])
    sq.createDataFrame(base, schema).registerTempTable(role)
pairs = sq.sql("""
SELECT t_year AS year, t_ts AS ts, t_in AS now_in, f_in AS future_in,
       (t_in + p1_in + p2_in) / 3.0 AS mean3
FROM t
JOIN f  ON f_hidx = t_hidx + %d
JOIN p1 ON p1_hidx = t_hidx - 1
JOIN p2 ON p2_hidx = t_hidx - 2
""" % H)
pairs.registerTempTable('pairs')
pairs.cache()

n_all = pairs.count()
p90 = sq.sql("SELECT percentile_approx(future_in, 0.9) FROM pairs").collect()[0][0]
print('### 짝지은 시각 수: %d · 큰물 기준(6시간 뒤 유입 상위 10%%): %.1f ㎥/s' % (n_all, p90))

res = sq.sql("""
SELECT '%s' AS damcode, %d AS horizon_h, scope, COUNT(*) AS n,
       AVG(ABS(future_in - now_in)) AS mae_persist,
       AVG(ABS(future_in - mean3)) AS mae_mean3
FROM (
  SELECT 'all' AS scope, future_in, now_in, mean3 FROM pairs
  UNION ALL
  SELECT 'high_water' AS scope, future_in, now_in, mean3 FROM pairs WHERE future_in >= %f
) u
GROUP BY scope
""" % (DAM, H, p90))
res.registerTempTable('res')

sq.sql("DROP TABLE IF EXISTS wp.mart_first_forecast")
sq.sql("""CREATE TABLE wp.mart_first_forecast (
  damcode STRING, horizon_h INT, scope STRING, n BIGINT, mae_persist DOUBLE, mae_mean3 DOUBLE, improve_pct DOUBLE)
  STORED AS PARQUET""")
sq.sql("""INSERT OVERWRITE TABLE wp.mart_first_forecast
SELECT damcode, horizon_h, scope, n, mae_persist, mae_mean3,
       100.0 * (1.0 - mae_mean3 / mae_persist) AS improve_pct
FROM res""")

print('### CAPTURE: Spark_첫_예측_결과')
print('댐 %s · %d시간 뒤 유입량 · 평균 절대 오차(㎥/s)' % (DAM, H))
for r in sq.sql("SELECT scope, n, mae_persist, mae_mean3, improve_pct FROM wp.mart_first_forecast ORDER BY scope").collect():
    print('%-11s 시각 %7d개 · 지금 그대로 %8.2f · 지난 3시간 평균 %8.2f · 개선 %+6.1f%%' % (r[0], r[1], r[2], r[3], r[4]))
print('연도별 짝 수:')
for r in sq.sql("SELECT year, COUNT(*) FROM pairs GROUP BY year ORDER BY year").collect():
    print('  %d  %d' % (r[0], r[1]))
sc.stop()
