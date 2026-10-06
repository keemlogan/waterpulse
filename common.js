"use strict";
/* 방류 계산기·재난 상황판이 함께 쓰는 계산과 부품. 두 화면의 숫자가 어긋나지 않도록 계산은 여기에만 둔다. */

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n = (v, d = 0) => (v != null && Number.isFinite(Number(v)) ? Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: d }) : "–");
const HORIZON = 12;                 // 앞으로 몇 시간을 보고 판단하나
const PRED_H = [3, 6, 9, 12];       // 모델이 맞히는 시간
const M3_PER_HOUR = 3600 / 1e6;     // ㎥/s × 1시간 = 백만㎥ 단위 저수량 변화
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;

/* 같은 파일은 한 번만 받는다(시나리오 파일은 하나에 240KB쯤) */
const fetched = {};
function getJSON(path) {
  return (fetched[path] ||= fetch(path).then((r) => {
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  }).catch((e) => {
    delete fetched[path];
    throw e;
  }));
}

function setUrl(q) {
  const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== ""));
  if (theme) s.set("theme", theme);
  history.replaceState(null, "", `?${s}`);
}

/* 댐 번호 첫 자리 = 5대 강(K-water 코드 체계). 제원의 강 이름은 지류까지 적혀 있고 빈 곳도 있다 */
const BASIN = { 1: "한강", 2: "낙동강", 3: "금강", 4: "섬진강", 5: "영산강" };
const basinOf = (dam) => BASIN[String(dam.code)[0]] || "기타";
/* 수위 판정·방류 계산 대상: 물을 담아 두는 댐과 조정지. 보·하굿둑은 흘려보내는 시설이라 제원의 계획홍수위가
   평소 수위와 맞지 않는다(큰비 때 몇 m씩 넘음) → 판정에서 뺀다 */
const judgeable = (dam) => Boolean(dam) && (dam.kind === "댐" || dam.kind === "조정지");
const damName = (dam) => (dam.kind === "댐" && !dam.name.endsWith("댐") ? `${dam.name}댐` : dam.name);
const lowOf = (dam) => dam.low ?? dam.curve[0][1];

/* 곡선 [[저수량, 수위], …]은 둘 다 오름차순. 선형 보간, 끝은 마지막 기울기로 연장 */
function interp(x, xs, ys) {
  let i = 1;
  while (i < xs.length - 1 && x > xs[i]) i++;
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
  return ys[i - 1] + t * (ys[i] - ys[i - 1]);
}
const curveOf = (dam) => (dam._c ||= { S: dam.curve.map((p) => p[0]), L: dam.curve.map((p) => p[1]) });   // 한 번만 펼쳐 둔다
const levelOf = (dam, S) => interp(S, curveOf(dam).S, curveOf(dam).L);
const storageOf = (dam, L) => interp(L, curveOf(dam).L, curveOf(dam).S);

/* 기준 수위: 홍수기(6/21~9/20)엔 홍수기제한수위, 그 밖엔 상시만수위. 저수위 이하·계획홍수위 초과처럼
   말이 안 되는 값(제원에 0으로 적힌 칸 등)은 없는 것으로 보고, 둘 다 없으면 계획홍수위를 쓴다 */
function guideLevel(dam, ts) {
  const usable = (v) => v != null && v > lowOf(dam) && v <= dam.plan;
  const md = Number(ts.slice(5, 7)) * 100 + Number(ts.slice(8, 10));
  if (md >= 621 && md <= 920 && usable(dam.limit)) return { level: dam.limit, name: "홍수기제한수위" };
  if (usable(dam.normal)) return { level: dam.normal, name: "상시만수위" };
  return { level: dam.plan, name: "계획홍수위" };
}

/* i 시점에 예측한 앞으로 1~12시간 유입량(3시간 평균, ㎥/s). 0·3·6·9·12시간 점을 잇는다 */
function inflowPath(series, i) {
  const pts = [[0, series.I[i]], ...PRED_H.map((h, k) => [h, series.P[k][i]])];
  if (pts.some((p) => p[1] == null)) return null;
  return Array.from({ length: HORIZON }, (_, k) => interp(k + 1, pts.map((p) => p[0]), pts.map((p) => p[1])));
}

