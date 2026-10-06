"use strict";
/* 재난 상황판: 고른 시점에 모든 댐을 판정하고, 급한 곳부터 보여 준다 */

const st = { meta: null, scn: null, data: null, i: 0, rows: [], tanksFor: null, deep: new URLSearchParams(location.search).get("dam") };
const damSheet = sheet("#dam-sheet");
const msgSheet = sheet("#send-sheet");
const scores = {};

boot(onTime, () => ($("#al-title").textContent = "자료를 불러오지 못했어요"));

function onTime(meta, scn, data, i) {
  Object.assign(st, { meta, scn, data, i });
  st.rows = assessScenario(meta, data, i);
  setUrl({ scn: scn.id, t: i });
  const known = st.rows.filter((r) => r.a);
  const count = (s) => known.filter((r) => r.a.status === s).length;
  const danger = count("danger"), warn = count("warn"), gap = st.rows.length - known.length;
  const when = esc(fmtTs(data.ts[i]));
  $("#al-title").innerHTML = danger
    ? `${when} 기준, 12시간 안에 넘칠 위험이 있는 곳 <em class="bad-text">${danger}곳</em>`
    : warn
      ? `${when} 기준, 위험한 곳은 없지만 <em class="warn-text">${warn}곳</em>은 지켜봐야 해요`
      : `${when} 기준, 모든 댐이 기준 아래예요`;
  $("#sum").innerHTML = ["danger", "warn", "ok"].map((s) => `<div class="${s}"><b>${count(s)}곳</b><span>${STATUS[s].label}</span></div>`).join("");
  $("#sum-note").textContent = gap ? `이 시각 자료가 빈 ${gap}곳은 빼고 셌어요.` : "";
  $("#send").hidden = danger === 0;
  renderUrgent();
  renderRivers();
  renderCheck();
  watchCheckAll();
  if (st.deep) {                                            // 공유 링크 ?dam=코드: 처음 한 번만 그 댐을 연다
    openDam(st.deep, $(`.tank[data-code="${CSS.escape(st.deep)}"]`));
    st.deep = null;
  }
}

const frac = (dam, L) => Math.max(0, Math.min(1, (L - lowOf(dam)) / (dam.plan - lowOf(dam))));

function renderUrgent() {
  const rows = st.rows.filter((r) => r.a && r.a.status !== "ok").slice(0, 10);
  $("#urgent").innerHTML = rows.length
    ? rows
        .map(({ code, dam, a }) => `<li><button class="urow" data-code="${esc(code)}">
          <span><span class="name">${esc(damName(dam))}</span><span class="meta">${esc(basinOf(dam))} · ${esc(whenText(a))}</span></span>
          <span class="st ${a.status}">${STATUS[a.status].label}</span>
          <span class="gauge" aria-hidden="true"><i style="transform:scaleX(${frac(dam, a.L0)})"></i><u style="left:${frac(dam, a.keepMax) * 100}%"></u><s></s></span>
          <span class="nums">지금 ${n(a.L0, 1)}m → 12시간 안 최고 ${n(a.keepMax, 1)}m · 계획홍수위 ${n(dam.plan, 1)}m</span></button></li>`)
        .join("")
    : `<li class="foot">지금은 급한 곳이 없어요.</li>`;
}

