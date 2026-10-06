"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null ? Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: d }) : "–");
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const LAG_MAX = 48;          // 목록 막대와 비교 그림의 세로축 끝(시간)
const FEW_EVENTS = 10;       // 큰비가 이보다 적으면 "참고용"
const SHEET_MS = 320;        // style.css의 .sheet 전환 시간과 같아야 함
const CHART_W = 340;

const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;

let D;
const state = { sort: "fast", kind: "전체", q: "", upH: "6" };

fetch("data/summary.json")
  .then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  })
  .then((data) => {
    D = data;
    [renderHero, renderKinds, renderList, renderCompare, renderUpstream, renderTrend, renderSteps, renderFooter].forEach(safe);
    safe(openFromHash);
  })
  .catch(() => {
    $("#headline").textContent = "자료를 불러오지 못했어요";
    $("#lede").textContent = "잠시 뒤 다시 열어 주세요.";
  })
  .finally(() => $("#app").setAttribute("aria-busy", "false"));

/* 한 구역이 실패해도 나머지는 그린다. 실패한 구역은 숨긴다. */
function safe(fn) {
  try {
    fn();
  } catch (e) {
    const sec = document.querySelector(`[data-part="${fn.name}"]`);
    if (sec) sec.hidden = true;
    console.error(fn.name, e);
  }
}

function barRow(label, v, color) {
  const w = Math.max(0, Math.min(1, v || 0)) * 100;
  const val = v == null ? "–" : v > 0 ? `${n(v * 100)}%` : "개선 없음";
  return `<div class="bar-row"><span>${esc(label)}</span><span class="bar"><i style="width:${w}%;background:${color}"></i></span><b>${val}</b></div>`;
}

