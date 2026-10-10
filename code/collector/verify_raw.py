# -*- coding: utf-8 -*-
"""받은 원본 검사: 빠진 파일, 줄 수 부족, 파일 안 중복 시각, 관측소 마지막 24시 줄, 자료별 행 수·용량.

사용법: python3 verify_raw.py   (collect_raw.py와 같은 폴더, 결과는 state/verify.json)
"""
import collections
import datetime as dt
import glob
import json
import os

ROOT = os.environ.get("WP_ROOT", os.path.dirname(os.path.abspath(__file__)))
RAW, STATE, LOGS = (os.path.join(ROOT, d) for d in ("raw", "state", "logs"))
START_YEAR, END_DATE = 2006, dt.date(2026, 10, 9)
TS = {"dam_hourly": "obsrdt", "dam_daily": "obsryymtde", "rain_hourly": "obsrdt", "level_hourly": "obsrdt", "asos_hourly": "tm"}


def jl(path):
    return [json.loads(l) for l in open(path, encoding="utf-8")]


def main():
    dams = [str(r["damcode"]) for r in jl(os.path.join(RAW, "meta", "dam_codes.jsonl"))]
    rain = [(r["q_damcode"], str(r["excllncobsrvtcode"])) for r in jl(os.path.join(RAW, "meta", "stations_rain.jsonl")) if "시험" not in r.get("obsrvtNm", "")]
    level = [(r["q_damcode"], str(r["walobsrvtcode"])) for r in jl(os.path.join(RAW, "meta", "stations_level.jsonl"))]
    asos = [r["stnId"] for r in jl(os.path.join(RAW, "meta", "asos_stations.jsonl"))]
    years = range(START_YEAR, END_DATE.year + 1)
    expect = {
        "dam_hourly": [f"{d}_{y}" for d in dams for y in years],
        "dam_daily": [f"{d}_{y}" for d in dams for y in years],
        "rain_hourly": [f"{d}_{s}_{y}" for d, s in rain for y in years],
        "level_hourly": [f"{d}_{s}_{y}" for d, s in level for y in years],
        "asos_hourly": [f"{s}_{y}" for s in asos for y in years],
    }
    incomplete = set()
    for f in glob.glob(os.path.join(LOGS, "manifest-*.jsonl")):
        for r in jl(f):
            if r.get("complete") is False:
                incomplete.add((r["dataset"], r["name"]))
    out = {"checked": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "datasets": {}}
    for ds, names in expect.items():
        missing, dup, no_edge, rows, size, empty = [], [], [], 0, 0, 0
        for n in names:
            p = os.path.join(RAW, ds, n + ".jsonl")
            if not os.path.exists(p):
                missing.append(n)
                continue
            size += os.path.getsize(p)
            recs = jl(p)
            rows += len(recs)
            if not recs:
                empty += 1
                continue
            ts = [r[TS[ds]] for r in recs]
            if len(ts) != len(set(ts)):
                dup.append(n)
            if ds in ("rain_hourly", "level_hourly"):
                q_to = recs[0]["q_to"]
                if f"{q_to} 24:00" not in set(ts[-30:]):
                    no_edge.append(n)
        out["datasets"][ds] = {"expected": len(names), "have": len(names) - len(missing), "missing": len(missing),
                               "empty_files": empty, "rows": rows, "MB": round(size / 1e6, 1),
                               "incomplete": sum(1 for d, n in incomplete if d == ds),
                               "dup_files": len(dup), "no_24h_row": len(no_edge),
                               "examples": {"missing": missing[:5], "dup": dup[:5], "no_24h_row": no_edge[:5]}}
    json.dump(out, open(os.path.join(STATE, "verify.json"), "w"), ensure_ascii=False, indent=1)
    for ds, v in out["datasets"].items():
        print(f"{ds:13s} 파일 {v['have']:5d}/{v['expected']:5d} · 빈 파일 {v['empty_files']:4d} · 행 {v['rows']:>11,} · {v['MB']:8.1f}MB"
              f" · 줄 수 부족 {v['incomplete']} · 중복 시각 {v['dup_files']} · 24시 줄 없음 {v['no_24h_row']}")


if __name__ == "__main__":
    main()