/* 강 줄기별 물탱크: 시나리오가 바뀔 때만 새로 그리고, 시간이 바뀌면 물 높이와 예상 최고 선만 움직인다 */
function renderRivers() {
  if (st.tanksFor !== st.scn.id) {
    const groups = {};
    st.rows.forEach((r) => (groups[basinOf(r.dam)] ||= []).push(r.code));
    $("#rivers").innerHTML = Object.entries(groups)
      .sort((x, y) => y[1].length - x[1].length)
      .map(([river, codes]) => `<div class="river"><h3>${esc(river)} <span class="muted">${codes.length}곳</span></h3><div class="tanks">${codes
        .sort((x, y) => st.meta[x].name.localeCompare(st.meta[y].name, "ko"))
        .map((c) => `<button class="tank" data-code="${esc(c)}"><span class="fill"></span><span class="peak"></span><span class="cap"></span><b>${esc(st.meta[c].name)}</b><span class="lvl"></span><span class="stw"></span></button>`)
        .join("")}</div></div>`)
      .join("");
    st.tanksFor = st.scn.id;
  }
  const byCode = Object.fromEntries(st.rows.map((r) => [r.code, r]));
  document.querySelectorAll(".tank").forEach((el) => {
    const r = byCode[el.dataset.code];
    el.classList.remove("danger", "warn", "ok");
    el.disabled = !r || !r.a;
    if (el.disabled) {
      $(".fill", el).style.transform = "scaleY(0)";
      $(".peak", el).style.opacity = "0";
      $(".lvl", el).textContent = "자료 없음";
      $(".stw", el).textContent = "";
      el.setAttribute("aria-label", `${st.meta[el.dataset.code].name}, 이 시각 자료 없음`);
      return;
    }
    const { dam, a } = r;
    el.classList.add(a.status);
    $(".fill", el).style.transform = `scaleY(${frac(dam, a.L0)})`;
    $(".peak", el).style.opacity = "1";
    $(".peak", el).style.transform = `translateY(${(1 - frac(dam, a.keepMax)) * 100}%)`;
    $(".lvl", el).textContent = `${n(a.L0, 1)}m`;
    $(".stw", el).textContent = STATUS[a.status].label;
    el.setAttribute("aria-label", `${dam.name} ${STATUS[a.status].label}, 지금 수위 ${n(a.L0, 1)}m, 12시간 안 예상 최고 ${n(a.keepMax, 1)}m`);
  });
}

/* ── 이 판정, 맞았을까 ──
   "위험"은 "방류를 그대로 두면"이라는 가정이라, 실제로 넘쳤는지만 세면 운영자가 막은 경우가 틀림이 된다.
   그래서 운영자 개입에 흔들리지 않는 값(계산 오차·예측 포함 오차·선행 시간)을 먼저 보여 주고, 넘침 채점은 참고로 둔다.
   계산은 common.js의 scoreScenario 한 곳에서만 한다(보고서 report_dash/validity.js도 같은 함수를 쓴다) */
const idle = () => new Promise((ok) => setTimeout(ok, 0));   // 시나리오 사이에 한 번씩 화면에 양보한다
const scoreOf = (id) => (scores[id] ||= getJSON(`data/scn_${id}.json`).then(async (d) => {
  await idle();
  return scoreScenario(st.meta, d);
}).catch((e) => {
  delete scores[id];
  throw e;
}));
const pct = (a, b) => (b ? `${n((a / b) * 100)}%` : "–");
const cm = (acc) => (acc[1] ? `${n((acc[0] / acc[1]) * 100)}cm` : "–");
const hrs = (v) => `${n(v, Number.isInteger(v) ? 0 : 1)}시간`;
const leadText = (c) => (c.leads.length ? `가운데 ${hrs(median(c.leads))} 앞` : "먼저 알린 때 없음");
function addScore(t, c) {
  for (const [k, v] of Object.entries(c)) {
    if (k.startsWith("leads")) t[k] = (t[k] || []).concat(v);
    else if (Array.isArray(v)) t[k] = (t[k] || [0, 0]).map((x, j) => x + v[j]);
    else t[k] = (t[k] || 0) + v;
  }
  return t;
}

function renderCheck() {
  const id = st.scn.id;
  scoreOf(id).then((c) => {
    if (st.scn.id !== id) return;
    const judged = c.opsWarned + c.opsSilent;
    $("#check-sub").textContent = `${st.scn.title}의 모든 시각으로 되감아 봤어요. “위험”은 지금 방류를 그대로 둔다는 가정이라, 실제로 넘쳤는지만 보면 운영자가 방류를 늘려 막은 경우가 틀림으로 세어져요. 그래서 운영자 손길에 흔들리지 않는 값으로 채점했어요.`;
    $("#check").innerHTML = `
      <div><b>${cm(c.eng)}</b><span>실제로 들어오고 나간 물을 넣었을 때 12시간 최고 수위 오차 (계산만 시험)</span></div>
      <div><b>${cm(c.fc)}</b><span>방류는 실제, 유입은 예측일 때 오차 · 물이 불어날 때 ${cm(c.fcBig)}</span></div>
      <div><b>${n(c.opsWarned)}/${n(judged)}번</b><span>운영자가 방류를 크게 늘리기 전에 경계·위험을 낸 횟수 · ${leadText(c)}</span></div>`;
    $("#check-note").textContent = `참고로 실제로 계획홍수위에 닿았는지로 세면, “위험” ${n(c.tp + c.fp)}번 중 ${pct(c.tp, c.tp + c.fp)}가 닿았고 실제로 닿은 ${n(c.tp + c.fn)}번 중 ${pct(c.tp, c.tp + c.fn)}를 미리 알렸어요. 한 댐을 한 시간마다 한 번씩 셌고, 이미 계획홍수위 위였던 ${n(c.already)}번과 자료가 빈 ${n(c.gap)}번은 뺐어요. “크게 늘림” = 정점 48시간 전 방류의 1.2배+10톤 이상, 처음부터 경계·위험이던 ${n(c.ops - judged)}곳은 뺐어요.`;
  }).catch((e) => {
    $("#check-note").textContent = "채점에 필요한 자료를 불러오지 못했어요.";
    console.error(e);
  });
}

