'use strict';
/* 团队工作台 · 前端（原生 JS，无依赖） */

const DAY = 86400000;
const STATUS = {
  todo:    { label: '待办',   color: '#94a3b8', soft: '#f0f2f6' },
  doing:   { label: '进行中', color: '#3b82f6', soft: '#e9f1fe' },
  paused:  { label: '暂停',   color: '#f59e0b', soft: '#fdf3e3' },
  review:  { label: '待验收', color: '#8b5cf6', soft: '#f2ecfe' },
  blocked: { label: '阻塞',   color: '#ef4444', soft: '#feeceb' },
  done:    { label: '已完成', color: '#10b981', soft: '#e8f8f2' }
};
const ORDER = ['todo', 'doing', 'paused', 'review', 'blocked', 'done'];
const PRIO = { P0: '#ef4444', P1: '#f59e0b', P2: '#94a3b8' };
const PRIO_LABEL = { P0: '高', P1: '中', P2: '低' };

const VIEWS = [
  { id: 'dashboard', label: '总览',   icon: '◎', title: '总览',       sub: '团队今天该关注什么' },
  { id: 'kanban',    label: '看板',   icon: '▤', title: '看板',       sub: '拖拽卡片变更状态，点击查看详情' },
  { id: 'plan',      label: '计划',   icon: '☰', title: '计划与排期', sub: '谁在做什么、什么时候完成' },
  { id: 'timeline',  label: '时间线', icon: '▭', title: '时间线',     sub: '按成员分组的排期视图' },
  { id: 'kpi',       label: 'KPI',   icon: '◈', title: 'KPI 指标',   sub: '成员指标达成情况' },
  { id: 'alerts',    label: '提醒',   icon: '!', title: '事务提醒',   sub: '逾期、临期、阻塞与停滞' },
  { id: 'report',    label: '周报',   icon: '✎', title: '周报总结',   sub: '按日期区间自动汇总' },
  { id: 'team',      label: '团队',   icon: '☺', title: '团队管理',   sub: '成员、职责与产出' }
];

const S = {
  view: 'dashboard',
  data: { members: [], tasks: [], kpis: [], updates: [], logs: [], visits: null },
  today: iso(new Date()),
  me: null,
  guest: false,
  ip: '',
  guestNote: '',
  filter: { member: '', q: '', overdueOnly: false, status: '' },
  openTask: null,
  drag: null,
  reportWeek: null,
  reportData: null,
  reportMd: '',
  reportMdWeek: ''
};
const FIELD_CN = {
  title: '标题', detail: '说明', member_id: '负责人', status: '状态', priority: '优先级',
  category: '类型', progress: '进度', start_date: '开始日期', due_date: '截止日期', estimate: '预估工时'
};

/* ------------------------------------------------------------ utils */
function iso(dt) { const p = n => String(n).padStart(2, '0'); return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()); }
function parse(s) { return s ? new Date(s.slice(0, 10) + 'T00:00:00') : null; }
function addDays(s, n) { const d = parse(s) || new Date(); d.setDate(d.getDate() + n); return iso(d); }
function diffDays(a, b) { return Math.round((b - a) / DAY); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmt(s) { return s ? s.slice(5, 10).replace('-', '/') : '—'; }
function fmtFull(s) { return s ? s.slice(0, 16).replace('T', ' ').replace(/-/g, '/') : ''; }
function todayD() { return parse(S.today); }
function isOverdue(t) { return t.status !== 'done' && t.status !== 'paused' && t.due_date && t.due_date < S.today; }
function daysLeft(t) { return t.due_date ? diffDays(todayD(), parse(t.due_date)) : null; }
function initials(name) { return (name || '?').slice(-2); }
function memberById(id) { return S.data.members.find(m => m.id === id) || null; }
function memberName(id) { const m = memberById(id); return m ? m.name : '未指派'; }
function memberColor(id) { const m = memberById(id); return m ? m.color : '#94a3b8'; }
function avatar(m, cls) {
  if (!m) return '<span class="avatar ' + (cls || '') + '" style="background:#cbd2e0">?</span>';
  if (m.avatar) return '<img class="avatar ' + (cls || '') + '" src="' + esc(m.avatar) + '" alt="' + esc(m.name) + '" title="' + esc(m.name) + '">';
  return '<span class="avatar ' + (cls || '') + '" style="background:' + esc(m.color) + '" title="' + esc(m.name) + '">' + esc(initials(m.name)) + '</span>';
}
function taskUpdates(id) { return S.data.updates.filter(u => u.task_id === id); }
function taskLogsHtml(tid) {
  const logs = (S.data.logs || []).filter(l => l.task_id === tid);
  if (!logs.length) return '';
  return '<div class="section-title" style="margin-top:22px">变更日志<span class="count">' + logs.length + '</span></div>' +
    '<div class="logs">' + logs.map(l => {
      const when = (l.created_at || '').slice(5, 16).replace('-', '/');
      const who = esc(l.member_name || '系统');
      const body = l.action === 'create'
        ? who + ' 创建了事务'
        : who + ' <span class="fl">' + esc(FIELD_CN[l.field] || l.field) + '</span> ' +
          '<span class="arrow">' + esc(l.old_value || '空') + ' → ' + esc(l.new_value || '空') + '</span>';
      return '<div class="log-row"><span class="when">' + esc(when) + '</span><span>' + body + '</span></div>';
    }).join('') + '</div>';
}
function lastUpdate(id) { const a = taskUpdates(id).filter(u => u.kind !== 'system'); return a.length ? a[0] : null; }
// 最近一次「有动作」：写进展 或 改字段（改进度/状态/日期也算在推进）
function lastActivity(t) {
  const n = lastUpdate(t.id);
  const logs = (S.data.logs || []).filter(l => l.task_id === t.id && l.action !== 'create');
  let at = t.created_at || null;                    // 刚建的事务本身就算「刚有动作」
  if (n && (!at || n.created_at > at)) at = n.created_at;
  if (logs.length) {
    const l = logs.reduce((a, b) => (a.created_at > b.created_at ? a : b));
    if (!at || l.created_at > at) at = l.created_at;
  }
  return at;
}
// 周期口径：上周五 ~ 本周四（取不晚于 d 的最近周五）
function weekOf(s) { const d = parse(s); const off = (d.getDay() + 2) % 7; d.setDate(d.getDate() - off); return iso(d); }
function dueLabel(t) {
  if (!t.due_date) return '<span class="muted">未排期</span>';
  const n = daysLeft(t);
  if (t.status === 'done') return '<span class="muted">' + fmt(t.due_date) + '</span>';
  if (n < 0) return '<span style="color:#b91c1c;font-weight:600">逾期 ' + (-n) + ' 天</span>';
  if (n === 0) return '<span style="color:#b45309;font-weight:600">今天到期</span>';
  if (n <= 2) return '<span style="color:#b45309;font-weight:600">剩 ' + n + ' 天</span>';
  return '<span class="muted">' + fmt(t.due_date) + '</span>';
}
function chipStatus(st) { const m = STATUS[st] || STATUS.todo; return '<span class="chip ' + st + '"><i style="width:6px;height:6px;border-radius:50%;background:' + m.color + '"></i>' + m.label + '</span>'; }

async function api(path, method, body) {
  const opt = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (body) opt.body = JSON.stringify(body);
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('请求失败 ' + r.status));
  return j;
}

let toastTimer = null;
function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2400);
}

async function load() {
  const j = await api('/api/bootstrap');
  S.data = { members: j.members, tasks: j.tasks, kpis: j.kpis, updates: j.updates, logs: j.logs || [], visits: j.visits || null };
  S.today = j.today;
  renderSidebar();
}

async function reload() {
  await load();
  render();
  if (S.openTask) renderDrawer();
}

/* ------------------------------------------------------------ 身份（按 IP 识别） */
async function loadIdentity() {
  try {
    const j = await api('/api/whoami');
    S.me = j.member;
    S.guest = !!j.guest;
    S.ip = j.ip;
    S.guestNote = j.note || '';
    S.local = !!j.local;
  } catch (e) { S.me = null; }
  document.body.classList.toggle('guest', !!S.guest);
  renderWho();
}

function uaShort() {
  const ua = navigator.userAgent || '';
  let m = ua.match(/(Edg|OPR|Chrome|Firefox)\/(\d+)/);
  if (m) {
    const n = { Edg: 'Edge', OPR: 'Opera', Chrome: 'Chrome', Firefox: 'Firefox' }[m[1]] || m[1];
    return n + ' ' + m[2];
  }
  m = ua.match(/Version\/(\d+).*Safari/);
  if (m) return 'Safari ' + m[1];
  return '浏览器';
}

function visitPlatform() {
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();
  return [uaShort(), navigator.platform || '', screen.width + 'x' + screen.height, tz].filter(Boolean).join(' · ');
}

/* 每次打开页面记一条访问：谁、哪台机器、什么浏览器 */
async function recordVisit(kind) {
  try {
    await api('/api/visit', 'POST', { kind: kind || (S.me ? 'member' : (S.guest ? 'guest' : 'anon')), platform: visitPlatform(), note: S.guestNote || '' });
    await refreshVisits();
  } catch (e) { /* 统计失败不影响使用 */ }
}

async function refreshVisits() {
  try {
    const j = await api('/api/visits');
    S.data.visits = j;
    renderSiteStats();
  } catch (e) { /* ignore */ }
}

function renderSiteStats() {
  const el = document.getElementById('side-stats');
  if (!el) return;
  el.innerHTML = '<button class="all" id="btn-visits">站点统计</button>';
}

function showVisitsModal() {
  const modal = document.getElementById('modal');
  const overlay = document.getElementById('overlay');
  const v = S.data.visits || { rows: [], total: 0, today: 0 };
  const rows = v.rows || [];
  modal.innerHTML =
    '<div class="drawer-head"><span class="t">站点访问记录</span><button class="btn ghost sm x" data-iclose>✕</button></div>' +
    '<div style="padding:4px 20px 22px;max-height:70vh;overflow:auto">' +
    '<p class="muted" style="font-size:12px;margin:0 0 12px;line-height:1.7">今天 <b>' + v.today + '</b> 次 · 累计 <b>' + v.total +
    '</b> 次 · 来访设备 <b>' + rows.length + '</b> 台（游客 ' + (v.guests || 0) + ' 台）。' +
    '设备名与登录用户：本机访问可直接读取系统账号，其它机器只能靠 NetBIOS / 反向解析拿到设备名，拿不到对方登录账号。</p>' +
    '<table class="list visits"><thead><tr><th>谁</th><th>IP</th><th>登录用户</th><th>设备名</th><th>浏览器 / 系统</th><th>次数</th><th>最近</th></tr></thead><tbody>' +
    (rows.map(r => '<tr><td>' + (r.name ? '<b>' + esc(r.name) + '</b>' : (r.note ? esc(r.note) : '<span class="muted">未识别</span>') +
      (r.guest ? ' <span class="chip todo">游客</span>' : '')) + '</td>' +
      '<td class="mono">' + esc(r.ip) + '</td>' +
      '<td class="mono">' + (r.os_user ? esc(r.os_user) : '<span class="muted">—</span>') + '</td>' +
      '<td class="mono">' + (r.host ? esc(r.host) : '<span class="muted">—</span>') +
      (r.source ? ' <span class="muted" style="font-size:10px">' + esc(r.source) + '</span>' : '') + '</td>' +
      '<td class="muted" style="font-size:11px">' + esc((r.platform || '').replace(/\s*·\s*/g, ' · ') || '—') + '</td>' +
      '<td class="mono">' + r.n + '</td>' +
      '<td class="muted mono" style="font-size:11px">' + esc((r.last || '').slice(5, 16)) + '</td></tr>').join('') ||
    '<tr><td colspan="7" class="muted">还没有访问记录</td></tr>') +
    '</tbody></table></div>';
  modal.className = 'modal wide show';
  overlay.classList.add('show');
}

