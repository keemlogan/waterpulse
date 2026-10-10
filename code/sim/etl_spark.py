# -*- coding: utf-8 -*-
"""WaterPulse 실데이터 사전 시뮬레이션 — ③ 정리·저장 (Spark).

원본 선반(lake/etl/…/raw, JSON Lines) → 정리 선반(lake/data/…/clean, Parquet, 연·월 칸 나눔).
실제 과제의 Hive 원본 표 + Spark 정리 작업을 로컬 Spark로 그대로 해 본다.
- 원본 표는 모든 열을 STRING으로 둔다(형식이 틀리면 조용히 NULL이 되는 문제를 피하려고).
- 함정 처리: 연도 붙이기, 24시 → 다음 날 0시, 쉼표 빼기, 시험 관측소 빼기, 0 이하 유입량 표시.
- 측정: 그냥 숫자로 바꿨을 때 사라지는 값 수, JSON↔Parquet 용량, 칸 나누기 전후 조회 시간.

사용법: JAVA_HOME=/opt/homebrew/opt/openjdk@21 .venv/bin/python etl_spark.py
"""
import json
import os
import tempfile
import sys
import statistics
import time

from pyspark.sql import SparkSession, Window, functions as F

HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("PYSPARK_PYTHON", sys.executable)   # Spark 작업자도 같은 파이썬을 쓰게
RAW = os.path.join(HERE, "lake", "etl", "waterpulse", "raw")
CLEAN = os.path.join(HERE, "lake", "data", "waterpulse", "clean")
BENCH = os.path.join(HERE, "lake", "data", "waterpulse", "bench")
OUT = os.path.join(HERE, "out")

spark = (SparkSession.builder.master("local[*]").appName("waterpulse-etl")
         .config("spark.driver.memory", "6g")
         .config("spark.sql.session.timeZone", "Asia/Seoul")
         .config("spark.sql.ansi.enabled", "false")   # Hive처럼: 형식이 틀리면 오류 대신 NULL
         .config("spark.sql.shuffle.partitions", "16")
         .config("spark.ui.showConsoleProgress", "false").config("spark.ui.enabled", "false")
         
         # 기본값은 실행 위치의 spark-warehouse인데, 경로의 띄어쓰기를 %20으로 바꿔 바탕화면에 'ITM%20아카이브' 폴더를 만든다 → 임시 폴더로
         .config("spark.sql.warehouse.dir", os.path.join(tempfile.gettempdir(), "waterpulse-spark-warehouse"))
         .getOrCreate())
spark.sparkContext.setLogLevel("ERROR")


def du(path):
    total, files = 0, 0
    for root, _, fs in os.walk(path):
        for f in fs:
            if f.endswith((".jsonl", ".parquet")):
                total += os.path.getsize(os.path.join(root, f))
                files += 1
    return total, files


def num(c):
    """쉼표 빼고 숫자로. 빈 문자열·'-'는 NULL."""
    s = F.regexp_replace(F.trim(F.col(c)), ",", "")
    return F.when(s.isin("", "-"), None).otherwise(s).cast("double")


report = {}

