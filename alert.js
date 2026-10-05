"use strict";
/* 재난 상황판: 고른 시점에 모든 댐을 판정하고, 급한 곳부터 보여 준다 */

const params = new URLSearchParams(location.search);
const st = { meta: null, scn: null, data: null, i: 0, rows: [], tanksFor: null };
const damSheet = sheet("#dam-sheet");
const sendSheet = sheet("#send-sheet");
const SEVERITY = { danger: 0, warn: 1, ok: 2 };
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const checks = {};

Promise.all([getJSON("data/dams_meta.json"), getJSON("data/scenarios.json")])
  .then(([meta, scenarios]) => {
    st.meta = meta;
    const t = params.get("t");
    return timeline($("#timeline"), scenarios, { scn: params.get("scn") || scenarios.find((s) => s.id === "20200808")?.id || scenarios[0].id, t: t == null ? null : Number(t) }, onTime);
  })
  .catch((e) => {
    $("#al-title").textContent = "자료를 불러오지 못했어요";
    console.error(e);
  })
  .finally(() => $("#app").setAttribute("aria-busy", "false"));

function assessAt(i) {
  return Object.keys(st.data.dams)
    .filter((code) => judgeable(st.meta[code]))
    .map((code) => ({ code, dam: st.meta[code], a: assess(st.meta[code], st.data.dams[code], i, st.data.ts[i]) }))
    .filter((r) => r.a)
    .sort((x, y) => SEVERITY[x.a.status] - SEVERITY[y.a.status] || (x.a.toPlan ?? 99) - (y.a.toPlan ?? 99) || (x.a.toGuide ?? 99) - (y.a.toGuide ?? 99));
}

function onTime(scn, data, i) {
  st.scn = scn;
  st.data = data;
  st.i = i;
  st.rows = assessAt(i);
  history.replaceState(null, "", `?scn=${scn.id}&t=${i}${theme ? `&theme=${theme}` : ""}`);
  const count = (s) => st.rows.filter((r) => r.a.status === s).length;
  const danger = count("danger"), warn = count("warn");
  $("#al-title").innerHTML = danger
    ? `${esc(fmtTs(data.ts[i]))} 기준, 12시간 안에 넘칠 위험이 있는 곳 <em class="bad-text">${danger}곳</em>`
    : warn
      ? `${esc(fmtTs(data.ts[i]))} 기준, 위험한 곳은 없지만 <em class="warn-text">${warn}곳</em>은 지켜봐야 해요`
      : `${esc(fmtTs(data.ts[i]))} 기준, 모든 댐이 기준 아래예요`;
  $("#sum").innerHTML = ["danger", "warn", "ok"].map((s) => `<div class="${s}"><b>${count(s)}</b><span>${STATUS[s].label}</span></div>`).join("");
  $("#send").hidden = danger === 0;
  renderUrgent();
  renderRivers();
  renderCheck();
  if (params.get("dam")) {           // 공유 링크: ?dam=코드면 그 댐을 바로 연다(처음 한 번만)
    openDam(params.get("dam"), null);
    params.delete("dam");
  }
}

const lowOf = (dam) => dam.low ?? dam.curve[0][1];
const frac = (dam, L) => Math.max(0, Math.min(1, (L - lowOf(dam)) / (dam.plan - lowOf(dam))));
const whenText = (a) =>
  a.toPlan != null ? (a.toPlan === 0 ? "이미 계획홍수위 위" : `${a.toPlan}시간 뒤 계획홍수위`) : a.toGuide != null ? (a.toGuide === 0 ? `이미 ${a.guide.name} 위` : `${a.toGuide}시간 뒤 ${a.guide.name}`) : "기준 아래";