function renderHero() {
  const h = D.headline;
  $("#headline").innerHTML = `비가 오면, 댐에는 보통 <em>${n(h.median_lag_h)}시간</em> 뒤에 물이 가장 많이 몰려와요`;
  $("#lede").textContent = `K-water 댐·보 ${n(h.dams)}곳의 ${h.years} 시간 자료 ${n(h.hourly_rows)}줄에서 큰비 사건 ${n(h.events)}개를 찾아 확인했어요. 2026년 10월 5일에 공공 API로 직접 받은 실제 값이에요.`;
  $("#stats").innerHTML = h.stats.map((s) => `<div class="stat"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join("");
}

function renderKinds() {
  const kinds = ["전체", ...new Set(D.dams.map((d) => d.kind))];
  $("#kinds").innerHTML = kinds.map((k) => `<button class="chip" aria-pressed="${k === state.kind}" data-kind="${esc(k)}">${esc(k)}</button>`).join("");
  $("#kinds").addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]");
    if (!b) return;
    state.kind = b.dataset.kind;
    press($("#kinds"), b);
    renderList();
  });
  $("#sort").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sort]");
    if (!b) return;
    state.sort = b.dataset.sort;
    press($("#sort"), b);
    renderList();
  });
  $("#q").addEventListener("input", (e) => {
    state.q = e.target.value.trim();
    renderList();
  });
}

function press(group, on) {
  group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === on)));
}

function renderList() {
  const rows = D.dams.filter((d) => (state.kind === "전체" || d.kind === state.kind) && d.name.includes(state.q));
  const lag = (d, none) => (d.lag ? d.lag.median_h : none);
  if (state.sort === "fast") rows.sort((a, b) => lag(a, Infinity) - lag(b, Infinity));
  if (state.sort === "slow") rows.sort((a, b) => lag(b, -1) - lag(a, -1));
  if (state.sort === "name") rows.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const pos = (h) => (Math.min(h, LAG_MAX) / LAG_MAX) * 100;
  $("#list").innerHTML = rows
    .map((d) => {
      const few = d.lag && d.lag.events < FEW_EVENTS;
      const meta = [d.kind, d.basin_km2 ? `유역 ${n(d.basin_km2)}㎢` : null, d.lag ? `큰비 ${n(d.lag.events)}번${few ? " · 참고용" : ""}` : null].filter(Boolean).join(" · ");
      const bar = d.lag
        ? `<span class="lagbar" aria-hidden="true"><i style="left:${pos(d.lag.q1_h)}%;width:${Math.max(pos(d.lag.q3_h) - pos(d.lag.q1_h), 1)}%"></i><b style="left:${pos(d.lag.median_h)}%"></b></span>`
        : "";
      const val = d.lag ? `<span class="val">${n(d.lag.median_h)}시간<small>${n(d.lag.q1_h)}–${n(d.lag.q3_h)}시간</small></span>` : `<span class="val none">사건 부족</span>`;
      return `<li><button class="row" data-code="${esc(d.code)}"><span><span class="name">${esc(d.name)}</span><span class="meta">${esc(meta)}</span>${bar}</span>${val}${CHEVRON}</button></li>`;
    })
    .join("");
  $("#list-foot").textContent = rows.length ? `${rows.length}곳 · 막대는 0~${LAG_MAX}시간, 옅은 구간은 사건의 절반이 들어가는 범위예요` : "검색 결과가 없어요";
}

$("#list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-code]");
  if (b) openSheet(b.dataset.code, b);
});

/* 바텀시트 — 열면 주소가 #dam=코드로 바뀌어 그대로 공유할 수 있다 */
let lastFocus = null;
let closeTimer = 0;
let pushed = false;          // 목록에서 열었으면 기록을 하나 쌓아 휴대폰 "뒤로"가 시트를 닫게 한다

function openSheet(code, from, push = true) {
  const d = D.dams.find((x) => x.code === code);
  if (!d) return;
  clearTimeout(closeTimer);
  lastFocus = from || lastFocus;
  $("#sheet-body").innerHTML = sheetHTML(d);
  if (d.event) {
    try {
      drawEvent($(".ev-chart", $("#sheet-body")), d.event);
    } catch (e) {
      $(".ev-sec", $("#sheet-body")).hidden = true;   // 그림만 빼고 나머지는 보여 준다
      console.error("drawEvent", e);
    }
  }
  const sheet = $("#sheet"), scrim = $("#scrim");
  sheet.hidden = false;
  scrim.hidden = false;
  requestAnimationFrame(() => {
    sheet.classList.add("on");
    scrim.classList.add("on");
  });
  sheet.scrollTop = 0;
  $("#app").inert = true;
  document.body.style.overflow = "hidden";
  sheet.focus({ preventScroll: true });   // 시트 자체에 초점: 화면 읽기 프로그램이 제목부터 읽는다
  if (location.hash !== `#dam=${code}`) {
    if (push) {
      history.pushState(null, "", `${location.pathname}${location.search}#dam=${code}`);
      pushed = true;
    } else history.replaceState(null, "", `${location.pathname}${location.search}#dam=${code}`);
  }
}

function closeSheet() {
  const sheet = $("#sheet"), scrim = $("#scrim");
  if (!sheet.classList.contains("on")) return;
  sheet.classList.remove("on");
  scrim.classList.remove("on");
  $("#app").inert = false;
  document.body.style.overflow = "";
  closeTimer = setTimeout(() => {
    sheet.hidden = true;
    scrim.hidden = true;
  }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : SHEET_MS);
  (lastFocus && document.contains(lastFocus) ? lastFocus : $("#q")).focus({ preventScroll: true });
  if (pushed) {
    pushed = false;
    history.back();
  } else if (location.hash) history.replaceState(null, "", `${location.pathname}${location.search}`);
}

function openFromHash() {
  const m = location.hash.match(/^#dam=(\d+)$/);
  if (m) return openSheet(m[1], null, false);
  pushed = false;              // "뒤로"로 이미 기록이 빠졌으니 다시 빼지 않는다
  closeSheet();
}

window.addEventListener("hashchange", () => safe(openFromHash));
$("#close").addEventListener("click", closeSheet);
$("#scrim").addEventListener("click", closeSheet);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSheet();
});