# ---------- 원본 표(외부 표, 전부 STRING) ----------
DDL = {
    "raw_dam_hourly": ("dam_hourly", "inflowqy STRING, lowlevel STRING, obsrdt STRING, rf STRING, rsvwtqy STRING, rsvwtrt STRING, totdcwtrqy STRING, damcode STRING, year INT", "damcode, year"),
    "raw_dam_daily": ("dam_daily", "inflowqy STRING, lowlevel STRING, obsryymtde STRING, prcptqy STRING, rsvwtqy STRING, rsvwtrt STRING, totdcwtrqy STRING, damcode STRING, year INT", "damcode, year"),
    "raw_rain_hourly": ("rain_hourly", "acmtlrf STRING, hourrf STRING, obsrdt STRING, damcode STRING, station STRING, year INT", "damcode, station, year"),
    "raw_level_hourly": ("level_hourly", "flux STRING, hourwal STRING, obsrdt STRING, damcode STRING, station STRING, year INT", "damcode, station, year"),
}
DDL = {k: v for k, v in DDL.items() if os.path.isdir(os.path.join(RAW, v[0]))}   # 아직 안 온 자료는 건너뜀
ddl_text = []
for name, (folder, cols, parts) in DDL.items():
    sql = f"CREATE TABLE {name} ({cols}) USING json PARTITIONED BY ({parts}) LOCATION '{os.path.join(RAW, folder)}'"
    spark.sql(f"DROP TABLE IF EXISTS {name}")
    spark.sql(sql)
    spark.sql(f"MSCK REPAIR TABLE {name}")       # 새로 생긴 폴더(파티션)를 표에 알려 주기 = Impala의 REFRESH와 같은 역할
    ddl_text.append(sql.replace(HERE, "…"))
report["ddl"] = ddl_text

# ---------- 함정 ②: 그냥 숫자로 바꾸면 몇 개가 사라지나 ----------
raw = spark.table("raw_dam_hourly")
naive = raw.select(*[(F.col(c).isNotNull() & F.col(c).cast("double").isNull()).cast("int").alias(c)
                     for c in ["inflowqy", "rsvwtqy", "totdcwtrqy", "rf"]]).agg(*[F.sum(c).alias(c) for c in ["inflowqy", "rsvwtqy", "totdcwtrqy", "rf"]]).first().asDict()
report["naive_cast_null"] = naive
report["raw_rows"] = {t: spark.table(t).count() for t in DDL}

# ---------- 정리: 댐 시간 자료 ----------
t0 = time.time()
m = F.regexp_extract("obsrdt", r"(\d{2})-(\d{2})\s+(\d{1,2})시", 1).cast("int")
d = F.regexp_extract("obsrdt", r"(\d{2})-(\d{2})\s+(\d{1,2})시", 2).cast("int")
h = F.regexp_extract("obsrdt", r"(\d{2})-(\d{2})\s+(\d{1,2})시", 3).cast("int")
dam_h = (raw
         .withColumn("ts", F.make_timestamp(F.col("year"), m, d, F.lit(0), F.lit(0), F.lit(0)) + F.make_interval(F.lit(0), F.lit(0), F.lit(0), F.lit(0), h))
         .withColumn("is24", (h == 24).cast("int"))
         .select("damcode", "ts", "is24",
                 num("rf").alias("rain_mm"), num("inflowqy").alias("inflow"), num("totdcwtrqy").alias("outflow"),
                 num("lowlevel").alias("level_m"), num("rsvwtqy").alias("storage"), num("rsvwtrt").alias("storage_pct"))
         .where(F.col("ts").isNotNull())
         .dropDuplicates(["damcode", "ts"])
         .withColumn("inflow_le0", (F.col("inflow") <= 0).cast("int"))
         .withColumn("year", F.year("ts")).withColumn("month", F.month("ts")))
# 함정 ⑤ 불가능한 값: 그 댐 평소 최댓값(양수 유입의 상위 0.1%)의 10배를 넘고, 앞뒤 1시간보다 10배 넘게 튀는 한 시간짜리 값
# (예: 광동댐 2020-11-07 01시 42,231,460㎥/s). 원본 선반엔 그대로 두고, 정리본에서는 빈칸으로 바꾸고 표시만 남긴다.
p999 = dam_h.where("inflow > 0").groupBy("damcode").agg(F.expr("percentile_approx(inflow, 0.999)").alias("p999"))
wo = Window.partitionBy("damcode").orderBy("ts")
nb = F.greatest(F.coalesce(F.lag("inflow").over(wo), F.lit(0.0)), F.coalesce(F.lead("inflow").over(wo), F.lit(0.0)), F.lit(1.0))
dam_h = (dam_h.join(p999, "damcode", "left")
         .withColumn("inflow_bad", ((F.col("inflow") > 10 * F.col("p999")) & (F.col("inflow") > 10 * nb)).cast("int"))
         .withColumn("bad_value", F.when(F.col("inflow_bad") == 1, F.col("inflow")))
         .withColumn("inflow", F.when(F.col("inflow_bad") == 1, None).otherwise(F.col("inflow")))
         .drop("p999"))