function renderUrgent() {
  const rows = st.rows.filter((r) => r.a.status !== "ok").slice(0, 10);
  $("#urgent").innerHTML = rows.length
    ? rows
        .map(({ code, dam, a }) => {
          const peak = Math.max(...a.keep);
          return `<li><button class="urow" data-code="${esc(code)}"><span><span class="name">${esc(dam.name)}</span><span class="meta">${esc(basinOf(dam))} · 지금 ${n(a.L0, 2)}m → 최고 ${n(peak, 2)}m</span></span>
            <span class="st ${a.status}">${esc(whenText(a))}</span>
            <span class="gauge" aria-hidden="true"><i style="transform:scaleX(${frac(dam, a.L0)})"></i><u style="left:${frac(dam, peak) * 100}%"></u><s></s></span></button></li>`;
        })
        .join("")
    : `<li class="foot" style="padding:8px 24px">지금은 급한 곳이 없어요.</li>`;
}

/* 강 줄기별 물탱크: 시나리오가 바뀔 때만 새로 그리고, 시간이 바뀌면 물 높이만 움직인다 */
function renderRivers() {
  if (st.tanksFor !== st.scn.id) {
    const groups = {};
    Object.keys(st.data.dams).filter((c) => judgeable(st.meta[c])).forEach((c) => (groups[basinOf(st.meta[c])] ||= []).push(c));
    $("#rivers").innerHTML = Object.entries(groups)
      .sort((x, y) => y[1].length - x[1].length)
      .map(([river, codes]) => `<div class="river"><h3>${esc(river)} <span class="muted">${codes.length}곳</span></h3><div class="tanks">${codes
        .map((c) => `<button class="tank" data-code="${esc(c)}"><span class="fill"></span><span class="cap"></span><b>${esc(st.meta[c].name)}</b><span class="lvl"></span></button>`)
        .join("")}</div></div>`)
      .join("");
    st.tanksFor = st.scn.id;
  }
  const byCode = Object.fromEntries(st.rows.map((r) => [r.code, r]));
  document.querySelectorAll(".tank").forEach((el) => {
    const r = byCode[el.dataset.code];
    el.classList.remove("danger", "warn", "ok");
    if (!r) {
      $(".lvl", el).textContent = "자료 없음";
      $(".fill", el).style.transform = "scaleY(0)";
      return;
    }
    el.classList.add(r.a.status);
    $(".fill", el).style.transform = `scaleY(${frac(r.dam, r.a.L0)})`;
    $(".lvl", el).textContent = `${n(frac(r.dam, r.a.L0) * 100)}% · ${STATUS[r.a.status].label}`;
    el.setAttribute("aria-label", `${r.dam.name} ${STATUS[r.a.status].label}, 지금 수위 ${n(r.a.L0, 2)}m`);
  });
}

/* 이 시나리오의 모든 시간에 대해: "위험"이라고 했을 때 실제로 계획홍수위에 닿았나 */
function renderCheck() {
  const c = checks[st.scn.id] || (checks[st.scn.id] = scoreScenario());
  $("#check-sub").textContent = `${st.scn.title}의 모든 시간을 되돌려 보고, 12시간 뒤 실제 수위와 맞춰 봤어요.`;
  $("#check").innerHTML = `
    <div><b>${c.tp + c.fp ? n((c.tp / (c.tp + c.fp)) * 100) + "%" : "–"}</b><span>“위험”이라고 한 때 실제로 닿은 비율</span></div>
    <div><b>${c.tp + c.fn ? n((c.tp / (c.tp + c.fn)) * 100) + "%" : "–"}</b><span>실제로 닿은 때 미리 알린 비율</span></div>
    <div><b>${n(c.fn)}번</b><span>알림 없이 닿은 때 (댐×시간)</span></div>`;
  $("#check-note").textContent = c.tp + c.fn === 0
    ? "이 큰비 동안 계획홍수위에 실제로 닿은 댐은 없었어요."
    : "“위험”인데 닿지 않은 경우엔 실제로 방류를 늘려 수위를 낮췄을 수 있어요. 이 판정은 지금 방류량이 그대로라고 가정해요.";
}

