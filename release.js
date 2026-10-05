"use strict";
/* 방류 계산기: 과거 시점 하나, 댐 하나에 대해 "얼마나 내보내야 했나"를 보여 준다 */

const params = new URLSearchParams(location.search);
const st = { meta: null, scn: null, data: null, i: 0, dam: params.get("dam"), mode: "plan", previewTimer: 0 };
const damSheet = sheet("#dam-sheet");
const SEVERITY = { danger: 0, warn: 1, ok: 2 };
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

Promise.all([getJSON("data/dams_meta.json"), getJSON("data/scenarios.json")])
  .then(([meta, scenarios]) => {
    st.meta = meta;
    const t = params.get("t");
    return timeline($("#timeline"), scenarios, { scn: params.get("scn") || scenarios.find((s) => s.id === "20200808")?.id || scenarios[0].id, t: t == null ? null : Number(t) }, onTime);
  })
  .catch((e) => {
    $("#answer-title").textContent = "자료를 불러오지 못했어요";
    console.error(e);
  })
  .finally(() => $("#app").setAttribute("aria-busy", "false"));

function assessAll() {
  return Object.keys(st.data.dams)
    .filter((code) => judgeable(st.meta[code]))
    .map((code) => ({ code, dam: st.meta[code], a: assess(st.meta[code], st.data.dams[code], st.i, st.data.ts[st.i]) }))
    .filter((r) => r.a)
    .sort((x, y) => SEVERITY[x.a.status] - SEVERITY[y.a.status] || (x.a.toPlan ?? 99) - (y.a.toPlan ?? 99) || (x.a.toGuide ?? 99) - (y.a.toGuide ?? 99));
}

function onTime(scn, data, i) {
  stopPreview();
  st.scn = scn;
  st.data = data;
  st.i = i;
  const all = assessAll();
  if (!all.some((r) => r.code === st.dam)) st.dam = all[0] && all[0].code;
  history.replaceState(null, "", `?scn=${scn.id}&dam=${st.dam}&t=${i}${theme ? `&theme=${theme}` : ""}`);
  render(all);
}

function render(all = assessAll()) {
  const row = all.find((r) => r.code === st.dam);
  if (!row) {
    $("#answer-title").textContent = "이 시점에는 계산할 수 있는 자료가 부족해요";
    return;
  }
  const { dam, a } = row;
  const series = st.data.dams[st.dam];
  $("#dam-name").textContent = `${dam.name}${dam.kind === "댐" ? "댐" : ""}`;
  $("#dam-sub").textContent = `${basinOf(dam)} · 계획홍수위 ${n(dam.plan, 1)}m`;
  $("#dam-st").innerHTML = `<span class="st ${a.status}">${STATUS[a.status].label}</span>`;
  renderAnswer(dam, a);
  drawDam(dam, a, series);
  levelChart($("#lvl"), dam, series, st.i, {
    guide: a.guide,
    list: [
      { values: a.keep, color: "var(--text3)", dash: "5 4" },
      { values: a.plan, color: "var(--blue)", width: 2.5 },
      { values: a.actualL, color: "var(--text)", dash: "1 3", width: 2 },
    ],
  });
  const crossed = a.actualMax >= dam.plan;
  $("#actual").textContent = a.actualOavg == null
    ? ""
    : `실제로는 그 뒤 12시간 동안 1초에 평균 ${n(a.actualOavg)}톤을 내보냈고, 수위는 최고 ${n(a.actualMax, 2)}m였어요. 계획홍수위를 ${crossed ? "넘었어요" : "넘지 않았어요"}.`;
}