function showGuestModal() {
  const modal = document.getElementById('modal');
  const overlay = document.getElementById('overlay');
  modal.className = 'modal';
  modal.innerHTML =
    '<div class="drawer-head"><span class="t">参观一下</span><button class="btn ghost sm x" data-iclose>✕</button></div>' +
    '<div style="padding:6px 20px 22px">' +
    '<p class="muted" style="font-size:12.5px;margin:0 0 14px;line-height:1.8">' +
    '只读浏览：看板、计划、时间线、KPI、周报都能翻，但不能修改数据。<br>' +
    '会记录一次访问：IP <b class="mono">' + esc(S.ip || '未知') + '</b>、设备名、浏览器。' +
    '不是本团队的人，留个称呼方便认出来。</p>' +
    '<div class="form-row"><label>你的称呼（可选）</label>' +
    '<input type="text" id="guest-note" maxlength="20" placeholder="例如：安全中心 张三"></div>' +
    '<button class="btn primary" id="guest-go" style="width:100%;margin-top:8px">进入只读浏览</button>' +
    '</div>';
  modal.classList.add('show');
  overlay.classList.add('show');
  const go = async () => {
    const note = (document.getElementById('guest-note') || {}).value || '';
    S.guestNote = note.trim();
    try {
      await api('/api/whoami', 'POST', { guest: true, note: S.guestNote, platform: visitPlatform() });
      S.me = null; S.guest = true;
      document.body.classList.add('guest');
      closeModal();
      renderWho(); render();
      refreshVisits();
      toast('已进入游客模式（只读）');
    } catch (e) { toast(e.message, true); }
  };
  document.getElementById('guest-go').addEventListener('click', go);
  document.getElementById('guest-note').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

function renderWho() {
  const btn = document.getElementById('btn-who');
  if (!btn) return;
  if (S.me) {
    btn.className = 'who';
    btn.innerHTML = avatar(S.me, 'sm') + '<span class="nm">' + esc(S.me.name) + '</span>' +
      '<span class="ip mono">' + esc(S.ip) + '</span>';
    btn.title = '当前身份（按 IP 识别）· 点击切换';
  } else if (S.guest) {
    btn.className = 'who guest';
    btn.innerHTML = '<span class="avatar sm" style="background:#0ea5e9">客</span><span>游客</span>' +
      '<span class="ip mono">' + esc(S.ip || '') + '</span>';
    btn.title = '游客只能浏览 · 点击改为「我是谁」';
  } else {
    btn.className = 'who unset';
    btn.innerHTML = '<span class="avatar sm" style="background:#d97706">?</span><span>选择我是谁</span>';
    btn.title = '还没有识别到你的身份，点这里选择';
  }
}

function closeModal() {
  document.getElementById('modal').classList.remove('show');
  if (!document.getElementById('drawer').classList.contains('show')) {
    document.getElementById('overlay').classList.remove('show');
  }
}

function showIdentityModal(first) {
  const modal = document.getElementById('modal');
  const overlay = document.getElementById('overlay');
  modal.className = 'modal';
  const members = S.data.members.filter(m => m.active !== 0);
  modal.innerHTML =
    '<div class="drawer-head"><span class="t">' + (first ? '欢迎，你是哪位？' : '切换身份') + '</span>' +
    '<button class="btn ghost sm x" data-iclose>✕</button></div>' +
    '<div style="padding:6px 20px 22px">' +
    '<p class="muted" style="font-size:12.5px;margin:0 0 16px;line-height:1.85">' +
    '选一次就记住了，下次打开不用再选；你记的进展、交的周报都会署在这个名字下。</p>' +
    '<div class="id-grid">' + members.map(m =>
      '<button class="id-item" data-pick="' + m.id + '">' + avatar(m, 'lg') +
      '<span>' + esc(m.name) + '</span><em>' + esc(m.role || '—') + '</em></button>').join('') +
    '<button class="id-item guest" data-guest><span class="avatar lg" style="background:#0ea5e9">客</span>' +
    '<span>参观一下</span><em>只读浏览</em></button>' +
    '</div>' +
    '<p class="muted" style="font-size:11.5px;margin:16px 0 0">不在名单里？联系 <b>王少君</b> 加你进来。</p>' +
    '</div>';
  modal.classList.add('show');
  overlay.classList.add('show');
}

async function bindIdentity(mid, code) {
  try {
    const j = await api('/api/whoami', 'POST', { member_id: mid, code: code || '' });
    S.me = j.member;
    S.ip = j.ip;
    S.guest = false;
    S.local = !!j.local;
    document.body.classList.remove('guest');
    closeModal();
    renderWho();
    render();
    recordVisit();
    toast('已识别为 ' + S.me.name);
  } catch (e) {
    const err = document.getElementById('code-err');
    const inp = document.getElementById('id-code');
    if (err && inp) {
      err.textContent = e.message;
      err.style.display = 'block';
      inp.classList.add('bad');
      inp.select();
    } else toast(e.message, true);
  }
}

/* 选完人后校验一次，界面上只说「验证码」 */
function askCode(mid) {
  const m = S.data.members.find(x => x.id === mid);
  if (!m) return;
  const modal = document.getElementById('modal');
  modal.className = 'modal';
  modal.innerHTML =
    '<div class="drawer-head"><span class="t">验证一下</span>' +
    '<button class="btn ghost sm x" data-iclose>✕</button></div>' +
    '<div style="padding:6px 20px 22px">' +
    '<div class="id-me">' + avatar(m, 'lg') + '<div><b>' + esc(m.name) + '</b>' +
    '<em>' + esc(m.role || '—') + '</em></div></div>' +
    '<div class="form-row" style="margin-top:16px"><label>验证码</label>' +
    '<input type="password" id="id-code" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="4 位数字"></div>' +
    '<p class="muted" style="font-size:11.5px;margin:-2px 0 6px">' +
    (m.has_phone ? '用于确认这台设备归你使用。' : '这位成员还没登记验证码。') + '</p>' +
    '<p id="code-err" style="display:none;color:#d1383d;font-size:11.5px;margin:0 0 12px"></p>' +
    '<div style="display:flex;gap:8px;margin-top:10px">' +
    '<button class="btn primary" id="code-go" style="flex:1">确认</button>' +
    '<button class="btn" data-back>返回</button></div>' +
    '</div>';
  const inp = document.getElementById('id-code');
  inp.focus();
  modal.classList.add('show');
  document.getElementById('overlay').classList.add('show');
  const go = () => bindIdentity(mid, inp.value.trim());
  document.getElementById('code-go').addEventListener('click', go);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  inp.addEventListener('input', () => {
    inp.classList.remove('bad');
    const err = document.getElementById('code-err');
    if (err) err.style.display = 'none';
  });
  document.querySelector('[data-back]').addEventListener('click', () => showIdentityModal(false));
}

/* ------------------------------------------------------------ reminders */
function buildReminders() {
  const out = [];
  const done = new Set();
  const push = (kind, t, text, extra) => {
    const key = String(t.id);
    if (done.has(key)) return;
    done.add(key);
    out.push(Object.assign({ kind, task: t, text, member: memberName(t.member_id) }, extra || {}));
  };
  // 每个事务只保留最高优先级的一条提醒，避免同一件事在列表里重复出现
  S.data.tasks.forEach(t => {
    if (t.status === 'done' || t.status === 'paused') return;
    const n = daysLeft(t);
    if (isOverdue(t)) { push('overdue', t, '已逾期 ' + (-n) + ' 天，进度 ' + t.progress + '%'); return; }
    if (t.status === 'blocked') { push('blocked', t, '阻塞中，需要外部条件解除'); return; }
    const la = lastActivity(t);
    if (t.status !== 'todo' && (!la || diffDays(parse(la.slice(0, 10)), todayD()) >= 4)) {
      push('stalled', t, la ? '已 ' + diffDays(parse(la.slice(0, 10)), todayD()) + ' 天没有更新' : '一直没有写进展，也没改进度');
      return;
    }
    if (n !== null && n <= 2) { push('soon', t, n === 0 ? '今天到期' : '还有 ' + n + ' 天到期'); return; }
    if (!t.due_date) push('nodate', t, '没有排期，无法进入时间线');
  });
  const rank = { overdue: 0, blocked: 1, soon: 2, stalled: 3, nodate: 4 };
  out.sort((a, b) => rank[a.kind] - rank[b.kind]);
  return out;
}
const REM_META = {
  overdue: { icon: '⚠', color: '#ef4444', label: '逾期' },
  blocked: { icon: '⛔', color: '#ef4444', label: '阻塞' },
  soon:    { icon: '⏰', color: '#f59e0b', label: '临期' },
  stalled: { icon: '💤', color: '#8b5cf6', label: '停滞' },
  nodate:  { icon: '◌', color: '#94a3b8', label: '未排期' }
};

/* ------------------------------------------------------------ sidebar */
function renderSidebar() {
  const rem = buildReminders();
  const nav = document.getElementById('nav');
  nav.innerHTML = VIEWS.map(v => {
    const badge = v.id === 'alerts' && rem.length ? '<span class="badge">' + rem.length + '</span>' : '';
    return '<button class="nav-item' + (S.view === v.id ? ' active' : '') + '" data-view="' + v.id + '">' +
      '<span class="ic">' + v.icon + '</span><span>' + v.label + '</span>' + badge + '</button>';
  }).join('');
  const sm = document.getElementById('side-members');
  sm.innerHTML = S.data.members.filter(m => m.active !== 0).map(m => {
    const n = S.data.tasks.filter(t => t.member_id === m.id && t.status !== 'done').length;
    return '<div class="side-member">' + avatar(m, 'sm') + '<span>' + esc(m.name) + '</span>' +
      '<span class="dot" style="background:' + (n ? '#4f46e5' : '#3b4252') + '"></span>' +
      '<span class="mono" style="font-size:11px;color:#6b7285">' + n + '</span></div>';
  }).join('') || '<div class="side-member muted">还没有成员</div>';
}

/* ------------------------------------------------------------ render root */
function render() {
  const meta = VIEWS.find(v => v.id === S.view);
  document.getElementById('page-title').textContent = meta.title;
  document.getElementById('page-sub').textContent = meta.sub + ' · ' + S.today.replace(/-/g, '/') + ' 周' + '日一二三四五六'[new Date(S.today + 'T00:00:00').getDay()];
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === S.view));
  const el = document.getElementById('view');
  const fn = ({
    dashboard: viewDashboard, kanban: viewKanban, plan: viewPlan, timeline: viewTimeline,
    kpi: viewKpi, alerts: viewAlerts, report: viewReport, team: viewTeam
  })[S.view];
  el.innerHTML = fn();
  if (S.view === 'report') renderReportBox();
  renderSidebar();
  renderSiteStats();
  renderWho();
}

