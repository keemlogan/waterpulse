# -*- coding: utf-8 -*-
"""WaterPulse 되감기(리플레이) 자료 만들기 — 방류 계산기·재난 상황판용.

실시간 자료 대신 "과거 큰비 시점"을 골라, 그 시점에 알 수 있었던 값과 그 뒤 실제로 일어난 일을 함께 담는다.
- 댐별 기준 수위(계획홍수위·홍수기제한수위·상시만수위·댐마루)와 수위↔저수량 곡선(실측에서 만듦)
- 과거 최대 방류량(댐이 실제로 내보낸 적 있는 양 = 계산의 상한)
- 큰비 시점: 기준 수위를 넘거나 유입이 평소 상위 1%를 넘은 댐 수로 골라 72시간 창
- 예측: 그 시점이 들어 있지 않은 해로만 배운 모델이 3·6·9·12시간 뒤 유입량(3시간 평균)을 예측

사용법: .venv/bin/python scenarios.py   → ../web/data/dams_meta.json, scenarios.json, scn_*.json
"""
import json
import os
import re
import time

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

HERE = os.path.dirname(os.path.abspath(__file__))
CLEAN = os.path.join(HERE, "lake", "data", "waterpulse", "clean")
MART = os.path.join(HERE, "lake", "data", "waterpulse", "mart")
WEB = os.path.join(HERE, "..", "web", "data")
HORIZONS = [3, 6, 9, 12]
N_SCN = 6
FEATS = ["s3", "s3_lag1", "s3_lag2", "s3_lag3", "s3_lag6", "s3_lag12", "s3_d1", "s3_d3", "rain_mm", "rain_sum3",
         "rain_sum6", "rain_sum12", "rain_sum24", "outflow", "storage_pct", "month", "hour"]


