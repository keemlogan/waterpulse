# -*- coding: utf-8 -*-
"""분석 결과(out/*.json, logs/*)를 웹이 읽는 작은 요약 파일(web/data/summary.json)로 줄인다.
원본 데이터·인증키는 넣지 않는다(공개 저장소에 올라가는 파일)."""
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "..", "web", "data")
A = json.load(open(os.path.join(HERE, "out", "analysis.json"), encoding="utf-8"))
E = json.load(open(os.path.join(HERE, "out", "etl_report.json"), encoding="utf-8"))
C = json.load(open(os.path.join(HERE, "out", "collect_stats.json"), encoding="utf-8"))


def f0(v):
    return f"{v:,.0f}"


dams = []
for code, d in A["dams"].items():
    lag = A["lag"]["by_dam"].get(code)
    ev = A["rep_events"].get(code)
    fc = A["forecast"]["by_dam"].get(code, {})
    if ev:
        peak = max(v for v in ev["inflow"] if v is not None)
        ev = dict(ev, label=f"{ev['ts'][ev['rain_peak_i']][:10]} 큰비 · 최대 {f0(peak)}㎥/s · 이 댐의 보통 반응 시간에 가장 가까운 큰 사건")
    dams.append({
        "code": code, "name": d["name"], "kind": d["kind"], "basin_km2": d["basin_km2"],
        "lag": {k: lag[k] for k in ["median_h", "q1_h", "q3_h", "events", "xcorr_h"] if k in lag} if lag else None,
        "quality": A["quality"].get(code),
        "forecast": {str(h): {"skill": r["skill"], "skill_high": r["skill_high"]} for h, r in fc.items()},
        "event": ev, "anomaly": A["anomalies"].get(code),
    })

fs = A["forecast"]
up = []
for code, hs in A["upstream"].items():
    up.append({"code": code, "name": A["dams"][code]["name"],
               "h": {str(h): {"dam_only": r["dam_only"]["skill"], "with_upstream": r["with_upstream"]["skill"]} for h, r in hs.items()}})
gain6 = [u["h"]["6"]["with_upstream"] - u["h"]["6"]["dam_only"] for u in up if "6" in u["h"]]

