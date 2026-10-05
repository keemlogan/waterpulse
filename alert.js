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

/* ── 이 판정, 맞았을까: 그 시각에 "위험"이라고 했을 때 12시간 안에 실제로 계획홍수위에 닿았나 ──
   한 댐을 한 시간마다 한 번 센다. 이미 넘어 있던 시간은 맞히는 게 아니라서 빼고, 자료가 빈 시간도 뺀다.
   acted: 실제로 넘쳤거나, 그 뒤 12시간 평균 방류를 지금보다 20%+10톤 넘게 늘린 때(운영자가 손을 쓴 때) */
function scoreScenario(meta, data) {
  const c = { tp: 0, fp: 0, fn: 0, tn: 0, already: 0, gap: 0, danger: 0, dangerActed: 0, ok: 0, okActed: 0 };
  for (let i = 0; i + HORIZON < data.ts.length; i++) {
    for (const code of Object.keys(data.dams)) {
      const dam = meta[code];
      if (!judgeable(dam)) continue;
      const a = assess(dam, data.dams[code], i, data.ts[i]);
      if (!a || !a.complete) c.gap++;
      else if (a.L0 >= dam.plan) c.already++;
      else {
        const real = a.actualMax >= dam.plan, acted = real || (a.actualOavg != null && a.actualOavg >= a.O0 * 1.2 + 10);
        c[a.status === "danger" ? (real ? "tp" : "fp") : real ? "fn" : "tn"]++;
        if (a.status !== "warn") {
          c[a.status]++;
          if (acted) c[`${a.status}Acted`]++;
        }
      }
    }
  }
  return c;
}
const idle = () => new Promise((ok) => setTimeout(ok, 0));   // 시나리오 사이에 한 번씩 화면에 양보한다
const scoreOf = (id) => (scores[id] ||= getJSON(`data/scn_${id}.json`).then(async (d) => {
  await idle();
  return scoreScenario(st.meta, d);
}).catch((e) => {
  delete scores[id];
  throw e;
}));
const pct = (a, b) => (b ? `${n((a / b) * 100)}%` : "–");

function renderCheck() {
  const id = st.scn.id;
  scoreOf(id).then((c) => {
    if (st.scn.id !== id) return;
    $("#check-sub").textContent = `${st.scn.title}의 모든 시각으로 되감아 판정하고, 그 뒤 12시간 실제 수위와 맞춰 봤어요.`;
    $("#check").innerHTML = `
      <div><b>${pct(c.tp, c.tp + c.fp)}</b><span>“위험”이라고 한 ${n(c.tp + c.fp)}번 중 실제로 닿은 비율</span></div>
      <div><b>${pct(c.tp, c.tp + c.fn)}</b><span>실제로 닿은 ${n(c.tp + c.fn)}번 중 미리 알린 비율</span></div>
      <div><b>${n(c.fn)}번</b><span>알림 없이 닿은 때</span></div>`;
    $("#check-note").textContent = `한 댐을 한 시간마다 한 번씩 셌어요. 이미 계획홍수위 위였던 ${n(c.already)}번과 자료가 빈 ${n(c.gap)}번은 빼고 셌어요.`;
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
      const sum = rows.reduce((t, { c }) => Object.fromEntries(Object.keys(t).map((k) => [k, t[k] + c[k]])), { tp: 0, fp: 0, fn: 0, danger: 0, dangerActed: 0, ok: 0, okActed: 0 });
      const tr = (name, c, cls = "") => `<tr class="${cls}"><th scope="row">${esc(name)}</th><td>${n(c.tp + c.fp)}</td><td>${pct(c.tp, c.tp + c.fp)}</td><td>${n(c.tp + c.fn)}</td><td>${pct(c.tp, c.tp + c.fn)}</td></tr>`;
      $("#check-all").innerHTML = `<table class="tbl">
        <caption>여섯 번의 큰비 모두 (댐×시간)</caption>
        <thead><tr><th scope="col">큰비</th><th scope="col">“위험”</th><th scope="col">맞음</th><th scope="col">실제 닿음</th><th scope="col">미리 알림</th></tr></thead>
        <tbody>${rows.map(({ s, c }) => tr(s.title.replace(" 큰비", ""), c)).join("")}${tr("모두", sum, "total")}</tbody></table>
        <p class="note">${actedNote(sum)}</p>`;
    })
    .catch((e) => {
      $("#check-all").innerHTML = `<p class="note">채점에 필요한 자료를 불러오지 못했어요.</p>`;
      console.error(e);
    });
}

/* 넘친 것만이 아니라 "운영자가 손을 쓴 때"까지 넓혀 비교. 숫자가 말하는 만큼만 말한다 */
function actedNote(c) {
  const d = c.danger ? c.dangerActed / c.danger : null, o = c.ok ? c.okActed / c.ok : null;
  const base = `실제로 넘쳤거나 그 뒤 12시간 평균 방류를 지금보다 20%+10톤 넘게 늘린 때까지 넓혀 보면, “위험”이었던 때는 <b>${pct(c.dangerActed, c.danger)}</b>, “정상”이었던 때는 ${pct(c.okActed, c.ok)}였어요.`;
  if (d == null || o == null) return base;
  if (d >= o * 2) return `${base} “위험” 판정이 실제로 손을 써야 했던 때와 꽤 겹친다는 뜻이에요.`;
  if (d > o) return `${base} 차이가 크지 않아, “위험” 판정만으로 손쓸 때를 가려내기엔 부족해요.`;
  return `${base} “위험” 판정이 실제 운영과 거의 맞지 않았어요.`;
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