/* ------------------------------------------------------------ 总览 */
function viewDashboard() {
  const tasks = S.data.tasks;
  const doing = tasks.filter(t => t.status === 'doing' || t.status === 'review');
  const blocked = tasks.filter(t => t.status === 'blocked');
  const paused = tasks.filter(t => t.status === 'paused');
  const wk = weekOf(S.today);
  const weekDone = tasks.filter(t => t.done_at && t.done_at.slice(0, 10) >= wk);
  const overdue = tasks.filter(isOverdue);
  const lastWeekDone = tasks.filter(t => t.done_at && t.done_at.slice(0, 10) >= addDays(wk, -7) && t.done_at.slice(0, 10) < wk);
  const rem = buildReminders();

  const stat = (k, v, d, cls, spark) =>
    '<div class="card stat"><div class="k">' + k + '</div><div class="v mono">' + v + '</div><div class="d ' + (cls || '') + '">' + d + '</div><div class="spark">' + (spark || '') + '</div></div>';

  let h = '<div class="stat-row">' +
    stat('进行中事务', doing.length + blocked.length, '其中阻塞 ' + blocked.length + ' 项' + (paused.length ? ' · 暂停 ' + paused.length + ' 项' : ''), blocked.length ? 'down' : '', '▶') +
    stat('本周完成', weekDone.length, '上周 ' + lastWeekDone.length + ' 项', weekDone.length >= lastWeekDone.length ? 'up' : 'down', '✓') +
    stat('逾期未完成', overdue.length, overdue.length ? '需要今天处理' : '全部在计划内', overdue.length ? 'down' : 'up', '⚠') +
    stat('待跟进提醒', rem.length, '停滞 / 临期 / 未排期', rem.length ? 'down' : '', '!') +
    '</div>';

  h += '<div class="section-title">成员当前在忙什么<span class="count">' + S.data.members.filter(m => m.active !== 0).length + ' 人</span><span class="spacer"></span><button class="btn sm ghost" data-view-jump="team">管理成员</button></div>';
  h += '<div class="member-cards">';
  S.data.members.filter(m => m.active !== 0).forEach(m => {
    const mine = tasks.filter(t => t.member_id === m.id && t.status !== 'done');
    const act = mine.filter(t => ['doing', 'review', 'blocked', 'paused'].includes(t.status));
    const kpis = S.data.kpis.filter(k => k.member_id === m.id);
    const score = kpiScore(kpis);
    h += '<div class="card member-card" data-jump-member="' + m.id + '" title="查看看板中 ' + esc(m.name) + ' 的事务"><div class="top">' + avatar(m, 'lg') +
      '<div><div class="nm">' + esc(m.name) + '</div><div class="rl">' + esc(m.role || '未填写职责') + '</div></div>' +
      '<div class="load"><b class="mono">' + mine.length + '</b>在手事务</div></div>';
    h += '<div style="display:flex;align-items:center;gap:10px;margin-top:12px"><div class="bar" style="flex:1"><i style="width:' + (score || 0) + '%;background:' + (score === null ? '#cbd0dc' : score >= 90 ? '#10b981' : score >= 70 ? '#f59e0b' : '#ef4444') + '"></i></div><span class="mono" style="font-size:11px;color:#7b8296">KPI ' + (score === null ? '未设目标' : score + '%') + '</span></div>';
    if (act.length) {
      h += '<div class="now">' + act.slice(0, 3).map(t =>
        '<div class="item" data-task="' + t.id + '" style="cursor:pointer">' +
        '<i style="width:6px;height:6px;border-radius:50%;background:' + STATUS[t.status].color + ';flex:0 0 auto"></i>' +
        '<span style="overflow:hidden;text-overflow:ellipsis">' + esc(t.title) + '</span>' +
        '<em>' + (t.status === 'blocked' ? '阻塞' : t.status === 'paused' ? '暂停' : t.progress + '%') + '</em></div>').join('') + '</div>';
      if (act.length > 3) h += '<div class="none">另有 ' + (act.length - 3) + ' 项</div>';
    } else {
      h += '<div class="none">当前没有进行中的事务</div>';
    }
    h += '</div>';
  });
  h += '</div>';

  h += '<div class="grid-2" style="margin-top:20px">';
  h += '<div><div class="section-title">最近更新的事务<span class="count">' + S.data.updates.length + ' 条进展</span></div><div class="card">';
  const recent = S.data.updates.slice(0, 8);
  if (!recent.length) h += '<div class="empty">暂无进展记录</div>';
  else h += '<div class="reminder-list">' + recent.map(u => {
    const t = S.data.tasks.find(x => x.id === u.task_id);
    return '<div class="rem" style="cursor:pointer" data-task="' + u.task_id + '">' +
      '<span class="ic" style="color:#c7cbe0">•</span><div class="body"><div class="t">' + esc(t ? t.title : '已删除事务') + '</div>' +
      '<div class="m">' + esc(u.content) + '</div></div>' +
      '<span class="muted" style="font-size:11px;white-space:nowrap">' + esc((u.member_name || '') + ' · ' + fmt(u.created_at)) + '</span></div>';
  }).join('') + '</div>';
  h += '</div></div>';

  h += '<div><div class="section-title">待处理提醒<span class="count">' + rem.length + '</span><span class="spacer"></span><button class="btn sm ghost" data-view-jump="alerts">全部</button></div><div class="card">';
  if (!rem.length) h += '<div class="empty">没有需要额外关注的事务 🎉</div>';
  else h += '<div class="reminder-list">' + rem.slice(0, 7).map(r => {
    const m = REM_META[r.kind];
    return '<div class="rem"><span class="ic" style="color:' + m.color + '">' + m.icon + '</span>' +
      '<div class="body"><div class="t" data-task="' + r.task.id + '" style="cursor:pointer">' + esc(r.task.title) + '</div>' +
      '<div class="m">' + esc(r.member) + ' · ' + esc(r.text) + '</div></div></div>';
  }).join('') + '</div>';
  h += '</div></div></div>';
  return h;
}

function copyText(t) {
  return navigator.clipboard.writeText(t).then(() => true).catch(() => false);
}

/* 看某人某周提交的周报原文（团队页/周报页共用） */
function showReportContent(mid, week) {
  const wk = week || S.reportWeek || weekOf(S.today);
  const d = S.reportData;
  const m = S.data.members.find(x => x.id === mid);
  const rep = d && d.week === wk ? d.reports.find(r => r.member_id === mid) : null;
  if (!rep) { toast('这一周还没有提交内容', true); return; }
  const body = '<div class="raw-meta">' + (m ? esc(m.name) : '成员 ' + mid) + ' · ' +
    wk.replace(/-/g, '/') + ' ~ ' + addDays(wk, 6).replace(/-/g, '/') +
    ' · 提交于 ' + esc(fmtFull(rep.submitted_at)) + (rep.updated_at && rep.updated_at !== rep.submitted_at ? ' · 最后更新 ' + esc(fmtFull(rep.updated_at)) : '') +
    '</div><pre class="raw-pre">' + esc(rep.content || '（空）') + '</pre>';
  openModal({
    title: '周报原文', body, okText: '复制原文',
    onSubmit: async () => {
      const ok = await copyText(rep.content || '');
      toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文本');
    }
  });
}

/* 本周所有人提交的原文，堆在一起看 */
function showAllReports() {
  const wk = S.reportWeek || weekOf(S.today);
  const d = S.reportData;
  if (!d || d.week !== wk) return;
  const parts = d.members.map(m => {
    const rep = d.reports.find(r => r.member_id === m.id);
    if (!rep) return '';
    return '<div class="raw-block"><div class="raw-h">' + esc(m.name) +
      '<span class="muted">' + esc(m.role || '') + ' · ' + esc(fmtFull(rep.submitted_at)) + '</span></div>' +
      '<pre class="raw-pre">' + esc(rep.content || '（空）') + '</pre></div>';
  }).filter(Boolean).join('');
  openModal({
    title: '本周周报原文 · ' + wk.replace(/-/g, '/') + ' ~ ' + addDays(wk, 6).replace(/-/g, '/'),
    body: '<div class="raw-all">' + (parts || '<p class="muted">这周还没有人提交</p>') + '</div>',
    okText: '复制全部',
    onSubmit: async () => {
      const text = d.members.map(m => {
        const rep = d.reports.find(r => r.member_id === m.id);
        return rep ? ('## ' + m.name + '\n' + (rep.content || '').trim()) : '';
      }).filter(Boolean).join('\n\n');
      const ok = await copyText(text);
      toast(ok ? '已复制全部原文' : '复制失败');
    }
  });
}

function kpiScore(kpis) {
  const measured = kpis.filter(k => k.target && k.target > 0);
  if (!measured.length) return null;
  let sum = 0;
  measured.forEach(k => {
    const tgt = k.target;
    let r = 0;
    if (k.direction === 'down') r = k.current ? tgt / k.current : 0;
    else r = k.current / tgt;
    sum += Math.min(1.6, r);
  });
  return Math.min(100, Math.round(sum / measured.length * 100));
}

