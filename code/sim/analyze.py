# -*- coding: utf-8 -*-
"""WaterPulse 실데이터 사전 시뮬레이션 — ④ 분석.

큰 데이터 작업(빈 시간 채우기, 시간 밀기, 이동 합계)은 Spark DataFrame으로, 작아진 표의 모델·통계는 Python으로.
1) 데이터 품질  2) 반응 시간(사건 기반) + 유역 넓이와 비교  3) 20년 추세  4) 3·6·12시간 뒤 예측(기준선 대비)
5) 상류 관측소를 넣으면 나아지나(3개 댐)  6) 이상한 순간 찾기

사용법: JAVA_HOME=/opt/homebrew/opt/openjdk@21 .venv/bin/python analyze.py
결과: out/analysis.json
"""
import json
import os
import tempfile
import sys
import re
import time

import numpy as np
import pandas as pd
from pyspark.sql import SparkSession, Window, functions as F
from scipy import stats
from sklearn.ensemble import HistGradientBoostingRegressor

HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("PYSPARK_PYTHON", sys.executable)   # Spark 작업자도 같은 파이썬을 쓰게
CLEAN = os.path.join(HERE, "lake", "data", "waterpulse", "clean")
MART = os.path.join(HERE, "lake", "data", "waterpulse", "mart")
OUT = os.path.join(HERE, "out")
STATION_DAMS = ["1012110", "3008110", "2001110"]
HORIZONS = [3, 6, 12]
TIMER = {}

spark = (SparkSession.builder.master("local[*]").appName("waterpulse-analyze")
         .config("spark.driver.memory", "8g").config("spark.sql.session.timeZone", "Asia/Seoul")
         .config("spark.sql.ansi.enabled", "false")   # Hive처럼: 형식이 틀리면 오류 대신 NULL
         .config("spark.sql.shuffle.partitions", "16").config("spark.ui.showConsoleProgress", "false").config("spark.ui.enabled", "false")
         .config("spark.sql.execution.arrow.pyspark.enabled", "true")
         # 기본값은 실행 위치의 spark-warehouse인데, 경로의 띄어쓰기를 %20으로 바꿔 바탕화면에 'ITM%20아카이브' 폴더를 만든다 → 임시 폴더로
         .config("spark.sql.warehouse.dir", os.path.join(tempfile.gettempdir(), "waterpulse-spark-warehouse"))
         .getOrCreate())
spark.sparkContext.setLogLevel("ERROR")


def tic(name):
    TIMER[name] = time.time()


def toc(name):
    TIMER[name] = round(time.time() - TIMER[name], 1)


# ---------- 기준표: 댐 이름·종류·제원 ----------
codes = json.load(open(os.path.join(HERE, "spool", "meta", "dam_codes.json"), encoding="utf-8"))["items"]
specs = json.load(open(os.path.join(HERE, "spool", "meta", "dam_specs.json"), encoding="utf-8"))["items"]
norm = lambda s: re.sub(r"\(.*?\)|댐|\s", "", str(s))
spec_by = {norm(s["damnm"]): s for s in specs}
DAMS = {}
for c in codes:
    nm = c["damnm"]
    kind = "보" if nm.endswith("보") else "조정지" if "조정지" in nm else "하굿둑" if "하굿둑" in nm else "댐"
    sp = spec_by.get(norm(nm), {})
    area = sp.get("dgrar")
    DAMS[str(c["damcode"])] = {"name": nm, "kind": kind,
                               "basin_km2": float(str(area).replace(",", "")) if area not in (None, "", "-") else None,
                               "height_m": sp.get("hg"), "capacity": sp.get("totRsvwtcpcty")}

