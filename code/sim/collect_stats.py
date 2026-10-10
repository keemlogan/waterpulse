# -*- coding: utf-8 -*-
"""수집 통계: logs/calls.jsonl(호출 한 번 = 한 줄)과 원본 선반 파일에서 호출 수·실패·재시도·줄 수를 센다.
걸린 시간(PHASE_SEC)은 collect.py 실행 화면에 찍힌 값을 옮겨 적었다(2026-10-05 실행)."""
import collections
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "lake", "etl", "waterpulse", "raw")
PHASE_SEC = {"dam_daily": 484, "dam_hourly": 344, "stations": 1466}   # 관측소는 초당 한도로 한 번 멈췄다 다시 받은 마지막 실행 기준
DATASET = {"/sluicePresentCondition/delist": "dam_daily", "/sluicePresentCondition/hourlist": "dam_hourly",
           "/excllncobsrvt/hourrf/hourrflist": "rain_hourly", "/excllncobsrvt/hourwal/hourwallist": "level_hourly"}

calls = [json.loads(l) for l in open(os.path.join(HERE, "logs", "calls.jsonl"), encoding="utf-8")]
by = collections.defaultdict(lambda: {"calls": 0, "ok": 0, "retry": 0, "problems": collections.Counter(), "sec": []})
for c in calls:
    d = by[DATASET.get(c["path"], "meta")]
    d["calls"] += 1
    d["sec"].append(c["sec"])
    if c["rows"] is None:
        key = "초당 한도 초과(429)" if c["status"] == 429 else "빈 답" if c["problem"] == "empty_body" else "네트워크 오류" if c["problem"] == "URLError" else "기타"
        d["problems"][key] += 1
    else:
        d["ok"] += 1
    if c["attempt"] > 1:
        d["retry"] += 1

rows, files = {}, {}
for ds in DATASET.values():
    n, f = 0, 0
    for root, _, fs in os.walk(os.path.join(RAW, ds)):
        for fn in fs:
            if fn.endswith(".jsonl"):
                f += 1
                n += sum(1 for _ in open(os.path.join(root, fn), encoding="utf-8"))
    rows[ds], files[ds] = n, f

out = {
    "by_dataset": {k: {"calls": v["calls"], "ok": v["ok"], "retry": v["retry"], "problems": dict(v["problems"]),
                       "median_sec": sorted(v["sec"])[len(v["sec"]) // 2]} for k, v in by.items()},
    "rows": rows, "files": sum(files.values()), "files_by": files, "rows_total": sum(rows.values()),
    "calls_total": len(calls), "calls_ok": sum(v["ok"] for v in by.values()),
    "failed": 0,   # collect.py가 끝에 찍은 "실패" 수(최종적으로 못 받은 파일) — 세 단계 모두 0
    "phase_sec": PHASE_SEC,
    "minutes": sum(v for v in PHASE_SEC.values() if v) / 60,
}
json.dump(out, open(os.path.join(HERE, "out", "collect_stats.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps(out, ensure_ascii=False, indent=1))