/* ------------------------------------------------------------ 看板 */
function viewKanban() {
  const f = S.filter;
  let tasks = S.data.tasks.slice();
  if (f.member) tasks = tasks.filter(t => String(t.member_id) === String(f.member));
  if (f.q) { const q = f.q.toLowerCase(); tasks = tasks.filter(t => (t.title + ' ' + (t.detail || '') + ' ' + t.category).toLowerCase().includes(q)); }

  let h = '<div class="kanban-tools">';
  h += '<div class="field"><label>成员</label><select data-filter="member"><option value="">全部成员</option>' +
    S.data.members.map(m => '<option value="' + m.id + '"' + (String(f.member) === String(m.id) ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('') + '</select></div>';
  h += '<input type="search" placeholder="搜索事务标题 / 描述" value="' + esc(f.q) + '" data-filter="q" style="width:240px">';
  h += '<span class="muted" style="font-size:12px">共 ' + tasks.length + ' 项 · 卡片可拖到其他列</span></div>';

  h += '<div class="kanban">';
  // 列内排序：优先级高→低，再按剩余天数从少到多，没排期的排最后
  const PRIO_RANK = { P0: 0, P1: 1, P2: 2 };
  const sortCards = list => list.slice().sort((a, b) => {
    const pa = PRIO_RANK[a.priority] === undefined ? 3 : PRIO_RANK[a.priority];
    const pb = PRIO_RANK[b.priority] === undefined ? 3 : PRIO_RANK[b.priority];
    if (pa !== pb) return pa - pb;
    const da = a.due_date ? daysLeft(a) : Infinity;
    const db = b.due_date ? daysLeft(b) : Infinity;
    if (da !== db) return da - db;
    return a.id - b.id;
  });

  ORDER.forEach(st => {
    const list = sortCards(tasks.filter(t => t.status === st));
    const meta = STATUS[st];
    h += '<div class="col" data-status="' + st + '"><div class="col-head"><span class="dot" style="background:' + meta.color + '"></span>' +
      meta.label + '<span class="n">' + list.length + '</span></div><div class="col-body">';
    list.forEach(t => {
      const m = memberById(t.member_id);
      const lu = lastUpdate(t.id);
      h += '<div class="kcard" draggable="true" data-task="' + t.id + '">' +
        '<div class="ttl">' + esc(t.title) + '</div>' +
        '<div class="tags"><span class="chip ' + t.priority.toLowerCase() + '">' + (PRIO_LABEL[t.priority] || t.priority) + '</span>' +
        '<span class="chip cat">' + esc(t.category) + '</span>' +
        '</div>' +
        (t.progress > 0 && t.progress < 100 ? '<div class="mini"><i style="width:' + t.progress + '%;background:' + meta.color + '"></i></div>' : '') +
        '<div class="foot">' + avatar(m, 'sm') + '<span>' + esc(m ? m.name : '未指派') + '</span>' +
        '<span class="right mono">' + dueLabel(t) + '</span></div>' +
        (lu ? '<div style="font-size:10.5px;color:#9aa1b2;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(lu.content) + '</div>' : '') +
        '</div>';
    });
    h += '<button class="col-add" data-new="' + st + '">＋ 添加事务</button>';
    h += '</div></div>';
  });
  h += '</div>';
  return h;
}

/* ------------------------------------------------------------ 计划 */
function viewPlan() {
  const f = S.filter;
  let tasks = S.data.tasks.slice();
  if (f.member) tasks = tasks.filter(t => String(t.member_id) === String(f.member));
  if (f.status) tasks = tasks.filter(t => t.status === f.status);
  if (f.q) { const q = f.q.toLowerCase(); tasks = tasks.filter(t => (t.title + ' ' + (t.detail || '')).toLowerCase().includes(q)); }
  if (f.overdueOnly) tasks = tasks.filter(isOverdue);
  // 未完成优先：先按截止日期从早到晚（逾期的自然在最前），没排期的排在其后；已完成的沉到底部
  const planKey = t => (t.status === 'done' ? 1 : 0);
  const planDue = t => (t.due_date ? (t.status === 'done' ? t.done_at || t.due_date : t.due_date) : '9999');
  tasks.sort((a, b) => {
    const ka = planKey(a), kb = planKey(b);
    if (ka !== kb) return ka - kb;
    if (ka === 0) {
      const da = planDue(a), db = planDue(b);
      if (da !== db) return da < db ? -1 : 1;
    } else {
      const da = a.done_at || '', db = b.done_at || '';
      if (da !== db) return da > db ? -1 : 1;   // 刚完成的在前
    }
    return a.id - b.id;
  });

  let h = '<div class="filters">';
  h += '<div class="field"><label>成员</label><select data-filter="member"><option value="">全部</option>' +
    S.data.members.map(m => '<option value="' + m.id + '"' + (String(f.member) === String(m.id) ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('') + '</select></div>';
  h += '<div class="field"><label>状态</label><select data-filter="status"><option value="">全部</option>' +
    ORDER.map(s => '<option value="' + s + '"' + (f.status === s ? ' selected' : '') + '>' + STATUS[s].label + '</option>').join('') + '</select></div>';
  h += '<input type="search" placeholder="搜索" value="' + esc(f.q) + '" data-filter="q" style="width:180px">';
  h += '<label class="field" style="cursor:pointer"><input type="checkbox" data-filter="overdueOnly"' + (f.overdueOnly ? ' checked' : '') + '> 仅看逾期</label>';
  h += '<span class="muted" style="font-size:12px;margin-left:auto">' + tasks.length + ' 项</span></div>';

  if (!tasks.length) return h + '<div class="empty">没有符合条件的事务</div>';
  h += '<div class="card" style="overflow:hidden"><table class="list"><thead><tr>' +
    '<th style="width:36%">事务</th><th>负责人</th><th>状态</th><th>优先级</th><th style="width:150px">进度</th><th>开始</th><th>截止</th><th>预估</th></tr></thead><tbody>';
  tasks.forEach(t => {
    const m = memberById(t.member_id);
    const st = STATUS[t.status];
    h += '<tr data-task="' + t.id + '">' +
      '<td><div class="t">' + esc(t.title) + '</div><div class="muted" style="font-size:11px">' + esc(t.category) + (t.detail ? ' · ' + esc(t.detail.slice(0, 42)) : '') + '</div></td>' +
      '<td><div class="owner">' + avatar(m, 'sm') + esc(m ? m.name : '未指派') + '</div></td>' +
      '<td>' + chipStatus(t.status) + '</td>' +
      '<td><span class="chip ' + t.priority.toLowerCase() + '">' + (PRIO_LABEL[t.priority] || t.priority) + '</span></td>' +
      '<td><div class="pbar"><div class="bar"><i style="width:' + t.progress + '%;background:' + st.color + '"></i></div><span class="mono">' + t.progress + '%</span></div></td>' +
      '<td class="muted mono">' + fmt(t.start_date) + '</td>' +
      '<td class="mono">' + (t.due_date ?
        fmt(t.due_date) + '<div style="font-size:10.5px;color:' + (t.status !== 'done' && t.status !== 'paused' && daysLeft(t) < 0 ? '#b91c1c' : '#9aa1b2') + '">' +
        (t.status === 'done' ? '已完成' : t.status === 'paused' ? '暂停中' : daysLeft(t) < 0 ? '逾期 ' + (-daysLeft(t)) + ' 天' : daysLeft(t) === 0 ? '今天到期' : '剩 ' + daysLeft(t) + ' 天') + '</div>'
        : '<span class="muted">未排期</span>') + '</td>' +
      '<td class="muted mono">' + (t.estimate ? t.estimate + 'h' : '—') + '</td></tr>';
  });
  h += '</tbody></table></div>';
  return h;
}

/* ------------------------------------------------------------ 时间线 */
function viewTimeline() {
  const dated = S.data.tasks.filter(t => t.start_date || t.due_date);
  const doneCount = dated.filter(t => t.status === 'done').length;
  // 默认不显示已完成，勾选后才参与绘制（也不参与时间轴范围计算）
  const tasks = S.tlDone ? dated.slice() : dated.filter(t => t.status !== 'done');
  if (!tasks.length) {
    return '<div class="empty">还没有可排期的事务' +
      (!S.tlDone && doneCount ? '（已有 ' + doneCount + ' 项已完成，勾选下方「显示已完成」可查看）' : '') + '</div>' +
      tlDoneToggle(doneCount);
  }
  const tD = parse(S.today);
  let minD = S.today, maxD = S.today;
  tasks.forEach(t => {
    const s = t.start_date || t.due_date, e = t.due_date || t.start_date;
    if (s < minD) minD = s;
    if (e > maxD) maxD = e;
  });

  /* 双段轴：近期 3 个月按天（看清单条短任务），再往后按月压缩（长任务也不丢） */
  const GAP = 12;
  const nearStart = (parse(minD) < parse(addDays(S.today, -7)) ? minD : addDays(S.today, -7));
  let nearEnd = addDays(S.today, 90);
  if (parse(nearEnd) > parse(maxD)) nearEnd = addDays(maxD, 5);
  const hasFar = parse(maxD) > parse(nearEnd);
  const farEnd = addDays(maxD, 5);

  const nearDays = diffDays(parse(nearStart), parse(nearEnd)) + 1;
  const farDays = hasFar ? diffDays(parse(addDays(nearEnd, 1)), parse(farEnd)) + 1 : 0;
  const nearPx = Math.max(9, Math.min(26, 1250 / nearDays));
  const farPx = hasFar ? Math.max(1.1, Math.min(5, 240 / farDays)) : 0;
  const nearW = nearDays * nearPx;
  const farW = farDays * farPx;
  const width = Math.round(nearW + (hasFar ? GAP + farW : 0));

  // 日期 → x
  const xOf = ds => {
    if (ds <= nearEnd || !hasFar) {
      return Math.max(0, Math.min(nearDays - 1, diffDays(parse(nearStart), parse(ds)))) * nearPx;
    }
    return nearW + GAP + diffDays(parse(addDays(nearEnd, 1)), parse(ds)) * farPx;
  };

  // 顶部月份条（含远期压缩段）
  let bands = [];
  const pushBand = (from, to) => {
    let cur = new Date(parse(from).getTime());
    const stop = parse(to);
    while (cur <= stop) {
      const next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      const segEnd = next <= stop ? new Date(next.getTime() - DAY) : stop;
      bands.push({
        left: xOf(iso(cur)), w: xOf(iso(segEnd)) - xOf(iso(cur)) + (hasFar && iso(cur) > nearEnd ? farPx : nearPx),
        label: (segEnd.getFullYear() !== parse(nearStart).getFullYear() && cur.getMonth() === 0) ? cur.getFullYear() + '/' + (cur.getMonth() + 1) + ' 月' : (cur.getMonth() + 1) + ' 月'
      });
      cur = next;
    }
  };
  pushBand(nearStart, nearEnd);
  if (hasFar) pushBand(addDays(nearEnd, 1), farEnd);

  // 刻度
  const ticks = [];
  for (let i = 0; i < nearDays; i++) {
    const d = new Date(parse(nearStart).getTime() + i * DAY);
    ticks.push({
      left: i * nearPx, w: nearPx, label: String(d.getDate()),
      cls: ((d.getDay() === 0 || d.getDay() === 6) ? 'weekend ' : '') + (iso(d) === S.today ? 'today' : '')
    });
  }
  if (hasFar) {
    let cur = parse(addDays(nearEnd, 1));
    const stop = parse(farEnd);
    while (cur <= stop) {
      const next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      const segEnd = next <= stop ? new Date(next.getTime() - DAY) : stop;
      ticks.push({
        left: xOf(iso(cur)), w: xOf(iso(segEnd)) - xOf(iso(cur)) + farPx,
        label: (cur.getMonth() + 1) + ' 月', cls: 'month'
      });
      cur = next;
    }
  }

  const outside = tasks.filter(t => (t.start_date || t.due_date) < nearStart);
  const inWin = tasks.filter(t => outside.indexOf(t) < 0);
  const tIdx = diffDays(parse(nearStart), tD);

  let h = '<div class="card tl-wrap"><div class="tl" style="width:' + (156 + width) + 'px">';
  h += '<div class="tl-head"><div class="tl-name-col">成员 / 事务</div><div class="tl-days" style="width:' + width + 'px">';
  h += '<div class="tl-months">' + bands.map(b => '<div class="tl-month" style="left:' + b.left + 'px;width:' + b.w + 'px">' + (b.w < 16 ? '' : b.label) + '</div>').join('') + '</div>';
  h += '<div class="tl-dnums">' + ticks.map(t => '<div class="tl-tick ' + t.cls + '" style="left:' + t.left + 'px;width:' + t.w + 'px">' + t.label + '</div>').join('') +
    (hasFar ? '<div class="tl-break" style="left:' + nearW + 'px;width:' + GAP + 'px"></div>' : '') + '</div>';
  h += '</div></div>';

  const tlMembers = S.data.members.filter(m => m.active !== 0).slice().sort((a, b) => {
    const am = S.me && a.id === S.me.id, bm = S.me && b.id === S.me.id;
    if (am !== bm) return am ? -1 : 1;
    return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
  });
  tlMembers.concat([{ id: 0, name: '未指派', color: '#94a3b8', role: '' }]).forEach(m => {
    const mine = inWin.filter(t => (t.member_id || 0) === m.id);
    const far = outside.filter(t => (t.member_id || 0) === m.id);
    if (!mine.length && !far.length) return;
    mine.sort((a, b) => (a.start_date || a.due_date) < (b.start_date || b.due_date) ? -1 : 1);
    const rowH = Math.max(40, (mine.length + (far.length ? 1 : 0)) * 26 + 12);
    h += '<div class="tl-row"><div class="who">' + avatar(m, 'sm') + '<span>' + esc(m.name) + '</span><span class="muted" style="font-weight:400;font-size:11px;margin-left:auto">' + (mine.length + far.length) + '</span></div>';
    h += '<div class="tl-lane" style="width:' + width + 'px;height:' + rowH + 'px">';
    h += '<div class="tl-grid">' + ticks.map(t => '<i class="' + t.cls + '" style="left:' + t.left + 'px;width:' + t.w + 'px"></i>').join('') +
      (hasFar ? '<div class="tl-break" style="left:' + nearW + 'px;width:' + GAP + 'px"></div>' : '') + '</div>';
    if (tIdx >= 0 && tIdx < nearDays) {
      h += '<div class="tl-today-line" style="left:' + (tIdx * nearPx) + 'px"></div>';
    }
    mine.forEach((t, i) => {
      const s = t.start_date || t.due_date, e = t.due_date || t.start_date;
      const x1 = xOf(s) + 1, x2 = xOf(e) + (e <= nearEnd ? nearPx : farPx) - 1;
      const st = STATUS[t.status];
      const wPx = Math.max(6, Math.min(x2 - x1, width - x1 - 1));
      h += '<div class="gbar' + (t.status === 'done' ? ' done' : '') + (wPx < 52 ? ' tiny' : '') + (x2 - x1 > wPx + 1 ? ' clipped' : '') + '" data-task="' + t.id + '" title="' + esc(t.title + ' · ' + fmt(s) + ' ~ ' + fmt(e) + ' · ' + t.progress + '%') + '" ' +
        'style="left:' + x1 + 'px;width:' + wPx + 'px;top:' + (8 + i * 26) + 'px;position:absolute;background:' + st.color + ';--prog:' + t.progress + '%">' +
        '<span class="lbl">' + esc(t.title) + '</span></div>';
    });
    if (far.length) {
      h += '<div class="tl-far" style="top:' + (8 + mine.length * 26) + 'px">' + far.length + ' 项早于窗口：' +
        far.map(t => '<a data-task="' + t.id + '">' + esc(t.title) + '</a><span class="muted">' + fmt(t.start_date || t.due_date) + '</span>').join(' · ') + '</div>';
    }
    h += '</div></div>';
  });
  h += '</div></div>';

  h += '<div class="tl-legend">' + ORDER.map(s => '<span><i style="background:' + STATUS[s].color + '"></i>' + STATUS[s].label + '</span>').join('') +
    '<span><i style="background:#4f46e5"></i>今天</span>' + tlDoneToggle(doneCount) +
    (hasFar ? '<span class="muted">左侧按天到 ' + fmt(nearEnd) + '，之后按月压缩（虚线处断开）</span>' : '') +
    '</div>';
  return h;
}

function tlDoneToggle(n) {
  return '<label class="tl-done-toggle"><input type="checkbox" data-tl-done' + (S.tlDone ? ' checked' : '') + '> 显示已完成' +
    (n ? '<span class="n">' + n + '</span>' : '') + '</label>';
}

/* ------------------------------------------------------------ KPI */
function viewKpi() {
  const members = S.data.members.filter(m => m.active !== 0);
  let h = '<div class="filters"><span class="muted" style="font-size:12.5px">指标每周期手动更新当前值；绿色为达标，黄色接近，红色未达标。</span>' +
    '<span style="margin-left:auto"></span><button class="btn sm" id="btn-add-kpi">＋ 新增指标</button></div>';
  h += '<div class="kpi-grid">';
  members.forEach(m => {
    const kpis = S.data.kpis.filter(k => k.member_id === m.id);
    const score = kpiScore(kpis);
    h += '<div class="card kpi-card"><div class="head">' + avatar(m, 'lg') +
      '<div><div class="nm">' + esc(m.name) + '</div><div class="rl">' + esc(m.role || '') + ' · ' + kpis.length + ' 项指标</div></div>' +
      '<div class="score">' + (score === null ? '<b class="mono">—</b>未设目标' : '<b class="mono">' + score + '%</b>综合达成') + '</div></div>';
    if (!kpis.length) h += '<div class="empty" style="padding:18px">还没有 KPI 指标</div>';
    kpis.forEach(k => {
      const hasTarget = !!(k.target && k.target > 0);
      const rate = hasTarget ? (k.direction === 'down' ? (k.current ? k.target / k.current : 0) : k.current / k.target) : 0;
      const pct = hasTarget ? Math.round(Math.min(1.6, rate) / 1.6 * 100) : 0;
      const cls = rate >= 1 ? 'ok' : rate >= 0.85 ? 'warn' : 'bad';
      h += '<div class="kpi-row" data-kpi="' + k.id + '">' +
        '<div class="r1">' +
          (k.cat ? '<span class="cat">' + esc(k.cat) + '</span>' : '') +
          '<span class="name" title="' + esc(k.name) + '">' + esc(k.name) + '</span>' +
          '<span class="weight">' + (+k.weight) + '%</span>' +
        '</div>' +
        '<div class="r2">' +
          '<div class="bar"><i class="' + (hasTarget ? cls : '') + '" style="width:' + pct + '%"></i></div>' +
          (hasTarget
            ? '<span class="st mono">' + k.current + ' / ' + k.target + ' ' + esc(k.unit) + '</span>' +
              '<span class="st strong">' + Math.round(rate * 100) + '%</span>' +
              '<span class="adj"><button data-kpi-adj="-1" data-id="' + k.id + '" title="减少">−</button><button data-kpi-adj="1" data-id="' + k.id + '" title="增加">＋</button></span>'
            : '<span class="st">未设目标值</span>' +
              '<button class="btn sm ghost" data-kpi-adj="0" data-id="' + k.id + '">设目标</button>') +
          (k.direction === 'down' ? '<span class="dir">越低越好</span>' : '') +
        '</div></div>';
    });
    h += '</div>';
  });
  h += '</div>';
  return h;
}

/* ------------------------------------------------------------ 提醒 */
function viewAlerts() {
  const rem = buildReminders();
  const groups = ['overdue', 'blocked', 'soon', 'stalled', 'nodate'];
  let h = '<div class="section-title">待处理提醒<span class="count">共 ' + rem.length + ' 条</span></div>';
  if (!rem.length) return h + '<div class="empty">所有事务都在计划内，没有需要提醒的事项 🎉</div>';
  groups.forEach(g => {
    const list = rem.filter(r => r.kind === g);
    if (!list.length) return;
    const meta = REM_META[g];
    h += '<div class="section-title" style="margin-top:22px"><span style="color:' + meta.color + '">' + meta.icon + '</span>' + meta.label +
      '<span class="count">' + list.length + '</span></div><div class="card"><div class="reminder-list">';
    list.forEach(r => {
      const t = r.task;
      h += '<div class="rem"><span class="ic" style="color:' + meta.color + '">' + meta.icon + '</span>' +
        '<div class="body"><div class="t" data-task="' + t.id + '" style="cursor:pointer">' + esc(t.title) + '</div>' +
        '<div class="m">' + esc(r.member) + ' · ' + esc(r.text) + ' · 截止 ' + fmt(t.due_date) + ' · 进度 ' + t.progress + '%</div></div>' +
        '<div class="act">' +
        (t.status !== 'done' ? '<button class="btn sm" data-quick="done" data-id="' + t.id + '">标记完成</button>' : '') +
        (t.due_date ? '<button class="btn sm" data-quick="postpone" data-id="' + t.id + '">延期 3 天</button>' : '') +
        '<button class="btn sm ghost" data-task="' + t.id + '">详情</button></div></div>';
    });
    h += '</div></div>';
  });
  return h;
}

/* ------------------------------------------------------------ 周报 */
function viewReport() {
  const wk = S.reportWeek || weekOf(S.today);
  S.reportWeek = wk;
  const end = addDays(wk, 6);
  const d = S.reportData;
  if (!d || d.week !== wk) {
    loadWeek(wk);
    return '<div class="empty">正在读取本周提交情况…</div>';
  }
  const submitted = d.submitted || [];
  const total = d.members.length;
  const mine = S.me ? d.reports.find(r => r.member_id === S.me.id) : null;
  const isThisWeek = wk === weekOf(S.today);

  let h = '<div class="week-nav">' +
    '<button class="btn sm" data-week="-1">← 上一周</button>' +
    '<span class="lbl">' + wk.replace(/-/g, '/') + ' ~ ' + end.replace(/-/g, '/') + (isThisWeek ? '（本周）' : '') + '</span>' +
    '<button class="btn sm" data-week="1"' + (isThisWeek ? ' disabled' : '') + '>下一周 →</button>' +
    '<span style="margin-left:auto"></span>' +
    '<span class="chip ' + (d.all_submitted ? 'done' : 'soon') + '">已提交 ' + submitted.length + ' / ' + total + '</span></div>';

  h += '<div class="grid-2">';
  h += '<div class="card pad"><div class="section-title" style="margin-top:0">我的周报' +
    '<span class="count">' + (S.me ? esc(S.me.name) + ' · ' + esc(S.ip) : '未识别身份') + '</span></div>';
  if (!S.me) {
    h += '<div class="empty">先点右上角选择「我是谁」，才能填写和提交自己的周报。</div>';
  } else {
    h += '<textarea class="report-editor" id="my-report" placeholder="本周做了什么、下周计划、遇到的问题和需要的支持…">' +
      esc(mine ? mine.content : '') + '</textarea>';
    h += '<div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">' +
      '<button class="btn primary" id="btn-submit-report">' + (mine ? '更新周报' : '提交周报') + '</button>' +
      '<button class="btn" id="btn-draft-report">带入我的统计</button>' +
      (mine
        ? '<span class="muted" style="font-size:11.5px">已提交于 ' + esc(fmtFull(mine.submitted_at)) + ' · 可修改后重新提交</span>'
        : '<span class="muted" style="font-size:11.5px">提交后全员可见，并自动进入团队周报</span>') +
      '</div>';
  }
  h += '</div>';

  h += '<div class="card" style="overflow:hidden"><div class="sub-head"><b>提交情况</b>' +
    (submitted.length ? '<button class="btn sm ghost" id="btn-all-reports">看全部原文</button>' : '') + '</div><div>';
  d.members.forEach(m => {
    const rep = d.reports.find(r => r.member_id === m.id);
    h += '<div class="sub-row' + (rep ? ' clickable' : '') + '"' + (rep ? ' data-report="' + m.id + '" title="点击看原文"' : '') + '>' +
      avatar(m, 'sm') + '<span>' + esc(m.name) + '</span>' +
      '<span class="muted" style="font-size:11px">' + esc(m.role || '') + '</span>' +
      (rep ? '<span class="st ok">已提交 ' + esc((rep.submitted_at || '').slice(5, 16)) + '</span>' +
             '<span class="view-raw">原文 →</span>'
        : '<span class="st no">未提交</span>') + '</div>';
  });
  h += '</div>' + (d.all_submitted ? '' :
    '<div style="padding:10px 16px;font-size:11.5px;color:#b45309;background:#fffbf3;border-top:1px solid #f5e6cd">还有 ' +
    (total - submitted.length) + ' 人未提交，可以先出一份草稿。</div>') + '</div>';
  h += '</div>';

  h += '<div class="section-title" style="margin-top:24px">团队周报<span class="count">' +
    wk.replace(/-/g, '/') + ' ~ ' + end.replace(/-/g, '/') + '</span></div>';
  h += '<div class="report-bar">' +
    '<button class="btn primary" id="btn-gen-report"' + (d.all_submitted ? '' : ' disabled') + '>生成团队周报</button>' +
    (d.all_submitted ? '' : '<button class="btn" id="btn-gen-force">先生成草稿</button>') +
    '<button class="btn" id="btn-copy-report">复制</button>' +
    '<button class="btn" id="btn-dl-report">下载 .md</button>' +
    '<span class="muted" style="font-size:12px;margin-left:auto">' +
    (d.all_submitted ? '全员已提交，可以出正式周报' : '全员提交后解锁') + '</span></div>';
  h += '<div class="card"><div class="report-pre" id="report-body">' +
    (S.reportMd && S.reportMdWeek === wk ? mdToHtml(S.reportMd)
      : '点击「生成团队周报」，汇总本周完成、进行中、逾期风险、下周计划，以及每位成员提交的周报原文。') + '</div></div>';
  return h;
}

async function loadWeek(wk) {
  S.reportWeek = wk;
  try {
    S.reportData = await api('/api/reports?week=' + wk);
  } catch (e) {
    S.reportData = null;
    toast(e.message, true);
  }
  if (S.view === 'report') render();
}

function renderReportBox() {
  const box = document.getElementById('report-body');
  if (!box || !S.reportMd || S.reportMdWeek !== S.reportWeek) return;
  box.innerHTML = mdToHtml(S.reportMd);
}

async function genReport(force) {
  const wk = S.reportWeek;
  const d = S.reportData || {};
  if (!force && !d.all_submitted) return toast('还有成员没提交周报', true);
  try {
    const j = await api('/api/report?start=' + wk + '&end=' + addDays(wk, 6));
    S.reportMd = j.markdown;
    S.reportMdWeek = wk;
    render();
    toast(force ? '已生成草稿（含未提交名单）' : '团队周报已生成');
  } catch (e) { toast(e.message, true); }
}

async function fillDraft() {
  try {
    const j = await api('/api/reports/draft?week=' + S.reportWeek);
    const ta = document.getElementById('my-report');
    if (!ta) return;
    if (ta.value.trim() && !confirm('会覆盖当前已写的内容，继续？')) return;
    ta.value = j.content;
    toast('已按你本周的事务生成草稿，补充说明后提交');
  } catch (e) { toast(e.message, true); }
}

async function submitReport() {
  const ta = document.getElementById('my-report');
  if (!ta) return;
  const content = ta.value.trim();
  if (content.length < 10) return toast('再写详细一点（至少 10 个字）', true);
  const btn = document.getElementById('btn-submit-report');
  if (btn) btn.disabled = true;
  try {
    await api('/api/reports', 'POST', { week_start: S.reportWeek, content });
    await loadWeek(S.reportWeek);
    toast('周报已提交');
  } catch (e) {
    toast(e.message, true);
    if (btn) btn.disabled = false;
  }
}

function mdToHtml(md) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const out = [];
  let list = [], table = [];
  const flushList = () => { if (list.length) { out.push('<ul>' + list.map(x => '<li>' + x + '</li>').join('') + '</ul>'); list = []; } };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter(l => !/^\|[\s\-:|]+\|$/.test(l)).map(l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
    if (rows.length) {
      out.push('<table class="md-table"><thead><tr>' + rows[0].map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.slice(1).map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
    }
    table = [];
  };
  md.split('\n').forEach(raw => {
    const l = raw.trim();
    if (/^\|/.test(l)) { table.push(l); return; } else flushTable();
    if (/^-\s/.test(l)) { list.push(inline(l.slice(2))); return; } else flushList();
    if (/^##\s/.test(l)) out.push('<h3>' + inline(l.slice(3)) + '</h3>');
    else if (/^#\s/.test(l)) out.push('<h2>' + inline(l.slice(2)) + '</h2>');
    else if (/^>\s/.test(l)) out.push('<blockquote>' + inline(l.slice(2)) + '</blockquote>');
    else if (l) out.push('<p>' + inline(l) + '</p>');
  });
  flushList(); flushTable();
  return out.join('');
}

/* ------------------------------------------------------------ 团队 */
function viewTeam() {
  const members = S.data.members;
  const admin = !!S.local;
  let h = '<div class="section-title">成员<span class="count">' + members.filter(m => m.active !== 0).length + ' 人在职</span><span class="spacer"></span>' +
    (admin
      ? '<button class="btn sm ghost" id="btn-reset" style="color:#b91c1c">清空数据</button>' +
        '<button class="btn sm" id="btn-add-member" style="margin-left:8px">＋ 添加成员</button>'
      : '<span class="muted" style="font-size:11.5px">成员增改请在本机用 localhost 打开</span>') + '</div>';
  h += '<div class="card" style="overflow:hidden"><table class="list"><thead><tr>' +
    '<th>成员</th><th>职责</th><th>IP 地址（身份识别）</th><th>进行中</th><th>本周完成</th><th>KPI</th><th style="text-align:right">操作</th></tr></thead><tbody>';
  members.filter(m => m.active !== 0).forEach(m => {
    const mine = S.data.tasks.filter(t => t.member_id === m.id);
    const doing = mine.filter(t => t.status !== 'done').length;
    const done = mine.filter(t => t.status === 'done' && t.done_at && t.done_at.slice(0, 10) >= weekOf(S.today)).length;
    const kpis = S.data.kpis.filter(k => k.member_id === m.id);
    const isMe = S.me && S.me.id === m.id;
    h += '<tr><td><div class="owner">' + avatar(m) + '<div><b>' + esc(m.name) + '</b>' +
      (m.phone_mask ? '<div class="muted" style="font-size:10.5px">' + esc(m.phone_mask) + '</div>' : '') + '</div>' +
      (isMe ? '<span class="chip" style="background:#eef0ff;color:#3730a3">我</span>' : '') + '</div></td>' +
      '<td class="muted">' + esc(m.role || '—') + '</td>' +
      '<td>' + (m.ip ? '<span class="mono" style="font-size:12px">' + esc(m.ip) + '</span>' + (m.last_seen ? '<div class="muted" style="font-size:10.5px">最近 ' + esc(m.last_seen.slice(5, 16)) + '</div>' : '') : '<span class="muted" style="font-size:12px">未绑定</span>') + '</td>' +
      '<td class="mono">' + doing + ' 项</td><td class="mono">' + done + ' 项</td>' +
      '<td>' + (kpiScore(kpis) === null ? '<span class="muted" style="font-size:11px">未设目标</span>' : '<div class="pbar"><div class="bar"><i style="width:' + Math.min(100, kpiScore(kpis)) + '%"></i></div><span class="mono">' + kpiScore(kpis) + '%</span></div>') + '</td>' +
      '<td style="text-align:right;white-space:nowrap">' +
      (admin ? '<button class="btn sm ghost" data-avatar="' + m.id + '">头像</button>' +
        '<button class="btn sm ghost" data-edit-member="' + m.id + '">编辑</button>'
        : '<span class="muted" style="font-size:11px">—</span>') + '</td></tr>';
  });
  h += '</tbody></table></div>';

  h += '<div class="section-title" style="margin-top:26px">每个成员的事务分布</div><div class="member-cards">';
  members.filter(m => m.active !== 0).forEach(m => {
    const mine = S.data.tasks.filter(t => t.member_id === m.id);
    h += '<div class="card pad member-dist" data-jump-member="' + m.id + '" title="查看看板中 ' + esc(m.name) + ' 的事务"><div style="display:flex;align-items:center;gap:9px">' + avatar(m) + '<b>' + esc(m.name) + '</b>' +
      '<span class="muted" style="margin-left:auto;font-size:11.5px">' + mine.length + ' 项总计</span></div>' +
      '<div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap">' +
      ORDER.map(s => { const n = mine.filter(t => t.status === s).length; if (!n) return ''; return '<span class="chip ' + s + '">' + STATUS[s].label + ' ' + n + '</span>'; }).join('') +
      (mine.length ? '' : '<span class="muted" style="font-size:12px">暂无事务</span>') +
      '</div><div style="margin-top:12px;font-size:12px" class="muted">合计预估 ' + mine.reduce((a, t) => a + (t.estimate || 0), 0) + ' 小时</div></div>';
  });
  h += '</div>';
  return h;
}

/* ------------------------------------------------------------ 头像上传 */
function resizeImage(file, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const s = Math.min(img.width, img.height);
      g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片无法读取')); };
    img.src = url;
  });
}

function pickAvatar(mid) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/png,image/jpeg,image/webp';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    if (f.size > 12 * 1024 * 1024) return toast('图片太大，换一张小一点的', true);
    try {
      const dataUrl = await resizeImage(f, 256);
      await act(() => api('/api/members/' + mid + '/avatar', 'POST', { data: dataUrl }), '头像已更新');
    } catch (e) { toast(e.message || '图片处理失败', true); }
  };
  inp.click();
}

/* ------------------------------------------------------------ 任务详情抽屉 */
function renderDrawer() {
  const id = S.openTask;
  const isNew = id === 'new';
  const t = isNew ? null : S.data.tasks.find(x => x.id === id);
  if (!isNew && !t) { closeDrawer(); return; }
  const d = t || {
    title: '', detail: '', member_id: (S.me ? S.me.id : ((S.data.members.filter(x => x.active !== 0)[0] || {}).id || null)),
    status: S.pendingStatus || 'todo', priority: 'P1', category: '需求', progress: 0,
    start_date: S.today, due_date: addDays(S.today, 7), estimate: 0
  };
  const drawer = document.getElementById('drawer');
  drawer.innerHTML =
    '<div class="drawer-head"><span class="t">' + (isNew ? '新建事务' : '事务详情') + '</span>' +
    '<span class="muted mono" style="font-size:11px">' + (t ? '#' + t.id : '') + '</span>' +
    '<button class="btn ghost sm x" id="drawer-x">✕</button></div>' +
    '<div class="drawer-body">' +
    '<div class="form-row"><label>标题</label><input type="text" id="f-title" value="' + esc(d.title) + '" placeholder="要做什么"></div>' +
    '<div class="form-row"><label>负责人</label><select id="f-member">' +
      S.data.members.filter(m => m.active !== 0).map(m => '<option value="' + m.id + '"' + (m.id === d.member_id ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('') +
      '</select></div>' +
    '<div class="form-row split"><label>状态</label><div class="two"><select id="f-status">' +
      ORDER.map(s => '<option value="' + s + '"' + (s === d.status ? ' selected' : '') + '>' + STATUS[s].label + '</option>').join('') + '</select>' +
      '<select id="f-priority">' + Object.keys(PRIO).map(p => '<option value="' + p + '"' + (p === d.priority ? ' selected' : '') + '>' + PRIO_LABEL[p] + '</option>').join('') + '</select></div></div>' +
    '<div class="form-row"><label>类型</label><select id="f-category">' +
      ['需求', '任务', '其他'].map(c => '<option value="' + c + '"' + (c === d.category ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></div>' +
    '<div class="form-row"><label>开始</label><input type="date" id="f-start" value="' + esc(d.start_date || '') + '"></div>' +
    '<div class="form-row"><label>截止</label><input type="date" id="f-due" value="' + esc(d.due_date || '') + '"></div>' +
    '<div class="form-row"><label>进度</label><div style="display:flex;align-items:center;gap:10px"><input type="range" id="f-progress" min="0" max="100" step="5" value="' + d.progress + '" style="flex:1"><span class="mono" id="f-progress-v" style="width:38px;text-align:right;font-size:12.5px">' + d.progress + '%</span></div></div>' +
    '<div class="form-row"><label>预估工时</label><input type="number" id="f-estimate" min="0" step="0.5" value="' + (d.estimate || 0) + '"></div>' +
    '<div class="form-row" style="align-items:start"><label style="padding-top:6px">说明</label><textarea id="f-detail" placeholder="背景、验收标准、依赖…">' + esc(d.detail) + '</textarea></div>' +
    (t ? '<div class="section-title" style="margin-top:22px">进展记录<span class="count">' + taskUpdates(t.id).length + '</span></div>' +
      '<div class="updates">' + (taskUpdates(t.id).map(u => {
        const m = memberById(u.member_id);
        return '<div class="upd">' + avatar(m, 'sm') + '<div class="body"><div class="txt' + (u.kind === 'system' ? ' sys' : '') + '">' + esc(u.content) + '</div>' +
          '<div class="when">' + esc((m ? m.name : '') + ' · ' + fmtFull(u.created_at)) + '</div></div></div>';
      }).join('') || '<div class="muted" style="font-size:12px;padding:8px 0">还没有进展记录</div>') + '</div>' +
      '<div class="upd-input"><textarea id="f-upd" placeholder="记录一条进展（⌘/Ctrl + Enter 提交）"></textarea><button class="btn" id="btn-add-upd">添加</button></div>' +
      '<div class="muted" style="font-size:11px;margin-top:6px">将以 <b>' + esc(S.me ? S.me.name : '未识别身份') + '</b> 的身份记录' + (S.me ? '（' + esc(S.ip) + '）' : '') + '</div>' +
      taskLogsHtml(t.id) : '') +
    '</div>' +
    '<div class="drawer-foot">' +
    '<button class="btn primary" id="btn-save">' + (isNew ? '创建事务' : '保存修改') + '</button>' +
    (t ? '<button class="btn" id="btn-done">' + (t.status === 'done' ? '重新打开' : '标记完成') + '</button>' : '') +
    '<span class="spacer"></span>' +
    (t ? '<button class="btn danger sm" id="btn-del">删除</button>' : '') +
    '</div>';
  drawer.classList.add('show');
  document.getElementById('overlay').classList.add('show');

  const rg = document.getElementById('f-progress');
  rg.addEventListener('input', () => { document.getElementById('f-progress-v').textContent = rg.value + '%'; });
  if (t) {
    document.getElementById('btn-add-upd').addEventListener('click', addUpdate);
    document.getElementById('f-upd').addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') addUpdate(); });
    document.getElementById('btn-done').addEventListener('click', async () => {
      await act(() => api('/api/tasks/' + t.id, 'PATCH', { status: t.status === 'done' ? 'doing' : 'done' }), t.status === 'done' ? '已重新打开' : '已标记完成');
      S.openTask = null;
    });
    document.getElementById('btn-del').addEventListener('click', async () => {
      if (!confirm('确定删除「' + t.title + '」？进展记录也会一并删除。')) return;
      await act(() => api('/api/tasks/' + t.id, 'DELETE'), '已删除');
      S.openTask = null;
    });
  }
  document.getElementById('btn-save').addEventListener('click', saveTask);
}

function collectTask() {
  const v = k => document.getElementById(k).value;
  return {
    title: v('f-title').trim(),
    member_id: +v('f-member') || null,
    status: v('f-status'),
    priority: v('f-priority'),
    category: v('f-category'),
    start_date: v('f-start') || null,
    due_date: v('f-due') || null,
    progress: +v('f-progress') || 0,
    estimate: +v('f-estimate') || 0,
    detail: v('f-detail')
  };
}

async function saveTask() {
  const p = collectTask();
  if (!p.title) return toast('请填写标题', true);
  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  try {
    if (S.openTask === 'new') {
      const j = await api('/api/tasks', 'POST', p);
      S.openTask = null;
      await reload();
      toast('事务已创建');
    } else {
      await api('/api/tasks/' + S.openTask, 'PATCH', p);
      await reload();
      toast('已保存');
    }
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
}

async function addUpdate() {
  const el = document.getElementById('f-upd');
  const txt = el.value.trim();
  if (!txt) return;
  try {
    await api('/api/tasks/' + S.openTask + '/updates', 'POST', { content: txt });
    el.value = '';
    await reload();
    toast('进展已记录');
  } catch (e) { toast(e.message, true); }
}

async function act(fn, okMsg) {
  try { await fn(); await reload(); toast(okMsg || '已更新'); }
  catch (e) { toast(e.message, true); }
}

function openTask(id, status) {
  S.openTask = id;
  S.pendingStatus = status || null;
  renderDrawer();
}
function closeDrawer() {
  S.openTask = null;
  document.getElementById('drawer').classList.remove('show');
  document.getElementById('overlay').classList.remove('show');
}

/* ------------------------------------------------------------ modal */
function openModal(cfg) {
  const modal = document.getElementById('modal');
  const overlay = document.getElementById('overlay');
  modal.className = 'modal';
  modal.innerHTML = '<div class="drawer-head" style="border-radius:16px 16px 0 0"><span class="t">' + esc(cfg.title) + '</span><button class="btn ghost sm x" data-mclose>✕</button></div>' +
    '<div style="padding:18px 20px">' + cfg.body + '</div>' +
    '<div class="drawer-foot" style="border-radius:0 0 16px 16px"><button class="btn primary" data-mok>' + (cfg.okText || '保存') + '</button><span class="spacer"></span><button class="btn ghost" data-mclose>取消</button></div>';
  modal.classList.add('show');
  overlay.classList.add('show');
  overlay.dataset.modal = '1';
  const close = () => { modal.classList.remove('show'); if (!document.getElementById('drawer').classList.contains('show')) overlay.classList.remove('show'); overlay.dataset.modal = ''; };
  modal.querySelectorAll('[data-mclose]').forEach(b => b.addEventListener('click', close));
  modal.querySelector('[data-mok]').addEventListener('click', async () => {
    const vals = {};
    modal.querySelectorAll('[data-k]').forEach(el => { vals[el.dataset.k] = el.value; });
    try { await cfg.onSubmit(vals); close(); } catch (e) { toast(e.message, true); }
  });
  const first = modal.querySelector('input,select,textarea');
  if (first) first.focus();
}

function kpiEdit(k) {
  const body =
    '<div class="form-row"><label>指标</label><input type="text" data-k="name" value="' + esc(k.name) + '"></div>' +
    '<div class="form-row"><label>类别</label><input type="text" data-k="cat" value="' + esc(k.cat || '') + '" placeholder="产品研发 / 服务质量 / ai提效 / 能力建设"></div>' +
    '<div class="form-row split"><label>目标 / 当前</label><div class="two"><input type="number" step="0.1" data-k="target" value="' + (k.target || '') + '" placeholder="目标值"></div></div>' +
    '<div class="form-row split"><label>当前 / 单位</label><div class="two"><input type="number" step="0.1" data-k="current" value="' + (k.current || 0) + '"><input type="text" data-k="unit" value="' + esc(k.unit || '') + '" placeholder="% / 个 / 天"></div></div>' +
    '<div class="form-row"><label>权重 %</label><input type="number" step="0.1" min="0" data-k="weight" value="' + (+k.weight) + '"></div>';
  openModal({
    title: '编辑 KPI', body, okText: '保存',
    onSubmit: async v => {
      await api('/api/kpis/' + k.id, 'PATCH', {
        name: v.name, cat: v.cat, unit: v.unit,
        target: v.target || 0, current: v.current || 0, weight: v.weight || 0
      });
      await reload();
      toast('已保存');
    }
  });
}

function kpiModal(memberId) {
  const members = S.data.members.filter(m => m.active !== 0);
  const body =
    '<div class="form-row"><label>成员</label><select data-k="member_id">' +
      members.map(m => '<option value="' + m.id + '"' + (m.id === memberId ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('') + '</select></div>' +
    '<div class="form-row"><label>指标名</label><input type="text" data-k="name" placeholder="如：工单按时关闭率"></div>' +
    '<div class="form-row split"><label>目标 / 当前</label><div class="two"><input type="number" step="0.1" data-k="target" placeholder="目标"><input type="number" step="0.1" data-k="current" placeholder="当前"></div></div>' +
    '<div class="form-row"><label>单位</label><input type="text" data-k="unit" placeholder="% / 个 / 天 / 小时"></div>' +
    '<div class="form-row split"><label>周期 / 方向</label><div class="two"><select data-k="period"><option value="month">月度</option><option value="week">周度</option><option value="quarter">季度</option></select>' +
    '<select data-k="direction"><option value="up">越高越好</option><option value="down">越低越好</option></select></div></div>' +
    '<div class="form-row"><label>权重</label><input type="number" min="1" max="5" data-k="weight" value="2"></div>';
  openModal({
    title: '新增 KPI 指标', body, okText: '添加',
    onSubmit: async v => {
      if (!v.name.trim()) throw new Error('请填写指标名');
      await api('/api/kpis', 'POST', v);
      await reload();
      toast('指标已添加');
    }
  });
}

/* ------------------------------------------------------------ events */
document.addEventListener('click', async e => {
  const nav = e.target.closest('[data-view]');
  if (nav) { S.view = nav.dataset.view; render(); window.scrollTo(0, 0); return; }
  const jump = e.target.closest('[data-view-jump]');
  if (jump) { S.view = jump.dataset.viewJump; render(); return; }

  // 成员卡：点人 → 看板 + 按该成员过滤（点卡里的具体事务仍然先打开抽屉）
  const mjump = e.target.closest('[data-jump-member]');
  if (mjump && !e.target.closest('[data-task]')) {
    S.filter.member = mjump.dataset.jumpMember;
    S.filter.status = '';
    S.view = 'kanban';
    render();
    window.scrollTo(0, 0);
    return;
  }

  const tlDone = e.target.closest('[data-tl-done]');
  if (tlDone) { S.tlDone = tlDone.checked; render(); return; }

  const card = e.target.closest('[data-task]');
  if (card && !e.target.closest('[data-quick]')) { openTask(+card.dataset.task); return; }

  const nh = e.target.closest('[data-new]');
  if (nh) { openTask('new', nh.dataset.new); return; }

  const quick = e.target.closest('[data-quick]');
  if (quick) {
    const id = +quick.dataset.id;
    const t = S.data.tasks.find(x => x.id === id);
    if (quick.dataset.quick === 'done') await act(() => api('/api/tasks/' + id, 'PATCH', { status: 'done' }), '已完成：' + t.title);
    if (quick.dataset.quick === 'postpone') await act(() => api('/api/tasks/' + id, 'PATCH', { due_date: addDays(t.due_date || S.today, 3) }), '已延期 3 天');
    return;
  }

  const adj = e.target.closest('[data-kpi-adj]');
  if (adj && adj.dataset.kpiAdj === '0') {
    const k0 = S.data.kpis.find(x => x.id === +adj.dataset.id);
    if (k0) kpiEdit(k0);
    return;
  }
  if (adj) {
    const k = S.data.kpis.find(x => x.id === +adj.dataset.id);
    const step = Math.abs(k.target) >= 100 ? 1 : Math.abs(k.target) >= 20 ? 0.5 : 0.1;
    const next = Math.max(0, Math.round(((+k.current || 0) + step * (+adj.dataset.kpiAdj)) * 100) / 100);
    await act(() => api('/api/kpis/' + k.id, 'PATCH', { current: next }), k.name + ' 当前值 ' + next);
    return;
  }
  const krow = e.target.closest('.kpi-row');
  if (krow && e.target.closest('#view')) {
    const k = S.data.kpis.find(x => x.id === +krow.dataset.kpi);
    if (k) { kpiEdit(k); return; }
  }
  if (e.target.id === 'btn-add-kpi') { kpiModal(null); return; }

  if (e.target.id === 'btn-reset') {
    if (!confirm('这会删除所有成员、事务、KPI 与进展记录，用于从示例数据切换到你自己的团队。继续？')) return;
    if (!confirm('再确认一次：清空后无法恢复，确定吗？')) return;
    await act(() => api('/api/reset', 'POST', { seed: false }), '已清空，可以从添加成员开始');
    return;
  }

  if (e.target.id === 'btn-add-member') {
    openModal({
      title: '添加成员', okText: '添加',
      body: '<div class="form-row"><label>姓名</label><input type="text" data-k="name"></div>' +
        '<div class="form-row"><label>职责</label><input type="text" data-k="role" placeholder="如：桌面客户端"></div>' +
        '<div class="form-row"><label>IP 地址</label><input type="text" data-k="ip" placeholder="可留空，首次打开网页时自动绑定"></div>' +
        '<div class="form-row"><label>手机号</label><input type="text" data-k="phone" placeholder="用中间 4 位做验证码，可不填"></div>' +
        '<div class="form-row"><label>周工时</label><input type="number" data-k="capacity" value="40"></div>' +
        '<div class="form-row"><label>头像色</label><input type="text" data-k="color" value="#4f46e5"></div>',
      onSubmit: async v => {
        if (!v.name.trim()) throw new Error('请填写姓名');
        await api('/api/members', 'POST', v);
        await reload(); toast('成员已添加');
      }
    });
    return;
  }

  const em = e.target.closest('[data-edit-member]');
  if (em) {
    const m = memberById(+em.dataset.editMember);
    openModal({
      title: '编辑成员 · ' + m.name, okText: '保存',
      body: '<div class="form-row"><label>头像</label><div class="avatar-pick">' + avatar(m, 'lg') +
          '<button class="btn sm" id="edit-avatar">上传图片</button>' +
          '<span class="muted" style="font-size:11px">正方形裁剪 256px</span></div></div>' +
        '<div class="form-row"><label>姓名</label><input type="text" data-k="name" value="' + esc(m.name) + '"></div>' +
        '<div class="form-row"><label>职责</label><input type="text" data-k="role" value="' + esc(m.role || '') + '"></div>' +
        '<div class="form-row"><label>IP 地址</label><input type="text" data-k="ip" value="' + esc(m.ip || '') + '" placeholder="留空则不按 IP 识别"></div>' +
        '<div class="form-row"><label>手机号</label><input type="text" data-k="phone" value="' + esc(m.phone || '') + '" placeholder="用中间 4 位做验证码"></div>' +
        '<div class="form-row"><label>周工时</label><input type="number" data-k="capacity" value="' + (m.capacity || 40) + '"></div>' +
        '<div class="form-row"><label>头像色</label><input type="text" data-k="color" value="' + esc(m.color) + '"></div>',
      onSubmit: async v => {
        await api('/api/members/' + m.id, 'PATCH', v);
        await reload();
        toast('已保存');
      }
    });
    const ea = document.getElementById('edit-avatar');
    if (ea) ea.addEventListener('click', () => pickAvatar(m.id));
    return;
  }

  if (e.target.id === 'drawer-x') { closeDrawer(); return; }
  if (e.target.id === 'overlay') {
    const mo = document.getElementById('modal');
    if (mo && mo.classList.contains('show')) { closeModal(); return; }
    closeDrawer();
    return;
  }

  if (e.target.id === 'btn-gen-report') { await genReport(false); return; }
  if (e.target.id === 'btn-gen-force') { await genReport(true); return; }
  if (e.target.id === 'btn-submit-report') { await submitReport(); return; }
  if (e.target.id === 'btn-draft-report') { await fillDraft(); return; }
  if (e.target.id === 'btn-who') { showIdentityModal(false); return; }
  if (e.target.closest('[data-iclose]')) { closeModal(); return; }
  if (e.target.closest('[data-guest]')) { showGuestModal(); return; }
  if (e.target.id === 'btn-visits') { showVisitsModal(); return; }
  if (e.target.closest('#btn-all-reports')) { showAllReports(); return; }
  const repRow = e.target.closest('[data-report]');
  if (repRow) { showReportContent(+repRow.dataset.report); return; }
  const pick = e.target.closest('[data-pick]');
  if (pick) { askCode(+pick.dataset.pick); return; }
  const wkBtn = e.target.closest('[data-week]');
  if (wkBtn && !wkBtn.disabled) {
    const wk = addDays(S.reportWeek || weekOf(S.today), 7 * (+wkBtn.dataset.week));
    S.reportMdWeek = '';
    loadWeek(wk);
    return;
  }
  const zoomBtn = e.target.closest('[data-tl]');
  if (zoomBtn) { S.tlZoom = zoomBtn.dataset.tl; render(); return; }
  const av = e.target.closest('[data-avatar]');
  if (av) { pickAvatar(+av.dataset.avatar); return; }
  if (e.target.id === 'btn-copy-report') {
    if (!S.reportMd) return toast('先生成团队周报', true);
    try { await navigator.clipboard.writeText(S.reportMd); toast('已复制到剪贴板'); }
    catch (_) { toast('复制失败，请手动选择文本', true); }
    return;
  }
  if (e.target.id === 'btn-dl-report') {
    if (!S.reportMd) return toast('先生成团队周报', true);
    const blob = new Blob([S.reportMd], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '团队周报-' + (S.reportMdWeek || S.reportWeek) + '.md';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已下载');
    return;
  }
});

document.addEventListener('change', e => {
  const f = e.target.dataset.filter;
  if (f) {
    S.filter[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    render();
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeDrawer();
    document.getElementById('modal').classList.remove('show');
    document.getElementById('overlay').classList.remove('show');
  }
  if (e.key === 'n' && (e.metaKey || e.ctrlKey) === false && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    openTask('new');
  }
});

/* drag & drop 看板 */
document.addEventListener('dragstart', e => {
  const c = e.target.closest('.kcard');
  if (!c) return;
  if (S.guest) { e.preventDefault(); toast('游客只能浏览，不能修改状态', true); return; }
  S.drag = +c.dataset.task;
  c.classList.add('dragging');
  e.dataTransfer.setData('text/plain', c.dataset.task);
  e.dataTransfer.effectAllowed = 'move';
});
document.addEventListener('dragend', e => {
  document.querySelectorAll('.kcard.dragging').forEach(c => c.classList.remove('dragging'));
  document.querySelectorAll('.col.over').forEach(c => c.classList.remove('over'));
});
document.addEventListener('dragover', e => {
  const col = e.target.closest('.col');
  if (!col) return;
  e.preventDefault();
  document.querySelectorAll('.col.over').forEach(c => { if (c !== col) c.classList.remove('over'); });
  col.classList.add('over');
});
document.addEventListener('dragleave', e => {
  const col = e.target.closest('.col');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('over');
});
document.addEventListener('drop', async e => {
  const col = e.target.closest('.col');
  if (!col || !S.drag) return;
  e.preventDefault();
  col.classList.remove('over');
  const id = S.drag; S.drag = null;
  const t = S.data.tasks.find(x => x.id === id);
  if (!t || t.status === col.dataset.status) return;
  await act(() => api('/api/tasks/' + id, 'PATCH', { status: col.dataset.status }),
    '「' + t.title.slice(0, 12) + '」→ ' + STATUS[col.dataset.status].label);
});

/* ------------------------------------------------------------ boot */
document.getElementById('btn-refresh').addEventListener('click', async () => { await reload(); toast('数据已刷新'); });
document.getElementById('btn-new').addEventListener('click', () => openTask('new'));

(async function boot() {
  document.getElementById('view').innerHTML = '<div class="empty">正在加载…</div>';
  try {
    await load();
    await loadIdentity();
    render();
    if (!S.me && !S.guest) showIdentityModal(true);
    else recordVisit();
  } catch (e) {
    document.getElementById('view').innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>';
  }
})();
