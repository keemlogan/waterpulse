"use strict";
/* 방류 계산기: 과거 시점 하나, 댐 하나에 대해 "얼마나 내보내야 했나"를 보여 준다 */

const st = { meta: null, scn: null, data: null, i: 0, dam: new URLSearchParams(location.search).get("dam"), mode: "plan", timer: 0, scale: null, anim: null };
const damSheet = sheet("#dam-sheet");

boot(onTime, () => {
  $("#answer-title").textContent = "자료를 불러오지 못했어요";
  $("#answer-sub").textContent = "잠시 뒤 새로 고쳐 주세요.";
});

function onTime(meta, scn, data, i, playing) {
  stopPreview();
  $("#anim-cap").setAttribute("aria-live", playing ? "off" : "polite");   // 재생 중엔 매시간 읽지 않는다
  Object.assign(st, { meta, scn, data, i });
  if (!judgeable(meta[st.dam])) {                          // 처음 열 때만 그 시각 가장 급한 댐을 고른다
    const top = assessScenario(meta, data, i).find((r) => r.a);
    st.dam = top ? top.code : null;
  }
  setUrl({ scn: scn.id, dam: st.dam, t: i });
  render();
}

function render() {
  const dam = st.meta[st.dam], series = st.data.dams[st.dam];
  const a = series ? assess(dam, series, st.i, st.data.ts[st.i]) : null;
  $("#dam-name").textContent = dam ? damName(dam) : "댐 고르기";
  $("#dam-sub").textContent = dam ? `${basinOf(dam)} · 계획홍수위 ${n(dam.plan, 1)}m` : "";
  $("#dam-st").innerHTML = a ? `<span class="st ${a.status}">${STATUS[a.status].label}</span>` : "";
  $("#detail").hidden = !a;
  $("#chart-part").hidden = !a;
  if (!a) {                                                // 고른 댐은 그대로 두고, 왜 비었는지만 말한다
    $("#answer-title").textContent = series ? "이 시각엔 이 댐 자료가 비어 있어요" : "이 큰비 기간엔 이 댐 자료가 없어요";
    $("#answer-sub").textContent = series ? "시각을 조금 옮기거나 다른 댐을 골라 보세요." : "다른 댐을 골라 보세요.";
    $("#answer-warn").innerHTML = "";
    return;
  }
  renderAnswer(dam, a);
  const scale = scaleFor(dam, series);
  drawDam(dam, a, scale);
  setDam(dam, a.L0, series.I[st.i], a.O0, series.R[st.i], "지금");
  levelChart($("#lvl"), dam, series, st.i, {
    guide: a.guide,
    range: scale.chart,
    list: [
      { values: a.keep, color: "var(--text3)", dash: "5 4" },
      { values: a.plan, color: "var(--blue)", width: 2.5 },
      { values: a.actualL, color: "var(--text)", dash: "1 3" },
    ],
  });
  $("#actual").textContent = a.actualOavg == null || a.actualMax == null
    ? "그 뒤 12시간 실제 기록이 비어 있어요."
    : `실제로는 그 뒤 12시간 동안 1초에 평균 ${perSec(a.actualOavg)}을 내보냈고, 수위는 최고 ${n(a.actualMax, 2)}m였어요. 계획홍수위를 ${a.actualMax >= dam.plan ? "넘었어요" : "넘지 않았어요"}.`;
}