# ---------- 1) 품질 ----------
tic("quality")
dh = spark.read.parquet(os.path.join(CLEAN, "dam_hourly"))
EXPECTED = int((pd.Timestamp("2026-01-01") - pd.Timestamp("2020-01-01")) / pd.Timedelta(hours=1))
q = (dh.groupBy("damcode").agg(F.count("*").alias("rows"),
                               F.sum(F.col("inflow").isNull().cast("int")).alias("inflow_null"),
                               F.sum("inflow_le0").alias("inflow_le0"),
                               F.sum(F.col("rain_mm").isNull().cast("int")).alias("rain_null"),
                               F.min("ts").alias("first"), F.max("ts").alias("last"))
     .toPandas())
quality = {}
for r in q.itertuples():
    quality[r.damcode] = {"rows": int(r.rows), "coverage": round(r.rows / EXPECTED * 100, 1),
                          "inflow_null_pct": round(r.inflow_null / r.rows * 100, 2),
                          "inflow_le0_pct": round(r.inflow_le0 / r.rows * 100, 2),
                          "rain_null_pct": round(r.rain_null / r.rows * 100, 2),
                          "first": str(r.first)[:16], "last": str(r.last)[:16]}
toc("quality")

# ---------- Spark: 빈 시간 채우기 + 시간 밀기로 학습표 만들기 ----------
tic("features_spark")
rng = dh.groupBy("damcode").agg(F.min("ts").alias("mn"), F.max("ts").alias("mx"))
grid = rng.select("damcode", F.explode(F.expr("sequence(mn, mx, interval 1 hour)")).alias("ts"))
full = grid.join(dh.select("damcode", "ts", "rain_mm", "inflow", "outflow", "storage_pct", "inflow_le0"),
                 ["damcode", "ts"], "left")
w = Window.partitionBy("damcode").orderBy("ts")
roll = lambda k: w.rowsBetween(-(k - 1), 0)
# 매시간 유입량은 저수량 변화로 계산한 값이라 들쭉날쭉하다(1차 시도에서 확인). 지난 3시간 평균(s3)을 맞힐 대상으로 쓴다.
feat = (full.withColumn("inflow_pos", F.when(F.col("inflow") > 0, F.col("inflow")))
        .withColumn("s3", F.avg("inflow_pos").over(roll(3))))
for k in [1, 2, 3, 6, 12]:
    feat = feat.withColumn(f"s3_lag{k}", F.lag("s3", k).over(w))
feat = feat.withColumn("s3_d1", F.col("s3") - F.col("s3_lag1")).withColumn("s3_d3", F.col("s3") - F.col("s3_lag3"))
for k in [3, 6, 12, 24]:
    feat = feat.withColumn(f"rain_sum{k}", F.sum("rain_mm").over(roll(k)))
for h in HORIZONS:
    feat = feat.withColumn(f"y{h}", F.lead("s3", h).over(w))
feat = (feat.withColumn("month", F.month("ts")).withColumn("year", F.year("ts"))
        .withColumn("hour", F.hour("ts")))

# 상류 관측소(3개 댐): 관측소 평균 강우, 강 수위 변화, 강 유량 합
HAS_STN = os.path.isdir(os.path.join(CLEAN, "rain_hourly")) and os.path.isdir(os.path.join(CLEAN, "level_hourly"))
if not HAS_STN:
    STATION_DAMS = []
    feat = feat.select("*", *[F.lit(None).cast("double").alias(c) for c in
                              ["up_rain", "up_rain_sum3", "up_rain_sum6", "up_rain_sum12", "up_rain_sum24", "up_dlev1", "up_dlev3", "up_flow", "up_flow_d3"]])