rho = A["lag"]["spearman_dams"]
LABEL = {"충주", "소양강", "횡성", "부안"}   # 몰려 있는 댐끼리 이름이 겹치지 않게 넷만
compare = {
    "points": [{"name": d["name"], "kind": d["kind"], "area": d["basin_km2"], "lag": d["lag"]["median_h"], "label": d["name"] in LABEL}
               for d in dams if d["lag"] and d["basin_km2"]],
    "sub": f"점 하나가 댐 하나예요. 가로는 유역 넓이(비가 내려 이 댐으로 흘러드는 땅의 넓이, 눈금 한 칸마다 10배), 세로는 반응 시간이에요. 파란 점이 댐, 회색 점이 보·조정지예요.",
    "note": f"점이 오른쪽 위로 올라가요. 넓은 깔때기일수록 물이 다 모이는 데 오래 걸리듯, 유역이 넓을수록 늦게 몰려와요. 댐 {rho['n']}곳을 넓이 순과 반응 시간 순으로 줄 세우면 순서가 거의 같아요(순위 상관 {rho['rho']:.2f}, 1이면 완전히 같은 순서). 다만 경사나 상류 댐 방류 같은 다른 이유도 섞여 있어서, 원인이라기보다 뚜렷한 관계로 봐 주세요.",
}
tr = A["trend"]
t = tr["tests"]["max_idx"]
top = tr["max_idx"].index(max(tr["max_idx"]))
trend_sig = t["p"] < 0.05
summary = {
    "headline": {
        "median_lag_h": A["lag"]["median_of_medians"], "dams": len(A["dams"]), "years": "2020–2025",
        "hourly_rows": E["dam_hourly"]["rows"], "events": A["lag"]["events_total"],
        "stats": [
            {"value": f"{f0(C['rows_total'] / 10000)}만 줄", "label": f"공공 API {f0(C['calls_ok'])}번 호출로 받은 실제 값"},
            {"value": f"{fs['dams_beating_base']['6']}/{fs['dams_evaluated']['6']}곳", "label": "6시간 뒤 예측이 “그대로 찍기”보다 정확한 댐"},
            {"value": f"{statistics.median(gain6) * 100:+.0f}%p" if gain6 else "–", "label": "상류 관측소를 넣으면 6시간 예측이 좋아지는 폭 (퍼센트포인트)"},
        ],
    },
    "dams": dams,
    "compare": compare,
    "upstream": up,
    "upstream_note": "소양강·대청·안동댐은 상류 비 관측소와 강 수위 관측소 자료까지 받아 비교했어요. 2020–2022년으로 배우고 2024–2025년으로 시험했어요.",
    "trend": {
        "years": tr["years"], "max_idx": tr["max_idx"],
        "sub": f"댐 {tr['n_dams']}곳의 2006–2025년 일 자료로, 막대 하나가 한 해의 홍수 크기예요. 그해 가장 많이 들어온 양을 그 댐의 보통 해 값으로 나눴어요. 1이면 보통 해, 2면 보통의 2배예요.",
        "note": (f"{tr['years'][top]}년이 가장 컸어요. 20년 동안 " +
                 ("뚜렷이 늘어나는 흐름이 보여요" if trend_sig and t["tau"] > 0 else "뚜렷이 줄어드는 흐름이 보여요" if trend_sig else "한쪽으로 늘거나 주는 흐름은 통계적으로 뚜렷하지 않았어요") +
                 f" (아무 흐름이 없어도 이 정도는 우연히 흔히 나와요, p={t['p']:.2f}). 홍수 크기는 해마다 크게 출렁여서, 커졌는지보다 ‘어느 해가 특별했나’가 더 잘 보여요."),
    },
    "steps": [
        {"title": "모으기 · Python 수집기", "body": f"K-water 공공 API를 {f0(C['calls_ok'])}번 불러 {f0(C['rows_total'])}줄을 받았어요. 실패 {C['failed']}번, 재시도로 모두 받았고 {C['minutes']:.0f}분 걸렸어요."},
        {"title": "창고에 넣기 · Flume 역할", "body": f"받은 파일 {f0(C['files'])}개를 <code>/etl/…/raw</code> 원본 선반으로 옮기고, 보낸 파일엔 <code>.COMPLETED</code> 표시를 남겼어요."},
        {"title": "정리하기 · Spark", "body": f"연도 붙이기, 24시를 다음 날 0시로 바꾸기({f0(E['dam_hourly']['h24_fixed'])}건), 쉼표 숫자 고치기를 했어요. 그냥 바꿨다면 유입량 {f0(E['naive_cast_null']['inflowqy'])}개가 빈칸이 될 뻔했어요. 평소의 수만 배로 튄 불가능한 값 {f0(E['dam_hourly']['inflow_bad'])}개도 걸렀어요."},
        {"title": "저장하기 · Parquet + 연·월 칸", "body": f"시간 자료 {E['sizes']['dam_hourly']['raw_bytes'] / 1e6:,.0f}MB가 {E['sizes']['dam_hourly']['parquet_bytes'] / 1e6:,.0f}MB가 됐어요. 한 달치 질문은 칸 나누기로 {E['bench_ms']['month']['parquet_nopart']}ms → {E['bench_ms']['month']['parquet_part']}ms."},
        {"title": "분석하기 · Spark + Python", "body": f"Spark로 빈 시간을 채우고 시간을 밀어 학습표를 만든 뒤, 큰비 {f0(A['lag']['events_total'])}번의 반응 시간과 3·6·12시간 뒤 예측을 계산했어요."},
    ],
    "how_note": "이 시뮬레이션은 노트북에서 돌렸어요. 실제 과제에서는 같은 순서를 수업 실습 VM의 HDFS·Hive·Impala 위에서 그대로 하면 돼요.",
    "footer": [
        "자료: 공공데이터포털 한국수자원공사 수문 운영 정보·우량수위 관측소 운영 정보·수문 제원 현황 (2026년 10월 5일 호출).",
        "유입량은 저수량 변화로 계산한 값이라 0 이하 값이 섞여 있어요. 반응 시간과 예측은 0 이하와 불가능한 값(평소 최대의 10배를 넘어 한 시간만 튄 값)을 빼고 계산했어요.",
        "ITM 527 빅데이터실무 팀 프로젝트 WaterPulse 사전 시뮬레이션 결과물이에요.",
    ],
}
os.makedirs(WEB, exist_ok=True)
json.dump(summary, open(os.path.join(WEB, "summary.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print("summary.json", os.path.getsize(os.path.join(WEB, "summary.json")) // 1024, "KB")
