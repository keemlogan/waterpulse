"use strict";
/* 방류 계산기·재난 상황판이 함께 쓰는 계산. 두 화면의 숫자가 어긋나지 않도록 계산은 여기에만 둔다. */

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n = (v, d = 0) => (v != null && Number.isFinite(Number(v)) ? Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: d }) : "–");
const HORIZON = 12;                 // 앞으로 몇 시간을 보고 판단하나
const PRED_H = [3, 6, 9, 12];       // 모델이 맞히는 시간
const M3_PER_HOUR = 3600 / 1e6;     // ㎥/s × 1시간 = 백만㎥ 단위 저수량 변화
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;

async function getJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

/* 댐 번호 첫 자리 = 5대 강(K-water 코드 체계). 제원의 강 이름은 지류까지 적혀 있고 빈 곳도 있다 */
const BASIN = { 1: "한강", 2: "낙동강", 3: "금강", 4: "섬진강", 5: "영산강" };
const basinOf = (dam) => BASIN[String(dam.code)[0]] || "기타";
/* 수위 판정·방류 계산 대상: 물을 담아 두는 댐과 조정지. 보·하굿둑은 흘려보내는 시설이라 제원의 계획홍수위가
   평소 수위와 맞지 않는다(큰비 때 몇 m씩 넘음) → 판정에서 뺀다 */
const judgeable = (dam) => dam && (dam.kind === "댐" || dam.kind === "조정지");

/* 곡선 [[저수량, 수위], …]은 둘 다 오름차순. 선형 보간, 끝은 마지막 기울기로 연장 */
function interp(x, xs, ys) {
  let i = 1;
  while (i < xs.length - 1 && x > xs[i]) i++;
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
  return ys[i - 1] + t * (ys[i] - ys[i - 1]);
}
const levelOf = (dam, S) => interp(S, dam.curve.map((p) => p[0]), dam.curve.map((p) => p[1]));
const storageOf = (dam, L) => interp(L, dam.curve.map((p) => p[1]), dam.curve.map((p) => p[0]));

/* 홍수기(6/21~9/20)엔 홍수기제한수위, 아니면 상시만수위를 "관리 기준 수위"로 쓴다 */
function guideLevel(dam, ts) {
  const md = Number(ts.slice(5, 7)) * 100 + Number(ts.slice(8, 10));
  if (md >= 621 && md <= 920 && dam.limit != null) return { level: dam.limit, name: "홍수기제한수위" };
  if (dam.normal != null) return { level: dam.normal, name: "상시만수위" };
  return { level: dam.plan, name: "계획홍수위" };
}

/* i 시점에 예측한 앞으로 1~12시간 유입량(3시간 평균, ㎥/s). 0·3·6·9·12시간 점을 잇는다 */
function inflowPath(series, i) {
  const now = series.I[i];
  const pts = [[0, now], ...PRED_H.map((h, k) => [h, series.P[k][i]])];
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
  const firstOver = (path, lvl) => {
    const k = path.findIndex((L) => L >= lvl);
    return k < 0 ? null : k + 1;
  };
  const toPlan = L0 >= dam.plan ? 0 : firstOver(keep, dam.plan);
  const toGuide = L0 >= guide.level ? 0 : firstOver(keep, guide.level);
  const status = toPlan != null ? "danger" : toGuide != null ? "warn" : "ok";

  // 12시간 뒤 관리 기준 수위까지 낮추고, 그 사이 계획홍수위를 넘지 않는 가장 작은 일정 방류량
  let cum = 0, qPeak = 0;
  const Vplan = storageOf(dam, dam.plan - off);
  inflow.forEach((I, k) => {
    cum += I * M3_PER_HOUR;
    qPeak = Math.max(qPeak, (S0 + cum - Vplan) / ((k + 1) * M3_PER_HOUR));
  });
  const qEnd = (S0 + cum - storageOf(dam, guide.level - off)) / (HORIZON * M3_PER_HOUR);
  const need = Math.max(0, qEnd, qPeak);
  const q = Math.max(need, 0);
  const plan = levelPath(dam, S0, inflow, Math.max(q, O0), off);
  // 실제로 그 뒤 12시간에 일어난 일(되감기라서 알 수 있다)
  const actualL = series.L.slice(i + 1, i + 1 + HORIZON);
  const actualO = series.O.slice(i + 1, i + 1 + HORIZON).filter((v) => v != null);
  const actualI = series.I.slice(i + 1, i + 1 + HORIZON);
  return {
    L0, S0, O0, guide, inflow, keep, plan, status, toPlan, toGuide,
    q, extra: Math.max(0, q - O0), enough: q <= O0, overCapacity: q > dam.omax,
    totalTon: Math.max(q, O0) * HORIZON * 3600, extraTon: Math.max(0, q - O0) * HORIZON * 3600,
    actualL, actualI, actualOavg: actualO.length ? actualO.reduce((a, b) => a + b, 0) / actualO.length : null,
    actualMax: Math.max(...actualL.filter((v) => v != null)),
  };
}