rain_st = spark.read.parquet(os.path.join(CLEAN, "rain_hourly")) if HAS_STN else None
if HAS_STN:
    lvl_st = spark.read.parquet(os.path.join(CLEAN, "level_hourly"))
    ra = rain_st.groupBy("damcode", "ts").agg(F.avg("rain_mm").alias("up_rain"))
    ws = Window.partitionBy("station").orderBy("ts")
    lv = (lvl_st.withColumn("dlev1", F.col("level_m") - F.lag("level_m", 1).over(ws))
          .withColumn("dlev3", F.col("level_m") - F.lag("level_m", 3).over(ws))
          .groupBy("damcode", "ts").agg(F.avg("dlev1").alias("up_dlev1"), F.avg("dlev3").alias("up_dlev3"),
                                       F.sum(F.when(F.col("flow") > 0, F.col("flow"))).alias("up_flow")))
    up = (grid.where(F.col("damcode").isin(STATION_DAMS)).join(ra, ["damcode", "ts"], "left").join(lv, ["damcode", "ts"], "left"))
    for k in [3, 6, 12, 24]:
        up = up.withColumn(f"up_rain_sum{k}", F.sum("up_rain").over(roll(k)))
    up = up.withColumn("up_flow_d3", F.col("up_flow") - F.lag("up_flow", 3).over(w))
    feat = feat.join(up, ["damcode", "ts"], "left")
feat.write.mode("overwrite").partitionBy("year").parquet(os.path.join(MART, "features_hourly"))
# 310만 줄을 Spark→pandas로 넘기면 맥의 소켓 버퍼가 터진다(No buffer space available). Spark가 쓴 Parquet을 pandas가 직접 읽는다.
pdf = pd.read_parquet(os.path.join(MART, "features_hourly"))
pdf["year"] = pdf["year"].astype(int)
pdf["ts"] = pdf["ts"].dt.tz_localize("UTC").dt.tz_convert("Asia/Seoul").dt.tz_localize(None)   # Parquet 시각은 UTC로 저장됨
pdf["damcode"] = pdf["damcode"].astype(str)
pdf = pdf.sort_values(["damcode", "ts"]).reset_index(drop=True)
toc("features_spark")
print("features", pdf.shape, flush=True)

# ---------- 2) 반응 시간: 큰비 사건마다 비 최고 → 유입 최고 ----------
tic("lag")


def storm_events(g, gap=6, min_total=30.0):
    r = g["rain_mm"].fillna(0).to_numpy()
    wet = np.where(r > 0)[0]
    if len(wet) == 0:
        return []
    ev, start, last = [], wet[0], wet[0]
    for i in wet[1:]:
        if i - last > gap:
            ev.append((start, last))
            start = i
        last = i
    ev.append((start, last))
    return [(s, e) for s, e in ev if r[s:e + 1].sum() >= min_total]


lag_rows, rep_events = [], {}
for code, g in pdf.groupby("damcode"):
    g = g.reset_index(drop=True)
    inf = g["inflow"].where(g["inflow"] > 0).rolling(3, center=True, min_periods=1).mean().to_numpy()
    r = g["rain_mm"].fillna(0).to_numpy()
    cand = []
    for s, e in storm_events(g):
        tp = s + int(np.argmax(r[s:e + 1]))
        win_end = min(len(g) - 1, e + 72)
        seg = inf[s:win_end + 1]
        if np.all(np.isnan(seg)):
            continue
        ip = s + int(np.nanargmax(seg))
        base = np.nanmedian(inf[max(0, s - 24):s]) if s > 0 else np.nan
        peak = inf[ip]
        if not (np.isfinite(base) and peak >= 1.5 * base and peak - base >= 5):
            continue                                   # 비가 와도 유입이 뚜렷이 늘지 않은 사건은 빼기
        lag = ip - tp
        if lag < 0:
            continue
        cen = s + float(np.sum(np.arange(e - s + 1) * r[s:e + 1]) / r[s:e + 1].sum())
        rec = {"damcode": code, "rain_peak": str(g.ts[tp])[:16], "inflow_peak": str(g.ts[ip])[:16],
               "lag_h": int(lag), "lag_centroid_h": round(ip - cen, 1), "rain_total": round(float(r[s:e + 1].sum()), 1),
               "peak_inflow": round(float(peak), 1), "base_inflow": round(float(base), 1)}
        lag_rows.append(rec)
        cand.append((peak, lag, s, tp, ip))
    if len(cand) >= 5:
        # 대표 사건: 큰 사건(유입 상위 25%) 가운데 반응 시간이 그 댐의 가운데 값에 가장 가까운 것
        med = float(np.median([c[1] for c in cand]))
        cut = np.quantile([c[0] for c in cand], .75)
        _, lg, s, tp, ip = min((c for c in cand if c[0] >= cut), key=lambda c: (abs(c[1] - med), -c[0]))
        a, b = max(0, s - 12), min(len(g), ip + 36)
        seg = g.iloc[a:b]
        rep_events[code] = {"ts": [str(t)[:16] for t in seg.ts], "rain_peak_i": int(tp - a), "inflow_peak_i": int(ip - a), "lag_h": int(lg),
                            "rain": [None if pd.isna(x) else round(float(x), 1) for x in seg.rain_mm],
                            "inflow": [None if pd.isna(x) else round(float(x), 1) for x in seg.inflow]}
