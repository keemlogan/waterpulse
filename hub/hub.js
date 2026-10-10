import { GROUPS, ITEMS, FLOW, SCHEDULE, UPDATED, MIDTERM, FINAL } from "./data.js";

const view = document.getElementById("view");
const STATUS = { done: "끝남", doing: "진행 중", todo: "할 일", decide: "팀 결정 필요" };
const KIND = { pdf: "문서", app: "화면", code: "코드", ext: "외부 링크" };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "");
const day = (d) => new Date(d + "T00:00:00+09:00");
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const dday = (iso) => Math.round((day(iso.slice(0, 10)) - today()) / 86400000);
const badge = (st) => `<span class="st ${st}">${STATUS[st]}</span>`;

function masthead() {
  const count = (st) => ITEMS.filter((i) => i.status === st).length;
  const dm = dday(MIDTERM), df = dday(FINAL);
  document.getElementById("facts").innerHTML =
    `<span>중간발표까지 <b>${dm > 0 ? `D-${dm}` : dm === 0 ? "D-DAY" : "끝남"}</b></span>` +
    `<span>최종발표까지 <b>D-${Math.max(df, 0)}</b></span>` +
    `<span>할 일 <b>${count("todo")}</b> · 진행 중 <b>${count("doing")}</b> · 팀 결정 <b>${count("decide")}</b> · 끝남 <b>${count("done")}</b></span>` +
    `<span class="upd">내용 기준일 ${UPDATED}</span>`;
}

// 전체 구조 그림. 상자 = 구성요소, 화살표 라벨 = 옮기는 도구.
function archFigure() {
  const box = (t, s, cls = "") => `<div class="ab ${cls}"><b>${t}</b>${s ? `<span>${s}</span>` : ""}</div>`;
  return `
  <figure class="arch" aria-label="WaterPulse 전체 구조">
    <div class="arow src">
      <p class="alabel">데이터 출처 · 공공 API</p>
      <div class="agrid four">
        ${box("수문 운영 정보", "댐 수위·유입·방류·저수량 · 15099110")}
        ${box("우량수위 관측소", "상류 비·강 수위·유량 · 15099115")}
        ${box("수문 제원 · 댐코드", "계획홍수위·유역 넓이 · 15099107/105")}
        ${box("기상청 ASOS", "강수·기온·습도·적설 · 15057210")}
      </div>
    </div>
    <div class="aarrow"><span>Python 수집기 · 페이지 나눠 받기 · 재시도 · 호출 기록</span></div>
    <div class="arow">
      <div class="agrid two">
        ${box("spool 폴더", "받은 그대로 JSON Lines", "file")}
        ${box("MySQL 기준표", "댐 좌표 · 관측소 연결 · ASOS 연결 · 수위 곡선", "db")}
      </div>
    </div>
    <div class="agrid two arrows"><div class="aarrow"><span>Flume (spooldir → HDFS)</span></div><div class="aarrow"><span>Sqoop import</span></div></div>
    <div class="arow hadoop">
      <p class="alabel">빅데이터 관리 · 하둡 (수업 실습 VM)</p>
      <div class="shelves">
        ${box("① 원본 선반", "/etl/waterpulse/raw · Hive EXTERNAL 표, 전부 STRING", "shelf")}
        <i class="sa">Spark 정제</i>
        ${box("② 정리 선반", "/data/waterpulse/clean · Parquet · 연도 파티션", "shelf")}
        <i class="sa">Spark 특징·분석 + Python 모델</i>
        ${box("③ 결과 선반", "/data/waterpulse/mart · 예측 · 방류 · 경보 · 품질표", "shelf")}
      </div>
      <p class="atools">HDFS 저장 · YARN 자원 배분 · Hive 표 정의 · Impala 빠른 조회 · Hue 화면</p>
    </div>
    <div class="aarrow"><span>Sqoop export</span></div>
    <div class="arow">
      <div class="agrid two">
        ${box("MySQL 결과 DB", "forecast · release · alert · lag_events · quality", "db")}
        ${box("웹 서버", "Flask · 결과 표를 JSON으로", "srv")}
      </div>
    </div>
    <div class="aarrow"><span>브라우저</span></div>
    <div class="arow web">
      <div class="agrid two">
        ${box("방류 계산기", "댐 운영자 · 지금 몇 ㎥/s 내보내야 하나", "ui")}
        ${box("재난 상황판", "재난 담당자 · 어느 댐이 위험해지나", "ui")}
      </div>
    </div>
  </figure>`;
}

function flowStrip() {
  return `<ol class="flow">${FLOW.map((f, k) => {
    const g = GROUPS.find((x) => x.id === f.group);
    const its = ITEMS.filter((i) => i.group === f.group);
    const done = its.filter((i) => i.status === "done").length;
    return `<li><a href="#${f.group}">
      <span class="fn">${g.step}</span>
      <b>${esc(f.title)}</b>
      <span class="ft">${esc(f.tools)}</span>
      <span class="fo">→ ${esc(f.out)}</span>
      <span class="fc">${esc(f.course)}</span>
      <span class="fp" aria-label="${its.length}개 중 ${done}개 끝남"><i style="width:${its.length ? (done / its.length) * 100 : 0}%"></i></span>
    </a></li>`;
  }).join("")}</ol>`;
}