function sheetHTML(d) {
  const few = d.lag && d.lag.events < FEW_EVENTS;
  const title = d.lag ? `큰비가 오면 약 <em>${n(d.lag.median_h)}시간</em> 뒤에 물이 가장 많이 들어와요` : "반응 시간을 잴 만큼 큰비 사건이 부족했어요";
  const fc = d.forecast || {};
  const hs = ["3", "6", "12"].filter((h) => fc[h] && fc[h].skill != null);
  const allWorse = hs.length && hs.every((h) => fc[h].skill <= 0);
  const fcRows = hs.map((h) => barRow(`${h}시간 뒤`, fc[h].skill, "var(--blue)")).join("");
  const fcHigh = ["3", "6", "12"].filter((h) => fc[h] && fc[h].skill_high != null).map((h) => barRow(`${h}시간 뒤`, fc[h].skill_high, "var(--blue)")).join("");
  const q = d.quality || {};
  const ev = d.event;
  return `
    <div class="hd"><span class="kind">${esc(d.name)} · ${esc(d.kind)}</span><h3 id="sheet-title">${title}</h3>
      ${few ? `<p class="sub">큰비가 ${n(d.lag.events)}번뿐이라 참고용으로 봐 주세요.</p>` : ""}</div>
    ${ev ? `<div class="sec ev-sec"><h4>큰비가 왔을 때</h4><p class="sub">${esc(ev.label)}</p>
      <figure class="chart ev-chart"></figure>
      <p class="sub">비가 가장 셌던 ${esc(ev.ts[ev.rain_peak_i].slice(5))} → 유입이 가장 많았던 ${esc(ev.ts[ev.inflow_peak_i].slice(5))}, ${n(ev.lag_h)}시간 차이</p></div>` : ""}
    ${hs.length ? `<div class="sec"><h4>몇 시간 뒤를 맞힐 수 있을까요</h4><p class="sub">2024–2025년으로 시험했어요. “지금 양이 그대로 간다”고 찍을 때보다 덜 틀린 정도예요. 20%면 찍기가 100만큼 틀릴 때 모델은 80만큼만 틀렸다는 뜻이에요.</p><div class="fc">${fcRows}</div>
      ${fcHigh ? `<p class="sub fc-sub">홍수 때만 보면 (이 댐에 물이 가장 많이 들어오는 상위 5% 시간)</p><div class="fc">${fcHigh}</div>` : ""}
      ${allWorse ? `<p class="sub fc-sub">이 댐은 아직 “그대로 찍기”보다 나은 예측을 못 했어요. 원인은 아직 확인하지 못했고, 아래 데이터 상태를 함께 봐 주세요.</p>` : ""}</div>` : ""}
    <div class="sec"><h4>데이터 상태</h4><dl class="kv">
      <dt>2020–2025 시간 자료</dt><dd>${n(q.rows || 0)}줄 (${n(q.coverage || 0, 1)}%)</dd>
      <dt>유입량 0 이하</dt><dd>${n(q.inflow_le0_pct || 0, 1)}%</dd>
      ${d.lag ? `<dt>큰비 사건</dt><dd>${n(d.lag.events)}번</dd><dt>다른 방법으로 잰 값 (비 그래프를 몇 시간 밀면 유입과 가장 닮는지)</dt><dd>${d.lag.xcorr_h != null ? `${n(d.lag.xcorr_h)}시간` : "–"}</dd>` : ""}
      ${d.basin_km2 ? `<dt>유역 넓이</dt><dd>${n(d.basin_km2)}㎢</dd>` : ""}
      ${d.anomaly ? `<dt>예측이 크게 빗나간 때 (2024–2025)</dt><dd>${n(d.anomaly.episodes)}번 · ${n(d.anomaly.flag_hours)}시간</dd>` : ""}
    </dl></div>`;
}