lags = pd.DataFrame(lag_rows)
lag_by_dam = {}
for code, g in lags.groupby("damcode"):
    if len(g) >= 5:
        lag_by_dam[code] = {"events": int(len(g)), "median_h": float(g.lag_h.median()),
                            "q1_h": float(g.lag_h.quantile(.25)), "q3_h": float(g.lag_h.quantile(.75)),
                            "median_centroid_h": float(g.lag_centroid_h.median())}

# 두 번째 방법: 비 그래프를 몇 시간 밀었을 때 유입량과 가장 닮나(교차상관, 6~9월)
for code, g in pdf[pdf.month.between(6, 9)].groupby("damcode"):
    if code not in lag_by_dam:
        continue
    r = g["rain_mm"].fillna(0).to_numpy()
    inf = g["inflow"].where(g["inflow"] > 0).interpolate(limit=6).fillna(0).to_numpy()
    best = max(range(0, 49), key=lambda k: np.corrcoef(r[:len(r) - k], inf[k:])[0, 1] if r[:len(r) - k].std() > 0 else -1)
    lag_by_dam[code]["xcorr_h"] = int(best)

cmp_rows = [(DAMS[c]["basin_km2"], v["median_h"], DAMS[c]["kind"]) for c, v in lag_by_dam.items() if DAMS.get(c, {}).get("basin_km2")]
dams_only = [(a, l) for a, l, k in cmp_rows if k == "댐"]
rho_all = stats.spearmanr([a for a, _, _ in cmp_rows], [l for _, l, _ in cmp_rows])
rho_dam = stats.spearmanr([a for a, _ in dams_only], [l for _, l in dams_only]) if len(dams_only) > 4 else None
agree = [abs(v["median_h"] - v.get("xcorr_h", np.nan)) <= 3 for v in lag_by_dam.values() if "xcorr_h" in v]
toc("lag")

# ---------- 3) 20년 추세(일 자료) ----------
tic("trend")
dd = spark.read.parquet(os.path.join(CLEAN, "dam_daily")).toPandas()
dd["damcode"] = dd["damcode"].astype(str)
yr = (dd.groupby(["damcode", "year"]).agg(days=("date", "count"), rain=("rain_mm", "sum"),
                                          max_inflow=("inflow", "max"),
                                          heavy=("rain_mm", lambda s: int((s >= 50).sum()))).reset_index())
yr = yr[yr.days >= 330]
long_dams = [c for c, g in yr.groupby("damcode") if g.year.min() <= 2008 and len(g) >= 17]
yl = yr[yr.damcode.isin(long_dams)].copy()
yl["max_idx"] = yl.groupby("damcode").max_inflow.transform(lambda s: s / s.median())
nat = yl.groupby("year").agg(max_idx=("max_idx", "median"), rain=("rain", "median"), heavy=("heavy", "mean")).reset_index()