function nextTodos() {
  const open = ITEMS.filter((i) => (i.status === "todo" || i.status === "decide") && i.due)
    .sort((a, b) => a.due.localeCompare(b.due)).slice(0, 8);
  return `<ol class="next">${open.map((i) => {
    const d = Math.ceil((day(i.due) - today()) / 86400000);
    return `<li><a href="#/r/${i.id}"><span class="nd ${d < 0 ? "late" : d <= 2 ? "soon" : ""}">${md(i.due)}</span><span class="rid">${i.id}</span><span class="nt">${esc(i.title)}</span>${badge(i.status)}</a></li>`;
  }).join("")}</ol>`;
}

function gantt() {
  const start = day("2026-10-10"), end = day("2026-12-10");
  const span = end - start;
  const pos = (d) => Math.max(0, Math.min(100, ((day(d) - start) / span) * 100));
  const t = today();
  const tp = ((t - start) / span) * 100;
  const months = ["2026-10-19", "2026-11-01", "2026-11-15", "2026-12-01"].map((d) => `<span style="left:${pos(d)}%">${md(d)}</span>`).join("");
  const rows = SCHEDULE.map((s) => {
    const g = GROUPS.find((x) => x.id === s.group);
    const l = pos(s.from), w = Math.max(pos(s.to) + 100 / 61 - l, 1.2);
    return `<li class="${s.milestone ? "ms" : ""}"><a href="#${s.group}"><span class="gl"><em>${esc(g.label)}</em>${esc(s.label)}</span>
      <span class="gt"><i class="g-${s.group}" style="left:${l}%;width:${s.milestone ? 0 : w}%"></i>${s.milestone ? `<i class="dot" style="left:${l}%"></i>` : ""}</span>
      <span class="gd">${md(s.from)}${s.to !== s.from ? `–${md(s.to)}` : ""}</span></a></li>`;
  }).join("");
  return `<div class="gantt"><div class="gh"><span class="gl"></span><span class="gt">${months}${tp >= 0 && tp <= 100 ? `<b class="now" style="left:${tp}%">오늘</b>` : ""}</span><span class="gd"></span></div><ol>${rows}</ol></div>`;
}

function listView() {
  const rail = GROUPS.map((g) => {
    const its = ITEMS.filter((i) => i.group === g.id);
    const open = its.filter((i) => i.status !== "done").length;
    return `<li><a href="#${g.id}"><span class="wk">${g.step !== undefined ? g.step : "·"}</span><span class="lb">${esc(g.label)}</span><span class="dt">${g.due ? md(g.due) : ""}</span>${open ? `<span class="oc">${open}</span>` : ""}</a></li>`;
  }).join("");

  const sections = GROUPS.map((g) => {
    const rows = ITEMS.filter((i) => i.group === g.id).map((i) => `
      <li><a class="row" href="#/r/${i.id}">
        <span class="rid">${i.id}</span>
        <span class="rt">${esc(i.title)}${i.summary ? `<small>${esc(i.summary.length > 90 ? i.summary.slice(0, 88) + "…" : i.summary)}</small>` : ""}</span>
        <span class="rd">${i.due ? md(i.due) : ""}</span>
        ${badge(i.status)}
      </a></li>`).join("");
    const when = g.due ? `<span class="due">마감 ${md(g.due)}</span>` : "";
    return `<section class="group" id="${g.id}"><header><h2>${g.step !== undefined ? `<span class="sn">${g.step}단계</span>` : ""}${esc(g.label)}</h2>${when}<p>${esc(g.note)}</p></header><ol class="rows">${rows}</ol></section>`;
  }).join("");

  view.innerHTML = `
  <section class="intro">
    <div class="two-col">
      <div>
        <h2 class="sh">한 문장 목표</h2>
        <p class="lead">비가 오면 몇 시간 뒤 댐에 물이 몰려오는지 미리 맞혀, 댐 운영자에게는 <b>지금 얼마나 내보내야 하는지</b>를, 재난 담당자에게는 <b>어느 댐이 위험해지는지</b>를 알려 준다.</p>
        <div class="goals">
          <a href="#/r/G-1"><span>최종 목표 ①</span><b>방류 계산기</b><small>넘치지 않을 최소 방류량</small></a>
          <a href="#/r/G-2"><span>최종 목표 ②</span><b>재난 상황판</b><small>정상 · 경계 · 위험, 몇 시간 전에</small></a>
          <a href="#/r/G-3" class="core"><span>두 화면이 공유</span><b>유입량 예측</b><small>3 · 6 · 12시간 뒤, 관측소·ASOS로 정확도 올리기</small></a>
        </div>
      </div>
      <div>
        <h2 class="sh">가까운 마감 할 일</h2>
        ${nextTodos()}
      </div>
    </div>
    <h2 class="sh">흐름 한눈에 <small>단계를 누르면 그 단계 할 일로 갑니다</small></h2>
    ${flowStrip()}
    <h2 class="sh">전체 구조 <small>중간발표 슬라이드 ② 초안</small></h2>
    ${archFigure()}
    <h2 class="sh">남은 일정 <small>10/10 기준으로 다시 짠 계획</small></h2>
    ${gantt()}
  </section>
  <div class="board"><nav class="rail" aria-label="단계"><ol>${rail}</ol></nav><div class="groups">${sections}</div></div>`;
}