def num(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def kst(s):
    return s.dt.tz_localize("UTC").dt.tz_convert("Asia/Seoul").dt.tz_localize(None)


t0 = time.time()
codes = json.load(open(os.path.join(HERE, "spool", "meta", "dam_codes.json"), encoding="utf-8"))["items"]
specs = json.load(open(os.path.join(HERE, "spool", "meta", "dam_specs.json"), encoding="utf-8"))["items"]
norm = lambda s: re.sub(r"\(.*?\)|댐|\s", "", str(s))
spec_by = {norm(s["damnm"]): s for s in specs}

h = pd.read_parquet(os.path.join(CLEAN, "dam_hourly"), columns=["damcode", "ts", "rain_mm", "inflow", "outflow", "level_m", "storage", "storage_pct"])
h["ts"] = kst(h["ts"])
h["damcode"] = h["damcode"].astype(str)
d = pd.read_parquet(os.path.join(CLEAN, "dam_daily"), columns=["damcode", "date", "level_m", "storage", "outflow"])
d["damcode"] = d["damcode"].astype(str)


def drop_spikes(df, col):
    """수위·저수량에도 튐 값이 있다(예: 평소 6m 안팎인 승촌보가 한 시간 66.4m). 댐별 0.1~99.9% 범위에서
    폭의 20%+1만큼 넘게 벗어난 값은 빈칸으로 바꾼다. 큰비 때 진짜 최고 수위는 이 여유 안에 들어온다."""
    q = df.groupby("damcode")[col].quantile([0.001, 0.999]).unstack()
    band = q[0.999] - q[0.001]
    lo, hi = df.damcode.map(q[0.001] - 0.2 * band - 1), df.damcode.map(q[0.999] + 0.2 * band + 1)
    bad = (df[col] < lo) | (df[col] > hi)
    df.loc[bad, col] = np.nan
    return int(bad.sum())


SPIKES = {c: drop_spikes(h, c) for c in ["level_m", "storage"]}
print("spikes removed:", SPIKES, flush=True)

# ---------- 댐 기준 정보 ----------
meta = {}
for c in codes:
    code, nm = str(c["damcode"]), c["damnm"]
    sp = spec_by.get(norm(nm))
    g = h[h.damcode == code]
    if sp is None or g.empty:
        continue
    plan = num(sp.get("planFwal"))
    lv95 = g.level_m.quantile(.95)
    if plan is None or lv95 > plan + 0.5:          # 보처럼 기준 체계가 다른 곳은 수위 판단에서 뺀다
        continue
    pairs = pd.concat([g[["storage", "level_m"]], d[d.damcode == code][["storage", "level_m"]]]).dropna()
    pairs = pairs[(pairs.storage > 0) & (pairs.level_m > 0)]
    if len(pairs) < 500:
        continue
    pairs["bin"] = pd.qcut(pairs.storage, 40, duplicates="drop")
    cur = pairs.groupby("bin", observed=True).agg(S=("storage", "median"), L=("level_m", "median")).sort_values("S")
    S, L = cur.S.to_numpy(), np.maximum.accumulate(cur.L.to_numpy())     # 수위는 저수량과 함께 늘어나야 한다
    slope = (L[-1] - L[-4]) / max(S[-1] - S[-4], 1e-6)
    S_ext = S[-1] * 1.35
    curve = [[round(float(s), 3), round(float(l), 3)] for s, l in zip(S, L)] + [[round(S_ext, 3), round(float(L[-1] + slope * (S_ext - S[-1])), 3)]]
    omax = float(max(g.outflow.max(), d[d.damcode == code].outflow.max()))
    low = num(sp.get("lowlevel")) or float(L[0])
    valid = lambda v: v if v is not None and v > low else None   # 제원에 0으로 적힌 기준 수위(예: 충주조정지 홍수기제한수위)는 없는 것으로
    meta[code] = {
        "code": code, "name": nm, "river": sp.get("damdgr"),
        "kind": "보" if nm.endswith("보") else "조정지" if "조정지" in nm else "하굿둑" if "하굿둑" in nm else "댐",
        "plan": plan, "limit": valid(num(sp.get("floodseLmttWal"))), "normal": valid(num(sp.get("ordtmFwal"))), "crest": num(sp.get("nrmltAl")),
        "low": num(sp.get("lowlevel")), "capacity": num(sp.get("totRsvwtcpcty")), "omax": round(omax, 1), "curve": curve,
        "basin_km2": num(sp.get("dgrar")),
    }
print("dams with thresholds:", len(meta), round(time.time() - t0, 1), "s", flush=True)

# ---------- 큰비 시점 고르기: 그 앞 48시간 ~ 뒤 24시간을 담는다 ----------
hh = h[h.damcode.isin(meta)].copy()
p99 = hh[hh.inflow > 0].groupby("damcode").inflow.quantile(.99)
col = lambda k: hh.damcode.map({c: m[k] for c, m in meta.items()}).astype(float)
season = (hh.ts.dt.month * 100 + hh.ts.dt.day).between(621, 920)
hh["thr"] = np.where(season & col("limit").notna(), col("limit"), np.where(col("normal").notna(), col("normal"), col("plan")))
hh["hot"] = ((hh.level_m >= hh.thr) | (hh.inflow >= hh.damcode.map(p99))).astype(int)
# 시점 고르기는 "물이 몰려오는 중"(유입 상위 1%)인 댐 수로: 비가 그친 뒤 수위가 높게 머무는 날이 뽑히지 않게
surge = (hh.inflow >= hh.damcode.map(p99)).astype(int)
idx = surge.groupby(hh.ts).sum().rolling(12, min_periods=1).sum()
picked = []
for ts, v in idx.sort_values(ascending=False).items():
    if all(abs((ts - p).days) >= 10 for p in picked) and ts.year <= 2025:
        picked.append(ts)
    if len(picked) == N_SCN:
        break
picked.sort()
print("scenario peaks:", [str(p) for p in picked], flush=True)

# ---------- 예측 모델: 시나리오가 든 해를 빼고 배운다 ----------
feat = pd.read_parquet(os.path.join(MART, "features_hourly"))
feat["year"] = feat["year"].astype(int)
feat["ts"] = kst(feat["ts"])
feat["damcode"] = feat["damcode"].astype(str)
feat = feat[feat.damcode.isin(meta)]
SETS = {"A": [2020, 2021, 2022], "B": [2023, 2024, 2025]}          # 시나리오 해가 A에 들면 B 모델, B에 들면 A 모델
models = {}
for code, g in feat.groupby("damcode"):
    for key, years in SETS.items():
        tr = g[g.year.isin(years) & g.s3.notna()]
        for hz in HORIZONS:
            if hz == 9:   # 9시간 뒤는 학습표에 없어 여기서 만든다. Spark가 쓴 표는 시간순이 아니라 행이 아닌 시각으로 9시간을 민다
                y = g.set_index("ts").s3.reindex(tr.ts + pd.Timedelta(hours=9)).to_numpy()
            else:
                y = tr[f"y{hz}"].to_numpy()
            ok = ~np.isnan(y)
            if ok.sum() < 3000:
                continue
            m = HistGradientBoostingRegressor(max_iter=200, learning_rate=0.06, random_state=0)
            m.fit(tr[FEATS][ok], y[ok] - tr.s3.to_numpy()[ok])
            models[(code, key, hz)] = m
    print(f"  models {code} {meta[code]['name']} · {len(models)} · {time.time() - t0:,.0f}s", flush=True)

# ---------- 시나리오 파일 ----------
os.makedirs(WEB, exist_ok=True)
scn_list = []
for i, peak in enumerate(picked, 1):
    start, end = peak - pd.Timedelta(hours=48), peak + pd.Timedelta(hours=24)
    key = "B" if peak.year in SETS["A"] else "A"
    win = feat[(feat.ts >= start) & (feat.ts <= end)]
    raw = h[(h.ts >= start) & (h.ts <= end + pd.Timedelta(hours=12))]
    ts_all = pd.date_range(start, end + pd.Timedelta(hours=12), freq="h")
    dams = {}
    for code in meta:
        g = win[win.damcode == code].set_index("ts").reindex(pd.date_range(start, end, freq="h"))
        r = raw[raw.damcode == code].set_index("ts").reindex(ts_all)
        if g.s3.isna().mean() > 0.3 or r.level_m.isna().mean() > 0.3:
            continue
        preds = []
        for hz in HORIZONS:
            m = models.get((code, key, hz))
            X = g[FEATS]
            p = (g.s3 + m.predict(X)).to_numpy() if m is not None else np.full(len(g), np.nan)
            preds.append(np.where(g.s3.isna(), np.nan, np.maximum(p, 0)))
        rnd = lambda a, k=2: [None if v is None or np.isnan(v) else round(float(v), k) for v in np.asarray(a, dtype=float)]
        dams[code] = {"L": rnd(r.level_m), "S": rnd(r.storage, 3),
                      "I": rnd(r.inflow.where(r.inflow > 0).rolling(3, min_periods=1).mean(), 1),   # 3시간 평균(예측 대상과 같은 뜻)
                      "O": rnd(r.outflow.rolling(3, min_periods=1).mean(), 1), "R": rnd(r.rain_mm, 1),
                      "P": [rnd(p, 1) for p in preds]}
    hot = hh[(hh.ts >= peak - pd.Timedelta(hours=12)) & (hh.ts <= peak + pd.Timedelta(hours=12)) & (hh.hot == 1)]
    rivers = hot.damcode.map(lambda c: meta[c]["river"]).value_counts().head(3).index.tolist()
    sid = peak.strftime("%Y%m%d")
    scn_list.append({"id": sid, "peak": str(peak)[:16], "start": str(start)[:16], "hours": int((end - start) / pd.Timedelta(hours=1)) + 1,
                     "title": f"{peak.year}년 {peak.month}월 {peak.day}일 큰비", "rivers": rivers, "dams": len(dams),
                     "model": f"{min(SETS[key])}–{max(SETS[key])}년 자료로만 배운 모델 (이 시점은 못 본 모델)"})
    json.dump({"ts": [str(t)[:16] for t in ts_all], "dams": dams}, open(os.path.join(WEB, f"scn_{sid}.json"), "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    print(f"scenario {sid}: {len(dams)} dams, rivers {rivers}", flush=True)

json.dump(meta, open(os.path.join(WEB, "dams_meta.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
json.dump(scn_list, open(os.path.join(WEB, "scenarios.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
json.dump({"spikes_removed": SPIKES, "dams": len(meta)}, open(os.path.join(HERE, "out", "scenarios_report.json"), "w"), ensure_ascii=False)
print("done", round(time.time() - t0), "s")