dam_h.cache()
report["dam_hourly"] = {"rows": dam_h.count(),
                        "h24_fixed": dam_h.agg(F.sum("is24")).first()[0],
                        "inflow_le0": dam_h.agg(F.sum("inflow_le0")).first()[0],
                        "inflow_null": dam_h.where(F.col("inflow").isNull()).count(),
                        "inflow_bad": dam_h.agg(F.sum("inflow_bad")).first()[0],
                        "inflow_bad_examples": [r.asDict() for r in dam_h.where("inflow_bad = 1").orderBy(F.desc("bad_value")).select("damcode", F.date_format("ts", "yyyy-MM-dd HH:mm").alias("ts"), "bad_value").limit(20).collect()],
                        "dams": dam_h.select("damcode").distinct().count(),
                        "ts_min": str(dam_h.agg(F.min("ts")).first()[0]), "ts_max": str(dam_h.agg(F.max("ts")).first()[0])}
(dam_h.drop("is24", "bad_value").repartition("year", "month").write.mode("overwrite")
 .partitionBy("year", "month").parquet(os.path.join(CLEAN, "dam_hourly")))
report["dam_hourly"]["sec"] = round(time.time() - t0, 1)

# ---------- 정리: 댐 일 자료 ----------
dd = spark.table("raw_dam_daily")
dam_d = (dd.select("damcode", F.to_date("obsryymtde").alias("date"),
                   num("prcptqy").alias("rain_mm"), num("inflowqy").alias("inflow"), num("totdcwtrqy").alias("outflow"),
                   num("lowlevel").alias("level_m"), num("rsvwtqy").alias("storage"), num("rsvwtrt").alias("storage_pct"))
         .where(F.col("date").isNotNull()).dropDuplicates(["damcode", "date"])
         .withColumn("year", F.year("date")))
report["dam_daily"] = {"rows": dam_d.count(), "dams": dam_d.select("damcode").distinct().count()}
dam_d.repartition("year").write.mode("overwrite").partitionBy("year").parquet(os.path.join(CLEAN, "dam_daily"))

# ---------- 정리: 관측소 ----------
HAS_STN = "raw_rain_hourly" in DDL and "raw_level_hourly" in DDL
meta = json.load(open(os.path.join(HERE, "spool", "meta", "stations.json"), encoding="utf-8"))["items"][0]
names = {}
for dam, lists in meta.items():
    for r in lists["rain"]:
        names[("rain", str(r["excllncobsrvtcode"]))] = r["obsrvtNm"]
    for w in lists["level"]:
        names[("level", str(w["walobsrvtcode"]))] = w["obsrvtNm"]
test_rain = [k[1] for k, v in names.items() if k[0] == "rain" and "시험" in v]


def station_ts(col="obsrdt"):  # "2023-07-14 24:00" → 다음 날 0시
    day = F.to_date(F.substring(col, 1, 10))
    hh = F.substring(col, 12, 2).cast("int")
    return F.to_timestamp(day) + F.make_interval(F.lit(0), F.lit(0), F.lit(0), F.lit(0), hh)