/* 사건 그림: 위 = 비(막대), 아래 = 유입량(선). 단위가 달라 한 축에 겹치지 않는다 */
function drawEvent(fig, ev) {
  const W = CHART_W, L = 38, R = 8, TOP = 22, RH = 44, GAP = 34, FH = 110;
  const nPts = ev.ts.length, pw = W - L - R, H = TOP + RH + GAP + FH + 22;
  const x = (i) => L + (pw * i) / Math.max(1, nPts - 1);
  const rmax = Math.max(1, ...ev.rain.map((v) => v || 0));
  const fmax = Math.max(1, ...ev.inflow.map((v) => v || 0));
  const fTop = TOP + RH + GAP;
  const fy = (v) => fTop + FH - (FH * v) / fmax;
  const bw = Math.max(1.5, pw / nPts - 1);
  const ri = ev.rain_peak_i, fi = ev.inflow_peak_i;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="비가 가장 셌던 때부터 ${n(ev.lag_h)}시간 뒤에 유입량이 가장 많았어요">`;
  s += `<text x="0" y="12">비 (mm/시간)</text><text x="0" y="${fTop - 10}">유입량 (㎥/s)</text>`;
  ev.rain.forEach((v, i) => {
    if (v > 0) s += `<rect x="${x(i) - bw / 2}" y="${TOP + RH - (RH * v) / rmax}" width="${bw}" height="${(RH * v) / rmax}" rx="1" fill="var(--rain)"/>`;
  });
  s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${TOP + RH}" y2="${TOP + RH}"/>`;
  [0, 0.5, 1].forEach((f) => {
    s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${fy(fmax * f)}" y2="${fy(fmax * f)}"/><text x="${L - 4}" y="${fy(fmax * f) + 4}" text-anchor="end">${n(fmax * f)}</text>`;
  });
  const path = ev.inflow.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${fy(v).toFixed(1)}`)).filter(Boolean).join(" L");
  s += `<path d="M${path}" fill="none" stroke="var(--flow)" stroke-width="2" stroke-linejoin="round"/>`;
  s += `<line class="tip-line" x1="${x(ri)}" x2="${x(ri)}" y1="${TOP}" y2="${fy(0)}"/><line class="tip-line" x1="${x(fi)}" x2="${x(fi)}" y1="${TOP}" y2="${fy(0)}"/>`;
  s += `<line x1="${x(ri)}" x2="${x(fi)}" y1="${TOP + RH + GAP / 2 + 2}" y2="${TOP + RH + GAP / 2 + 2}" stroke="var(--text)" stroke-width="1.5"/>`;
  s += `<text class="lbl halo" x="${(x(ri) + x(fi)) / 2}" y="${TOP + RH + GAP / 2 - 2}" text-anchor="middle">${n(ev.lag_h)}시간</text>`;
  if (ev.inflow[fi] != null) s += `<circle cx="${x(fi)}" cy="${fy(ev.inflow[fi])}" r="4" fill="var(--flow)" stroke="var(--bg)" stroke-width="2"/>`;
  s += `<text x="${L}" y="${H - 4}">${esc(ev.ts[0].slice(5))}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">${esc(ev.ts[nPts - 1].slice(5))}</text>`;
  s += `<line class="tip-line cursor" x1="0" x2="0" y1="${TOP}" y2="${fy(0)}" visibility="hidden"/></svg><div class="tip" hidden></div>`;
  fig.innerHTML = s;
  const svg = fig.querySelector("svg"), tip = fig.querySelector(".tip"), cur = fig.querySelector(".cursor");
  const move = (e) => {
    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(nPts - 1, Math.round(((((e.clientX - r.left) / r.width) * W - L) / pw) * (nPts - 1))));
    cur.setAttribute("x1", x(i));
    cur.setAttribute("x2", x(i));
    cur.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.style.left = `${(x(i) / W) * 100}%`;
    tip.style.top = `${(fy(ev.inflow[i] || 0) / H) * 100}%`;
    tip.textContent = `${ev.ts[i].slice(5)} · 비 ${n(ev.rain[i] || 0, 1)}mm · 유입 ${ev.inflow[i] == null ? "–" : n(ev.inflow[i])}㎥/s`;
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", () => {
    tip.hidden = true;
    cur.setAttribute("visibility", "hidden");
  });
}