const STATUS = {
  danger: { label: "위험", hint: "12시간 안에 계획홍수위", cls: "danger" },
  warn: { label: "경계", hint: "12시간 안에 관리 기준 수위", cls: "warn" },
  ok: { label: "정상", hint: "기준 아래", cls: "ok" },
};

const tons = (m3) => (m3 >= 1e8 ? `${n(m3 / 1e8, 2)}억 톤` : m3 >= 1e4 ? `${n(m3 / 1e4)}만 톤` : `${n(m3)}톤`);
const fmtTs = (ts) => `${Number(ts.slice(5, 7))}월 ${Number(ts.slice(8, 10))}일 ${ts.slice(11, 16)}`;

/* 시점 고르기: 시나리오 칩 + 시간 막대 + 재생. onChange(scn, data, i) */
function timeline(root, scenarios, initial, onChange) {
  root.innerHTML = `
    <div class="chips scn" role="group" aria-label="큰비 시나리오">${scenarios
      .map((s) => `<button class="chip" data-scn="${esc(s.id)}" aria-pressed="false">${esc(s.title.replace(" 큰비", ""))}</button>`)
      .join("")}</div>
    <div class="scrub">
      <button class="play" aria-label="재생"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="i-play" d="M8 5v14l11-7z"/><path class="i-pause" d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg></button>
      <div class="scrub-body"><div class="scrub-ts" aria-live="polite"></div><input type="range" min="0" value="0" aria-label="시각"></div>
    </div>
    <p class="scrub-note"></p>`;
  const range = $("input", root), tsEl = $(".scrub-ts", root), play = $(".play", root), note = $(".scrub-note", root);
  const cache = {};
  let cur = null, data = null, timer = 0;

  async function pick(id, i) {
    cur = scenarios.find((s) => s.id === id) || scenarios[0];
    root.querySelectorAll("[data-scn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scn === cur.id)));
    data = cache[cur.id] || (cache[cur.id] = await getJSON(`data/scn_${cur.id}.json`));
    range.max = String(cur.hours - 1);
    range.value = String(i != null ? Math.min(i, cur.hours - 1) : Math.max(0, cur.hours - 1 - 24 - 12));
    note.textContent = `큰비 ${fmtTs(cur.peak)} 무렵 · ${cur.rivers.join("·")} 쪽 · 예측은 ${cur.model}`;
    emit();
  }
  function emit() {
    const i = Number(range.value);
    tsEl.textContent = fmtTs(data.ts[i]);
    range.style.setProperty("--p", `${(i / Number(range.max)) * 100}%`);
    onChange(cur, data, i);
  }
  function stop() {
    clearInterval(timer);
    timer = 0;
    play.classList.remove("on");
    play.setAttribute("aria-label", "재생");
  }
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-scn]");
    if (b) {
      stop();
      pick(b.dataset.scn);
    }
  });
  range.addEventListener("input", () => {
    stop();
    emit();
  });
  play.addEventListener("click", () => {
    if (timer) return stop();
    if (Number(range.value) >= Number(range.max)) range.value = "0";
    play.classList.add("on");
    play.setAttribute("aria-label", "멈춤");
    timer = setInterval(() => {
      if (Number(range.value) >= Number(range.max)) return stop();
      range.value = String(Number(range.value) + 1);
      emit();
    }, 700);
  });
  return pick(initial.scn, initial.t);
}