/* 여섯 번 모두 채점은 무거우니 그 칸이 화면에 가까워질 때 한 번만(자료를 받은 뒤에 지켜보기 시작한다) */
let watchingAll = false;
function watchCheckAll() {
  if (watchingAll) return;
  watchingAll = true;
  new IntersectionObserver((entries, io) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    renderCheckAll();
  }, { rootMargin: "400px" }).observe($("#check-all"));
}

/* 여섯 번의 큰비 모두: 한 번만 계산해 표로 */
function renderCheckAll() {
  $("#check-all").innerHTML = `<p class="note">여섯 번의 큰비를 모두 채점하고 있어요…</p>`;
  getJSON("data/scenarios.json")
    .then(async (list) => {
      const rows = [];
      for (const s of list) rows.push({ s, c: await scoreOf(s.id) });   // 하나씩: 한꺼번에 돌리면 화면이 멈춘다
      return rows;
    })
    .then((rows) => {
      const sum = rows.reduce((t, { c }) => addScore(t, c), {});
      const tr = (name, c, cls = "") => `<tr class="${cls}"><th scope="row">${esc(name)}</th><td>${cm(c.eng)}</td><td>${cm(c.fc)}</td><td>${n(c.opsWarned)}/${n(c.opsWarned + c.opsSilent)}</td><td>${c.leads.length ? hrs(median(c.leads)) : "–"}</td><td>${pct(c.tp, c.tp + c.fp)}</td></tr>`;
      $("#check-all").innerHTML = `<table class="tbl">
        <caption>여섯 번의 큰비 모두</caption>
        <thead><tr><th scope="col">큰비</th><th scope="col">계산 오차</th><th scope="col">예측 포함</th><th scope="col">먼저 알림</th><th scope="col">얼마나 먼저</th><th scope="col">참고: “위험” → 닿음</th></tr></thead>
        <tbody>${rows.map(({ s, c }) => tr(s.title.replace(" 큰비", ""), c)).join("")}${tr("모두", sum, "total")}</tbody></table>
        <p class="note">${readNote(sum)}</p>`;
    })
    .catch((e) => {
      $("#check-all").innerHTML = `<p class="note">채점에 필요한 자료를 불러오지 못했어요.</p>`;
      console.error(e);
    });
}

/* 숫자가 말하는 만큼만: 오차가 어디서 오나, 헛알림은 왜 생기나 */
function readNote(c) {
  const engE = c.eng[1] ? c.eng[0] / c.eng[1] : null, fcE = c.fc[1] ? c.fc[0] / c.fc[1] : null;
  const where = engE != null && fcE != null && fcE > engE * 2
    ? `계산 자체의 오차는 ${cm(c.eng)}로 작고, 예측을 넣으면 ${cm(c.fc)}로 커져요. 오차는 거의 다 들어올 물 예측에서 나와요.`
    : `계산 오차 ${cm(c.eng)}, 예측을 넣은 오차 ${cm(c.fc)}예요.`;
  const fp = c.fpAdj + c.fpDam;
  const why = fp ? ` 실제로 닿지 않은 “위험” ${n(fp)}번 중 ${n(c.fpAdj)}번은 조정지였어요(작은 저수지라 예측이 조금만 틀려도 계산 수위가 크게 흔들려요). 댐에서 나온 ${n(c.fpDam)}번 중 ${n(c.fpDamActed)}번은 그 뒤 운영자가 방류를 늘렸어요 — 막았기 때문에 안 넘쳤을 수 있어요.` : "";
  const silent = c.opsSilent ? ` 운영자가 방류를 크게 늘린 때 중 ${n(c.opsSilent)}번은 우리 판정이 먼저 알리지 못했어요.` : "";
  return where + why + silent;
}