/* 유역 넓이 ↔ 반응 시간: 가로는 로그 눈금 */
function renderCompare() {
  const c = D.compare;
  $("#cmp-sub").textContent = c.sub;
  const W = CHART_W, H = 230, L = 30, R = 10, T = 10, B = 36;
  const lo = Math.floor(Math.log10(Math.min(...c.points.map((p) => p.area))));
  const hi = Math.ceil(Math.log10(Math.max(...c.points.map((p) => p.area))));
  const x = (v) => L + ((W - L - R) * (Math.log10(v) - lo)) / (hi - lo);
  const y = (v) => T + (H - T - B) * (1 - Math.min(v, LAG_MAX) / LAG_MAX);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.sub)}">`;
  const tick = (e) => ["1", "10", "100", "1천", "1만", "10만"][e] || n(10 ** e);
  for (let e = lo; e <= hi; e++) s += `<line class="grid" x1="${x(10 ** e)}" x2="${x(10 ** e)}" y1="${T}" y2="${H - B}"/><text x="${x(10 ** e)}" y="${H - B + 14}" text-anchor="middle">${tick(e)}</text>`;
  s += `<text x="${W - R}" y="${H - 2}" text-anchor="end">유역 넓이 (㎢)</text>`;
  [0, LAG_MAX / 2, LAG_MAX].forEach((t) => (s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 4}" y="${y(t) + 4}" text-anchor="end">${t}h</text>`));
  c.points.forEach((p) => {
    s += `<circle cx="${x(p.area).toFixed(1)}" cy="${y(p.lag).toFixed(1)}" r="4" fill="${p.kind === "댐" ? "var(--blue)" : "var(--dot)"}"><title>${esc(p.name)} · 유역 ${n(p.area)}㎢ · ${n(p.lag)}시간</title></circle>`;
  });
  c.points.filter((p) => p.label).forEach((p) => (s += `<text class="lbl" x="${x(p.area) + 6}" y="${y(p.lag) - 6}">${esc(p.name)}</text>`));
  $("#cmp").innerHTML = `${s}</svg>`;
  $("#cmp-note").textContent = c.note;
}

/* 상류 관측소를 넣었을 때 */
function renderUpstream() {
  const draw = () => {
    $("#upstream").innerHTML = D.upstream
      .filter((u) => u.h[state.upH])
      .map((u) => {
        const r = u.h[state.upH];
        return `<div class="up"><h3>${esc(u.name)}</h3>${barRow("댐 자료만", r.dam_only, "var(--dot)")}${barRow("+ 상류 관측소", r.with_upstream, "var(--up)")}</div>`;
      })
      .join("");
  };
  $("#up-h").addEventListener("click", (e) => {
    const b = e.target.closest("[data-h]");
    if (!b) return;
    state.upH = b.dataset.h;
    press($("#up-h"), b);
    draw();
  });
  draw();
  $("#up-note").textContent = D.upstream_note;
}

/* 20년 홍수 크기 (그해 최대 유입 ÷ 보통 해) */
function renderTrend() {
  const t = D.trend;
  $("#trend-sub").textContent = t.sub;
  const W = CHART_W, H = 150, L = 30, R = 8, T = 10, B = 22;
  const ys = t.max_idx, xs = t.years;
  const ymax = Math.max(...ys) * 1.1;
  const x = (i) => L + ((W - L - R) * i) / (xs.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / ymax);
  const top = ys.indexOf(Math.max(...ys));
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t.note)}">`;
  [1, 2].filter((v) => v < ymax).forEach((v) => {
    s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 4}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  });
  s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
  ys.forEach((v, i) => {
    s += `<rect x="${x(i) - 5}" y="${y(v)}" width="10" height="${y(0) - y(v)}" rx="2" fill="${i === top ? "var(--blue)" : "var(--dot)"}"><title>${xs[i]}년 ${n(v, 2)}</title></rect>`;
  });
  s += `<text class="lbl" x="${x(top)}" y="${y(ys[top]) - 6}" text-anchor="middle">${xs[top]}년</text>`;
  s += `<text x="${x(0)}" y="${H - 4}" text-anchor="middle">${xs[0]}</text><text x="${x(xs.length - 1)}" y="${H - 4}" text-anchor="middle">${xs[xs.length - 1]}</text>`;
  $("#trend").innerHTML = `${s}</svg>`;
  $("#trend-note").textContent = t.note;
}

/* steps·footer의 body는 우리 빌드 스크립트가 만든 신뢰된 HTML(<code> 포함)이다 */
function renderSteps() {
  $("#steps").innerHTML = D.steps.map((s) => `<li><b>${esc(s.title)}</b><p>${s.body}</p></li>`).join("");
  $("#how-note").textContent = D.how_note;
}

function renderFooter() {
  $("#footer").innerHTML = D.footer.map((p) => `<p>${p}</p>`).join("");
}
