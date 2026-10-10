# -*- coding: utf-8 -*-
"""WaterPulse 실데이터 사전 시뮬레이션 — ① 수집기.

공공데이터포털(K-water) API를 불러 받은 그대로 spool/ 폴더에 파일로 떨군다.
실제 과제에서 "Python 수집기"가 하는 일과 같다. 정리·계산은 하지 않는다(그건 Spark 몫).

사용법: python3 collect.py [dam_hourly|dam_daily|stations|meta|all]
- 키는 과제/.env 의 DATA_GO_KR_KEY 를 읽고, 출력·로그 어디에도 남기지 않는다.
- 이미 받은 파일은 건너뛰므로 중간에 끊겨도 다시 실행하면 이어 받는다.
- 호출 기록은 logs/calls.jsonl 에 한 줄씩 남긴다(발표의 "수집 통계" 근거).
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
SPOOL = os.path.join(HERE, "spool")
LOGS = os.path.join(HERE, "logs")
BASE = "https://apis.data.go.kr/B500001/dam"

ENV = {}
for line in open(os.path.join(HERE, "..", "..", ".env"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        ENV[k.strip()] = v.strip()
KEY = ENV["DATA_GO_KR_KEY"]

YEARS_HOURLY = range(2020, 2026)          # 2020~2025 시간 자료 (예측·반응 시간용)
YEARS_DAILY = range(2006, 2026)           # 2006~2025 일 자료 (20년 추세용)
STATION_DAMS = {"1012110": "소양강", "3008110": "대청", "2001110": "안동"}  # 상류 관측소까지 받는 댐
PAGE_DAM, PAGE_STN = 400, 500             # 실측: 댐 시간 ~490줄까지, 관측소는 999줄이 어떤 쪽에선 빈 답 → 500줄
WORKERS = 6                               # 댐 API는 6갈래도 괜찮았음
WORKERS_STN, STN_GAP = 3, 0.3             # 관측소 API는 초당 한도가 빡빡해 3갈래 + 호출 간격(코드 23 실측)

_log_lock = threading.Lock()


def log_call(rec):
    with _log_lock:
        with open(os.path.join(LOGS, "calls.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def call(path, **params):
    """한 번 부르기. 빈 본문·한도 초과·네트워크 오류는 최대 5번까지 쉬었다 다시 부른다."""
    q = dict(params, _type="json", serviceKey=KEY)
    url = BASE + path + "?" + urllib.parse.urlencode(q)
    safe = {k: v for k, v in params.items()}
    for attempt in range(1, 8):
        t0 = time.time()
        status, body, err = None, "", None
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "WaterPulse-sim"}), timeout=90) as r:
                status, body = r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read().decode("utf-8", "replace")
        except Exception as e:  # 네트워크 오류도 기록하고 다시 시도
            err = type(e).__name__
        dt = round(time.time() - t0, 2)
        items, total, problem = None, None, None
        if body:
            try:
                j = json.loads(body)
                b = j["response"]["body"]
                it = b.get("items") or {}
                it = it.get("item", []) if isinstance(it, dict) else it
                items = [it] if isinstance(it, dict) else list(it or [])
                total = int(b.get("totalCount") or 0)
            except Exception:
                problem = "bad_json:" + body[:80].replace(KEY, "***")
        else:
            problem = err or "empty_body"
        log_call({"path": path, "params": safe, "status": status, "sec": dt, "attempt": attempt,
                  "rows": None if items is None else len(items), "total": total, "problem": problem})
        if items is not None:
            return items, total
        busy = status == 429 or (problem or "").find("LIMITED_NUMBER_OF_SERVICE_REQUESTS_PER_SECOND") >= 0
        time.sleep(5 * attempt if busy else min(30, 2 ** attempt))
    raise RuntimeError(f"7번 실패: {path} {safe}")


def fetch_all(path, page_size, **params):
    """페이지를 넘겨 가며 끝까지 받는다."""
    rows, page = [], 1
    while True:
        items, total = call(path, pageNo=page, numOfRows=page_size, **params)
        rows += items
        if not items or len(rows) >= total:
            return rows, total
        page += 1
        if "excllncobsrvt" in path:
            time.sleep(STN_GAP)


def save(dataset, name, rows, meta):
    d = os.path.join(SPOOL, dataset)
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "items": rows}, f, ensure_ascii=False)
    os.replace(tmp, os.path.join(d, name + ".json"))  # 다 쓴 파일만 보이게(Flume이 반쯤 쓴 파일을 집지 않도록)


def done(dataset, name):
    return os.path.exists(os.path.join(SPOOL, dataset, name + ".json")) or \
        os.path.exists(os.path.join(SPOOL, dataset, name + ".json.COMPLETED"))


def task_dam(dataset, op, code, year, page):
    name = f"{code}_{year}"
    if done(dataset, name):
        return name, "skip"
    rows, total = fetch_all(f"/sluicePresentCondition/{op}", page, damcode=code,
                            stdt=f"{year}-01-01", eddt=f"{year}-12-31")
    save(dataset, name, rows, {"damcode": code, "year": year, "op": op, "total": total,
                               "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S")})
    return name, len(rows)


def task_station(kind, dam, stn, year):
    dataset = "rain_hourly" if kind == "rain" else "level_hourly"
    name = f"{dam}_{stn}_{year}"
    if done(dataset, name):
        return name, "skip"
    path = "/excllncobsrvt/hourrf/hourrflist" if kind == "rain" else "/excllncobsrvt/hourwal/hourwallist"
    extra = {"excll": stn} if kind == "rain" else {"wal": stn}
    time.sleep(STN_GAP)
    rows, total = fetch_all(path, PAGE_STN, sdate=f"{year}-01-01", stime="00", edate=f"{year}-12-31",
                            etime="23", damcode=dam, **extra)
    save(dataset, name, rows, {"damcode": dam, "station": stn, "year": year, "kind": kind, "total": total,
                               "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S")})
    return name, len(rows)


def run(tasks, label, workers=WORKERS):
    t0, n, rows, fails = time.time(), 0, 0, []
    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(*t): t for t in tasks}
        for f in as_completed(futs):
            n += 1
            try:
                name, r = f.result()
                rows += r if isinstance(r, int) else 0
            except Exception as e:
                fails.append(str(e)[:120])
            if n % 50 == 0 or n == len(tasks):
                print(f"[{label}] {n}/{len(tasks)} 파일 · {rows:,}줄 · {time.time() - t0:,.0f}초 · 실패 {len(fails)}", flush=True)
    return fails


def meta():
    codes, _ = fetch_all("/damCode/damCodelist", 200)
    specs, _ = fetch_all("/dataPresent/dataPresentlist", 200)
    save("meta", "dam_codes", codes, {"fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S")})
    save("meta", "dam_specs", specs, {"fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S")})
    st = {}
    for dam in STATION_DAMS:
        rf, _ = fetch_all("/excllncobsrvt/excll/exclllist", 200, damcode=dam)
        wl, _ = fetch_all("/excllncobsrvt/wal/wallist", 200, damcode=dam)
        st[dam] = {"rain": rf, "level": wl}
    save("meta", "stations", [st], {"fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S")})
    print(f"[meta] 댐 {len(codes)} · 제원 {len(specs)} · 관측소 목록 {len(st)}댐", flush=True)
    return codes, st


def main(which):
    os.makedirs(LOGS, exist_ok=True)
    codes, st = meta() if which in ("meta", "all") or not os.path.exists(os.path.join(SPOOL, "meta", "dam_codes.json")) \
        else (json.load(open(os.path.join(SPOOL, "meta", "dam_codes.json")))["items"],
              json.load(open(os.path.join(SPOOL, "meta", "stations.json")))["items"][0])
    dams = [str(c["damcode"]) for c in codes]
    fails = []
    if which in ("dam_daily", "all"):
        fails += run([(task_dam, "dam_daily", "delist", d, y, PAGE_DAM) for d in dams for y in YEARS_DAILY], "댐 일자료")
    if which in ("dam_hourly", "all"):
        fails += run([(task_dam, "dam_hourly", "hourlist", d, y, PAGE_DAM) for d in dams for y in YEARS_HOURLY], "댐 시간자료")
    if which in ("stations", "all"):
        tasks = []
        for dam, lists in st.items():
            for r in lists["rain"]:
                if "시험" not in r["obsrvtNm"]:
                    tasks += [(task_station, "rain", dam, str(r["excllncobsrvtcode"]), y) for y in YEARS_HOURLY]
            for w in lists["level"]:
                if "시험" not in w["obsrvtNm"]:
                    tasks += [(task_station, "level", dam, str(w["walobsrvtcode"]), y) for y in YEARS_HOURLY]
        fails += run(tasks, "상류 관측소", WORKERS_STN)
    print("끝. 실패:", len(fails), fails[:5], flush=True)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "all")