/* 바텀시트: 열면 배경을 잠그고, Esc·배경 누르기·닫기로 닫는다 */
function sheet(id) {
  const el = $(id), scrim = $("#scrim");
  let last = null, timer = 0;
  const close = () => {
    if (!el.classList.contains("on")) return;
    el.classList.remove("on");
    scrim.classList.remove("on");
    $("#app").inert = false;
    document.body.style.overflow = "";
    timer = setTimeout(() => {
      el.hidden = true;
      scrim.hidden = true;
    }, REDUCED ? 0 : 320);
    if (last && document.contains(last)) last.focus({ preventScroll: true });
  };
  const open = (from) => {
    clearTimeout(timer);
    last = from || last;
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
  };
  $(".close", el).addEventListener("click", close);
  scrim.addEventListener("click", close);
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());
  return { open, close, body: $(".sheet-body", el) };
}

/* 수위 그림: 지난 24시간 실제 + 앞으로 12시간(여러 경로) + 기준선. paths = {guide, list:[{values,color,dash}]} */
function levelChart(fig, dam, series, i, paths) {
  const W = 340, H = 200, L = 40, R = 66, T = 12, B = 22;
  const past = Math.min(24, i);
  const xs = past + HORIZON;
  const x = (k) => L + ((W - L - R) * k) / xs;               // k = 0(24시간 전) ~ xs(12시간 뒤)
  const all = [...series.L.slice(i - past, i + 1), ...paths.list.flatMap((p) => p.values), dam.plan, paths.guide.level]
    .filter((v) => v != null);
  const lo = Math.min(...all) - 0.5, hi = Math.max(...all, dam.plan) + 0.5;
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const line = (vals, k0) => vals.map((v, k) => (v == null ? null : `${x(k0 + k).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(" L");
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(dam.name)} 수위: 지난 24시간과 앞으로 12시간">`;
  [[dam.plan, "계획홍수위", "var(--bad)"], [paths.guide.level, paths.guide.name, "var(--warn)"]].forEach(([v, name, c]) => {
    if (v == null || v < lo || v > hi) return;
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${c}" stroke-dasharray="4 3"/><text x="${W - R + 4}" y="${y(v) + 4}" style="fill:${c}">${name}</text>`;
  });
  [lo + 0.5, (lo + hi) / 2, hi - 0.5].forEach((v) => (s += `<text x="${L - 4}" y="${y(v) + 4}" text-anchor="end">${n(v, 1)}</text>`));
  s += `<line class="grid" x1="${x(past)}" x2="${x(past)}" y1="${T}" y2="${H - B}"/><text x="${x(past)}" y="${H - 6}" text-anchor="middle">지금</text>`;
  s += `<text x="${L}" y="${H - 6}">-${past}시간</text><text x="${W - R}" y="${H - 6}" text-anchor="end">+${HORIZON}시간</text>`;
  s += `<path d="M${line(series.L.slice(i - past, i + 1), 0)}" fill="none" stroke="var(--text)" stroke-width="2"/>`;
  paths.list.forEach((p) => {
    s += `<path d="M${x(past)},${y(series.L[i])} L${line(p.values, past + 1)}" fill="none" stroke="${p.color}" stroke-width="${p.width || 2}" ${p.dash ? `stroke-dasharray="${p.dash}"` : ""}/>`;
  });
  fig.innerHTML = `${s}</svg>`;
}
