# -*- coding: utf-8 -*-
"""WaterPulse 원본 수집기 (전체 수집용).

공공 API를 불러 받은 값을 그대로 JSON Lines 파일로 저장한다. 값은 고치지 않고,
줄마다 조회 조건(q_damcode·q_stn·q_from·q_to)만 덧붙인다. 정제는 하둡 안에서 Spark가 한다.

범위 (팀 결정 2026-10-10, 허브 S-5·C-0)
- 댐 시간·일 자료: 59곳 × 2006 ~ END_DATE
- 우량(비)·수위(강) 관측소 시간 자료: 댐별 상류 관측소 전체 × 2006 ~ END_DATE
- 기상청 ASOS 시간 자료: 전국 ASOS 지점 × 2006 ~ END_DATE
- 댐코드·수문 제원·관측소 목록·ASOS 지점 목록
- 댐 10분 자료는 받지 않는다(1시간 자료로 충분, 수집 기간이 두 배 이상 늘어남)

하루 호출 한도는 키·기능(상세기능)마다 10,000번이다. 기능별 큐를 최근 연도부터 꺼내고,
키마다 하루 사용량을 세다가 한도(또는 API의 한도 초과 응답)에 닿으면 한국 시간 자정까지 쉰다.
이미 받은 파일은 건너뛰므로 끊겨도 다시 실행하면 이어 받는다.

사용법
  python3 collect_raw.py            # 전체 실행 (끝나면 종료 코드 0)
  python3 collect_raw.py --plan     # 호출하지 않고 작업 수만 계산
  python3 collect_raw.py --smoke    # 기능마다 작업 1개씩만 받아 보는 시험

키: 같은 폴더의 .env 에 DATA_GO_KR_KEY=… (팀원 키는 DATA_GO_KR_KEY_2, DATA_GO_KR_KEY_3 …).
키 값은 로그·파일 어디에도 남기지 않고 k1·k2처럼 번호로만 적는다.
"""
import argparse
import datetime as dt
import json
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("WP_ROOT", HERE)
RAW, STATE, LOGS = (os.path.join(ROOT, d) for d in ("raw", "state", "logs"))
KST = ZoneInfo("Asia/Seoul")

START_YEAR = 2006
END_DATE = dt.date(2026, 10, 9)          # 스냅샷 끝 날짜. 수집이 며칠 걸려도 범위가 바뀌지 않게 고정한다.
DAILY_LIMIT = 10_000
SOFT_LIMIT = 9_950                        # 남은 호출이 적으면 새 작업을 시작하지 않는다(작업 하나가 최대 22번).
KW = "https://apis.data.go.kr/B500001/dam"
ASOS = "https://apis.data.go.kr/1360000/AsosHourlyInfoService/getWthrDataList"
PAGE = {"hourlist": 400, "delist": 400, "hourrflist": 500, "hourwallist": 500, "getWthrDataList": 999}
GAP = {"hourrflist": 0.3, "hourwallist": 0.3}   # 관측소 API는 초당 한도가 빡빡하다(시뮬레이션에서 429·코드 23)
ASOS_ID_RANGE = range(90, 300)

for d in (RAW, STATE, LOGS):
    os.makedirs(d, exist_ok=True)