/* 방류량 q(㎥/s)를 12시간 동안 똑같이 유지할 때의 수위 경로.
   곡선은 실측의 가운데 값이라 지금 수위와 조금 어긋난다 → off(지금 수위 − 곡선 수위)만큼 맞춰 이어 붙인다 */
function levelPath(dam, S0, inflow, q, off) {
  let S = S0;
  return inflow.map((I) => {
    S += (I - q) * M3_PER_HOUR;
    return levelOf(dam, S) + off;
  });
}

/* 한 댐, 한 시점의 판단: 지금처럼 두면 어떻게 되나, 얼마나 내보내야 하나 */
function assess(dam, series, i, ts) {
  const L0 = series.L[i], S0 = series.S[i], O0 = series.O[i];
  const inflow = inflowPath(series, i);
  if (L0 == null || S0 == null || O0 == null || !inflow) return null;
  const guide = guideLevel(dam, ts);
  const off = L0 - levelOf(dam, S0);
  const keep = levelPath(dam, S0, inflow, O0, off);                    // 지금 방류량 그대로
  const firstOver = (lvl, over) => {                    // over: 기준 수위는 "넘을 때", 계획홍수위는 "닿을 때"
    const hit = (L) => (over ? L > lvl : L >= lvl);
    if (hit(L0)) return 0;
    const k = keep.findIndex(hit);
    return k < 0 ? null : k + 1;
  };
  const toPlan = firstOver(dam.plan, false), toGuide = firstOver(guide.level, true);
  const status = toPlan != null ? "danger" : toGuide != null ? "warn" : "ok";

  // 답은 두 숫자로 나눈다.
  // ① 안전선(큰 답): 12시간 동안 똑같이 내보낼 때 계획홍수위를 한 번도 넘지 않는 가장 작은 양.
  //    이미 계획홍수위 위라면 "넘지 않기"는 지킬 수 없으니, 지금 높이보다 더 오르지 않는 것으로 바꾼다.
  // ② 비우기(보조): 다음 비를 받을 자리를 위해 24시간에 걸쳐 기준 수위까지 낮추는 양. 13~24시간 유입은
  //    12시간 뒤 예측값이 그대로 간다고 본다. 처음엔 이걸 "12시간 안에"로 큰 답에 섞어서, 실제 운영보다
  //    가운데 값 1.8배를 내보내라고 했다(2026-10-06 수정).
  let cum = 0, qPeak = 0;
  const Vcap = Math.max(storageOf(dam, dam.plan - off), S0);
  inflow.forEach((I, k) => {
    cum += I * M3_PER_HOUR;
    qPeak = Math.max(qPeak, (S0 + cum - Vcap) / ((k + 1) * M3_PER_HOUR));
  });
  // 위험이 아니면 지금 양으로 계획홍수위 아래 → 안전선은 지금 양
  const q = status === "danger" ? qPeak : Math.min(qPeak, O0);
  const out = Math.max(q, O0);
  const DRAIN_H = 24;
  const cum24 = cum + inflow[HORIZON - 1] * (DRAIN_H - HORIZON) * M3_PER_HOUR;
  const qDrain = Math.max(0, (S0 + cum24 - storageOf(dam, guide.level - off)) / (DRAIN_H * M3_PER_HOUR));
  const drain = qDrain > out ? { q: qDrain, hours: DRAIN_H, overCapacity: qDrain > dam.omax } : null;   // 안전선보다 더 내보내야 비울 수 있을 때만
  // 되감기라서 알 수 있는 "그 뒤 12시간에 실제로 일어난 일"
  const actualL = series.L.slice(i + 1, i + 1 + HORIZON);
  const actualO = series.O.slice(i + 1, i + 1 + HORIZON).filter((v) => v != null);
  const seen = actualL.filter((v) => v != null);
  return {
    L0, O0, guide, inflow, keep, keepMax: Math.max(...keep), plan: levelPath(dam, S0, inflow, out, off), status, toPlan, toGuide,
    q, enough: q <= O0, overCapacity: q > dam.omax, totalTon: out * HORIZON * 3600, drain,
    actualL, actualOavg: actualO.length ? actualO.reduce((a, b) => a + b, 0) / actualO.length : null,
    actualMax: seen.length ? Math.max(...seen) : null, complete: seen.length === HORIZON,
  };
}