/* 답 한 줄: 위의 상태 표시(위험·경계·정상)와 어긋나지 않게 경우를 나눈다 */
function renderAnswer(dam, a) {
  const g = `${a.guide.name}(${n(a.guide.level, 1)}m)`;
  const tone = a.status === "danger" ? "bad" : a.status === "warn" ? "warn" : "";
  let title, sub;
  if (!a.enough) {
    title = `지금부터 12시간 동안 1초에 <em class="${tone}">${perSec(a.q)}씩</em> 내보내야 해요`;
    const why = a.toPlan === 0 ? "이미 계획홍수위를 넘었어요."
      : a.toPlan != null ? `지금처럼 1초에 ${perSec(a.O0)}만 내보내면 ${a.toPlan}시간 뒤 계획홍수위(${n(dam.plan, 1)}m)를 넘어요.`
      : a.toGuide === 0 ? `이미 ${g} 위예요.`
      : `지금처럼 1초에 ${perSec(a.O0)}만 내보내면 ${a.toGuide}시간 뒤 ${g}를 넘어요.`;
    sub = `${why} 지금보다 1초에 ${perSec(a.q - a.O0)}씩 더, 12시간 동안 모두 ${tons(a.totalTon)}이에요.`;
  } else if (a.status === "ok") {
    title = "지금 내보내는 양이면 <em>충분해요</em>";
    sub = `지금처럼 1초에 ${perSec(a.O0)}씩 내보내면 12시간 동안 최고 ${n(a.keepMax, 2)}m로, ${g} 아래예요.`;
  } else {
    title = `지금 내보내는 양을 <em class="${tone}">줄이지 마세요</em>`;
    const now = a.toPlan === 0 ? "이미 계획홍수위 위예요." : a.toGuide === 0 ? `이미 ${g} 위예요.`
      : `${a.toGuide}시간 뒤 잠깐 ${g}를 넘어 최고 ${n(a.keepMax, 2)}m까지 올라요.`;
    sub = `${now} 지금처럼 1초에 ${perSec(a.O0)}씩 계속 내보내면 12시간 뒤엔 ${a.guide.name} 아래로 내려와요.`;
  }
  $("#answer-title").innerHTML = title;
  $("#answer-sub").textContent = sub;
  $("#answer-warn").innerHTML = [
    a.overCapacity && dam.kind === "댐"
      ? `<p class="warnline">모은 기록에서 이 댐이 가장 많이 내보낸 양(1초에 ${n(dam.omax)}톤)보다 많아요. 한 번에 이만큼 내보내기는 어려울 수 있어서, 실제 운영이라면 더 일찍부터 나눠 내보내는 방법을 따졌을 거예요.</p>`
      : "",
    a.status !== "ok" ? `<p class="fine">예측은 물이 갑자기 불어날 때 실제보다 적게 나오는 편이라, 실제로 필요했던 양은 이보다 많았을 수 있어요.</p>` : "",
  ].join("");
  $("#kpis").innerHTML = `
    <div><b>${n(a.L0, 2)}m</b><span>지금 수위</span></div>
    <div><b class="${a.toPlan != null ? "bad" : ""}">${n(a.keepMax, 2)}m</b><span>지금처럼 두면 12시간 안 최고 · ${esc(whenText(a))}</span></div>
    <div><b>${tons(a.totalTon)}</b><span>계산대로 12시간 동안 내보낼 양</span></div>`;
}

/* 세로 눈금은 시나리오·댐마다 한 번 정해 고정한다 → 시간을 옮기면 같은 그림 안에서 물만 움직인다 */
function scaleFor(dam, series) {
  const key = `${st.scn.id}|${dam.code}`;
  if (st.scale && st.scale.key === key) return st.scale;
  const vals = series.L.filter((v) => v != null);
  for (let i = 0; i < st.scn.hours; i++) {
    const a = assess(dam, series, i, st.data.ts[i]);
    if (a) vals.push(...a.keep, ...a.plan, a.guide.level);
  }
  const lo = Math.min(...vals), hi = Math.max(...vals, dam.plan);
  const pad = Math.max(1, (hi - lo) * 0.15);
  // 단면 그림은 계획홍수위 위로 너무 멀리 가지 않게 자른다(넘친 물은 둑 위까지 가득 찬 것으로 보인다)
  const top = Math.min(hi, dam.plan + Math.max(2, (dam.plan - lo) * 0.3));
  st.scale = { key, lo: lo - pad, hi: top + pad * 0.6, chart: [lo - 0.5, hi + 0.5] };
  st.anim = null;
  return st.scale;
}