function scoreScenario() {
  const c = { tp: 0, fp: 0, fn: 0 };
  for (let i = 0; i + HORIZON < st.data.ts.length; i++) {
    for (const code of Object.keys(st.data.dams)) {
      const dam = st.meta[code];
      if (!judgeable(dam)) continue;
      const a = assess(dam, st.data.dams[code], i, st.data.ts[i]);
      if (!a || a.actualL.some((v) => v == null)) continue;
      const pred = a.status === "danger", real = a.L0 >= dam.plan || a.actualMax >= dam.plan;
      if (pred && real) c.tp++;
      else if (pred) c.fp++;
      else if (real) c.fn++;
    }
  }
  return c;
}

/* 댐 하나 자세히 */
function openDam(code, from) {
  const r = st.rows.find((x) => x.code === code);
  if (!r) return;
  const { dam, a } = r;
  const series = st.data.dams[code];
  damSheet.body.innerHTML = `
    <div class="hd"><span class="kind">${esc(basinOf(dam))} · ${esc(dam.kind)}</span><h3 id="ds-title">${esc(dam.name)} <span class="st ${a.status}">${STATUS[a.status].label}</span></h3>
      <p class="sub">${esc(fmtTs(st.data.ts[st.i]))} 기준 · ${esc(whenText(a))}</p></div>
    <div class="kpis"><div><b>${n(a.L0, 2)}m</b><span>지금 수위</span></div><div><b class="${a.status === "danger" ? "bad" : ""}">${n(Math.max(...a.keep), 2)}m</b><span>12시간 안 예상 최고</span></div><div><b>${n(dam.plan, 1)}m</b><span>계획홍수위</span></div></div>
    <figure class="chart lvl-chart"></figure>
    <div class="legend2"><span><i style="background:var(--text3)"></i>지금처럼 두면 (예상)</span><span><i style="background:var(--text)"></i>실제</span></div>
    <a class="btn ghost" href="release.html?scn=${esc(st.scn.id)}&dam=${esc(code)}&t=${st.i}${theme ? `&theme=${theme}` : ""}" style="text-decoration:none">방류 계산기로 보기</a>`;
  levelChart($(".lvl-chart", damSheet.body), dam, series, st.i, {
    guide: a.guide,
    list: [{ values: a.keep, color: "var(--text3)", dash: "5 4" }, { values: a.actualL, color: "var(--text)", dash: "1 3" }],
  });
  damSheet.open(from);
}
$("#urgent").addEventListener("click", (e) => {
  const b = e.target.closest("[data-code]");
  if (b) openDam(b.dataset.code, b);
});
$("#rivers").addEventListener("click", (e) => {
  const b = e.target.closest("[data-code]");
  if (b) openDam(b.dataset.code, b);
});

/* 긴급 알림(모의): 보낼 문구를 미리 보여 주고, 실제로는 보내지 않는다 */
$("#send").addEventListener("click", (e) => {
  const danger = st.rows.filter((r) => r.a.status === "danger");
  const rivers = [...new Set(danger.map((r) => basinOf(r.dam)))];
  const lines = danger.map(({ dam, a }) => `○ ${dam.name}: ${a.toPlan === 0 ? "이미 계획홍수위 위" : `${a.toPlan}시간 뒤 계획홍수위(${n(dam.plan, 1)}m) 도달 예상`}`);
  sendSheet.body.innerHTML = `
    <div class="hd"><span class="kind">모의 발송</span><h3 id="ss-title">이렇게 보낼까요</h3><p class="sub">실제로 보내지지 않아요. 문구만 미리 만들어 봐요.</p></div>
    <div class="msg">[WaterPulse 모의 안내] ${esc(fmtTs(st.data.ts[st.i]))} 기준\n${esc(lines.join("\n"))}\n${esc(rivers.join("·"))} 하류 하천변에 계신 분은 높은 곳으로 피할 준비를 해 주세요.</div>
    <button class="btn danger" id="send-go">모의로 보내기</button>
    <button class="btn ghost" id="send-cancel">닫기</button>`;
  $("#send-go").addEventListener("click", () => {
    sendSheet.close();
    toast(`${danger.length}곳 안내를 모의로 보냈어요. 실제로 보내지 않았어요.`);
  });
  $("#send-cancel").addEventListener("click", () => sendSheet.close());
  sendSheet.open(e.currentTarget);
});

let toastTimer = 0;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 2600);
}