const STATUS = { danger: { label: "위험" }, warn: { label: "경계" }, ok: { label: "정상" } };
const SEVERITY = { danger: 0, warn: 1, ok: 2 };

/* 판정 대상 댐을 모두 판정해 급한 순서로. 그 시각 자료가 빈 댐은 a = null로 맨 뒤 */
function assessScenario(meta, data, i) {
  return Object.keys(data.dams)
    .filter((code) => judgeable(meta[code]))
    .map((code) => ({ code, dam: meta[code], a: assess(meta[code], data.dams[code], i, data.ts[i]) }))
    .sort((x, y) => (x.a ? SEVERITY[x.a.status] : 9) - (y.a ? SEVERITY[y.a.status] : 9)
      || (x.a?.toPlan ?? 99) - (y.a?.toPlan ?? 99) || (x.a?.toGuide ?? 99) - (y.a?.toGuide ?? 99));
}

/* 큰비 하나 채점. "위험"은 "방류를 그대로 두면"이라는 가정이라, 운영자가 방류를 늘려 막으면 맞는 경고도
   "안 넘침"이 된다. 그래서 운영자 개입에 흔들리지 않는 값을 함께 잰다.
   - eng: 실제 유입·실제 방류를 넣은 12시간 최고 수위 오차(m) → 계산(물 수지·곡선)만 시험
   - fc : 예측 유입 + 실제 방류 → 개입은 지우고 예측까지 시험 (fcBig: 그 사이 유입이 2배+50㎥/s 넘게 불어난 때)
   - 선행 시간: 운영자가 처음 방류를 크게 늘린 시각(창 시작 방류의 1.2배+10㎥/s 이상) 전에
     경계·위험이 새로 켜졌나(창 시작부터 켜져 있던 댐은 "새로"가 아니라 뺀다)
   - tp·fp·fn: 실제로 계획홍수위에 닿았나(참고). 이미 넘어 있던 시간·자료가 빈 시간은 뺀다 */