def trend(x, y):
    tau = stats.kendalltau(x, y)
    sen = stats.theilslopes(y, x)
    return {"tau": round(float(tau.statistic), 3), "p": round(float(tau.pvalue), 3), "slope_per_year": round(float(sen.slope), 4)}


trend_nat = {k: trend(nat.year, nat[k]) for k in ["max_idx", "rain", "heavy"]}
per_dam_sig = {"up": 0, "down": 0, "none": 0}
for c, g in yl.groupby("damcode"):
    t = stats.kendalltau(g.year, g.max_inflow)
    per_dam_sig["up" if t.pvalue < .05 and t.statistic > 0 else "down" if t.pvalue < .05 else "none"] += 1
toc("trend")

# ---------- 4~6) 예측과 이상 탐지 ----------
tic("forecast")
BASE_F = ["s3", "s3_lag1", "s3_lag2", "s3_lag3", "s3_lag6", "s3_lag12", "s3_d1", "s3_d3", "rain_mm", "rain_sum3",
          "rain_sum6", "rain_sum12", "rain_sum24", "outflow", "storage_pct", "month", "hour"]
UP_F = ["up_rain", "up_rain_sum3", "up_rain_sum6", "up_rain_sum12", "up_rain_sum24", "up_dlev1", "up_dlev3", "up_flow", "up_flow_d3"]


def fit_eval(g, h, feats):
    g = g[g.s3.notna() & g[f"y{h}"].notna()]
    tr, va, te = g[g.year <= 2022], g[g.year == 2023], g[g.year >= 2024]
    if len(tr) < 5000 or len(te) < 2000:
        return None
    m = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05, random_state=0)
    m.fit(tr[feats], tr[f"y{h}"] - tr.s3)                           # 지금보다 얼마나 늘고 줄지를 배움
    pred = lambda d: d.s3 + m.predict(d[feats])
    hi = te[f"y{h}"] >= tr[f"y{h}"].quantile(.95)                  # 큰물(상위 5%) 때만 따로 채점
    ae_m, ae_b = (te[f"y{h}"] - pred(te)).abs(), (te[f"y{h}"] - te.s3).abs()
    res = {"n_test": int(len(te)), "mae_base": round(float(ae_b.mean()), 2), "mae_model": round(float(ae_m.mean()), 2),
           "mae_base_high": round(float(ae_b[hi].mean()), 2) if hi.sum() else None,
           "mae_model_high": round(float(ae_m[hi].mean()), 2) if hi.sum() else None, "n_high": int(hi.sum())}
    # 유입이 거의 없는 댐은 기준선 오차가 0에 가까워 비율이 터진다 → 평균 오차 0.5㎥/s 미만은 채점 제외
    res["skill"] = round(1 - res["mae_model"] / res["mae_base"], 3) if res["mae_base"] >= 0.5 else None
    res["skill_high"] = round(1 - res["mae_model_high"] / res["mae_base_high"], 3) if (res["mae_base_high"] or 0) >= 0.5 else None
    return res, m, pred, va, te


