# -*- coding: utf-8 -*-
"""WaterPulse 실데이터 사전 시뮬레이션 — ② 적재 (Flume 흉내).

실제 과제: Flume의 spooldir 소스가 수집 폴더를 지켜보다 새 파일을 HDFS로 보내고, 보낸 파일 이름 끝에 .COMPLETED를 붙인다.
여기서는 HDFS 대신 lake/ 폴더를 쓴다. 파일 한 개 = 이벤트 묶음, 한 줄 = 측정값 한 건(JSON Lines)으로 바꿔 넣고,
파일 이름에 있던 댐·관측소·연도는 폴더 이름(damcode=…/year=…)으로 옮긴다(Flume이 헤더로 HDFS 경로를 정하는 것과 같은 역할).

사용법: python3 flume_sim.py
"""
import json
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SPOOL = os.path.join(HERE, "spool")
RAW = os.path.join(HERE, "lake", "etl", "waterpulse", "raw")   # 수업 폴더 규칙: 작업 중 데이터는 /etl

LAYOUT = {  # 파일 이름 조각 → 폴더 이름
    "dam_hourly": ("damcode", "year"),
    "dam_daily": ("damcode", "year"),
    "rain_hourly": ("damcode", "station", "year"),
    "level_hourly": ("damcode", "station", "year"),
}


def main():
    t0, moved, lines, bytes_in, bytes_out = time.time(), 0, 0, 0, 0
    for dataset, keys in LAYOUT.items():
        src_dir = os.path.join(SPOOL, dataset)
        if not os.path.isdir(src_dir):
            continue
        for fn in sorted(os.listdir(src_dir)):
            if not fn.endswith(".json"):        # .tmp(쓰는 중)와 .COMPLETED(이미 보냄)는 건너뜀
                continue
            src = os.path.join(src_dir, fn)
            parts = fn[:-5].split("_")
            dst_dir = os.path.join(RAW, dataset, *[f"{k}={v}" for k, v in zip(keys, parts)])
            os.makedirs(dst_dir, exist_ok=True)
            doc = json.load(open(src, encoding="utf-8"))
            dst = os.path.join(dst_dir, "events.jsonl")
            with open(dst, "w", encoding="utf-8") as f:
                for item in doc["items"]:
                    f.write(json.dumps(item, ensure_ascii=False) + "\n")
            bytes_in += os.path.getsize(src)
            bytes_out += os.path.getsize(dst)
            lines += len(doc["items"])
            moved += 1
            os.remove(src)
            open(src + ".COMPLETED", "w").close()     # Flume처럼 보낸 표시만 남긴다
    rec = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "files": moved, "lines": lines, "spool_bytes": bytes_in,
           "raw_bytes": bytes_out, "sec": round(time.time() - t0, 1)}
    os.makedirs(os.path.join(HERE, "logs"), exist_ok=True)
    with open(os.path.join(HERE, "logs", "flume.jsonl"), "a", encoding="utf-8") as f:   # 몇 번에 걸쳐 옮겼는지 기록
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(json.dumps(rec, ensure_ascii=False))


if __name__ == "__main__":
    main()