function renderAnswer(dam, a) {
  const keepMax = Math.max(...a.keep);
  let title, sub;
  if (a.enough) {
    title = `지금 내보내는 양이면 <em>충분해요</em>`;
    sub = `1초에 ${n(a.O0)}톤씩 지금처럼 내보내면 12시간 동안 수위가 최고 ${n(keepMax, 2)}m로 ${a.guide.name}(${n(a.guide.level, 1)}m) 근처에서 지켜져요.`;
  } else {
    title = `지금부터 12시간 동안 1초에 <em class="${a.status === "danger" ? "bad" : ""}">${n(a.q)}톤씩</em> 내보내야 해요`;
    sub = `지금은 1초에 ${n(a.O0)}톤 내보내고 있어요. 1초에 ${n(a.extra)}톤씩 더, 12시간 동안 모두 ${tons(a.totalTon)}이에요.`;
  }
  $("#answer-title").innerHTML = title;
  $("#answer-sub").textContent = sub;
  $("#answer-warn").innerHTML = a.overCapacity
    ? `<p class="warnline">이 댐이 2006년 이후 가장 많이 내보낸 양은 1초에 ${n(dam.omax)}톤이에요. 계산값이 그보다 커서, 지금 시작하면 늦어요. 더 일찍 내보내기 시작했어야 해요.</p>`
    : "";
  const keepText = a.toPlan != null ? (a.toPlan === 0 ? "이미 계획홍수위 위" : `${a.toPlan}시간 뒤 계획홍수위 넘음`) : a.toGuide != null ? (a.toGuide === 0 ? `이미 ${a.guide.name} 위` : `${a.toGuide}시간 뒤 ${a.guide.name} 넘음`) : "기준 아래 유지";
  $("#kpis").innerHTML = `
    <div><b>${n(a.L0, 2)}m</b><span>지금 수위</span></div>
    <div><b class="${a.toPlan != null ? "bad" : ""}">${n(keepMax, 2)}m</b><span>지금처럼 두면 12시간 안 최고 · ${keepText}</span></div>
    <div><b>${tons(a.totalTon)}</b><span>계산대로 12시간 동안 내보낼 양</span></div>`;
}