function scoreScenario(meta, data) {
  const c = { tp: 0, fp: 0, fn: 0, tn: 0, already: 0, gap: 0, danger: 0, dangerActed: 0, ok: 0, okActed: 0,
    fpAdj: 0, fpDam: 0, fpDamActed: 0, eng: [0, 0], fc: [0, 0], fcBig: [0, 0],
    ops: 0, opsWarned: 0, opsDanger: 0, opsSilent: 0, leads: [], leadsDanger: [] };
  const err = (acc, v) => { acc[0] += Math.abs(v); acc[1]++; };
  const n0 = data.ts.length - HORIZON;
  for (const code of Object.keys(data.dams)) {
    const dam = meta[code], ser = data.dams[code];
    if (!judgeable(dam)) continue;
    const st0 = [];                                     // 시각마다 판정(선행 시간용)
    for (let i = 0; i < n0; i++) {
      const a = assess(dam, ser, i, data.ts[i]);
      st0.push(a && a.L0 < dam.plan ? a.status : null);
      if (!a || !a.complete) { c.gap++; continue; }
      if (a.L0 >= dam.plan) { c.already++; continue; }
      const real = a.actualMax >= dam.plan, acted = real || (a.actualOavg != null && a.actualOavg >= a.O0 * 1.2 + 10);
      c[a.status === "danger" ? (real ? "tp" : "fp") : real ? "fn" : "tn"]++;
      if (a.status === "danger" && !real) {
        if (dam.kind === "조정지") c.fpAdj++;
        else { c.fpDam++; if (acted) c.fpDamActed++; }
      }
      if (a.status !== "warn") { c[a.status]++; if (acted) c[`${a.status}Acted`]++; }
      const fut = (arr) => arr.slice(i + 1, i + 1 + HORIZON);
      const O = fut(ser.O), I = fut(ser.I);
      if (O.length < HORIZON || O.some((v) => v == null) || I.some((v) => v == null)) continue;
      const off = a.L0 - levelOf(dam, ser.S[i]);
      const peak = (inflow) => { let S = ser.S[i], m = -Infinity; inflow.forEach((v, k) => { S += (v - O[k]) * M3_PER_HOUR; m = Math.max(m, levelOf(dam, S) + off); }); return m; };
      err(c.eng, a.actualMax - peak(I));
      const e = a.actualMax - peak(a.inflow);
      err(c.fc, e);
      if (Math.max(...I) >= 2 * Math.max(ser.I[i] ?? 0, 1) && Math.max(...I) >= (ser.I[i] ?? 0) + 50) err(c.fcBig, e);
    }
    const O0 = ser.O[0];
    if (O0 == null) continue;
    const tOp = ser.O.findIndex((v, t) => t > 0 && t < n0 && v != null && v >= O0 * 1.2 + 10);
    if (tOp < 0) continue;
    c.ops++;
    if (st0[0] != null && st0[0] !== "ok") continue;     // 처음부터 경계·위험이던 댐은 "먼저 알렸나"를 셀 수 없다
    const first = (ok) => { for (let i = 1; i <= tOp && i < st0.length; i++) if (ok(st0[i])) return i; return null; };
    const w = first((s) => s === "warn" || s === "danger"), d = first((s) => s === "danger");
    if (w != null) { c.opsWarned++; c.leads.push(tOp - w); } else c.opsSilent++;
    if (d != null) { c.opsDanger++; c.leadsDanger.push(tOp - d); }
  }
  return c;
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

/* "2시간 뒤 계획홍수위" 같은 한 줄 */
function whenText(a) {
  if (a.toPlan != null) return a.toPlan === 0 ? "이미 계획홍수위 위" : `${a.toPlan}시간 뒤 계획홍수위`;
  if (a.toGuide != null) return a.toGuide === 0 ? `이미 ${a.guide.name} 위` : `${a.toGuide}시간 뒤 ${a.guide.name}`;
  return "12시간 동안 기준 아래";
}

const tons = (m3) => (m3 >= 1e8 ? `${n(m3 / 1e8, 2)}억 톤` : m3 >= 1e4 ? `${n(m3 / 1e4)}만 톤` : `${n(m3)}톤`);
const perSec = (q) => (q > 0 && q < 1 ? "1톤 미만" : `${n(q)}톤`);
const fmtTs = (ts) => `${Number(ts.slice(5, 7))}월 ${Number(ts.slice(8, 10))}일 ${ts.slice(11, 16)}`;

/* 시점 고르기: 시나리오 칩 + 시간 막대 + 재생. onChange(scn, data, i, playing)
   stopPlayback(): 시트를 열거나 미리 보기를 시작할 때 재생을 멈춘다(재생 중엔 화면 뒤가 바뀌므로) */
let stopPlayback = () => {};
function timeline(root, scenarios, initial, onChange) {
  root.innerHTML = `
    <div class="chips scn" role="group" aria-label="큰비 시나리오">${scenarios
      .map((s) => `<button class="chip" data-scn="${esc(s.id)}" aria-pressed="false">${esc(s.title.replace(" 큰비", ""))}</button>`)
      .join("")}</div>
    <div class="scrub">
      <button class="play" aria-label="재생" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path class="i-play" d="M8 5v14l11-7z"/><path class="i-pause" d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg></button>
      <div class="scrub-body"><div class="scrub-ts" aria-live="polite"></div><input type="range" min="0" value="0" aria-label="되감을 시각" disabled></div>
    </div>
    <p class="scrub-note"></p>`;
  const range = $("input", root), tsEl = $(".scrub-ts", root), play = $(".play", root), note = $(".scrub-note", root);
  let cur = null, data = null, timer = 0, seq = 0;

  async function pick(id, i) {
    const want = scenarios.find((s) => s.id === id) || scenarios[0];
    const my = ++seq;                                      // 늦게 도착한 앞 요청이 뒤 선택을 덮지 않게
    const got = await getJSON(`data/scn_${want.id}.json`);
    if (my !== seq) return;
    cur = want;
    data = got;
    root.querySelectorAll("[data-scn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scn === cur.id)));
    range.max = String(cur.hours - 1);
    range.value = String(Number.isInteger(i) && i >= 0 ? Math.min(i, cur.hours - 1) : Math.max(0, cur.hours - 1 - 36));   // 기본: 큰비 12시간 전
    note.textContent = `큰비 ${fmtTs(cur.peak)} 무렵 · ${cur.rivers.join("·")} 쪽 · 예측은 ${cur.model}`;
    play.disabled = false;
    range.disabled = false;
    emit();
  }
  function emit() {
    if (!data) return;
    const i = Number(range.value);
    tsEl.textContent = fmtTs(data.ts[i]);
    range.setAttribute("aria-valuetext", fmtTs(data.ts[i]));
    range.style.setProperty("--p", `${(i / Number(range.max)) * 100}%`);
    onChange(cur, data, i, Boolean(timer));
  }
  function stop(quiet) {
    if (!timer) return;
    clearInterval(timer);
    timer = 0;
    play.classList.remove("on");
    play.setAttribute("aria-label", "재생");
    tsEl.setAttribute("aria-live", "polite");              // 재생 중엔 매시간 읽지 않고, 멈추면 그 시각을 알린다
    if (!quiet) emit();
  }
  stopPlayback = () => stop();
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-scn]");
    if (!b) return;
    stop();
    pick(b.dataset.scn).catch((err) => console.error(err));
  });
  range.addEventListener("input", () => {
    stop(true);
    emit();
  });
  play.addEventListener("click", () => {
    if (timer) return stop();
    if (Number(range.value) >= Number(range.max)) range.value = "0";
    play.classList.add("on");
    play.setAttribute("aria-label", "멈춤");
    tsEl.setAttribute("aria-live", "off");
    timer = setInterval(() => {
      if (Number(range.value) >= Number(range.max)) return stop();
      range.value = String(Number(range.value) + 1);
      emit();
    }, 700);
  });
  return pick(initial.scn, initial.t);
}