def load_keys():
    env = {}
    for line in open(os.path.join(ROOT, ".env"), encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    keys = [env["DATA_GO_KR_KEY"]] + [env[k] for k in sorted(env) if k.startswith("DATA_GO_KR_KEY_") and k[15:].isdigit()]
    return [k for k in keys if k]


KEYS = load_keys()
_io = threading.Lock()


def now_kst():
    return dt.datetime.now(KST)


def log(rec, name="calls"):
    rec = {"t": now_kst().strftime("%Y-%m-%dT%H:%M:%S"), **rec}
    with _io:
        with open(os.path.join(LOGS, f"{name}-{now_kst():%Y%m%d}.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def say(msg):
    line = f"[{now_kst():%m-%d %H:%M:%S}] {msg}"
    with _io:
        print(line, flush=True)


# ───────────── 하루 호출 수 (키 × 기능) ─────────────
class Quota:
    """키·기능별 오늘(한국 시간) 호출 수. 파일에 저장해 재시작해도 이어서 센다."""

    def __init__(self):
        self.path = os.path.join(STATE, "quota.json")
        self.lock = threading.Lock()
        try:
            self.s = json.load(open(self.path))
        except Exception:
            self.s = {}
        self._roll()

    def _roll(self):
        today = now_kst().date().isoformat()
        if self.s.get("date") != today:
            self.s = {"date": today, "used": {}, "blocked": {}}

    def _save(self):
        tmp = self.path + ".tmp"
        json.dump(self.s, open(tmp, "w"), ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

    def left(self, k, op):
        with self.lock:
            self._roll()
            if self.s["blocked"].get(f"k{k + 1}|{op}"):
                return 0
            return DAILY_LIMIT - self.s["used"].get(f"k{k + 1}|{op}", 0)

    def add(self, k, op):
        with self.lock:
            self._roll()
            key = f"k{k + 1}|{op}"
            self.s["used"][key] = self.s["used"].get(key, 0) + 1
            self._save()

    def block(self, k, op, why):
        with self.lock:
            self._roll()
            self.s["blocked"][f"k{k + 1}|{op}"] = why
            self._save()

    def snapshot(self):
        with self.lock:
            self._roll()
            return json.loads(json.dumps(self.s))


QUOTA = Quota()


class QuotaExceeded(Exception):
    pass


class Unauthorized(Exception):
    pass


def seconds_to_midnight():
    n = now_kst()
    nxt = (n + dt.timedelta(days=1)).replace(hour=0, minute=2, second=0, microsecond=0)
    return (nxt - n).total_seconds()


# ───────────── 한 번 부르기 ─────────────
def call(k, url, op, params):
    """한 페이지를 부른다. (items, totalCount)를 돌려준다. 빈 본문·네트워크 오류·초당 한도는 쉬었다 다시 부른다."""
    q = dict(params)
    if url.startswith(KW):
        q["_type"] = "json"
    q["serviceKey"] = KEYS[k]
    full = url + "?" + urllib.parse.urlencode(q)
    for attempt in range(1, 8):
        if QUOTA.left(k, op) <= 0:
            raise QuotaExceeded(op)
        t0 = time.time()
        status, body, err = None, "", None
        try:
            with urllib.request.urlopen(urllib.request.Request(full, headers={"User-Agent": "WaterPulse-collector"}), timeout=90) as r:
                status, body = r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read().decode("utf-8", "replace")
        except Exception as e:
            err = type(e).__name__
        QUOTA.add(k, op)
        sec = round(time.time() - t0, 2)
        items, total, problem = parse(body, err)
        log({"k": k + 1, "op": op, "params": params, "status": status, "sec": sec, "attempt": attempt,
             "rows": None if items is None else len(items), "total": total, "problem": problem})
        if items is not None:
            return items, total
        if problem in ("quota_exceeded",):
            QUOTA.block(k, op, problem)
            raise QuotaExceeded(op)
        if problem in ("unauthorized",):
            raise Unauthorized(op)
        busy = status == 429 or problem == "per_second_limit"
        time.sleep(5 * attempt if busy else min(30, 2 ** attempt))
    raise RuntimeError(f"7번 실패: {op} {params}")


def parse(body, err):
    if not body.strip():
        return None, None, err or "empty_body"
    if "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS" in body or "<returnReasonCode>22<" in body:
        return None, None, "quota_exceeded"
    if "LIMITED_NUMBER_OF_SERVICE_REQUESTS_PER_SECOND" in body or "<returnReasonCode>23<" in body:
        return None, None, "per_second_limit"
    if "SERVICE_KEY_IS_NOT_REGISTERED" in body or "SERVICE_ACCESS_DENIED" in body or "SERVICE_KEY_IS_NULL" in body:
        return None, None, "unauthorized"
    try:
        j = json.loads(body)
    except Exception:
        return None, None, "bad_json:" + body[:60]
    if "OpenAPI_ServiceResponse" in j:
        code = str(j["OpenAPI_ServiceResponse"].get("cmmMsgHeader", {}).get("returnReasonCode"))
        return None, None, {"22": "quota_exceeded", "23": "per_second_limit"}.get(code, "unauthorized" if code in ("20", "30", "31", "32") else f"gateway_{code}")
    resp = j.get("response", {})
    head = resp.get("header", {})
    code = str(head.get("resultCode", "00"))
    if code == "03":                      # ASOS: 자료 없음
        return [], 0, None
    if code not in ("00", "0", "0000"):
        if code == "22":
            return None, None, "quota_exceeded"
        return None, None, f"result_{code}:{head.get('resultMsg', '')[:40]}"
    b = resp.get("body", {}) or {}
    it = b.get("items") or {}
    it = it.get("item", []) if isinstance(it, dict) else it
    items = [it] if isinstance(it, dict) else list(it or [])
    return items, int(b.get("totalCount") or 0), None


def fetch_all(k, url, op, params):
    rows, page, total = [], 1, 0
    while True:
        items, total = call(k, url, op, dict(params, pageNo=page, numOfRows=PAGE.get(op, 200)))
        rows += items
        if not items or len(rows) >= total:
            return rows, total, page
        page += 1
        time.sleep(GAP.get(op, 0.05))


# ───────────── 저장 ─────────────
def out_path(dataset, name):
    return os.path.join(RAW, dataset, name + ".jsonl")


def done(dataset, name):
    return os.path.exists(out_path(dataset, name))


def save(dataset, name, rows, tag, meta):
    d = os.path.join(RAW, dataset)
    os.makedirs(d, exist_ok=True)
    tmp = out_path(dataset, name) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps({**tag, **r}, ensure_ascii=False) + "\n")
    os.replace(tmp, out_path(dataset, name))   # 다 쓴 파일만 보이게(Flume이 반쯤 쓴 파일을 집지 않도록)
    log({"dataset": dataset, "name": name, **meta}, "manifest")


# ───────────── 작업 목록 ─────────────
def years():
    return list(range(END_DATE.year, START_YEAR - 1, -1))   # 최근 연도부터


def span(y, fmt):
    a = dt.date(y, 1, 1)
    b = min(dt.date(y, 12, 31), END_DATE)
    return a.strftime(fmt), b.strftime(fmt)


def meta_stage():
    """댐코드·제원·관측소 목록·ASOS 지점 목록. 이미 받았으면 파일에서 읽는다."""
    k = 0
    if not done("meta", "dam_codes"):
        rows, total, _ = fetch_all(k, KW + "/damCode/damCodelist", "damCodelist", {})
        save("meta", "dam_codes", rows, {}, {"rows": len(rows), "total": total})
    if not done("meta", "dam_specs"):
        rows, total, _ = fetch_all(k, KW + "/dataPresent/dataPresentlist", "dataPresentlist", {})
        save("meta", "dam_specs", rows, {}, {"rows": len(rows), "total": total})
    dams = [str(json.loads(l)["damcode"]) for l in open(out_path("meta", "dam_codes"), encoding="utf-8")]
    for kind, path, op in (("rain", "/excllncobsrvt/excll/exclllist", "exclllist"), ("level", "/excllncobsrvt/wal/wallist", "wallist")):
        name = f"stations_{kind}"
        if not done("meta", name):
            allrows = []
            for dam in dams:
                rows, _, _ = fetch_all(k, KW + path, op, {"damcode": dam})
                allrows += [{"q_damcode": dam, **r} for r in rows]
                time.sleep(0.3)
            save("meta", name, allrows, {}, {"rows": len(allrows), "dams": len(dams)})
    if not done("meta", "asos_stations"):
        found = []
        for sid in ASOS_ID_RANGE:            # 지점 번호 목록 API를 신청하지 않았으므로, 번호를 한 시간씩 불러 보고 답이 오는 지점만 남긴다
            for day in ("20250701", "20150701", "20080701"):
                items, total = call(k, ASOS, "getWthrDataList", {"dataType": "JSON", "dataCd": "ASOS", "dateCd": "HR", "startDt": day, "startHh": "00",
                                                                 "endDt": day, "endHh": "00", "stnIds": str(sid), "pageNo": 1, "numOfRows": 1})
                if total:
                    found.append({"stnId": str(sid), "stnNm": items[0].get("stnNm"), "seen": day})
                    break
            time.sleep(0.05)
        save("meta", "asos_stations", found, {}, {"rows": len(found), "probed": f"{ASOS_ID_RANGE.start}-{ASOS_ID_RANGE.stop - 1}"})
    rain = [(json.loads(l)["q_damcode"], str(json.loads(l)["excllncobsrvtcode"]), json.loads(l).get("obsrvtNm", "")) for l in open(out_path("meta", "stations_rain"), encoding="utf-8")]
    level = [(json.loads(l)["q_damcode"], str(json.loads(l)["walobsrvtcode"]), json.loads(l).get("obsrvtNm", "")) for l in open(out_path("meta", "stations_level"), encoding="utf-8")]
    asos = [json.loads(l)["stnId"] for l in open(out_path("meta", "asos_stations"), encoding="utf-8")]
    rain = [r for r in rain if "시험" not in r[2]]            # 시험용 관측소 제외(목록 원본은 meta에 그대로 남아 있음)
    return dams, rain, level, asos


def build_tasks(dams, rain, level, asos):
    """기능별 작업 큐. 같은 기능 안에서는 최근 연도부터."""
    t = {op: [] for op in PAGE}
    for y in years():
        for d in dams:
            t["hourlist"].append(("dam_hourly", f"{d}_{y}", y, {"damcode": d}, {"q_damcode": d}))
            t["delist"].append(("dam_daily", f"{d}_{y}", y, {"damcode": d}, {"q_damcode": d}))
        for d, s, _ in rain:
            t["hourrflist"].append(("rain_hourly", f"{d}_{s}_{y}", y, {"damcode": d, "excll": s}, {"q_damcode": d, "q_stn": s}))
        for d, s, _ in level:
            t["hourwallist"].append(("level_hourly", f"{d}_{s}_{y}", y, {"damcode": d, "wal": s}, {"q_damcode": d, "q_stn": s}))
        for s in asos:
            t["getWthrDataList"].append(("asos_hourly", f"{s}_{y}", y, {"stnIds": s}, {"q_stn": s}))
    return t


def request_for(op, y, base):
    if op in ("hourlist", "delist"):
        a, b = span(y, "%Y-%m-%d")
        return KW + f"/sluicePresentCondition/{op}", dict(base, stdt=a, eddt=b), a, b
    if op in ("hourrflist", "hourwallist"):
        a, b = span(y, "%Y-%m-%d")
        path = "/excllncobsrvt/hourrf/hourrflist" if op == "hourrflist" else "/excllncobsrvt/hourwal/hourwallist"
        # 관측소 API는 하루를 01~24시로 적는다. etime=23이면 마지막 날 24시(= 다음 날 0시) 한 줄이 빠진다(10/10 확인).
        return KW + path, dict(base, sdate=a, stime="00", edate=b, etime="24"), a, b
    a, b = span(y, "%Y%m%d")
    return ASOS, dict(base, dataType="JSON", dataCd="ASOS", dateCd="HR", startDt=a, startHh="00", endDt=b, endHh="23"), a, b


def patch_station_edges():
    """etime=23으로 받은 관측소 파일에 빠진 '마지막 날 24:00' 한 줄을 채운다. 파일당 1번 호출, 한 번 확인한 파일은 기록해 둔다."""
    done_path = os.path.join(STATE, "edge_patched.txt")
    seen = set(open(done_path).read().split()) if os.path.exists(done_path) else set()
    todo = []
    for ds, op, key in (("rain_hourly", "hourrflist", "excll"), ("level_hourly", "hourwallist", "wal")):
        for name in sorted(os.listdir(os.path.join(RAW, ds))) if os.path.isdir(os.path.join(RAW, ds)) else []:
            if not name.endswith(".jsonl") or f"{ds}/{name}" in seen:
                continue
            todo.append((ds, op, key, name))
    if not todo:
        return
    say(f"관측소 파일 마지막 24시 줄 확인: {len(todo)}개")
    n_fixed = 0
    for i, (ds, op, key, name) in enumerate(todo):
        path = os.path.join(RAW, ds, name)
        lines = open(path, encoding="utf-8").read().splitlines()
        dam, stn, y = name[:-6].split("_")
        q_to = min(dt.date(int(y), 12, 31), END_DATE).isoformat()
        want = f"{q_to} 24:00"
        have = {json.loads(l)["obsrdt"] for l in lines[-30:]}
        if want not in have:
            k = i % len(KEYS)
            if QUOTA.left(k, op) < 100:
                continue                       # 오늘 한도가 없으면 다음 실행 때
            url = KW + ("/excllncobsrvt/hourrf/hourrflist" if op == "hourrflist" else "/excllncobsrvt/hourwal/hourwallist")
            try:
                items, _ = call(k, url, op, {"damcode": dam, key: stn, "sdate": q_to, "stime": "24", "edate": q_to, "etime": "24", "pageNo": 1, "numOfRows": 10})
            except Exception as e:
                log({"dataset": ds, "name": name, "error": "edge:" + str(e)[:100]}, "failed")
                continue
            add = [r for r in items if r.get("obsrdt") == want]
            if add and lines:
                tag = {k2: v for k2, v in json.loads(lines[0]).items() if k2.startswith("q_")}
                tag["q_to"] = q_to
                tmp = path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    for l in lines:
                        f.write(l + "\n")
                    for r in add:
                        f.write(json.dumps({**tag, **r}, ensure_ascii=False) + "\n")
                os.replace(tmp, path)
                n_fixed += 1
            log({"dataset": ds, "name": name, "edge_added": len(add)}, "manifest")
            time.sleep(GAP.get(op, 0.1))
        with open(done_path, "a") as f:
            f.write(f"{ds}/{name}\n")
    say(f"24시 줄 채움: {n_fixed}개 파일")


# ───────────── 실행 ─────────────
class Op:
    def __init__(self, op, tasks):
        self.op, self.q = op, queue.Queue()
        self.total = len(tasks)
        self.skipped = 0
        for task in tasks:
            if done(task[0], task[1]):
                self.skipped += 1
            else:
                self.q.put((task, 0))
        self.done = self.rows = self.calls = self.failed = 0
        self.pending = self.q.qsize()
        self.lock = threading.Lock()


def worker(op: Op, k: int, stop: threading.Event):
    while not stop.is_set():
        if QUOTA.left(k, op.op) < DAILY_LIMIT - SOFT_LIMIT + 25:
            say(f"{op.op} k{k + 1}: 오늘 한도 소진 → 자정까지 대기 ({seconds_to_midnight() / 3600:.1f}시간)")
            stop.wait(seconds_to_midnight())
            continue
        try:
            task, tries = op.q.get_nowait()
        except queue.Empty:
            return
        dataset, name, y, base, tag = task
        url, params, a, b = request_for(op.op, y, base)
        try:
            rows, total, pages = fetch_all(k, url, op.op, params)
            ok = len(rows) >= total
            if not ok and tries < 2:
                op.q.put((task, tries + 1))       # 받은 줄 수가 totalCount보다 적으면 한 번 더
                continue
            save(dataset, name, rows, {**tag, "q_from": a, "q_to": b},
                 {"rows": len(rows), "total": total, "pages": pages, "k": k + 1, "complete": ok})
            with op.lock:
                op.done += 1
                op.pending -= 1
                op.rows += len(rows)
                op.calls += pages
        except QuotaExceeded:
            op.q.put((task, tries))                # 다음 날 다시
        except Unauthorized:
            op.q.put((task, tries))
            say(f"{op.op} k{k + 1}: 인증 거부(이 키로 이 API를 활용신청했는지 확인) → 이 키는 이 기능에서 빠짐")
            QUOTA.block(k, op.op, "unauthorized")
            return
        except Exception as e:
            if tries < 3:
                op.q.put((task, tries + 1))
            else:
                with op.lock:
                    op.failed += 1
                    op.pending -= 1
                log({"dataset": dataset, "name": name, "error": str(e)[:200]}, "failed")
            time.sleep(10)


def progress(ops, started):
    snap = QUOTA.snapshot()
    data = {"updated": now_kst().strftime("%Y-%m-%d %H:%M:%S"), "started": started, "end_date": END_DATE.isoformat(),
            "keys": len(KEYS), "quota_today": snap,
            "ops": {o.op: {"tasks": o.total, "already": o.skipped, "done_this_run": o.done, "pending": o.pending,
                           "failed": o.failed, "rows_this_run": o.rows} for o in ops}}
    tmp = os.path.join(STATE, "progress.json.tmp")
    json.dump(data, open(tmp, "w"), ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(STATE, "progress.json"))
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    say(f"키 {len(KEYS)}개 · 범위 {START_YEAR}-01-01 ~ {END_DATE} · 저장 {RAW}")
    dams, rain, level, asos = meta_stage()
    say(f"목록: 댐 {len(dams)} · 비 관측소 {len(rain)} · 강 관측소 {len(level)} · ASOS {len(asos)}")
    tasks = build_tasks(dams, rain, level, asos)
    if not a.plan and not a.smoke:
        patch_station_edges()
    if a.smoke:
        tasks = {op: [t for t in ts if not done(t[0], t[1])][:1] for op, ts in tasks.items()}
    ops = [Op(op, ts) for op, ts in tasks.items()]
    for o in ops:
        say(f"  {o.op}: 작업 {o.total} (이미 받음 {o.skipped}, 남음 {o.pending})")
    if a.plan:
        return 0
    stop = threading.Event()
    started = now_kst().strftime("%Y-%m-%d %H:%M:%S")
    threads = [threading.Thread(target=worker, args=(o, k, stop), daemon=True) for o in ops for k in range(len(KEYS))]
    for th in threads:
        th.start()
    last = 0
    while any(th.is_alive() for th in threads):
        time.sleep(5)
        if time.time() - last > 60:
            p = progress(ops, started)
            last = time.time()
            say(" · ".join(f"{op}: {v['done_this_run'] + v['already']}/{v['tasks']}" for op, v in p["ops"].items()))
    p = progress(ops, started)
    left = sum(o.pending for o in ops)
    say(f"끝: 남은 작업 {left}, 실패 {sum(o.failed for o in ops)}")
    failed = sum(o.failed for o in ops)
    return 0 if left == 0 and failed == 0 else 3


if __name__ == "__main__":
    sys.exit(main())