/* ── 댐 단면 그림: 물 높이·들어오는 물·내보내는 물·비가 움직인다. 세로는 기준선 근처를 확대해 보여 준다 ── */
let anim = null;
function drawDam(dam, a, series) {
  const W = 340, H = 200, BOT = 186, TOP = 26;
  const span = Math.max(1, dam.plan - a.guide.level);
  const lvMin = Math.min(a.guide.level, a.L0, ...a.keep, ...a.plan) - Math.max(2, span * 0.8);
  const lvMax = Math.max(dam.plan, ...a.keep) + Math.max(1, span * 0.4);
  const y = (L) => BOT - ((BOT - TOP) * (L - lvMin)) / (lvMax - lvMin);
  if (!anim || anim.code !== dam.code || anim.key !== `${lvMin}|${lvMax}`) {
    const yp = y(dam.plan), yg = y(a.guide.level);
    const thr = [[yp, `계획홍수위 ${n(dam.plan, 1)}m`, "var(--bad)", -5], [yg, `${a.guide.name} ${n(a.guide.level, 1)}m`, "var(--warn)", yg - yp < 16 ? 13 : -5]];
    const crestY = Math.max(TOP - 8, y(dam.crest ?? dam.plan + 1));
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
      <text class="lv" x="244" y="0" text-anchor="end"></text>
    </svg>`;
    anim = { code: dam.code, key: `${lvMin}|${lvMax}`, y, water: $("#anim .water"), lv: $("#anim .lv"),
      inflow: [...document.querySelectorAll("#anim .inflow")], outflow: [...document.querySelectorAll("#anim .outflow")], rain: $("#anim .rain") };
  }
  setDam(dam, a.L0, series.I[st.i], a.O0, series.R[st.i], "지금");
}

function setDam(dam, level, inflow, outflow, rain, label) {
  const yy = anim.y(level);
  anim.water.style.transform = `translateY(${yy}px)`;
  anim.lv.setAttribute("y", String(yy - 7));
  anim.lv.textContent = `${n(level, 2)}m`;
  const flowStyle = ([base, top], q) => {
    const r = Math.min(1, Math.max(0, (q || 0) / Math.max(dam.omax, 1)));
    base.style.strokeWidth = `${3 + 12 * Math.sqrt(r)}`;
    top.style.setProperty("--dur", `${(2.2 - 1.8 * r).toFixed(2)}s`);
    base.style.opacity = q > 0 ? "0.35" : "0.08";
    top.style.opacity = q > 0 ? "1" : "0";
  };
  flowStyle(anim.inflow, inflow);
  flowStyle(anim.outflow, outflow);
  anim.rain.style.opacity = String(Math.min(1, (rain || 0) / 8));
  $("#anim-cap").innerHTML = `<b>${esc(label)}</b> · 들어오는 물 1초에 ${n(inflow)}톤 · 내보내는 물 ${n(outflow)}톤${rain ? ` · 비 ${n(rain, 1)}mm` : ""}`;
}

/* 12시간 미리 보기: 고른 방식의 수위 경로를 한 시간씩 움직인다 */
function stopPreview() {
  clearInterval(st.previewTimer);
  st.previewTimer = 0;
  $("#preview").textContent = "12시간 미리 보기";
}
$("#preview").addEventListener("click", () => {
  if (st.previewTimer) return stopPreview();
  const dam = st.meta[st.dam], series = st.data.dams[st.dam];
  const a = assess(dam, series, st.i, st.data.ts[st.i]);
  if (!a) return;
  const path = st.mode === "keep" ? a.keep : st.mode === "plan" ? a.plan : a.actualL;
  const out = (k) => (st.mode === "keep" ? a.O0 : st.mode === "plan" ? Math.max(a.q, a.O0) : series.O[st.i + k]);
  const inflow = (k) => (st.mode === "actual" ? series.I[st.i + k] : a.inflow[k - 1]);
  let k = 0;
  const step = () => {
    k += 1;
    if (k > HORIZON || path[k - 1] == null) return stopPreview();
    setDam(dam, path[k - 1], inflow(k), out(k), st.mode === "actual" ? series.R[st.i + k] : 0, `+${k}시간`);
  };
  if (REDUCED) {
    k = HORIZON - 1;
    return step();
  }
  $("#preview").textContent = "멈추기";
  step();
  st.previewTimer = setInterval(step, 500);
});

$("#mode").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]");
  if (!b) return;
  st.mode = b.dataset.mode;
  $("#mode").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  stopPreview();
  render();
});

/* 댐 고르기: 이 시점에 급한 순서로 */
$("#dam-btn").addEventListener("click", (e) => {
  const all = assessAll();
  damSheet.body.innerHTML = `<div class="hd"><h3>어느 댐을 볼까요</h3><p class="sub">${esc(fmtTs(st.data.ts[st.i]))} 기준, 급한 순서예요.</p></div>
    <ul class="list">${all
      .map(({ code, dam, a }) => {
        const when = a.toPlan != null ? `${a.toPlan}시간 뒤 계획홍수위` : a.toGuide != null ? `${a.toGuide}시간 뒤 ${a.guide.name}` : "기준 아래";
        return `<li><button class="row" data-code="${esc(code)}"><span><span class="name">${esc(dam.name)}</span><span class="meta">${esc(basinOf(dam))} · ${esc(when)}</span></span><span class="st ${a.status}">${STATUS[a.status].label}</span>${CHEVRON}</button></li>`;
      })
      .join("")}</ul>`;
  damSheet.open(e.currentTarget);
});
damSheet.body.addEventListener("click", (e) => {
  const b = e.target.closest("[data-code]");
  if (!b) return;
  st.dam = b.dataset.code;
  damSheet.close();
  history.replaceState(null, "", `?scn=${st.scn.id}&dam=${st.dam}&t=${st.i}${theme ? `&theme=${theme}` : ""}`);
  render();
});