forecast, upstream, anomalies, anomaly_example = {}, {}, {}, None
for code, g in pdf.groupby("damcode"):
    forecast[code] = {}
    for h in HORIZONS:
        out = fit_eval(g, h, BASE_F)
        if out is None:
            continue
        res, m, pred, va, te = out
        forecast[code][h] = res
        if h == 6:   # 6시간 예측의 빗나감으로 이상 탐지
            thr = float((va["y6"] - pred(va)).abs().quantile(.995)) if len(va) else None
            if thr:
                te = te.assign(resid=te["y6"] - pred(te))
                flag = te.resid.abs() > thr
                ep = (flag != flag.shift()).cumsum()[flag]
                episodes = te[flag].groupby(ep).agg(start=("ts", "min"), end=("ts", "max"), hours=("ts", "count"),
                                                    worst=("resid", lambda s: float(s.loc[s.abs().idxmax()])))
                anomalies[code] = {"threshold": round(thr, 1), "flag_hours": int(flag.sum()), "episodes": int(len(episodes)),
                                   "test_hours": int(len(te))}
                if code == "1012110" and len(episodes):
                    e = episodes.sort_values("worst", key=abs, ascending=False).iloc[0]
                    seg = te[(te.ts >= e.start - pd.Timedelta(hours=36)) & (te.ts <= e.end + pd.Timedelta(hours=36))]
                    anomaly_example = {"dam": code, "start": str(e.start)[:16], "end": str(e.end)[:16], "worst": round(e.worst, 1),
                                       "ts": [str(t)[5:16] for t in seg.ts + pd.Timedelta(hours=6)],
                                       "actual": [round(float(x), 1) for x in seg.y6], "pred": [round(float(x), 1) for x in pred(seg)],
                                       "flag": [bool(abs(x) > thr) for x in seg.resid]}
    if code in STATION_DAMS:
        upstream[code] = {}
        for h in HORIZONS:
            a = fit_eval(g, h, BASE_F)
            b = fit_eval(g, h, BASE_F + UP_F)
            if a and b:
                upstream[code][h] = {"dam_only": a[0], "with_upstream": b[0]}
toc("forecast")


def med(key, h):
    v = [f[h][key] for f in forecast.values() if h in f and f[h][key] is not None]
    return round(float(np.median(v)), 3) if v else None


result = {
    "dams": DAMS, "quality": quality, "expected_hours": EXPECTED,
    "lag": {"by_dam": lag_by_dam, "events_total": int(len(lags)), "dams_with_lag": len(lag_by_dam),
            "median_of_medians": float(np.median([v["median_h"] for v in lag_by_dam.values()])),
            "spearman_all": {"rho": round(float(rho_all.statistic), 3), "p": round(float(rho_all.pvalue), 4), "n": len(cmp_rows)},
            "spearman_dams": {"rho": round(float(rho_dam.statistic), 3), "p": round(float(rho_dam.pvalue), 4), "n": len(dams_only)} if rho_dam else None,
            "xcorr_agree_within3h": f"{sum(agree)}/{len(agree)}"},
    "events_sample": lags.sort_values("peak_inflow", ascending=False).head(12).to_dict("records"),
    "rep_events": rep_events,
    "trend": {"years": nat.year.tolist(), "max_idx": nat.max_idx.round(3).tolist(), "rain": nat.rain.round(0).tolist(),
              "heavy": nat.heavy.round(2).tolist(), "tests": trend_nat, "per_dam_maxinflow": per_dam_sig, "n_dams": len(long_dams)},
    "forecast": {"by_dam": forecast, "median_skill": {h: med("skill", h) for h in HORIZONS},
                 "median_skill_high": {h: med("skill_high", h) for h in HORIZONS},
                 "dams_beating_base": {h: sum(1 for f in forecast.values() if h in f and f[h]["skill"] and f[h]["skill"] > 0) for h in HORIZONS},
                 "dams_beating_base_high": {h: sum(1 for f in forecast.values() if h in f and f[h]["skill_high"] and f[h]["skill_high"] > 0) for h in HORIZONS},
                 "dams_evaluated": {h: sum(1 for f in forecast.values() if h in f and f[h]["skill"] is not None) for h in HORIZONS}},
    "upstream": upstream, "anomalies": anomalies, "anomaly_example": anomaly_example, "timer_sec": TIMER,
}
os.makedirs(OUT, exist_ok=True)
json.dump(result, open(os.path.join(OUT, "analysis.json"), "w", encoding="utf-8"), ensure_ascii=False, default=str)
print(json.dumps({k: result[k] for k in ["lag", "trend", "timer_sec"]}, ensure_ascii=False, default=str)[:2500])
print(json.dumps({"forecast": {k: result["forecast"][k] for k in ["median_skill", "median_skill_high", "dams_beating_base", "dams_evaluated"]},
                  "upstream": upstream}, ensure_ascii=False, default=str)[:3000])
spark.stop()