/* 바텀시트: 한 번에 하나만 열린다. Esc·배경 누르기·닫기 버튼으로 닫는다 */
const sheets = { open: null };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sheets.open) sheets.open.close();
});
function sheet(id) {
  const el = $(id), scrim = $("#scrim");
  let last = null, lastSel = null, timer = 0;
  const api = {
    body: $(".sheet-body", el),
    open(from) {
      stopPlayback();
      if (sheets.open && sheets.open !== api) sheets.open.close(true);
      clearTimeout(timer);
      if (from) {
        last = from;                                         // 목록이 다시 그려져 버튼이 바뀌어도 같은 댐 버튼으로 돌아간다
        lastSel = from.dataset && from.dataset.code ? `[data-code="${CSS.escape(from.dataset.code)}"]` : null;
      }
      el.hidden = false;
      scrim.hidden = false;
      requestAnimationFrame(() => {
        el.classList.add("on");
        scrim.classList.add("on");
      });
      el.scrollTop = 0;
      $("#app").inert = true;
      document.body.style.overflow = "hidden";
      el.focus({ preventScroll: true });
      sheets.open = api;
    },
    close(swap) {
      if (!el.classList.contains("on")) return;
      el.classList.remove("on");
      sheets.open = null;
      clearTimeout(timer);
      if (swap === true) {                                   // 다른 시트로 바로 바꿀 땐 배경을 그대로 둔다
        el.hidden = true;
        return;
      }
      scrim.classList.remove("on");
      $("#app").inert = false;
      document.body.style.overflow = "";
      timer = setTimeout(() => {
        el.hidden = true;
        if (!sheets.open) scrim.hidden = true;
      }, REDUCED ? 0 : 320);
      const back = last && document.contains(last) ? last : lastSel && $(`#app ${lastSel}`);
      if (back) back.focus({ preventScroll: true });
    },
  };
  $(".close", el).addEventListener("click", () => api.close());
  scrim.addEventListener("click", () => {
    if (sheets.open === api) api.close();
  });
  return api;
}