function tableHtml(t) {
  return `<div class="tw"><table><thead><tr>${t.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
    t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function previewable(l) { return l && (l.kind === "pdf" || l.kind === "app"); }

function detailView(id, tab) {
  const i = ITEMS.find((x) => x.id === id);
  if (!i) return listView();
  const g = GROUPS.find((x) => x.id === i.group);
  const idx = ITEMS.indexOf(i);
  const prev = ITEMS[idx - 1], next = ITEMS[idx + 1];
  const links = i.links || [];
  const pv = links.filter(previewable);
  const sel = pv[Math.min(tab || 0, pv.length - 1)];

  const sec = (title, body) => (body ? `<section class="ds"><h3>${title}</h3>${body}</section>` : "");
  view.innerHTML = `
  <article class="detail">
    <nav class="crumbs"><a href="#${g.id}">전체 목록</a><span>${g.step !== undefined ? `${g.step}단계 · ` : ""}${esc(g.label)}</span></nav>
    <header class="dh">
      <span class="rid big">${i.id}</span>
      <h2>${esc(i.title)}</h2>
      <p class="meta">${badge(i.status)}${i.due ? `<span>마감 ${md(i.due)}</span>` : ""}<span>담당 ${esc(i.owner || "미정")}</span></p>
    </header>
    <div class="dbody">
      ${i.quote ? sec("과제 설명서 원문", `<blockquote lang="en">${esc(i.quote)}</blockquote>`) : ""}
      ${sec(i.group === "req" ? "우리가 채우는 방법" : "무엇을 하나", i.summary ? `<p>${esc(i.summary)}</p>` : "")}
      ${i.gap ? `<p class="gap"><b>아직 빈 곳</b>${esc(i.gap)}</p>` : ""}
      ${i.figure === "arch" ? archFigure() : ""}
      ${sec("정리", i.specs ? `<dl class="specs">${i.specs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : "")}
      ${sec(i.table && !i.steps ? "표" : "세부", i.table ? tableHtml(i.table) : "")}
      ${sec("방법", i.steps ? `<ol class="steps">${i.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : "")}
      ${sec("명령 · 설정 예시", i.code ? `<pre><code>${esc(i.code)}</code></pre>` : "")}
      ${i.note ? `<p class="note">${esc(i.note)}</p>` : ""}
      ${sec("조심할 것", i.traps ? `<ul class="traps">${i.traps.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : "")}
      ${i.next ? sec("이어지는 곳", `<p>${i.next.map(esc).join(" · ")}</p>`) : ""}
      ${links.length ? sec("관련 자료", `<ul class="links">${links.map((l) => {
        const k = pv.indexOf(l);
        const on = l === sel;
        return `<li><span class="kind">${KIND[l.kind]}</span>${k >= 0 ? `<a href="#/r/${i.id}/${k}" class="${on ? "on" : ""}">${esc(l.label)}${on ? " · 아래에 미리보기" : ""}</a>` : esc(l.label)} <a class="ext" href="${l.href}" target="_blank" rel="noopener">새 창</a></li>`;
      }).join("")}</ul>`) : ""}
      ${sel ? `<div class="pv"><iframe src="${sel.href}" title="${esc(sel.label)}" loading="lazy"></iframe></div>` : ""}
    </div>
    <nav class="pager">
      ${prev ? `<a href="#/r/${prev.id}"><span>이전</span>${prev.id} ${esc(prev.title)}</a>` : "<span></span>"}
      ${next ? `<a href="#/r/${next.id}" class="nx"><span>다음</span>${next.id} ${esc(next.title)}</a>` : "<span></span>"}
    </nav>
  </article>`;
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function route() {
  const m = location.hash.match(/^#\/r\/([^/]+)(?:\/(\d+))?/);
  if (m) return detailView(decodeURIComponent(m[1]), Number(m[2] || 0));
  if (!view.querySelector(".board")) listView();
  const g = location.hash.slice(1);
  if (g) document.getElementById(g)?.scrollIntoView({ block: "start" });
}

masthead();
window.addEventListener("hashchange", route);
route();
