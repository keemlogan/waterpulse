import { UPDATED, MIDTERM, FINAL, PHASES, CURRENT, HERO, NOW, RECENT, TASKS, GUIDES, REQS, DOCS, LOG, ALIASES } from "./data.js";

const view = document.getElementById("view");
const ALL = [...TASKS, ...GUIDES];
const byId = Object.fromEntries(ALL.map((t) => [t.id, t]));
const STATUS = { done: "끝남", doing: "진행 중", todo: "할 일", decide: "결정 필요", wait: "대기" };
let status = null;   // status.json (수집 현황)

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "");
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const mdw = (d) => `${md(d)}(${WD[new Date(d + "T12:00:00").getDay()]})`;
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const daysTo = (d) => Math.round((new Date(d + "T00:00:00") - today()) / 86400000);
const dday = (d) => { const n = daysTo(d); return n > 0 ? `D-${n}` : n === 0 ? "D-DAY" : `D+${-n}`; };
const chip = (st) => `<span class="chip ${st}">${STATUS[st]}</span>`;
const num = (n) => n.toLocaleString("ko-KR");
const phaseOf = (t) => PHASES.find((p) => p.id === t.phase);
const tasksOf = (pid) => TASKS.filter((t) => t.phase === pid);
const arrow = `<svg class="arr" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function phaseState(pid) {
  const ts = tasksOf(pid);
  const done = ts.filter((t) => t.status === "done").length;
  const doing = ts.filter((t) => t.status === "doing").length;
  const pct = ((done + doing * 0.5) / ts.length) * 100;   // 진행 중은 반만 친다
  const state = done === ts.length ? "done" : ts.some((t) => t.status === "doing" || t.status === "done") ? "doing" : "wait";
  return { ts, done, doing, pct, state };
}

function setTab(name) {
  document.querySelectorAll(".tabs a").forEach((a) => a.toggleAttribute("aria-current", a.dataset.tab === name));
}

// ───────────── 수집 현황 카드 ─────────────
function collectCard(compact = false, self = false) {
  if (!status) return "";
  const pct = Math.floor((status.files_have / status.files_expected) * 100);
  const rows = status.datasets.map((d) => {
    const p = Math.floor((d.have / d.expected) * 100);
    return `<li><span class="dn">${esc(d.name)}</span><span class="bar sm"><i style="width:${p}%"></i></span><span class="dp">${p}%</span></li>`;
  }).join("");
  return `<section class="card collect">
    <div class="card-head"><h2>원본 수집</h2>${chip(pct >= 100 ? "done" : "doing")}</div>
    <p class="big"><b>${pct}</b><span>%</span></p>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <p class="muted">파일 ${num(status.files_have)} / ${num(status.files_expected)}개 · ${num(Math.round(status.rows / 10000))}만 행 · ${(status.MB / 1000).toFixed(1)}GB · 중복 ${status.dup_files} · 빠짐 ${status.incomplete}</p>
    ${compact ? "" : `<ul class="ds">${rows}</ul>`}
    <p class="foot-note">${esc(status.where)}에서 키 ${status.keys}개로 받는 중 · 예상 완료 <b>${mdw(status.eta)}</b> · ${esc(status.updated)} 기준</p>
    ${compact || self ? "" : `<a class="more" href="#/t/T11">자세히 보기 ${arrow}</a>`}
  </section>`;
}

function taskRow(t, showPhase = false) {
  const p = phaseOf(t);
  const meta = [t.due ? `마감 ${mdw(t.due)}` : "", `담당 ${t.owner || "미정"}`, showPhase && p ? (p.milestone ? p.name : `${p.no}단계 ${p.name}`) : ""].filter(Boolean).join(" · ");
  return `<li><a class="row" href="#/t/${t.id}">
    <div class="row-main">${chip(t.status)}<b>${esc(t.title)}</b><span class="lead2">${esc(t.lead)}</span><span class="meta">${meta}</span></div>${arrow}</a></li>`;
}

// ───────────── 홈 ─────────────
function home() {
  setTab("home");
  const m = MIDTERM;
  const midTasks = tasksOf("m1");
  const midLeft = midTasks.filter((t) => t.status !== "done").length;
  const decide = TASKS.filter((t) => t.status === "decide" && !NOW.includes(t.id));
  const phases = PHASES.filter((p) => !p.milestone).map((p) => {
    const s = phaseState(p.id);
    return `<li><a href="#/roadmap/${p.id}"><span class="pn ${s.state}">${s.state === "done" ? "✓" : p.no}</span><span class="pt">${esc(p.name)}</span><span class="bar sm"><i style="width:${s.pct}%"></i></span><span class="pc">${s.done}/${s.ts.length}</span></a></li>`;
  }).join("");

  view.innerHTML = `
  <section class="hero">
    <p class="eyebrow">${md(UPDATED.slice(0, 10))} 기준</p>
    <h1>${esc(HERO.title)}</h1>
    <p class="sub">${esc(HERO.sub)}</p>
  </section>

  <a class="card deadline" href="#/roadmap/m1">
    <div><p class="eyebrow">다음 마감</p><p class="dl-title">${esc(m.label)} <b>${dday(m.date)}</b></p>
    <p class="muted">${mdw(m.date)} ${m.time} · 남은 일 ${midLeft}개 · 늦은 제출 불가</p></div>${arrow}
  </a>

  ${collectCard()}

  <section class="block">
    <h2 class="bh">지금 할 일</h2>
    <ul class="list">${NOW.map((id) => taskRow(byId[id], true)).join("")}</ul>
  </section>

  ${decide.length ? `<section class="block">
    <h2 class="bh">그 밖에 결정할 것 <span class="count">${decide.length}</span></h2>
    <ul class="list">${decide.map((t) => taskRow(t, true)).join("")}</ul>
  </section>` : ""}

  <section class="block">
    <h2 class="bh">단계별 진행</h2>
    <ul class="card phases">${phases}</ul>
    <a class="more out" href="#/roadmap">로드맵 전체 보기 ${arrow}</a>
  </section>

  <section class="block">
    <h2 class="bh">최근 소식</h2>
    <ul class="card news">${RECENT.map((r) => `<li><span class="nd">${esc(r.d)}</span><span>${esc(r.t)}</span></li>`).join("")}</ul>
  </section>

  <section class="block">
    <h2 class="bh">우리가 만드는 것</h2>
    <div class="goals">
      <a class="card goal" href="#/t/T60"><span class="eyebrow">최종 목표 ①</span><b>방류 계산기</b><span class="muted">댐 운영자 · 넘치지 않을 최소 방류량</span></a>
      <a class="card goal" href="#/t/T61"><span class="eyebrow">최종 목표 ②</span><b>재난 상황판</b><span class="muted">재난 담당자 · 어느 댐이 위험해지나</span></a>
    </div>
    <a class="more out" href="#/t/G6">자세히 보기 ${arrow}</a>
  </section>`;
}

// ───────────── 로드맵 ─────────────
function roadmap(focus) {
  setTab("roadmap");
  const items = PHASES.map((p) => {
    const s = phaseState(p.id);
    const open = focus ? focus === p.id : CURRENT.includes(p.id);
    const rows = s.ts.map((t) => `<li><a class="trow" href="#/t/${t.id}">${chip(t.status)}<span class="tt">${esc(t.title)}</span><span class="td">${t.due ? md(t.due) : ""}</span>${arrow}</a></li>`).join("");
    return `<li class="step ${s.state}${p.milestone ? " ms" : ""}" id="${p.id}">
      <details ${open ? "open" : ""}>
        <summary>
          <span class="pn ${s.state}">${s.state === "done" ? "✓" : p.no}</span>
          <span class="sm-main"><b>${esc(p.name)}</b><span class="muted">${esc(p.what)}</span><span class="sm-meta">${esc(p.range)} · ${s.done}/${s.ts.length} 끝남</span></span>
          <span class="chev" aria-hidden="true"></span>
        </summary>
        <ul class="tasks">${rows}</ul>
      </details>
    </li>`;
  }).join("");
  view.innerHTML = `
  <section class="page-head">
    <h1>로드맵</h1>
    <p class="sub">단계를 누르면 할 일이 펼쳐져요. 할 일을 누르면 왜·어떻게·다 됐다의 기준이 나와요.</p>
    <div class="pills"><a href="#/t/G2">전체 구조 그림</a><a href="#/t/G3">다운로드한 뒤의 순서</a><a href="#/t/G1">VM 가이드</a></div>
  </section>
  <ol class="steps">${items}</ol>`;
  if (focus) document.getElementById(focus)?.scrollIntoView({ block: "start" });
}

// ───────────── 할 일·가이드 상세 ─────────────
function archFigure() {
  const box = (t, s, cls = "") => `<div class="ab ${cls}"><b>${t}</b>${s ? `<span>${s}</span>` : ""}</div>`;
  const down = (t) => `<div class="aarrow"><span>${t}</span></div>`;
  return `<figure class="arch" aria-label="WaterPulse 전체 구조">
    <p class="alabel">데이터 출처 · 공공 API</p>
    <div class="agrid four">${box("수문 운영 정보", "댐 수위·유입·방류")}${box("우량수위 관측소", "상류 비·강")}${box("제원·댐코드", "계획홍수위·유역")}${box("기상청 ASOS", "강수·기온·습도")}</div>
    ${down("Python 수집기 (맥미니)")}
    <div class="agrid two">${box("원본 파일", "받은 그대로 JSON Lines", "file")}${box("MySQL 기준표", "좌표·관측소 연결·수위 곡선", "db")}</div>
    <div class="agrid two">${down("Flume · hdfs dfs -put")}${down("Sqoop import")}</div>
    <div class="hadoop"><p class="alabel">빅데이터 관리 · 하둡 (수업 VM)</p>
      <div class="shelves">${box("① 원본 선반", "HDFS /etl · Hive 표(STRING)", "shelf")}<i class="sa">Spark 정제</i>${box("② 정리 선반", "Parquet · 연도 파티션 · Impala", "shelf")}<i class="sa">Spark + Python</i>${box("③ 결과 선반", "예측·방류·경보·품질표", "shelf")}</div>
    </div>
    ${down("Sqoop export")}
    <div class="agrid two">${box("MySQL 결과 DB", "forecast · release · alert", "db")}${box("웹 서버", "Flask", "srv")}</div>
    ${down("브라우저")}
    <div class="agrid two">${box("방류 계산기", "댐 운영자", "ui")}${box("재난 상황판", "재난 담당자", "ui")}</div>
  </figure>`;
}

function tableHtml(t) {
  return `<div class="tw"><table><thead><tr>${t.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
    t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function linkCard(l) {
  const ext = !l.href.startsWith("#");
  return `<li><a class="lrow" href="${l.href}"${ext ? ' target="_blank" rel="noopener"' : ""}><span class="kind">${esc(l.kind)}</span><span class="lt"><b>${esc(l.label)}</b>${l.sub ? `<span class="muted">${esc(l.sub)}</span>` : ""}</span>${arrow}</a></li>`;
}

function detail(id) {
  const t = byId[id];
  if (!t) return home();
  const isGuide = id.startsWith("G");
  setTab(isGuide ? "docs" : "roadmap");
  const p = phaseOf(t);
  const siblings = isGuide ? GUIDES : tasksOf(t.phase);
  const i = siblings.indexOf(t);
  const prev = siblings[i - 1], next = siblings[i + 1];
  const sec = (h, body) => (body ? `<section class="sec"><h2>${h}</h2>${body}</section>` : "");
  const crumb = isGuide ? `<a href="#/docs">자료</a><span>가이드</span>` : `<a href="#/roadmap/${t.phase}">로드맵</a><span>${p.milestone ? p.name : `${p.no}단계 · ${esc(p.name)}`}</span>`;

  view.innerHTML = `
  <article class="detail">
    <nav class="crumbs">${crumb}</nav>
    <h1>${esc(t.title)}</h1>
    <div class="dmeta">${t.status ? chip(t.status) : `<span class="chip guide">가이드</span>`}${t.due ? `<span>마감 ${mdw(t.due)} · ${dday(t.due)}</span>` : ""}${isGuide ? "" : `<span>담당 ${esc(t.owner || "미정")}</span>`}</div>
    <p class="lead">${esc(t.lead)}</p>
    ${t.live ? collectCard(false, true) : ""}
    ${t.figure === "arch" ? archFigure() : ""}
    ${sec(isGuide ? "배경" : "왜 하나요", t.why ? `<p>${esc(t.why)}</p>` : "")}
    ${sec(isGuide ? "내용" : "어떻게 하나요", t.how ? `<ol class="how">${t.how.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : "")}
    ${sec("자세히", t.table ? tableHtml(t.table) : "")}
    ${sec("명령 · 설정 예시", t.code ? `<pre><code>${esc(t.code)}</code></pre>` : "")}
    ${sec("다 됐다의 기준", t.done ? `<ul class="check">${t.done.map(([s, ok]) => `<li class="${ok ? "ok" : ""}"><span class="box" aria-label="${ok ? "끝남" : "아직"}">${ok ? "✓" : ""}</span>${esc(s)}</li>`).join("")}</ul>` : "")}
    ${sec("지금 상황", t.now ? `<p class="now">${esc(t.now)}</p>` : "")}
    ${sec("주의할 점", t.traps ? `<ul class="traps">${t.traps.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : "")}
    ${sec("참고 자료", t.links ? `<ul class="list links">${t.links.map(linkCard).join("")}</ul>` : "")}
    <nav class="pager">
      ${prev ? `<a href="#/t/${prev.id}"><span>이전</span>${esc(prev.title)}</a>` : "<span></span>"}
      ${next ? `<a href="#/t/${next.id}" class="nx"><span>다음</span>${esc(next.title)}</a>` : "<span></span>"}
    </nav>
  </article>`;
}

// ───────────── 과제 요구사항 ─────────────
function reqs() {
  setTab("req");
  const groups = REQS.map((g) => `
    <section class="block">
      <h2 class="bh">${esc(g.group)}</h2>
      <ul class="card reqs">${g.items.map((r) => `<li>
        <div class="rq-top">${chip(r.status)}<b>${esc(r.ko)}</b></div>
        <p class="en">${esc(r.en)}</p>
        <p class="where">${r.where.map((w) => `<a href="#/t/${w}">${esc(byId[w]?.title || w)}</a>`).join("")}</p>
      </li>`).join("")}</ul>
    </section>`).join("");
  view.innerHTML = `<section class="page-head"><h1>과제 요구사항</h1><p class="sub">과제 설명서 문장을 쉬운 말로 바꾸고, 어디서 채우는지 연결했어요.</p></section>${groups}`;
}

// ───────────── 자료 ─────────────
function docs() {
  setTab("docs");
  view.innerHTML = `<section class="page-head"><h1>자료</h1><p class="sub">가이드, 보고서, 시제품, 코드를 한곳에 모았어요.</p></section>
  ${DOCS.map((d) => `<section class="block"><h2 class="bh">${esc(d.title)}</h2><ul class="list links">${d.items.map(linkCard).join("")}</ul></section>`).join("")}
  <section class="block"><h2 class="bh">진행 기록</h2><ul class="card news">${LOG.map(([d, t]) => `<li><span class="nd">${esc(d)}</span><span>${esc(t)}</span></li>`).join("")}</ul></section>`;
}

// ───────────── 주소 ─────────────
function route() {
  let h = location.hash || "#/";
  const old = h.match(/^#\/r\/([^/]+)/) || h.match(/^#([a-z0-9]+)$/);
  if (old && ALIASES[old[1]]) { location.replace(ALIASES[old[1]]); return; }
  let m;
  if ((m = h.match(/^#\/t\/([A-Z0-9]+)/))) detail(m[1]);
  else if ((m = h.match(/^#\/roadmap(?:\/(\w+))?/))) roadmap(m[1]);
  else if (h.startsWith("#/req")) reqs();
  else if (h.startsWith("#/docs")) docs();
  else home();
  if (!h.match(/^#\/roadmap\/\w+/)) window.scrollTo(0, 0);
  view.focus({ preventScroll: true });
}

document.getElementById("d-mid").textContent = `중간 ${dday(MIDTERM.date)}`;
document.getElementById("d-fin").textContent = `최종 ${dday(FINAL.date)}`;
window.addEventListener("hashchange", route);
fetch("status.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  .then((s) => { status = s; route(); });