/* ── 댐 단면 그림: 물 높이·들어오는 물·내보내는 물·비가 움직인다. 시나리오·댐이 바뀔 때만 새로 그린다 ── */
function drawDam(dam, a, scale) {
  const key = `${scale.key}|${a.guide.level}`;
  if (st.anim && st.anim.key === key) return;
  const W = 340, H = 200, BOT = 186, TOP = 26;
  const y = (L) => BOT - ((BOT - TOP) * (L - scale.lo)) / (scale.hi - scale.lo);
  const yp = y(dam.plan), yg = y(a.guide.level);
  const thr = [[yp, `계획홍수위 ${n(dam.plan, 1)}m`, "var(--bad)", -5]];
  if (a.guide.level !== dam.plan) thr.push([yg, `${a.guide.name} ${n(a.guide.level, 1)}m`, "var(--warn)", yg - yp < 16 ? 13 : -5]);
  const crest = dam.crest > dam.plan ? dam.crest : dam.plan + 1;   // 조정지 4곳은 제원의 댐마루가 0으로 적혀 있다
  const crestY = Math.max(TOP - 8, y(crest));
  const flow = (cls, d) => `<path class="${cls} base" d="${d}" fill="none" stroke="var(--water)" stroke-linecap="round" opacity="0.35"/><path class="${cls} flow" d="${d}" fill="none" stroke="var(--water-deep)" stroke-width="2" stroke-linecap="round"/>`;
  $("#anim").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(dam.name)} 단면: 물 높이와 들어오고 나가는 물">
    <defs><clipPath id="basin"><polygon points="0,${TOP} 250,${TOP} 250,${BOT} 70,${BOT} 0,${TOP + 80}"/></clipPath></defs>
    <polygon points="0,${TOP + 80} 70,${BOT} 250,${BOT} 250,${H} 0,${H}" fill="var(--ground)"/>
    <g clip-path="url(#basin)"><g class="water"><rect x="0" y="0" width="250" height="${H * 2}" fill="var(--water)" opacity="0.5"/><rect x="0" y="0" width="250" height="2.5" fill="var(--water-deep)"/></g></g>
    ${thr.map(([yy, label, c, dy]) => `<line x1="0" x2="250" y1="${yy}" y2="${yy}" stroke="${c}" stroke-dasharray="5 4"/><text class="thr" x="6" y="${yy + dy}" style="fill:${c}">${label}</text>`).join("")}
    <polygon points="250,${crestY} 264,${crestY} 296,${BOT + 6} 250,${BOT + 6}" fill="var(--text3)" opacity="0.6"/>
    ${flow("inflow", `M-6,${TOP + 46} C 18,${TOP + 50} 30,${TOP + 62} 52,${TOP + 76}`)}
    ${flow("outflow", `M266,${crestY + 10} C 288,${crestY + 18} 300,${BOT - 34} 340,${BOT - 4}`)}
    <g class="rain">${Array.from({ length: 13 }, (_, k) => `<line class="drop" x1="${14 + k * 18}" x2="${11 + k * 18}" y1="0" y2="9" stroke="var(--rain)" stroke-width="1.6" stroke-linecap="round" style="animation-delay:${(k * 137) % 900}ms"/>`).join("")}</g>
    <g class="lvg"><text class="lv" x="244" y="-7" text-anchor="end"></text></g>
  </svg>`;
  st.anim = { key, y, top: TOP, water: $("#anim .water"), lvg: $("#anim .lvg"), lv: $("#anim .lv"),
    inflow: [...document.querySelectorAll("#anim .inflow")], outflow: [...document.querySelectorAll("#anim .outflow")], rain: $("#anim .rain") };
}

function setDam(dam, level, inflow, outflow, rain, label) {
  const an = st.anim, yy = an.y(level);
  an.water.style.transform = `translateY(${yy}px)`;
  an.lvg.style.transform = `translateY(${Math.max(an.top + 12, yy)}px)`;
  an.lv.textContent = `${n(level, 2)}m`;
  const flowStyle = ([base, top], q) => {
    const r = Math.min(1, Math.max(0, (q || 0) / Math.max(dam.omax, 1)));
    base.style.strokeWidth = `${3 + 12 * Math.sqrt(r)}`;
    top.style.setProperty("--dur", `${(2.2 - 1.8 * r).toFixed(2)}s`);
    base.style.opacity = q > 0 ? "0.35" : "0.08";
    top.style.opacity = q > 0 ? "1" : "0";
  };
  flowStyle(an.inflow, inflow);
  flowStyle(an.outflow, outflow);
  an.rain.style.opacity = String(Math.min(1, (rain || 0) / 8));
  $("#anim-cap").innerHTML = `<b>${esc(label)}</b> · 수위 ${n(level, 2)}m · 들어오는 물 1초에 ${perSec(inflow)} · 내보내는 물 ${perSec(outflow)}${rain ? ` · 비 ${n(rain, 1)}mm` : ""}`;
}

/* 12시간 미리 보기: 고른 방식의 수위 경로를 한 시간씩 움직인다 */
const MODE_NAME = { keep: "지금처럼 두면", plan: "계산대로 내보내면", actual: "실제로는" };
function stopPreview() {
  if (!st.timer) return;
  clearInterval(st.timer);
  st.timer = 0;
  $("#preview").textContent = "12시간 미리 보기";
  $("#anim-cap").setAttribute("aria-live", "polite");
}
function startPreview() {
  stopPlayback();                                           // 시간 막대 재생과 겹치면 매시간 미리 보기가 끊긴다
  stopPreview();
  const dam = st.meta[st.dam], series = st.data && st.data.dams[st.dam];
  const a = series && assess(dam, series, st.i, st.data.ts[st.i]);
  if (!a) return;
  const path = st.mode === "keep" ? a.keep : st.mode === "plan" ? a.plan : a.actualL;
  const out = (k) => (st.mode === "keep" ? a.O0 : st.mode === "plan" ? Math.max(a.q, a.O0) : series.O[st.i + k]);
  const inflow = (k) => (st.mode === "actual" ? series.I[st.i + k] : a.inflow[k - 1]);
  const rain = (k) => (st.mode === "actual" ? series.R[st.i + k] : 0);
  const show = (k) => setDam(dam, path[k - 1], inflow(k), out(k), rain(k), `+${k}시간 · ${MODE_NAME[st.mode]}`);
  let last = 0;
  while (last < HORIZON && path[last] != null) last++;     // 실제 기록이 비면 거기까지만
  if (!last) return;
  if (REDUCED) return show(last);
  let k = 0;
  $("#anim-cap").setAttribute("aria-live", "off");
  $("#preview").textContent = "멈추기";
  const step = () => {
    k += 1;
    show(k);
    if (k >= last) stopPreview();
  };
  step();
  st.timer = setInterval(step, 500);
}
$("#preview").addEventListener("click", () => (st.timer ? stopPreview() : startPreview()));

$("#mode").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]");
  if (!b) return;
  st.mode = b.dataset.mode;
  $("#mode").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  startPreview();                                           // 방식을 고르면 바로 12시간을 움직여 보여 준다
});

/* 댐 고르기: 이 시각에 급한 순서로 */
$("#dam-btn").addEventListener("click", (e) => {
  if (!st.data) return;
  const rows = assessScenario(st.meta, st.data, st.i);
  damSheet.body.innerHTML = `<div class="hd"><h3 id="dam-sheet-title">어느 댐을 볼까요</h3><p class="sub">${esc(fmtTs(st.data.ts[st.i]))} 기준, 급한 순서예요.</p></div>
    <ul class="list">${rows
      .map(({ code, dam, a }) => `<li><button class="row" data-code="${esc(code)}"${code === st.dam ? ' aria-current="true"' : ""}${a ? "" : " disabled"}>
        <span><span class="name">${esc(damName(dam))}</span><span class="meta">${esc(basinOf(dam))} · ${a ? esc(whenText(a)) : "이 시각 자료 없음"}</span></span>
        ${a ? `<span class="st ${a.status}">${STATUS[a.status].label}</span>` : "<span></span>"}${CHEVRON}</button></li>`)
      .join("")}</ul>`;
  damSheet.open(e.currentTarget);
});
damSheet.body.addEventListener("click", (e) => {
  const b = e.target.closest("[data-code]");
  if (!b || b.disabled) return;
  stopPreview();
  st.dam = b.dataset.code;
  damSheet.close();
  setUrl({ scn: st.scn.id, dam: st.dam, t: st.i });
  render();
});