if HAS_STN:
    rain = (spark.table("raw_rain_hourly").where(~F.col("station").isin(test_rain))
            .select("damcode", "station", station_ts().alias("ts"), num("hourrf").alias("rain_mm"))
            .dropDuplicates(["station", "ts"]).withColumn("year", F.year("ts")))
    level = (spark.table("raw_level_hourly")
             .select("damcode", "station", station_ts().alias("ts"), num("hourwal").alias("level_m"), num("flux").alias("flow"))
             .dropDuplicates(["station", "ts"]).withColumn("year", F.year("ts")))
    report["rain_hourly"] = {"rows": rain.count(), "stations": rain.select("station").distinct().count()}
    report["level_hourly"] = {"rows": level.count(), "stations": level.select("station").distinct().count()}
    rain.repartition("year").write.mode("overwrite").partitionBy("year").parquet(os.path.join(CLEAN, "rain_hourly"))
    level.repartition("year").write.mode("overwrite").partitionBy("year").parquet(os.path.join(CLEAN, "level_hourly"))

# ---------- 용량·파일 수 ----------
sizes = {}
for ds in ["dam_hourly", "dam_daily"] + (["rain_hourly", "level_hourly"] if HAS_STN else []):
    rb, rf = du(os.path.join(RAW, ds))
    cb, cf = du(os.path.join(CLEAN, ds))
    sizes[ds] = {"raw_bytes": rb, "raw_files": rf, "parquet_bytes": cb, "parquet_files": cf}
report["sizes"] = sizes

# ---------- 칸 나누기(파티션) 효과: 같은 질문을 세 가지 방식으로 ----------
dam_h.drop("is24", "bad_value").coalesce(8).write.mode("overwrite").parquet(os.path.join(BENCH, "dam_hourly_nopart"))
spark.read.parquet(os.path.join(CLEAN, "dam_hourly")).createOrReplaceTempView("p_part")
spark.read.parquet(os.path.join(BENCH, "dam_hourly_nopart")).createOrReplaceTempView("p_nopart")
RAW_INFLOW = "CAST(regexp_replace(inflowqy, ',', '') AS DOUBLE)"
QUERIES = {   # 같은 질문을 원본 JSON, 칸 안 나눈 Parquet, 연·월로 칸 나눈 Parquet에 던진다
    "month": {"label": "2023년 7월, 전체 댐 평균 유입량",
              "json_raw": f"SELECT avg({RAW_INFLOW}) FROM raw_dam_hourly WHERE year=2023 AND obsrdt LIKE '07-%'",
              "parquet_nopart": "SELECT avg(inflow) FROM p_nopart WHERE year=2023 AND month=7",
              "parquet_part": "SELECT avg(inflow) FROM p_part WHERE year=2023 AND month=7"},
    "full": {"label": "6년 전체, 댐별 평균 유입량",
             "json_raw": f"SELECT damcode, avg({RAW_INFLOW}) FROM raw_dam_hourly GROUP BY damcode",
             "parquet_nopart": "SELECT damcode, avg(inflow) FROM p_nopart GROUP BY damcode",
             "parquet_part": "SELECT damcode, avg(inflow) FROM p_part GROUP BY damcode"},
}


def bench(sql, n=5):
    ts = []
    for _ in range(n):
        t = time.time()
        spark.sql(sql).collect()
        ts.append(time.time() - t)
    return round(statistics.median(ts[1:]) * 1000)   # 첫 번은 준비 시간이라 빼고 가운데 값(ms)


report["bench_ms"] = {k: {"label": q["label"], **{m: bench(q[m]) for m in ["json_raw", "parquet_nopart", "parquet_part"]}}
                      for k, q in QUERIES.items()}
plan = spark.sql(QUERIES["month"]["parquet_part"])._jdf.queryExecution().executedPlan().toString()
i = plan.find("PartitionFilters: [")
report["bench_partition_filters"] = plan[i:plan.find("]", i) + 1] if i >= 0 else None   # 칸 나누기로 건너뛴 증거

os.makedirs(OUT, exist_ok=True)
json.dump(report, open(os.path.join(OUT, "etl_report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)
print(json.dumps(report, ensure_ascii=False, indent=1, default=str)[:3000])
spark.stop()