/* 두 화면 시작: 기준 정보와 시나리오 목록을 받고, URL의 시점으로 연다. onTime(meta, scn, data, i, playing) */
function boot(onTime, onFail) {
  const q = new URLSearchParams(location.search);
  return Promise.all([getJSON("data/dams_meta.json"), getJSON("data/scenarios.json")])
    .then(([meta, scenarios]) => {
      const t = q.get("t");
      const scn = q.get("scn") || (scenarios.find((s) => s.id === "20200808") || scenarios[0]).id;
      return timeline($("#timeline"), scenarios, { scn, t: t == null ? null : parseInt(t, 10) }, (s, d, i, playing) => onTime(meta, s, d, i, playing));
    })
    .catch((e) => {
      onFail();
      console.error(e);
    })
    .finally(() => $("#app").setAttribute("aria-busy", "false"));
}

/* 수위 그림: 지난 24시간 실제 + 앞으로 12시간(여러 경로) + 기준선.
   paths = {guide, list:[{values,color,dash,width}], range?:[lo,hi]} — range를 주면 세로 눈금이 고정돼 시간을 옮겨도 흔들리지 않는다 */
function levelChart(fig, dam, series, i, paths) {
  const W = 340, H = 200, L = 40, R = 66, T = 12, B = 22;
  const past = Math.min(24, i);
  const xs = past + HORIZON;
  const x = (k) => L + ((W - L - R) * k) / xs;               // k = 0(24시간 전) ~ xs(12시간 뒤)
  const all = [...series.L.slice(i - past, i + 1), ...paths.list.flatMap((p) => p.values), dam.plan, paths.guide.level].filter((v) => v != null);
  const [lo, hi] = paths.range || [Math.min(...all) - 0.5, Math.max(...all) + 0.5];
  const y = (v) => T + (H - T - B) * (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo));
  const line = (vals, k0) => vals.map((v, k) => (v == null ? null : `${x(k0 + k).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(" L");
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(dam.name)} 수위: 지난 ${past}시간과 앞으로 ${HORIZON}시간">`;
  const lines = [[dam.plan, "계획홍수위", "var(--bad)"]];
  if (paths.guide.level !== dam.plan) lines.push([paths.guide.level, paths.guide.name, "var(--warn)"]);
  lines.forEach(([v, name, c]) => {
    if (v < lo || v > hi) return;
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${c}" stroke-dasharray="4 3"/><text x="${W - R + 4}" y="${y(v) + 4}" style="fill:${c}">${name}</text>`;
  });
  [lo + 0.5, (lo + hi) / 2, hi - 0.5].forEach((v) => (s += `<text x="${L - 4}" y="${y(v) + 4}" text-anchor="end">${n(v, 1)}</text>`));
  s += `<line class="grid" x1="${x(past)}" x2="${x(past)}" y1="${T}" y2="${H - B}"/><text x="${x(past)}" y="${H - 6}" text-anchor="middle">지금</text>`;
  s += `<text x="${L}" y="${H - 6}">-${past}시간</text><text x="${W - R}" y="${H - 6}" text-anchor="end">+${HORIZON}시간</text>`;
  s += `<path d="M${line(series.L.slice(i - past, i + 1), 0)}" fill="none" stroke="var(--text)" stroke-width="2"/>`;
  paths.list.forEach((p) => {
    const d = line(p.values, past + 1);
    if (d) s += `<path d="M${x(past)},${y(series.L[i])} L${d}" fill="none" stroke="${p.color}" stroke-width="${p.width || 2}" ${p.dash ? `stroke-dasharray="${p.dash}"` : ""}/>`;
  });
  fig.innerHTML = `${s}</svg>`;
}