/* 댐 하나 자세히 */
function openDam(code, from) {
  const r = st.rows.find((x) => x.code === code);
  if (!r || !r.a) return;
  const { dam, a } = r;
  damSheet.body.innerHTML = `
    <div class="hd"><span class="kind">${esc(basinOf(dam))} · ${esc(dam.kind)}</span><h3 id="ds-title">${esc(damName(dam))} <span class="st ${a.status}">${STATUS[a.status].label}</span></h3>
      <p class="sub">${esc(fmtTs(st.data.ts[st.i]))} 기준 · ${esc(whenText(a))}</p></div>
    <div class="kpis"><div><b>${n(a.L0, 2)}m</b><span>지금 수위</span></div><div><b class="${a.status === "danger" ? "bad" : ""}">${n(a.keepMax, 2)}m</b><span>지금처럼 두면 12시간 안 최고</span></div><div><b>${n(dam.plan, 1)}m</b><span>계획홍수위</span></div></div>
    <figure class="chart lvl-chart"></figure>
    <div class="legend2"><span><i style="background:var(--text3)"></i>지금처럼 두면 (예상)</span><span><i class="dot"></i>실제 (되감기라 알 수 있어요)</span></div>
    <a class="btn ghost" href="release.html?${new URLSearchParams({ scn: st.scn.id, dam: code, t: st.i, ...(theme ? { theme } : {}) })}">얼마나 내보내야 했는지 보기</a>`;
  levelChart($(".lvl-chart", damSheet.body), dam, st.data.dams[code], st.i, {
    guide: a.guide,
    list: [{ values: a.keep, color: "var(--text3)", dash: "5 4" }, { values: a.actualL, color: "var(--text)", dash: "1 3" }],
  });
  damSheet.open(from);
}
["#urgent", "#rivers"].forEach((sel) => $(sel).addEventListener("click", (e) => {
  const b = e.target.closest("[data-code]");
  if (b && !b.disabled) openDam(b.dataset.code, b);
}));

/* 알림 문구 만들어 보기: 위험한 댐으로 안내 문구를 만들고 복사만 한다. 어디에도 보내지 않는다 */
$("#send").addEventListener("click", (e) => {
  const danger = st.rows.filter((r) => r.a && r.a.status === "danger");
  const rivers = [...new Set(danger.map((r) => basinOf(r.dam)))];
  const lines = danger.map(({ dam, a }) => `○ ${damName(dam)}: ${a.toPlan === 0 ? "이미 계획홍수위 위" : `${a.toPlan}시간 뒤 계획홍수위(${n(dam.plan, 1)}m) 도달 예상`}`);
  const text = `[모의 안내] ${fmtTs(st.data.ts[st.i])} 기준\n${lines.join("\n")}\n${rivers.join("·")} 하류 하천변에 계신 분은 높은 곳으로 피할 준비를 해 주세요.`;
  msgSheet.body.innerHTML = `
    <div class="hd"><span class="kind">교육용 화면</span><h3 id="ss-title">이런 문구가 나가요</h3><p class="sub">위험한 ${danger.length}곳으로 만든 문구예요. 실제로 보내지 않아요.</p></div>
    <div class="msg">${esc(text)}</div>
    <button class="btn" id="msg-copy">문구 복사하기</button>
    <button class="btn ghost" id="msg-close">닫기</button>`;
  $("#msg-copy").addEventListener("click", () => {
    if (!navigator.clipboard) return toast("이 브라우저에선 복사할 수 없어요. 문구를 길게 눌러 복사해 주세요");
    navigator.clipboard.writeText(text).then(
      () => toast("문구를 복사했어요"),
      () => toast("복사하지 못했어요. 문구를 길게 눌러 복사해 주세요")
    );
  });
  $("#msg-close").addEventListener("click", () => msgSheet.close());
  msgSheet.open(e.currentTarget);
});

let toastTimer = 0;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 2600);
}
