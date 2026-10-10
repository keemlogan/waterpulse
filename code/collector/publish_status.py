# -*- coding: utf-8 -*-
"""수집 현황을 허브(hub/status.json)에 올린다. 맥미니에서 1시간마다 돈다(status_loop.sh).

파일을 다시 읽지 않고 완료 목록(logs/manifest-*.jsonl)과 파일 크기로 센다(15GB를 매시간 읽지 않게).
중복·줄 수 부족은 마지막 전체 검사(state/verify.json) 값을 쓴다. 숫자가 바뀌었을 때만 커밋한다.

사용법: python3 publish_status.py   (WP_ROOT/site 에 저장소가 받아져 있어야 한다)
"""
import datetime as dt
import glob
import json
import math
import os
import subprocess
from zoneinfo import ZoneInfo

ROOT = os.environ.get("WP_ROOT", os.path.dirname(os.path.abspath(__file__)))
RAW, STATE, LOGS, SITE = (os.path.join(ROOT, d) for d in ("raw", "state", "logs", "site"))
KST = ZoneInfo("Asia/Seoul")
NAMES = {"dam_hourly": "댐 시간 자료", "dam_daily": "댐 일 자료", "rain_hourly": "비 관측소", "level_hourly": "강 관측소", "asos_hourly": "기상청 ASOS"}
OPS = {"dam_hourly": "hourlist", "dam_daily": "delist", "rain_hourly": "hourrflist", "level_hourly": "hourwallist", "asos_hourly": "getWthrDataList"}
LIMIT = 10_000


def jl(path):
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]


def build():
    prog = json.load(open(os.path.join(STATE, "progress.json")))
    keys = prog["keys"]
    rows, pages, incomplete = {}, {}, {}
    for f in sorted(glob.glob(os.path.join(LOGS, "manifest-*.jsonl"))):
        for r in jl(f):
            ds = r.get("dataset")
            if ds not in NAMES:
                continue
            if "rows" in r:
                rows[(ds, r["name"])] = r["rows"]
                pages[(ds, r["name"])] = r.get("pages", 1)
                incomplete[(ds, r["name"])] = r.get("complete") is False
            elif r.get("edge_added"):
                rows[(ds, r["name"])] = rows.get((ds, r["name"]), 0) + r["edge_added"]
    try:
        ver = json.load(open(os.path.join(STATE, "verify.json")))["datasets"]
    except Exception:
        ver = {}
    quota = prog.get("quota_today", {}).get("used", {})
    today = dt.datetime.now(KST).date()
    out_ds, eta = [], today
    for ds, name in NAMES.items():
        folder = os.path.join(RAW, ds)
        files = [f for f in os.listdir(folder) if f.endswith(".jsonl")] if os.path.isdir(folder) else []
        have = len(files)
        op = prog["ops"].get(OPS[ds], {})
        expected = op.get("tasks", have)
        size = sum(os.path.getsize(os.path.join(folder, f)) for f in files)
        got = [k for k in rows if k[0] == ds and k[1] + ".jsonl" in files]
        avg_pages = (sum(pages[k] for k in got) / len(got)) if got else 1
        left_calls = max(0, expected - have) * avg_pages
        left_today = sum(max(0, LIMIT - quota.get(f"k{k}|{OPS[ds]}", 0)) for k in range(1, keys + 1))
        extra = math.ceil(max(0, left_calls - left_today) / (LIMIT * keys)) if left_calls else 0
        eta = max(eta, today + dt.timedelta(days=extra))
        out_ds.append({"id": ds, "name": name, "have": have, "expected": expected, "rows": sum(rows[k] for k in got),
                       "MB": round(size / 1e6, 1), "dup": ver.get(ds, {}).get("dup_files", 0),
                       "incomplete": sum(1 for k in got if incomplete.get(k))})
    done = all(d["have"] >= d["expected"] for d in out_ds)
    return {"updated": dt.datetime.now(KST).strftime("%Y-%m-%d %H:%M"), "where": "맥미니 ~/WaterPulse", "keys": keys,
            "eta": eta.isoformat(), "state": "done" if done else "running", "auto": True,
            "files_have": sum(d["have"] for d in out_ds), "files_expected": sum(d["expected"] for d in out_ds),
            "rows": sum(d["rows"] for d in out_ds), "MB": round(sum(d["MB"] for d in out_ds), 1),
            "dup_files": sum(d["dup"] for d in out_ds), "incomplete": sum(d["incomplete"] for d in out_ds), "datasets": out_ds}


def git(*a):
    return subprocess.run(["git", "-C", SITE, *a], capture_output=True, text=True, timeout=120)


def main():
    git("pull", "--rebase", "--quiet")
    path = os.path.join(SITE, "hub", "status.json")
    new = build()
    try:
        old = json.load(open(path))
    except Exception:
        old = {}
    strip = lambda d: {k: v for k, v in d.items() if k != "updated"}
    if strip(old) == strip(new):
        print("변화 없음")
        return new["state"]
    json.dump(new, open(path, "w"), ensure_ascii=False, indent=1)
    msg = (f"수집 현황 갱신 {new['updated'][5:]} · 파일 {new['files_have']:,}/{new['files_expected']:,}"
           "\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>")
    git("add", "hub/status.json")
    c = git("commit", "-q", "-m", msg)
    p = git("push", "-q", "origin", "HEAD:main")
    if p.returncode != 0:                      # 다른 커밋과 겹치면 한 번 다시
        git("pull", "--rebase", "--quiet")
        p = git("push", "-q", "origin", "HEAD:main")
    print("올림" if p.returncode == 0 else f"푸시 실패: {p.stderr.strip()[:200]}", c.returncode)
    return new["state"]


if __name__ == "__main__":
    print(main())
