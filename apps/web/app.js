// agent-platform Web UI v3 —— 布局
// 左对齐活动流 / 思考折叠行 / 紧凑工具行 / 对话-轨迹-上下文 Tab / 状态栏 / 权限徽章
// 零依赖；API 层与 M2 一致

window.addEventListener('error', () => setConn('off'));
window.addEventListener('unhandledrejection', () => setConn('off'));

/* ---------------- 令牌 / API ---------------- */

function getToken() {
  try { return sessionStorage.getItem('myagentToken'); } catch { return null; }
}
function setTokenLocal(t) {
  try { sessionStorage.setItem('myagentToken', t); } catch { /* ignore */ }
}
const token = new URLSearchParams(location.search).get('token') || getToken() || '';
if (token) setTokenLocal(token);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- 状态 ---------------- */

const state = {
  sessionId: null,
  sessionTitle: '',
  tab: 'dialog',
  lastSeq: 0,
  events: 0,
  pendingUserText: null,
  toolRows: new Map(),   // callId -> { row, callTs, outPre }
  approvalCards: new Map(),
  shownApprovals: new Set(),
  sending: false,
  abortCtl: null,
  hasEverScrolled: false,
  stats: { rounds: 0, steps: 0, tokens: 0 },
  sessionTotal: 0,
  serverState: null,
  groups: {},            // sessionId -> 分组名（localStorage 持久化）
  collapsedGroups: new Set(),
  projFilter: '',        // 空 = 全部
  searchOpen: false,
  treeCollapsed: new Set(),
  showArchived: false,   // 侧栏是否显示已归档会话
  view: 'chat',          // chat | projects | office | agents | settings | feedback
  officeTab: 'experts',  // 办公套件子 Tab
  officeKw: '',          // 办公套件搜索词
  pendingFiles: [],      // 待发送附件 {kind:'image'|'text', name, dataUrl?, text?, mime?}
  pinned: new Set(),     // 置顶会话（localStorage）
  editing: null,         // {seq} 编辑重发中的截断点
};

const $ = (id) => document.getElementById(id);

/* ---------------- markdown（零依赖） ---------------- */

function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function md(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [], fence = null, list = null, quote = null;
  let table = null; // { header: string[], rows: string[][] }

  const flushPara = () => { if (para.length) { out.push(`<p>${inlineMd(para.join('<br>'))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushQuote = () => { if (quote) { out.push(`<blockquote>${inlineMd(quote.join('<br>'))}</blockquote>`); quote = null; } };
  const flushTable = () => {
    if (table) {
      const esc1 = (c) => inlineMd(esc(c.trim()));
      let html = '<table class="tbl"><thead><tr>';
      for (const c of table.header) html += `<th>${esc1(c)}</th>`;
      html += '</tr></thead><tbody>';
      for (const r of table.rows) {
        html += '<tr>';
        for (const c of r) html += `<td>${esc1(c)}</td>`;
        html += '</tr>';
      }
      html += '</tbody></table>';
      out.push(html);
      table = null;
    }
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); flushTable(); };

  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l) && l.includes('|');
  const isSep = (l) => /^\s*\|?\s*:?-{2,}[\s:|-]*\|?\s*$/.test(l) && l.includes('-') && l.includes('|') !== undefined && /-/.test(l) && l.split('|').length >= 2;
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].replace(/\s+$/, '');
    if (fence !== null) {
      if (/^```/.test(line)) { out.push(`<pre><code>${fence.join('\n')}</code></pre>`); fence = null; }
      else fence.push(line);
      continue;
    }
    if (/^```/.test(line)) { flushAll(); fence = []; continue; }
    if (!line.trim()) { flushAll(); continue; }

    // GFM 表格：当前行是 |…| 且下一行是 |---|---| 分隔
    if (isRow(line) && li + 1 < lines.length && /^\s*\|?[\s:|-]+\|\s*$/.test(lines[li + 1]) && lines[li + 1].includes('-')) {
      flushAll();
      table = { header: cells(line), rows: [] };
      li += 1; // 跳过分隔行
      continue;
    }
    if (table && isRow(line)) { table.rows.push(cells(line)); continue; }
    flushTable();

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushAll(); const n = h[1].length; out.push(`<h${n}>${inlineMd(esc(h[2]))}</h${n}>`); continue; }
    if (/^(---+|\*\*\*+)$/.test(line.trim())) { flushAll(); out.push('<hr>'); continue; }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ul) { flushPara(); flushQuote(); if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inlineMd(esc(ul[1]))}</li>`); continue; }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) { flushPara(); flushQuote(); if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inlineMd(esc(ol[1]))}</li>`); continue; }
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) { flushPara(); flushList(); if (!quote) quote = []; quote.push(esc(bq[1])); continue; }
    flushList(); flushQuote();
    para.push(esc(line));
  }
  if (fence !== null) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
  flushAll();
  return out.join('');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function cssEsc(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '');
}
function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 应用内确认弹窗（替代浏览器原生 confirm，深色 UI 一致） */
function uiConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML =
      `<div class="modal-title">${esc(opts.title ?? '确认操作')}</div>` +
      `<div class="modal-msg">${esc(message)}</div>` +
      `<div class="modal-ops"><button type="button" class="pbtn" data-x>取消</button>` +
      `<button type="button" class="pbtn ${opts.danger ? 'danger' : 'accent'}" data-ok>${esc(opts.okText ?? '确定')}</button></div>`;
    mask.appendChild(box);
    document.body.appendChild(mask);
    const close = (v) => { mask.remove(); resolve(v); };
    box.querySelector('[data-ok]').onclick = () => close(true);
    box.querySelector('[data-x]').onclick = () => close(false);
    mask.onclick = (e) => { if (e.target === mask) close(false); };
    box.querySelector('[data-ok]').focus();
  });
}

function relTime(id) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id);
  if (!m) return '';
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时';
  if (diff < 172800) return '1 天';
  return Math.floor(diff / 86400) + ' 天';
}

/* ---------------- 工具行文案 ---------------- */

const TOOL_VERBS = {
  read_file: '读取',
  write_file: '写入',
  echo: '回显',
  run_command: '执行命令',
  web_fetch: '抓取网页',
  todo_write: '更新计划',
  todo_read: '查看计划',
  'mcp__memory__memory_save': '记忆',
  'mcp__memory__memory_recall': '回忆',
};
function toolVerb(name) {
  if (TOOL_VERBS[name]) return TOOL_VERBS[name];
  if (name.startsWith('mcp__')) return name.split('__').slice(2).join('·');
  return '调用 ' + name;
}
function toolTarget(name, argsJson) {
  try {
    const a = JSON.parse(argsJson || '{}');
    if (name === 'todo_write') return `${(a.items || []).length} 项任务`;
    if (name === 'run_command') return truncate(a.command ?? '', 60);
    return a.path ?? a.text ?? a.command ?? a.query ?? a.content ?? '';
  } catch {
    return String(argsJson ?? '');
  }
}
function pretty(json) {
  try { return JSON.stringify(JSON.parse(json || '{}'), null, 2); } catch { return String(json ?? ''); }
}

/* ---------------- 滚动 ---------------- */

function nearBottom() {
  const el = $('streamScroll');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}
function scrollBottom(force) {
  const el = $('streamScroll');
  if (force || nearBottom() || !state.hasEverScrolled) {
    el.scrollTop = el.scrollHeight;
    state.hasEverScrolled = true;
  }
}
$('streamScroll') && $('streamScroll').addEventListener('scroll', () => {
  if (!nearBottom()) state.hasEverScrolled = true;
});

/* ---------------- 顶栏 / 状态 ---------------- */

function setSessStatus(running, text) {
  const el = $('sessStatus');
  const tx = $('sessStatusTx');
  if (!el || !tx) return; // 顶栏已净化（无状态元素）
  el.className = running ? 'running' : '';
  tx.textContent = text ?? '';
}
function updateStatusBar() {
  $('sbRounds').textContent = state.stats.rounds;
  $('sbSteps').textContent = state.stats.steps;
  $('sbTokens').textContent = state.stats.tokens > 0 ? state.stats.tokens.toLocaleString() : 0;
  $('sbSessions').textContent = state.sessionTotal;
  updatePlan();
}

async function loadState() {
  try {
    const s = await api('/api/state');
    state.serverState = s;
    $('modelSel').innerHTML = `${esc(s.model)} <span>▾</span>`;
    const pb = $('permBadge');
    if (s.mode === 'read-only') { pb.innerHTML = `${icon('shield', 12)} 仅可查看`; pb.className = 'cbtn'; pb.title = 'agent 只读：写文件与命令被禁止（点击可切换）'; }
    else if (s.autoApprove) { pb.innerHTML = `${icon('zap', 12)} 完全权限`; pb.className = 'cbtn full'; pb.title = '无人值守：写操作自动放行（点击可切换）'; }
    else { pb.innerHTML = `${icon('shieldCheck', 12)} 工作区权限`; pb.className = 'cbtn ws'; pb.title = '写操作需审批，仅限工作区内（点击可切换）'; }
    const s0 = state.serverState || {};
    if (s0.workspaceRoot) {
      const base = String(s0.workspaceRoot).split(/[\\/]/).pop();
      const chip = $('wsChip');
      if (chip) chip.textContent = `📁 ${base} · 已固定`;
    }
    updatePlan();
    const meta = $('meta');
    meta.innerHTML =
      `模型 <b>${esc(s.model)}</b><br>${esc(s.baseUrl)}<br>权限 ${esc(s.mode)}${s.autoApprove ? '（无人值守）' : ''}<br>工作区 ${esc(s.workspaceRoot)}<br>MCP ${esc(s.mcp)}`;
  } catch {
    setConn('off');
  }
}

function updatePlan() {
  const el = $('planTx');
  if (state.sending) el.textContent = `任务进行中 · ${state.stats.steps} 步 · ${state.stats.rounds} 轮`;
  else el.textContent = '就绪 · 等待任务';
}
function setConn(on) {
  const sb = $('sbInfo');
  if (sb) sb.textContent = on === false ? '内核未连接' : 'BugKiller v0.2.0 · 本地内核';
}

/** JS → C# 标题栏通道（WebView2 WebMessage；浏览器环境静默） */
function postToHost(msg) {
  try { window.chrome && window.chrome.webview && window.chrome.webview.postMessage(JSON.stringify(msg)); } catch { /* ignore */ }
}
function updateTitle(t) {
  $('sessTitle').textContent = t;
  postToHost({ type: 'session-title', title: t });
}

/* ---------------- 会话分组 ---------------- */

const GROUP_CAP = 5;

function loadGroups() {
  try { return JSON.parse(localStorage.getItem('myagentGroups') || '{}') || {}; } catch { return {}; }
}
function saveGroups() {
  try { localStorage.setItem('myagentGroups', JSON.stringify(state.groups)); } catch { /* ignore */ }
}

/* 组内拖拽排序：全局顺序数组（myagentSessionOrder），不在数组里的按 mtime 排后面 */
function getSessionOrder() {
  try { return JSON.parse(localStorage.getItem('myagentSessionOrder') || '[]') || []; } catch { return []; }
}
function saveSessionOrder(arr) {
  try { localStorage.setItem('myagentSessionOrder', JSON.stringify(arr)); } catch { /* ignore */ }
}
function insertSessionOrder(dragId, targetId, before) {
  let arr = getSessionOrder().filter((x) => x !== dragId);
  const i = arr.indexOf(targetId);
  if (i === -1) arr.push(dragId); // 目标从未排过序 → 追加到末尾
  else arr.splice(before ? i : i + 1, 0, dragId);
  saveSessionOrder(arr);
}
function loadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}
function saveSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
}

/** 置顶/取消置顶会话 */
function togglePin(sessionId) {
  if (state.pinned.has(sessionId)) state.pinned.delete(sessionId);
  else state.pinned.add(sessionId);
  saveSet('myagentPinned', state.pinned);
  refreshSessions();
}

function cancelEditing() {
  state.editing = null;
  const b = $('editBanner');
  if (b) b.style.display = 'none';
}

function renderGroups(sessions, searchHits) {
  const list = $('sessionList');
  const kw = state.searchOpen ? ($('sessionSearch').value || '').trim().toLowerCase() : '';
  const visible = sessions.filter((s) => s.archived === state.showArchived);
  const groups = new Map(); // 分组名 -> sessions[]
  for (const s of visible) {
    const g = state.pinned.has(s.id) ? '📌 置顶' : state.groups[s.id] || '未归属项目';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  // 置顶组最前；未归属项目最后；其余按名称
  const order = (g) => (g === '📌 置顶' ? 0 : g === '未归属项目' ? 2 : 1);
  const names = [...groups.keys()].sort((a, b) => order(a) - order(b) || (a < b ? -1 : 1));
  // 组内排序：按用户拖拽顺序数组（未排过的按 mtime 降序排后面）
  const sessOrder = getSessionOrder();
  const ordOf = (id) => { const i = sessOrder.indexOf(id); return i === -1 ? 1e9 : i; };
  for (const [, items] of groups) {
    items.sort((a, b) => ordOf(a.id) - ordOf(b.id) || (b.mtimeMs || 0) - (a.mtimeMs || 0));
  }

  list.innerHTML = '';
  let shown = 0;
  for (const g of names) {
    if (state.projFilter && state.projFilter !== g) continue;
    const all = groups.get(g);
    const matched = kw ? all.filter((s) => `${s.title || ''} ${s.id}`.toLowerCase().includes(kw)) : all;
    if (kw && matched.length === 0) continue;
    shown += 1;
    renderGroup(list, g, matched, kw);
  }

  // 全文命中（SQLite 投影）：标题没匹配但正文命中的会话，单独一组列出
  const hitById = new Map();
  for (const h of searchHits || []) {
    if (!hitById.has(h.sessionId)) hitById.set(h.sessionId, h);
  }
  const contentHits = [...hitById.values()].filter((h) => {
    const s = sessions.find((x) => x.id === h.sessionId);
    return s && kw && !`${s.title || ''} ${s.id}`.toLowerCase().includes(kw);
  });
  if (contentHits.length) {
    const g = document.createElement('div');
    g.className = 'group';
    g.innerHTML = `<button type="button" class="group-head"><span>📄 正文命中</span><span class="cnt">${contentHits.length}</span></button><div class="group-body"></div>`;
    const body = g.querySelector('.group-body');
    for (const h of contentHits) {
      const s = sessions.find((x) => x.id === h.sessionId);
      body.appendChild(sessionItem({ ...s, title: `${s.title || s.id} · ${h.snippet.slice(0, 24)}…` }));
    }
    list.appendChild(g);
  }

  if (shown === 0 && !contentHits.length) {
    list.innerHTML = `<div style="color:var(--muted);font-size:11.5px;padding:8px">${state.sessionTotal === 0 ? '暂无会话，点上面「新建会话」' : '无匹配会话'}</div>`;
  } else {
    bindListDropTarget(list);
  }
}

/** 会话列表 + （搜索时）全文命中一起刷 */
async function refreshSessions() {
  try {
    const { sessions } = await api('/api/sessions');
    state.sessionTotal = sessions.filter((s) => !s.archived).length;
    updateStatusBar();
    let hits = [];
    const kw = state.searchOpen ? ($('sessionSearch').value || '').trim() : '';
    if (kw) {
      try { hits = (await api(`/api/search?q=${encodeURIComponent(kw)}`)).hits || []; } catch { hits = []; }
    }
    renderGroups(sessions.filter((s) => s.archived === state.showArchived), hits);
    return sessions;
  } catch {
    return [];
  }
}

function renderGroup(list, name, items, kw) {
  const collapsed = state.collapsedGroups.has(name);
  const group = document.createElement('div');
  group.className = 'group' + (collapsed ? ' collapsed' : '');

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'group-head';
  head.innerHTML = `<span class="chev">▾</span><span>${esc(name)}</span><span class="cnt">${items.length}</span>`;
  head.onclick = () => {
    if (state.collapsedGroups.has(name)) state.collapsedGroups.delete(name);
    else state.collapsedGroups.add(name);
    saveSet('myagentGroupsCollapsed', state.collapsedGroups);
    group.classList.toggle('collapsed');
  };
  // 拖拽归组：会话拖到分组头上即移入该组
  head.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    head.classList.add('drop-hint');
  });
  head.addEventListener('dragleave', () => head.classList.remove('drop-hint'));
  head.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation(); // 别冒泡到列表空白处（会覆盖归组动作）
    head.classList.remove('drop-hint');
    const sid = e.dataTransfer.getData('text/session-id');
    if (sid) assignGroup(sid, name);
  });
  group.appendChild(head);

  const body = document.createElement('div');
  body.className = 'group-body';
  const cap = kw ? items.length : GROUP_CAP;
  for (let i = 0; i < Math.min(cap, items.length); i++) {
    body.appendChild(sessionItem(items[i]));
  }
  if (items.length > cap) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'group-more';
    more.textContent = `展开其余 ${items.length - cap} 个会话`;
    more.onclick = () => {
      for (let i = cap; i < items.length; i++) body.insertBefore(sessionItem(items[i]), more);
      more.remove();
    };
    body.appendChild(more);
  }
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--muted);font-size:11px;padding:4px 9px';
    empty.textContent = '（空）';
    body.appendChild(empty);
  }
  group.appendChild(body);
  list.appendChild(group);
}

/* 拖到列表空白处 = 移出分组（归到未归属项目） */
function bindListDropTarget(list) {
  list.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/session-id')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drop-hint');
  });
  list.addEventListener('dragleave', (e) => {
    if (e.target === list) list.classList.remove('drop-hint');
  });
  list.addEventListener('drop', (e) => {
    list.classList.remove('drop-hint');
    const sid = e.dataTransfer.getData('text/session-id');
    if (sid) {
      e.preventDefault();
      assignGroup(sid, ''); // 未归属项目
    }
  });
}

const ICON_TRASH = icon('trash2', 12);
const ICON_PIN = icon('pin', 12);
const ICON_DOTS = icon('ellipsis', 12);

function sessionItem(s) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'session-item' + (s.id === state.sessionId ? ' active' : '');
  btn.draggable = !s.archived; // 已归档视图不拖拽
  const pinned = state.pinned.has(s.id);
  btn.innerHTML =
    `<div class="row1"><span class="dot"></span>` +
    `<span class="t">${esc(s.title || s.id)}</span>` +
    `<span class="quick">` +
    `<button type="button" class="q danger" data-del title="删除会话">${ICON_TRASH}</button>` +
    `<button type="button" class="q ${pinned ? 'pinned' : ''}" data-pin title="${pinned ? '取消置顶' : '置顶会话'}">${ICON_PIN}</button>` +
    `<button type="button" class="q" data-menu title="更多操作">${ICON_DOTS}</button></span>` +
    `<span class="time">${esc(relTime(s.id))}</span></div>`;
  btn.dragstart = null;
  btn.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/session-id', s.id);
    e.dataTransfer.effectAllowed = 'move';
    btn.classList.add('dragging');
  });
  btn.addEventListener('dragend', () => {
    btn.classList.remove('dragging');
    btn.classList.remove('drop-above', 'drop-below');
  });
  // 拖到会话项上：上/下半决定插入位置（组内排序 + 跨组归组）
  btn.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/session-id')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = btn.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    btn.classList.toggle('drop-above', above);
    btn.classList.toggle('drop-below', !above);
  });
  btn.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.classList.remove('drop-above', 'drop-below');
    const sid = e.dataTransfer.getData('text/session-id');
    if (!sid || sid === s.id) return;
    const rect = btn.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const targetGroup = state.groups[s.id] || '未归属项目';
    const dragGroup = state.groups[sid] || '未归属项目';
    if (targetGroup !== dragGroup) assignGroup(sid, targetGroup); // 跨组拖拽 = 归组 + 排序
    insertSessionOrder(sid, s.id, before);
    refreshSessions();
  });
  btn.onclick = async (e) => {
    if (e.target.closest('[data-pin]')) { togglePin(s.id); return; }
    if (e.target.closest('[data-menu]')) { openSessionMenu(e, s); return; }
    if (e.target.closest('[data-del]')) {
      if (!(await uiConfirm(`删除会话「${s.title || s.id}」？历史不可恢复。`, { title: '删除会话', danger: true, okText: '删除' }))) return;
      api(`/api/sessions/${s.id}`, { method: 'DELETE' }).then(() => {
        if (state.sessionId === s.id) { state.sessionId = null; showWelcomeStandalone(); }
        refreshSessions();
      }).catch((err) => alert('删除失败：' + err.message));
      return;
    }
    openSession(s.id, s.title);
  };
  btn.oncontextmenu = (e) => {
    e.preventDefault();
    openSessionMenu(e, s);
  };
  if (s.id === state.sessionId) state.sessionTitle = s.title || s.id;
  return btn;
}

/* ---------------- 会话右键菜单（归组） ---------------- */

function closeSessionMenu() {
  const m = $('ctxMenu');
  if (m) m.remove();
}

function openSessionMenu(e, s) {
  closeSessionMenu();
  const menu = document.createElement('div');
  menu.id = 'ctxMenu';
  const current = state.groups[s.id] || '未归属项目';
  const groups = [...new Set(['未归属项目', ...Object.values(state.groups)])].filter((g) => g !== current);

  const title = document.createElement('div');
  title.style.cssText = 'padding:6px 10px;color:var(--muted);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px';
  title.textContent = truncate(s.title || s.id, 24) + ' · ' + current;
  menu.appendChild(title);
  menu.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }));

  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { closeSessionMenu(); fn(); };
    menu.appendChild(b);
  };
  for (const g of groups) mk(`移动到「${g}」`, () => { assignGroup(s.id, g); });
  mk('新建分组并移入…', () => {
    const name = prompt('新分组名称：', '');
    if (name && name.trim()) assignGroup(s.id, name.trim());
  });
  if (current !== '未归属项目') mk('移出分组', () => { assignGroup(s.id, ''); });
  mk(state.pinned.has(s.id) ? '取消置顶' : '📌 置顶会话', () => togglePin(s.id));
  mk('✎ 重命名', async () => {
    const name = prompt('重命名会话：', s.title || s.id);
    if (!name || !name.trim() || name.trim() === (s.title || s.id)) return;
    try {
      await api(`/api/sessions/${s.id}/rename`, { method: 'POST', body: JSON.stringify({ title: name.trim() }) });
      if (state.sessionId === s.id) { state.sessionTitle = name.trim(); updateTitle(name.trim()); }
      refreshSessions();
    } catch (e) {
      appendNote(`重命名失败：${e.message}`, true);
    }
  });
  mk('⑂ 分叉会话', async () => {
    try {
      const r = await api(`/api/sessions/${s.id}/fork`, { method: 'POST' });
      await refreshSessions();
      await openSession(r.id, `${s.title || s.id}（分叉）`);
    } catch (e) {
      appendNote(`分叉失败：${e.message}`, true);
    }
  });
  mk(s.archived ? '📂 取消归档' : '🗂 归档会话', async () => {
    try {
      await api(`/api/sessions/${s.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: !s.archived }) });
      if (s.archived === false && state.sessionId === s.id) { state.sessionId = null; showWelcomeStandalone(); }
      refreshSessions();
    } catch (e) {
      appendNote(`归档失败：${e.message}`, true);
    }
  });
  menu.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }));
  mk('删除会话…', async () => {
    if (!(await uiConfirm(`删除会话「${truncate(s.title || s.id, 20)}」？历史不可恢复。`, { danger: true, okText: '删除' }))) return;
    await api(`/api/sessions/${s.id}`, { method: 'DELETE' }).catch((err) => appendNote(`删除失败：${err.message}`, true));
    if (state.sessionId === s.id) { state.sessionId = null; showWelcomeStandalone(); }
    refreshSessions();
  });

  menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 220) + 'px';
  menu.style.display = 'block';
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', closeSessionMenu, { once: true }), 0);
}

function assignGroup(sessionId, project) {
  if (project) state.groups[sessionId] = project;
  else delete state.groups[sessionId];
  saveGroups();
  refreshSessions();
}

/* ---------------- 主题色 ---------------- */

const THEME_COLORS = [
  { name: '蓝（默认）', value: '#4f8ef7' },
  { name: '紫', value: '#8b6bf7' },
  { name: '青', value: '#2bbfa3' },
  { name: '绿', value: '#3fbf6f' },
  { name: '橙', value: '#e8913d' },
  { name: '玫红', value: '#e05b7f' },
];

function applyTheme(color) {
  if (!color) return;
  document.documentElement.style.setProperty('--accent', color);
}

function saveTheme(color) {
  try { localStorage.setItem('myagentTheme', color); } catch { /* ignore */ }
}

function loadTheme() {
  try { return localStorage.getItem('myagentTheme') || THEME_COLORS[0].value; } catch { return THEME_COLORS[0].value; }
}

/* ---------------- 主区视图系统：chat / projects / office / agents / settings / feedback ---------------- */

function switchView(view) {
  state.view = view;
  const isChat = view === 'chat';
  $('tabs').style.display = isChat ? 'flex' : 'none';
  $('composerWrap').style.display = isChat ? 'block' : 'none';
  // 文件浏览器自己管滚动（避免外层双滚动条 + 底部截断）
  for (const b of document.querySelectorAll('.menu-item')) b.classList.toggle('active', b.id === (isChat ? 'newSession' : viewNavId(view)));
  $('sessTitle').textContent = isChat ? (state.sessionTitle || 'BugKiller') : VIEW_TITLES[view];
  if (!isChat) {
    setSessStatus(false, '');
    $('stream').innerHTML = '';
    if (view === 'projects') renderProjectsPage();
    else if (view === 'office') renderOfficePage();
    else if (view === 'agents') renderAgentsPage();
    else if (view === 'settings') renderSettingsPage();
    else if (view === 'feedback') renderFeedbackPage();
    else if (view === 'audit') renderAuditPage();
  } else {
    reloadDialog();
  }
}

const VIEW_TITLES = { chat: 'BugKiller', projects: '项目 / 产品管理', office: '办公套件', agents: '云智能体', settings: '设置', feedback: '问题反馈', audit: '审计日志', files: '工作区文件' };

function viewNavId(view) {
  return { projects: 'navProjects', office: 'navOffice', agents: 'navAgents' }[view] ?? '';
}

function pageCard(title, sub, actionsHtml) {
  const c = document.createElement('div');
  c.className = 'page-card';
  c.innerHTML =
    `<div class="pc-head"><div><div class="pc-t">${esc(title)}</div>${sub ? `<div class="pc-s">${esc(sub)}</div>` : ''}</div>` +
    `<div class="pc-actions">${actionsHtml || ''}</div></div><div class="pc-body"></div>`;
  return c;
}

/* ---- 项目 / 产品管理：分组 CRUD + 组内会话 + 删除会话 ---- */

async function renderProjectsPage() {
  const stream = $('stream');
  stream.innerHTML = '';
  const { sessions } = await api('/api/sessions').catch(() => ({ sessions: [] }));

  const createCard = pageCard('新建分组', '分组用于侧栏的会话归类（本地持久化）',
    '<input id="npName" placeholder="分组名称" />' +
    '<button class="pbtn accent" id="npCreate">创建</button>');
  stream.appendChild(createCard);
  createCard.querySelector('#npCreate').onclick = () => {
    const name = createCard.querySelector('#npName').value.trim();
    if (!name) return;
    state.groups[`__group__${name}`] = name; // 仅标记存在（空分组）
    saveGroups();
    renderProjectsPage();
  };

  const groups = new Map();
  for (const s of sessions) {
    const g = state.groups[s.id] || '未归属项目';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  for (const [name, existsTag] of Object.entries(state.groups)) {
    if (name.startsWith('__group__') && existsTag && !groups.has(existsTag)) groups.set(existsTag, []);
  }
  const names = [...groups.keys()].sort((a, b) => (a === '未归属项目' ? 1 : b === '未归属项目' ? -1 : a < b ? -1 : 1));

  for (const g of names) {
    const items = groups.get(g) || [];
    const actions =
      (g !== '未归属项目'
        ? `<button class="pbtn" data-rename="${esc(g)}">重命名</button><button class="pbtn danger" data-delgroup="${esc(g)}">删除分组</button>`
        : '');
    const card = pageCard(`${g}`, `${items.length} 个会话`, actions);
    const body = card.querySelector('.pc-body');
    for (const s of items) {
      const row = document.createElement('div');
      row.className = 'prow';
      row.innerHTML =
        `<span class="prow-t">${esc(s.title || s.id)}</span>` +
        `<span class="prow-time">${esc(relTime(s.id))} · ${s.events} 事件</span>` +
        `<span class="prow-ops"><button class="pbtn" data-open="${s.id}" data-t="${esc(s.title || '')}">打开</button>` +
        `<button class="pbtn danger" data-delsess="${s.id}">删除会话</button></span>`;
      body.appendChild(row);
    }
    if (items.length === 0) body.innerHTML = '<div class="pc-empty">（空分组）</div>';
    stream.appendChild(card);
    if (g !== '未归属项目') {
      card.querySelector('[data-rename]').onclick = () => {
        const nn = prompt('重命名分组：', g);
        if (!nn || !nn.trim()) return;
        for (const [sid, grp] of Object.entries(state.groups)) if (grp === g) state.groups[sid] = nn.trim();
        if (state.groups[`__group__${g}`]) { delete state.groups[`__group__${g}`]; state.groups[`__group__${nn.trim()}`] = nn.trim(); }
        saveGroups();
        renderProjectsPage();
      };
      card.querySelector('[data-delgroup]').onclick = async () => {
        if (!(await uiConfirm(`删除分组「${g}」？组内会话将移到未归属项目。`, { danger: true, okText: '删除' }))) return;
        for (const [sid, grp] of Object.entries(state.groups)) if (grp === g) delete state.groups[sid];
        delete state.groups[`__group__${g}`];
        saveGroups();
        renderProjectsPage();
      };
    }
    for (const b of card.querySelectorAll('[data-open]')) {
      b.onclick = () => { switchView('chat'); openSession(b.dataset.open, b.dataset.t); };
    }
    for (const b of card.querySelectorAll('[data-delsess]')) {
      b.onclick = async () => {
        if (!(await uiConfirm('删除该会话？历史不可恢复。', { danger: true, okText: '删除' }))) return;
        await api(`/api/sessions/${b.dataset.delsess}`, { method: 'DELETE' }).catch((e) => appendNote(`删除失败：${e.message}`, true));
        if (state.sessionId === b.dataset.delsess) { state.sessionId = null; }
        renderProjectsPage();
        refreshSessions();
      };
    }
  }
  updateStatusBar();
}

/* ---- 办公套件 ---- */

function loadCustomAgents() {
  try { return JSON.parse(localStorage.getItem('myagentCustomAgents') || '[]') || []; } catch { return []; }
}
function saveCustomAgents(list) {
  try { localStorage.setItem('myagentCustomAgents', JSON.stringify(list)); } catch { /* ignore */ }
}
function loadAgentUse() {
  try { return JSON.parse(localStorage.getItem('myagentAgentUse') || '{}') || {}; } catch { return {}; }
}
function bumpAgentUse(id) {
  const u = loadAgentUse();
  u[id] = (u[id] || 0) + 1;
  try { localStorage.setItem('myagentAgentUse', JSON.stringify(u)); } catch { /* ignore */ }
}

const OFFICE_TABS = [
  ['experts', 'users', '专家'],
  ['skills', 'wrench', '技能'],
  ['connectors', 'plug', '连接器'],
  ['knowledge', 'bookOpen', '知识库'],
];

function toolDesc(name) {
  const known = {
    read_file: '读取工作区内的文本文件（UTF-8）',
    write_file: '创建或覆盖工作区文件（审批门 + 沙箱镜像 + 行级 diff）',
    run_command: '在工作区内执行 PowerShell 命令（审批门 + 超时 + 输出截断）',
    web_fetch: '抓取网页并转为纯文本（SSRF 防护）',
    todo_write: '写当前会话的任务计划（会话计划卡联动）',
    todo_read: '读取当前会话的任务计划',
    echo: '回显一段文本',
    'mcp__memory__memory_save': '保存记忆到 MCP memory 服务',
    'mcp__memory__memory_recall': '从 MCP memory 服务检索记忆',
  };
  return known[name] ?? 'MCP 提供的工具';
}

async function renderOfficePage() {
  const stream = $('stream');
  stream.innerHTML = '';
  const office = state.officeTab || 'experts';

  // ---- 页头：返回 + 大标题 + 副标题 + 创建/导入 ----
  const head = document.createElement('div');
  head.className = 'office-head';
  head.innerHTML =
    `<div class="office-back"><button class="tb-btn" id="officeBack" title="返回">←</button><span class="office-crumb">开发/办公套件</span></div>` +
    `<div class="office-actions"><button class="pbtn accent" id="ofCreate">＋ 创建专家</button><button class="pbtn" id="ofImport">导入专家</button></div>` +
    `<h1 class="office-title">开发/办公套件</h1>` +
    `<div class="office-sub">汇集办公与开发所需的专家、技能、连接器与知识库。</div>`;
  stream.appendChild(head);
  $('officeBack').onclick = () => switchView('chat');

  // ---- Tab 行 + 分类筛选 ----
  const tabRow = document.createElement('div');
  tabRow.className = 'office-tabs';
  tabRow.innerHTML =
    OFFICE_TABS.map(([id, ic, nm]) => `<button type="button" class="otab ${office === id ? 'active' : ''}" data-tab="${id}">${icon(ic, 14)} ${nm}</button>`).join('') +
    `<span class="spacer"></span><span class="allcat">全部分类 ▾</span>`;
  stream.appendChild(tabRow);
  for (const b of tabRow.querySelectorAll('.otab')) {
    b.onclick = () => { state.officeTab = b.dataset.tab; renderOfficePage(); };
  }

  // ---- 搜索行（专家/技能 Tab 用） ----
  const searchRow = document.createElement('div');
  searchRow.className = 'office-search';
  searchRow.innerHTML = `<input id="officeSearch" placeholder="${office === 'experts' ? '搜索专家名称或描述' : '搜索技能名称或描述'}" />`;
  stream.appendChild(searchRow);
  const kwEl = searchRow.querySelector('#officeSearch');
  kwEl.value = state.officeKw || '';
  kwEl.addEventListener('input', () => { state.officeKw = kwEl.value.trim().toLowerCase(); renderOfficePage(); });
  kwEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); renderOfficePage(); }
  });

  const listWrap = document.createElement('div');
  listWrap.id = 'officeList';
  stream.appendChild(listWrap);

  if (office === 'experts') await renderOfficeExperts(listWrap);
  else if (office === 'skills') await renderOfficeSkills(listWrap);
  else if (office === 'connectors') renderOfficeConnectors(listWrap);
  else renderOfficeKnowledge(listWrap);

  // ---- 创建 / 导入 表单 ----
  $('ofCreate').onclick = () => renderAgentForm();
  $('ofImport').onclick = () => {
    const json = prompt('粘贴专家定义 JSON（name / desc / icon / opening）：');
    if (!json) return;
    try {
      const a = JSON.parse(json);
      if (!a.name) throw new Error('缺少 name');
      const list = loadCustomAgents();
      list.push({ id: 'custom-' + Date.now(), name: String(a.name), desc: String(a.desc ?? ''), icon: String(a.icon ?? '🤖'), opening: String(a.opening ?? '') });
      saveCustomAgents(list);
      renderOfficePage();
    } catch (e) {
      alert('导入失败：' + e.message);
    }
  };
}

function renderAgentForm(editing) {
  const stream = $('stream');
  const old = $('agentFormCard');
  if (old) { old.remove(); if (!editing) return; }
  const isEdit = !!editing;
  const card = pageCard(isEdit ? `编辑专家「${editing.name}」` : '创建专家',
    isEdit ? '修改后立即生效；召唤时使用新的开场指令' : '保存后出现在专家列表，可在任意会话召唤',
    '<button class="pbtn accent" id="afSave">保存专家</button>');
  card.id = 'agentFormCard';
  card.querySelector('.pc-body').innerHTML =
    `<div class="form-row"><label>名称</label><input id="afName" placeholder="如：周报助手" value="${esc(isEdit ? editing.name : '')}" /></div>` +
    `<div class="form-row"><label>图标</label><input id="afIcon" placeholder="📊（emoji）" value="${esc(isEdit ? (editing.icon || '') : '')}" /></div>` +
    `<div class="form-row"><label>一句话描述</label><input id="afDesc" placeholder="这个专家擅长什么" value="${esc(isEdit ? (editing.desc || '') : '')}" /></div>` +
    `<div class="form-row"><label>开场指令</label><textarea id="afOpen" placeholder="召唤后自动发送给模型的角色指令…">${esc(isEdit ? (editing.opening || '') : '')}</textarea></div>`;
  stream.insertBefore(card, $('officeList'));
  card.querySelector('#afSave').onclick = () => {
    const name = card.querySelector('#afName').value.trim();
    if (!name) { alert('名称不能为空'); return; }
    const data = {
      id: isEdit ? editing.id : 'custom-' + Date.now(),
      name,
      icon: card.querySelector('#afIcon').value.trim() || '🤖',
      desc: card.querySelector('#afDesc').value.trim(),
      opening: card.querySelector('#afOpen').value.trim() || `你现在是「${name}」。请先简单介绍一下你能做什么。`,
    };
    const list = loadCustomAgents();
    if (isEdit) {
      const i = list.findIndex((x) => x.id === editing.id);
      if (i >= 0) list[i] = data; else list.push(data);
    } else {
      list.push(data);
    }
    saveCustomAgents(list);
    renderOfficePage();
  };
}

async function renderOfficeExperts(listWrap) {
  const s = state.serverState || {};
  let builtin = [];
  try { builtin = (await api('/api/agents')).agents; } catch { /* 忽略 */ }
  const custom = loadCustomAgents();
  const all = [...custom.map((a) => ({ ...a, custom: true })), ...builtin.map((a) => ({ ...a }))];
  const use = loadAgentUse();
  const installed = all.filter((a) => (use[a.id] || 0) > 0);
  const kw = state.officeKw || '';
  const match = (a) => !kw || `${a.name} ${a.desc ?? ''}`.toLowerCase().includes(kw);

  listWrap.innerHTML = '';

  const insCard = document.createElement('div');
  insCard.className = 'office-section';
  insCard.innerHTML = `<div class="office-sec-t">已安装 <span class="dim">${installed.length}</span></div>` +
    (installed.length ? '' : '<div class="pc-empty">暂无已召唤的专家 —— 在下方「公开」里点击召唤。</div>');
  listWrap.appendChild(insCard);
  for (const a of installed) {
    if (!match(a)) continue;
    listWrap.appendChild(expertCard(a, '已召唤 ' + use[a.id] + ' 次', true));
  }

  const pubCard = document.createElement('div');
  pubCard.className = 'office-section';
  pubCard.innerHTML =
    `<div class="office-sec-t">公开 <span class="dim">${all.filter(match).length}</span></div>` +
    `<div class="office-sec-s">本地可用的专家目录：点击召唤即可使用（自动建会话并注入开场指令）。</div>`;
  listWrap.appendChild(pubCard);
  const pubList = all.filter(match);
  if (!pubList.length) {
    pubCard.appendChild(Object.assign(document.createElement('div'), { className: 'pc-empty', textContent: '（无匹配专家）' }));
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'expert-grid';
  pubList.forEach((a, i) => grid.appendChild(expertCard(a, i < 2 ? '办公类' : '通用')));
  pubCard.appendChild(grid);
}

function expertCard(a, tag, installedMode) {
  const card = document.createElement('div');
  card.className = 'expert-card';
  card.innerHTML =
    `<div class="ec-top"><span class="ec-av">${esc((a.icon || a.name || '?').slice(0, 2))}</span>` +
    `<span class="ec-nm">${esc(a.name)}</span><span class="ec-tag">${esc(tag ?? '')}</span>` +
    (a.custom ? `<button type="button" class="ec-more" data-more title="编辑 / 删除">${ICON_DOTS}</button>` : '') +
    `</div>` +
    `<div class="ec-ds">${esc(a.desc || '')}</div>` +
    `<div class="ec-ops"><button class="pbtn accent" data-sum>召唤</button></div>`;
  card.querySelector('[data-sum]').onclick = () => {
    bumpAgentUse(a.id);
    startAgent(a);
  };
  const more = card.querySelector('[data-more]');
  if (more) {
    more.onclick = (e) => {
      e.stopPropagation();
      const old = document.querySelector('.expert-menu');
      if (old) old.remove();
      const menu = document.createElement('div');
      menu.className = 'expert-menu';
      const mk = (label, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.onclick = () => { menu.remove(); fn(); };
        menu.appendChild(b);
      };
      mk('✎ 编辑专家', () => renderAgentForm(a));
      mk('🗑 删除专家', async () => {
        if (!(await uiConfirm(`删除自定义专家「${a.name}」？`, { danger: true, okText: '删除' }))) return;
        saveCustomAgents(loadCustomAgents().filter((x) => x.id !== a.id));
        renderOfficePage();
      });
      document.body.appendChild(menu);
      const r = more.getBoundingClientRect();
      menu.style.left = Math.min(r.left, window.innerWidth - 170) + 'px';
      menu.style.top = r.bottom + 6 + 'px';
      setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
    };
  }
  return card;
}

async function renderOfficeSkills(listWrap) {
  const s = state.serverState || {};
  const rawTools = Array.isArray(s.tools) ? s.tools : String(s.tools || 'read_file, write_file').split(',');
  const names = rawTools.map((x) => String(x).trim()).filter(Boolean);
  const kw = state.officeKw || '';
  listWrap.innerHTML = `<div class="office-sec-t">已注册技能 <span class="dim">${names.length}</span></div>`;
  const grid = document.createElement('div');
  grid.className = 'expert-grid';
  let shown = 0;
  for (const n of names) {
    const desc = toolDesc(n);
    if (kw && !`${n} ${desc}`.toLowerCase().includes(kw)) continue;
    shown += 1;
    const card = document.createElement('div');
    card.className = 'expert-card';
    card.innerHTML =
      `<div class="ec-top"><span class="ec-av mono">⚙</span><span class="ec-nm mono">${esc(n)}</span></div>` +
      `<div class="ec-ds">${esc(desc)}</div>` +
      `<div class="ec-ops dim">已注册 · 内核实时提供</div>`;
    grid.appendChild(card);
  }
  if (!shown) listWrap.appendChild(Object.assign(document.createElement('div'), { className: 'pc-empty', textContent: '（无匹配技能）' }));
  listWrap.appendChild(grid);
}

function renderOfficeConnectors(listWrap) {
  const s = state.serverState || {};
  listWrap.innerHTML =
    `<div class="office-sec-t">已挂载连接器</div>` +
    `<div class="conn-list"><div class="expert-card"><div class="ec-top"><span class="ec-av">🔌</span><span class="ec-nm">MCP 服务器</span><span class="ec-tag">${s.mcp || '无'}</span></div>` +
    `<div class="ec-ds">stdio 传输 · policy/mcp-servers.json 声明；HTTP 传输已支持 url 声明。</div>` +
    `<div class="ec-ops dim">自动挂载 · 内核启动时连接</div></div>` +
    `<div class="expert-card"><div class="ec-top"><span class="ec-av">🧩</span><span class="ec-nm">插件</span><span class="ec-tag">plugins/plugins.json</span></div>` +
    `<div class="ec-ds">cordis 风格装配：manifest + overlay patch；当前已装载 example-echo。</div>` +
    `<div class="ec-ops dim">随内核启动加载</div></div></div>` +
    `<div class="office-sec-t" style="margin-top:10px">说明</div><div class="pc-empty">连接器声明写在 policy/mcp-servers.json，改完重启内核生效。</div>`;
}

function renderOfficeKnowledge(listWrap) {
  listWrap.innerHTML =
    `<div class="office-sec-t">知识库 = 工作区笔记 + 长期记忆</div>` +
    `<div class="pc-empty">笔记存于 notes/（agent 可直接读取），记忆存于 MCP memory 服务。</div>` +
    `<div class="office-ops"><button class="pbtn accent" id="kbNote">＋ 笔记</button></div>`;
  const noteWrap = document.createElement('div');
  noteWrap.className = 'office-ops';
  listWrap.appendChild(noteWrap);
  $('kbNote').onclick = () => openNoteEditor(noteWrap, '', '');
  let files = [];
  try { files = []; } catch { /* noop */ }
  // 笔记列表（复用办公 API）
  api('/api/notes').then((d) => {
    for (const f of d.files) {
      const row = document.createElement('div');
      row.className = 'prow';
      row.innerHTML =
        `<span class="prow-t">📄 ${esc(f.name)}</span>` +
        `<span class="prow-time">${f.size} 字节</span>` +
        `<span class="prow-ops"><button class="pbtn" data-edit="${esc(f.name)}">编辑</button>` +
        `<button class="pbtn danger" data-deln="${esc(f.name)}">删除</button></span>`;
      noteWrap.appendChild(row);
      row.querySelector('[data-edit]').onclick = async () => {
        const dd = await api(`/api/note?path=${encodeURIComponent('notes/' + f.name)}`).catch(() => null);
        openNoteEditor(noteWrap, 'notes/' + f.name, dd ? dd.content : '');
      };
      row.querySelector('[data-deln]').onclick = async () => {
        if (!(await uiConfirm(`删除笔记 ${f.name}？`, { danger: true, okText: '删除' }))) return;
        await api(`/api/note?path=${encodeURIComponent('notes/' + f.name)}`, { method: 'DELETE' });
        renderOfficePage();
      };
    }
  }).catch(() => {});
}

/* ---------------- 工作区文件浏览器（树 + 内置编辑器） ---------------- */

function buildFileTree(files) {
  const root = { name: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = String(f.path).split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push({ name: parts[parts.length - 1], path: f.path, size: f.size });
  }
  return root;
}

/** 会话工作区抽屉：右侧滑出（树 + 编辑器）；会话相关功能放对话里 */
async function openWsDrawer() {
  const sid = state.sessionId;
  if (!sid) { appendNote('先选择一个会话 —— 每个会话有自己独立的工作区', true); return; }
  closeWsDrawer();
  let ws = '';
  try { ws = (await api(`/api/sessions/${sid}/workspace`)).workspace || ''; } catch { ws = ''; }

  const choose = () => openWsChoose(async (path) => {
    try {
      const r = await api(`/api/sessions/${sid}/workspace`, { method: 'POST', body: JSON.stringify({ path }) });
      appendNote(`📁 工作区已${r.workspace ? '设为「' + r.workspace + '」' : '恢复为公共工作区'}`);
      openWsDrawer(); // 重开刷新
    } catch (e) {
      alert('设置失败：' + e.message);
    }
  });

  const drawer = document.createElement('div');
  drawer.id = 'wsDrawer';
  drawer.innerHTML =
    `<div class="wsd-splitter" id="wsdSplitter" title="左右拖动调整宽度"></div>` +
    `<div class="wsd-head">` +
    `<span class="wsd-title">${icon('folderTree', 15)} 会话工作区</span>` +
    `<span class="wsd-ws mono">${ws ? esc(ws) + '/' : '未选择'}</span>` +
    `<button type="button" class="pbtn ${ws ? '' : 'accent'}" id="wsdSet">${ws ? '修改工作区' : '选择工作区'}</button>` +
    `<button type="button" class="pbtn" id="wsdClose">${icon('x', 13)}</button>` +
    `</div>` +
    `<div class="wsd-body" id="wsdBody"><div class="pc-empty" style="margin:auto">加载中…</div></div>`;
  document.body.appendChild(drawer);
  drawer.dataset.sid = sid; // 标记归属会话：切换对话时据此自动重渲染
  drawer.querySelector('#wsdClose').onclick = closeWsDrawer;
  drawer.querySelector('#wsdSet').onclick = choose;

  // 宽度：记忆值 + 主区让位（真分栏，两侧窗口大小可拖）
  const applyW = (w) => {
    const ww = Math.max(340, Math.min(Math.round(w), Math.max(340, window.innerWidth - 360)));
    drawer.style.width = ww + 'px';
    const m = $('main');
    if (m) m.style.marginRight = ww + 'px';
    return ww;
  };
  applyW(Number(localStorage.getItem('myagentWsDrawerW') || 0) || Math.min(640, Math.floor(window.innerWidth * 0.42)));

  // 分隔条拖拽：左右调整 两栏 宽度
  const sp = drawer.querySelector('#wsdSplitter');
  sp.onmousedown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = drawer.getBoundingClientRect().width;
    sp.classList.add('dragging');
    const move = (ev) => {
      ev.preventDefault();
      applyW(startW + (startX - ev.clientX));
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      sp.classList.remove('dragging');
      try { localStorage.setItem('myagentWsDrawerW', String(Math.round(drawer.getBoundingClientRect().width))); } catch { /* ignore */ }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  const bodyEl = drawer.querySelector('#wsdBody');

  // 未选择工作区 → 空页面 + 选择按钮（不展示公共工作区内容）
  if (!ws) {
    bodyEl.innerHTML =
      `<div class="wsd-empty">` +
      `<div class="we-ic">${icon('folderTree', 44)}</div>` +
      `<div class="we-t">尚未为本会话选择工作区</div>` +
      `<div class="we-s">选择后，agent 读写、@ 提及与文件浏览都将使用该目录</div>` +
      `<button type="button" class="pbtn accent" id="weChoose" style="padding:7px 22px">选择工作区</button>` +
      `</div>`;
    bodyEl.querySelector('#weChoose').onclick = choose;
    return;
  }

  // 已选择工作区：加载文件树 + 编辑器
  const treeBox = document.createElement('div');
  treeBox.className = 'files-tree';
  treeBox.innerHTML = '<div class="files-tree-head">加载中…</div>';
  const editorBox = document.createElement('div');
  editorBox.className = 'files-editor';
  editorBox.innerHTML = '<div class="pc-empty">从左侧选择文件查看 / 编辑。</div>';
  bodyEl.innerHTML = '';
  bodyEl.appendChild(treeBox);
  bodyEl.appendChild(editorBox);
  let files = [];
  try {
    files = (await api(`/api/files?session=${encodeURIComponent(sid)}`)).files || [];
  } catch (e) {
    treeBox.innerHTML = `<div class="pc-empty">读取失败：${esc(e.message)}</div>`;
    return;
  }
  treeBox.innerHTML = `<div class="files-tree-head">${files.length} 个文件 · 保存即时写回工作区</div><div id="wsdTreeBody"></div>`;

  const treeBody = treeBox.querySelector('#wsdTreeBody');
  const root = buildFileTree(files);

  const drawNode = (node, container, depth, prefix) => {
    const entries = [...node.dirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [dirName, child] of entries) {
      const pathKey = prefix ? `${prefix}/${dirName}` : dirName;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tree-row dir';
      row.style.paddingLeft = `${8 + depth * 12}px`;
      const collapsed = state.treeCollapsed.has(pathKey);
      row.innerHTML = `<span class="tchev">${icon(collapsed ? 'chevronRight' : 'chevronDown', 14)}</span><span style="margin-left:4px">${icon('folder', 14)} ${esc(dirName)}</span>`;
      container.appendChild(row);
      const sub = document.createElement('div');
      sub.style.display = collapsed ? 'none' : 'block';
      container.appendChild(sub);
      row.onclick = () => {
        if (state.treeCollapsed.has(pathKey)) state.treeCollapsed.delete(pathKey);
        else state.treeCollapsed.add(pathKey);
        const nowCollapsed = state.treeCollapsed.has(pathKey);
        sub.style.display = nowCollapsed ? 'none' : 'block';
        row.querySelector('.tchev').innerHTML = icon(nowCollapsed ? 'chevronRight' : 'chevronDown', 14);
      };
      drawNode(child, sub, depth + 1, pathKey);
    }
    for (const f of node.files.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tree-row file';
      row.style.paddingLeft = `${8 + depth * 12 + 14}px`;
      row.title = '点击查看/编辑 · 拖到对话框插入引用';
      row.innerHTML = `${icon('fileText', 13)} <span style="margin-left:4px">${esc(f.name)}</span><span class="tsize">${fmtNum(f.size)}B</span>`;
      row.draggable = true; // 可拖入对话框插入 @路径 引用
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/wspath', f.path);
        e.dataTransfer.effectAllowed = 'copy';
      });
      row.onclick = () => openFileEditor(editorBox, f.path);
      container.appendChild(row);
    }
  };
  drawNode(root, treeBody, 0, '');

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'pbtn accent';
  newBtn.textContent = '＋ 新建文件';
  newBtn.style.margin = '10px 8px';
  newBtn.onclick = () => openFileEditor(editorBox, '');
  treeBody.appendChild(newBtn);
}

function closeWsDrawer() {
  const d = $('wsDrawer');
  if (d) d.remove();
  const m = $('main');
  if (m) m.style.marginRight = ''; // 恢复对话区宽度
}

/* ---------------- 提示词模板库（# 触发 / /tpl 命令 / 设置页管理） ---------------- */

/** 原生文件夹选择器（客户端 WebView2 桥接 C# FolderBrowserDialog）；浏览器模式返回 null */
function pickLocalFolder() {
  return new Promise((resolve) => {
    if (!(window.chrome && window.chrome.webview)) { resolve(null); return; }
    let done = false;
    window.__applyWsPick = (p) => {
      if (done) return;
      done = true;
      try { delete window.__applyWsPick; } catch { /* ignore */ }
      resolve(p);
    };
    postToHost({ type: 'pick-folder' });
    setTimeout(() => {
      if (!done) { done = true; try { delete window.__applyWsPick; } catch { /* ignore */ } resolve(null); }
    }, 180000); // 选择框最长等 3 分钟
  });
}

/** 工作区选择弹窗（深色；客户端带原生文件夹选择器，也可手动输入任意路径） */
function openWsChoose(apply) {
  const inClient = !!(window.chrome && window.chrome.webview);
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = 'modal-box';
  box.innerHTML =
    `<div class="modal-title">选择工作区</div>` +
    `<div class="modal-msg">agent 读写、@ 提及与文件浏览都将使用该目录。可选择任意本地文件夹（不限于平台目录）。</div>` +
    (inClient ? `<button type="button" class="pbtn wsc-btn" id="wscBrowse">浏览本地文件夹…</button>` : '') +
    `<div class="form-row"><label>或手动输入路径</label><input id="wscPath" placeholder="D:\\projects\\demo（或相对路径 ws/demo）" /></div>` +
    `<div class="modal-ops"><button type="button" class="pbtn" data-x>取消</button><button type="button" class="pbtn accent" data-ok>保存</button></div>`;
  mask.appendChild(box);
  document.body.appendChild(mask);
  const close = () => mask.remove();
  const inp = box.querySelector('#wscPath');
  const browse = box.querySelector('#wscBrowse');
  if (browse) {
    browse.onclick = async () => {
      const p = await pickLocalFolder();
      if (p) inp.value = p;
    };
  }
  box.querySelector('[data-x]').onclick = close;
  mask.onclick = (e) => { if (e.target === mask) close(); };
  box.querySelector('[data-ok]').onclick = () => {
    const v = inp.value.trim();
    if (!v) { inp.focus(); return; }
    close();
    apply(v);
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); box.querySelector('[data-ok]').click(); } });
  (browse || inp).focus();
}

async function openFileEditor(wrap, path) {
  const box = wrap.querySelector('#wsdEditor') || wrap.querySelector('#fileEditor') || wrap;
  box.innerHTML = '<div class="pc-empty">加载中…</div>';
  let content = '';
  if (path) {
    try {
      const d = await api(`/api/read?path=${encodeURIComponent(path)}&session=${encodeURIComponent(state.sessionId || '')}`);
      content = d.content;
    } catch (e) {
      box.innerHTML = `<div class="msg note err">读取失败：${esc(e.message)}</div>`;
      return;
    }
  }
  box.innerHTML =
    `<div class="fe-head"><input id="fePath" value="${esc(path)}" placeholder="相对路径，如 notes/idea.md" />` +
    `<button class="pbtn accent" id="feSave">保存</button></div>` +
    `<textarea id="feBody" spellcheck="false"></textarea>`;
  const ta = box.querySelector('#feBody');
  ta.value = content;
  box.querySelector('#feSave').onclick = async () => {
    const p = box.querySelector('#fePath').value.trim();
    if (!p) { alert('请填写文件路径'); return; }
    try {
      const r = await api('/api/write', { method: 'POST', body: JSON.stringify({ path: p, content: ta.value, session: state.sessionId || '' }) });
      appendNote(`💾 已保存 ${r.path}（${r.bytes} 字节）`);
      state.treeCollapsed.clear();
    } catch (e) {
      alert('保存失败：' + e.message);
    }
  };
}

/* ---------------- 提示词模板库（# 触发 / /tpl 命令 / 设置页管理） ---------------- */

const DEFAULT_TPLS = [
  { id: 'tpl-review', name: '代码审查', text: '请审查以下代码，按缺陷优先列出问题（正确性 / 边界 / 安全 / 可读性）：\n\n```\n\n```' },
  { id: 'tpl-summarize', name: '总结要点', text: '请把以下内容总结为 5 条要点，每条一行：\n\n' },
  { id: 'tpl-translate', name: '翻译成英文', text: '请把以下内容翻译成英文，保留 Markdown 格式与代码块：\n\n' },
];

function loadTemplates() {
  try {
    const raw = JSON.parse(localStorage.getItem('myagentPromptTemplates') || 'null');
    if (Array.isArray(raw)) return raw;
  } catch { /* ignore */ }
  return DEFAULT_TPLS.map((x) => ({ ...x }));
}
function saveTemplates(list) {
  try { localStorage.setItem('myagentPromptTemplates', JSON.stringify(list)); } catch { /* ignore */ }
}

let tpl = { open: false, items: [], idx: 0, start: -1 };

function renderTplPanel() {
  let p = $('tplPanel');
  if (!tpl.open || !tpl.items.length) { if (p) p.remove(); return; }
  if (!p) {
    p = document.createElement('div');
    p.id = 'tplPanel';
    $('composerWrap').appendChild(p);
  }
  p.innerHTML = tpl.items.map((t2, i) =>
    `<button type="button" class="sitem ${i === tpl.idx ? 'active' : ''}" data-i="${i}"><b>${esc(t2.name)}</b><span>${esc(truncate(String(t2.text).replace(/\n/g, ' '), 42))}</span></button>`).join('');
  for (const b of p.querySelectorAll('.sitem')) {
    b.onclick = () => runTpl(tpl.items[+b.dataset.i]);
  }
  const act = p.querySelector('.sitem.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

function runTpl(item) {
  const input = $('input');
  const v = input.value;
  const caret = input.selectionStart ?? v.length;
  const before = v.slice(0, tpl.start);
  const after = v.slice(caret);
  input.value = before + item.text + after;
  tpl.open = false;
  renderTplPanel();
  input.focus();
  const pos = (before + item.text).length;
  input.setSelectionRange(pos, pos);
  fitInput();
}

function tplOnInput() {
  const input = $('input');
  const v = input.value;
  const caret = input.selectionStart ?? v.length;
  const m = /#([^\s#@/]*)$/.exec(v.slice(0, caret));
  if (!m) { if (tpl.open) { tpl.open = false; renderTplPanel(); } return; }
  const kw = m[1].toLowerCase();
  tpl.open = true;
  tpl.start = caret - m[0].length;
  tpl.items = loadTemplates().filter((x) => x.name.toLowerCase().includes(kw)).slice(0, 10);
  tpl.idx = 0;
  renderTplPanel();
}

/* ---------------- @ 提及（文件 / 专家） ---------------- */

let mention = { open: false, items: [], idx: 0, start: -1 };

async function loadMentionSource() {
  if (state.mentionCache && Date.now() - (state.mentionCacheAt || 0) < 60000) return state.mentionCache;
  let files = [];
  try { files = (await api('/api/files')).files || []; } catch { /* 忽略 */ }
  let agents = [];
  try { agents = (await api('/api/agents')).agents || []; } catch { /* 忽略 */ }
  agents = [...loadCustomAgents(), ...agents];
  const src = [
    ...files.map((f) => ({ kind: 'file', value: '@' + f.path, label: '📄 ' + f.path, hint: fmtNum(f.size) + ' B' })),
    ...agents.map((a) => ({ kind: 'agent', value: a.opening || `你现在是「${a.name}」。`, label: (a.icon || '🤖') + ' ' + a.name, hint: '专家 · 插入开场指令' })),
  ];
  state.mentionCache = src;
  state.mentionCacheAt = Date.now();
  return src;
}

function renderMentionPanel() {
  let p = $('mentionPanel');
  if (!mention.open || !mention.items.length) { if (p) p.remove(); return; }
  if (!p) {
    p = document.createElement('div');
    p.id = 'mentionPanel';
    $('composerWrap').appendChild(p);
  }
  p.innerHTML = mention.items.map((c, i) =>
    `<button type="button" class="sitem ${i === mention.idx ? 'active' : ''}" data-i="${i}"><b>${esc(c.label)}</b><span>${esc(c.hint || '')}</span></button>`).join('');
  for (const b of p.querySelectorAll('.sitem')) {
    b.onclick = () => runMention(mention.items[+b.dataset.i]);
  }
  const act = p.querySelector('.sitem.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

function runMention(item) {
  const input = $('input');
  const v = input.value;
  const caret = input.selectionStart ?? v.length;
  const before = v.slice(0, mention.start);
  const after = v.slice(caret);
  input.value = before + item.value + (item.kind === 'file' ? ' ' : '') + after;
  mention.open = false;
  renderMentionPanel();
  input.focus();
  input.setSelectionRange((before + item.value).length + (item.kind === 'file' ? 1 : 0), (before + item.value).length + (item.kind === 'file' ? 1 : 0));
  fitInput();
}

async function mentionOnInput() {
  const input = $('input');
  const v = input.value;
  const caret = input.selectionStart ?? v.length;
  const m = /@([^\s@]*)$/.exec(v.slice(0, caret));
  if (!m) {
    if (mention.open) { mention.open = false; renderMentionPanel(); }
    return;
  }
  const kw = m[1].toLowerCase();
  const src = await loadMentionSource();
  mention.open = true;
  mention.start = caret - m[0].length;
  mention.items = src.filter((x) => x.label.toLowerCase().includes(kw) || x.value.toLowerCase().includes(kw)).slice(0, 12);
  mention.idx = 0;
  renderMentionPanel();
}

/* ---------------- 会话内搜索（Ctrl+F 高亮跳转） ---------------- */

const findState = { open: false, hits: [], idx: 0, kw: '' };

function openFindBar() {
  if (state.view !== 'chat') return;
  let bar = $('findBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'findBar';
    bar.innerHTML =
      `<input id="findInput" placeholder="在会话中查找…" />` +
      `<span id="findCount">0/0</span>` +
      `<button type="button" id="findPrev" title="上一个（Shift+Enter）">↑</button>` +
      `<button type="button" id="findNext" title="下一个（Enter）">↓</button>` +
      `<button type="button" id="findClose" title="关闭（Esc）">✕</button>`;
    $('main').appendChild(bar);
    const inp = bar.querySelector('#findInput');
    inp.addEventListener('input', () => runFind(inp.value));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); closeFindBar(); }
    });
    bar.querySelector('#findPrev').onclick = () => stepFind(-1);
    bar.querySelector('#findNext').onclick = () => stepFind(1);
    bar.querySelector('#findClose').onclick = closeFindBar;
  }
  findState.open = true;
  bar.style.display = 'flex';
  const inp = bar.querySelector('#findInput');
  inp.focus();
  inp.select();
}

function clearFind() {
  for (const m of document.querySelectorAll('#stream mark.find-hit')) {
    const parent = m.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  }
  findState.hits = [];
  findState.idx = 0;
  const c = $('findCount');
  if (c) c.textContent = '0/0';
}

function runFind(kw) {
  clearFind();
  findState.kw = kw;
  if (!kw) return;
  const lower = kw.toLowerCase();
  const walker = document.createTreeWalker($('stream'), NodeFilter.SHOW_TEXT, null);
  const targets = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && n.nodeValue.toLowerCase().includes(lower)) targets.push(n);
  }
  for (const tn of targets) {
    const text = tn.nodeValue;
    const lowText = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let pos = 0;
    let i;
    while ((i = lowText.indexOf(lower, pos)) !== -1) {
      if (i > pos) frag.appendChild(document.createTextNode(text.slice(pos, i)));
      const m = document.createElement('mark');
      m.className = 'find-hit';
      m.textContent = text.slice(i, i + kw.length);
      frag.appendChild(m);
      findState.hits.push(m);
      pos = i + kw.length;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    if (tn.parentNode) tn.parentNode.replaceChild(frag, tn);
  }
  if (findState.hits.length) { findState.idx = 0; focusHit(); }
  updateFindCount();
}

function stepFind(dir) {
  if (!findState.hits.length) return;
  findState.idx = (findState.idx + dir + findState.hits.length) % findState.hits.length;
  focusHit();
  updateFindCount();
}

function focusHit() {
  for (const m of findState.hits) m.classList.remove('active');
  const m = findState.hits[findState.idx];
  if (!m) return;
  m.classList.add('active');
  m.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function updateFindCount() {
  const c = $('findCount');
  if (c) c.textContent = findState.hits.length ? `${findState.idx + 1}/${findState.hits.length}` : '0/0';
}

function closeFindBar() {
  clearFind();
  findState.open = false;
  const bar = $('findBar');
  if (bar) bar.style.display = 'none';
  $('input').focus();
}

/* ---------------- 模型参数浮层（⚙ / /params） ---------------- */

async function toggleParamsPanel() {
  const old = $('paramsPanel');
  if (old) { old.remove(); return; }
  const s = state.serverState || {};
  const p = s.params || {};
  const panel = document.createElement('div');
  panel.id = 'paramsPanel';
  panel.innerHTML =
    `<div class="modal-title" style="margin-bottom:10px">模型参数</div>` +
    `<div class="form-row"><label>temperature（随机性，0–1）</label>` +
    `<div style="display:flex;align-items:center;gap:10px"><input type="range" id="ppTemp" min="0" max="1" step="0.1" value="${typeof p.temperature === 'number' ? p.temperature : 0.4}" style="flex:1" /><b id="ppTempV" style="font-family:var(--mono);min-width:32px">${typeof p.temperature === 'number' ? p.temperature : 0.4}</b></div></div>` +
    `<div class="form-row"><label>max tokens（留空 = 模型默认）</label><input id="ppMax" type="number" min="1" step="128" placeholder="默认" value="${typeof p.maxTokens === 'number' ? p.maxTokens : ''}" /></div>` +
    `<div class="ne-foot"><button class="pbtn" id="ppCancel">取消</button><button class="pbtn accent" id="ppSave">保存并生效</button></div>`;
  $('composerWrap').appendChild(panel);
  const temp = panel.querySelector('#ppTemp');
  temp.addEventListener('input', () => { panel.querySelector('#ppTempV').textContent = temp.value; });
  panel.querySelector('#ppCancel').onclick = () => panel.remove();
  panel.querySelector('#ppSave').onclick = async () => {
    const maxV = panel.querySelector('#ppMax').value.trim();
    try {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ params: { temperature: Number(temp.value), maxTokens: maxV ? Number(maxV) : null } }),
      });
      panel.remove();
      appendNote('🎛 模型参数已生效');
      loadState();
    } catch (e) {
      alert('保存失败：' + e.message);
    }
  };
}

/* ---------------- 审计视图（跨会话审批请求/决策时间线） ---------------- */

const auditOpts = { tool: '', kind: '' };

async function renderAuditPage() {
  const stream = $('stream');
  stream.innerHTML = '<div class="msg note">加载审计记录…</div>';
  let d;
  try {
    d = await api('/api/audit');
  } catch (e) {
    stream.innerHTML = `<div class="msg note err">读取失败：${esc(e.message)}</div>`;
    return;
  }
  stream.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'office-head';
  head.innerHTML =
    `<h1 class="office-title">审计日志</h1>` +
    `<div class="office-sub">全部会话的审批请求与决策记录（工具执行前的守卫留痕），按时间倒序。</div>`;
  stream.appendChild(head);

  const ctrl = document.createElement('div');
  ctrl.className = 'trace-ctrl';
  ctrl.innerHTML =
    `<button type="button" class="tbtn ${auditOpts.kind === 'decision' ? 'on' : ''}" data-k="decision">${auditOpts.kind === 'decision' ? '只看决策' : '全部记录'}</button>` +
    `<input id="auditTool" placeholder="按工具名筛选…" value="${esc(auditOpts.tool)}" />`;
  stream.appendChild(ctrl);
  ctrl.querySelector('[data-k]').onclick = () => {
    auditOpts.kind = auditOpts.kind === 'decision' ? '' : 'decision';
    renderAuditPage();
  };
  ctrl.querySelector('#auditTool').addEventListener('input', (e) => {
    auditOpts.tool = e.target.value.trim().toLowerCase();
    renderAuditPage();
    const inp = $('auditTool');
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  });

  const rows = d.rows.filter((r) =>
    (!auditOpts.kind || r.kind === auditOpts.kind) &&
    (!auditOpts.tool || r.tool.toLowerCase().includes(auditOpts.tool)));

  const card = document.createElement('div');
  card.className = 'office-section';
  card.innerHTML = `<div class="office-sec-t">记录 <span class="dim">${rows.length} 条${auditOpts.tool || auditOpts.kind ? '（已筛选）' : ''}</span></div>`;
  stream.appendChild(card);

  if (!rows.length) {
    card.innerHTML += '<div class="pc-empty">暂无审批记录 —— 在工作区权限模式下执行命令/写文件会产生审批留痕。</div>';
    return;
  }
  let prevDay = '';
  for (const r of rows) {
    const day = (r.ts || '').slice(0, 10);
    if (day && day !== prevDay) {
      const dh = document.createElement('div');
      dh.className = 'audit-day';
      dh.textContent = day;
      card.appendChild(dh);
      prevDay = day;
    }
    const row = document.createElement('div');
    row.className = 'audit-row';
    const isReq = r.kind === 'request';
    row.innerHTML =
      `<span class="a-time">${esc((r.ts || '').slice(11, 19))}</span>` +
      `<span class="badge ${isReq ? 'b-tool' : (r.detail === '允许' ? 'b-req' : 'b-rej')}">${isReq ? '请求' : esc(r.detail)}</span>` +
      `<span class="a-tool">${esc(r.tool || '—')}</span>` +
      `<span class="a-detail">${esc(truncate(r.detail, 90))}</span>` +
      `<span class="a-sess">${esc(truncate(r.title || r.sid, 14))}</span>`;
    card.appendChild(row);
  }
}

/* ---- 云智能体：智能体卡片，一键开场 ---- */

async function renderAgentsPage() {
  const stream = $('stream');
  stream.innerHTML = '';
  stream.appendChild(pageCard('智能体广场', '选择一个智能体 → 自动建会话并注入开场指令'));
  let agents = [];
  try {
    agents = (await api('/api/agents')).agents;
  } catch (e) {
    stream.appendChild(Object.assign(document.createElement('div'), { className: 'msg note err', textContent: `读取失败：${e.message}` }));
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'agent-grid';
  for (const a of agents) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'agent-card';
    c.innerHTML =
      `<div class="ag-ic">${esc(a.icon || '🤖')}</div>` +
      `<div class="ag-nm">${esc(a.name)}</div>` +
      `<div class="ag-ds">${esc(a.desc || '')}</div>`;
    c.onclick = () => startAgent(a);
    grid.appendChild(c);
  }
  stream.appendChild(grid);
}

async function startAgent(agent) {
  try {
    const { id } = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: agent.name }) });
    await refreshSessions();
    await openSession(id, agent.name, { skipWelcome: true });
    const input = $('input');
    input.value = agent.opening || `请介绍下你能做什么。`;
    send();
  } catch (e) {
    appendNote(`启动智能体失败：${e.message}`, true);
  }
}

/* ---------------- 分组筛选下拉 ---------------- */

function closeProjMenu() {
  const m = $('projMenu');
  if (m) m.remove();
}

function openProjFilterMenu() {
  closeProjMenu();
  const menu = document.createElement('div');
  menu.id = 'projMenu';
  menu.style.cssText =
    'position:fixed;z-index:50;background:var(--panel3);border:1px solid var(--line);border-radius:10px;' +
    'padding:4px;min-width:150px;box-shadow:0 12px 32px rgba(0,0,0,.5)';
  const mk = (label, val) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = val ? label : label;
    b.style.cssText = 'display:block;width:100%;text-align:left;background:transparent;border:0;color:var(--text-dim);font:12px/1.5 inherit;font-family:inherit;padding:7px 10px;border-radius:6px;cursor:pointer' + (state.projFilter === val ? ';color:var(--accent);background:var(--accent-soft)' : '');
    b.onmouseenter = () => { b.style.background = 'var(--accent-soft)'; };
    b.onmouseleave = () => { b.style.background = state.projFilter === val ? 'var(--accent-soft)' : 'transparent'; };
    b.onclick = () => {
      state.projFilter = val;
      $('projFilterName').textContent = val || '项目';
      $('projFilter').classList.toggle('active', !!val);
      closeProjMenu();
      refreshSessions();
    };
    menu.appendChild(b);
  };
  mk('全部分组', '');
  const names = [...new Set(Object.values(state.groups))].sort();
  for (const n of names) mk(n, n);
  const r = $('projFilter').getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 170) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', closeProjMenu, { once: true }), 0);
}

function refreshSessionsQuiet() {
  if (!state.sending) refreshSessions();
}

async function newSession(forSend) {
  // 已有空「新会话」（仅 session_start）→ 直接跳转，不再重复创建
  if (!forSend) {
    try {
      const { sessions } = await api('/api/sessions');
      const empty = sessions.find((s) => s.title === '新会话' && s.events <= 1);
      if (empty) {
        switchView('chat');
        await openSession(empty.id, empty.title);
        return;
      }
    } catch { /* 探测失败则走正常创建 */ }
  }
  try {
    const { id } = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: '新会话' }) });
    state.sessionId = null;
    await refreshSessions();
    await openSession(id, '新会话', { skipWelcome: !!forSend });
    $('input').focus();
  } catch (e) {
    appendNote(`创建会话失败：${e.message}`, true);
  }
}

async function openSession(id, title, opts) {
  opts = opts || {};
  state.sessionId = id;
  state.sessionTitle = title || id;
  state.lastSeq = 0;
  state.events = 0;
  state.hasEverScrolled = false;
  state.pendingUserText = null;
  state.editing = null;
  const eb = $('editBanner');
  if (eb) eb.style.display = 'none';
  state.toolRows.clear();
  state.approvalCards.clear();
  state.shownApprovals.clear();
  state.stats = { rounds: 0, steps: 0, tokens: 0 };
  state.traceSeq = 0;
  $('sessTitle').textContent = state.sessionTitle;
  postToHost({ type: 'session-title', title: state.sessionTitle });
  // 工作区抽屉跟随对话：切换会话时自动重渲染为新会话的工作区
  const wd = $('wsDrawer');
  if (wd && wd.dataset.sid !== id) openWsDrawer(); // 异步重渲染，不阻塞切换
  setSessStatus(false, '');
  $('stream').innerHTML = '';
  $('send').disabled = false;
  $('send').textContent = '➤';
  updateStatusBar();
  $('input').focus();
  await pollEvents();
  if (state.events === 0 && !opts.skipWelcome) renderWelcome();
  refreshSessions();
}

/* ---------------- 欢迎屏 ---------------- */

const SUGGESTIONS = [
  { s1: '📝 写一个文件', s2: '在工作区创建 notes/todo.md，列三件今天要做的事' },
  { s1: '🧠 记住一件事', s2: '用 memory_save 记住：用户喜欢深色界面' },
  { s1: '📂 讲讲项目结构', s2: '读取 README.md 和 package.json，总结这个项目' },
  { s1: '🔗 讲一条工作流', s2: '工作流 JSON 的 steps 里 parallel 和 dependencies 怎么用？' },
];

function renderWelcome() {
  if (state.events > 0) return;
  const old = $('welcome');
  if (old) old.remove();
  const div = document.createElement('div');
  div.id = 'welcome';
  div.innerHTML =
    '<div class="big-logo">A</div>' +
    '<h1>有什么可以帮你的？</h1>' +
    '<p>agent 可读文件、写文件、调用 MCP 工具 —— 下面试试：</p>' +
    '<div class="suggestions"></div>';
  const box = div.querySelector('.suggestions');
  for (const s of SUGGESTIONS) {
    const c = document.createElement('div');
    c.className = 'sug-card';
    c.innerHTML = `<div class="s1">${s.s1}</div><div class="s2">${esc(s.s2)}</div>`;
    c.onclick = () => {
      $('input').value = s.s2;
      fitInput();
      $('input').focus();
    };
    box.appendChild(c);
  }
  $('stream').appendChild(div);
}

/* ---------------- Tab ---------------- */

function switchTab(tab) {
  state.tab = tab;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === tab);
  if (tab === 'trace') { state.traceSeq = 0; pollTrace(); }
  else if (tab === 'ctx') renderCtx();
  else reloadDialog();
}

/* ---------------- 上下文页 ---------------- */

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(n));
}

function fmtDurLong(ms) {
  ms = Number(ms) || 0;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

/** SVG 环形图（零依赖）：segments [{v, color}] */
function donut(segments, centerBig, centerSub) {
  const total = segments.reduce((a, s) => a + s.v, 0) || 1;
  const R = 50;
  const C = 2 * Math.PI * R;
  let off = 0;
  const segs = segments
    .map((s) => {
      const len = (s.v / total) * C;
      const el = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${s.color}" stroke-width="13" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)" />`;
      off += len;
      return el;
    })
    .join('');
  return `<svg width="140" height="140" viewBox="0 0 140 140"><circle r="${R}" cx="70" cy="70" fill="none" stroke="var(--panel3)" stroke-width="13" />${segs}<text x="70" y="66" text-anchor="middle" fill="var(--text)" font-size="15" font-weight="700">${esc(centerBig)}</text><text x="70" y="84" text-anchor="middle" fill="var(--muted)" font-size="10">${esc(centerSub)}</text></svg>`;
}

function legendRow(color, name, val, pct) {
  return `<div class="lg-row"><span class="lg-dot" style="background:${color}"></span><span class="lg-nm">${esc(name)}</span><span class="lg-v">${esc(val)}</span><span class="lg-p">${esc(pct)}</span></div>`;
}

async function renderCtx() {
  const stream = $('stream');
  stream.innerHTML = '';
  if (!state.sessionId) {
    stream.innerHTML = '<div class="msg note">选择会话后查看上下文分析。</div>';
    return;
  }
  let d;
  try {
    d = await api(`/api/context/${state.sessionId}`);
  } catch (e) {
    stream.innerHTML = `<div class="msg note err">读取失败：${esc(e.message)}</div>`;
    return;
  }
  const s = state.serverState || {};

  // ---- 统计卡 ×6 ----
  const billed = d.billing.input + d.billing.output;
  const cards = document.createElement('div');
  cards.className = 'ctx-cards';
  cards.innerHTML =
    `<div class="cc"><div class="cc-t">轮次 / 步数</div><div class="cc-v">${d.rounds} / ${d.steps}</div></div>` +
    `<div class="cc"><div class="cc-t">计费 Token</div><div class="cc-v">${fmtNum(billed)}</div><div class="cc-s">输入 ${fmtNum(d.billing.input)} · 输出 ${fmtNum(d.billing.output)}</div></div>` +
    `<div class="cc"><div class="cc-t">工具调用</div><div class="cc-v">${d.toolCalls} 次</div><div class="cc-s">运行 ${fmtDurLong(d.toolMs)}</div></div>` +
    `<div class="cc"><div class="cc-t">活跃时长</div><div class="cc-v">${fmtDurLong(d.activeMs)}</div><div class="cc-s">模型调用 ${d.modelCalls} 次</div></div>` +
    `<div class="cc"><div class="cc-t">模型</div><div class="cc-v sm">${esc(d.model)}</div><div class="cc-s">上下文窗口 ${d.window ? fmtNum(d.window) : '未报告'}</div></div>` +
    `<div class="cc"><div class="cc-t">压缩</div><div class="cc-v">${d.compactions} 次</div><div class="cc-s">当前上下文 ~${fmtNum(d.currentTokens)} tok</div></div>`;
  stream.appendChild(cards);

  // ---- 两列：Token 组成 + 耗时 ----
  const two = document.createElement('div');
  two.className = 'ctx-two';
  const inV = d.billing.input, outV = d.billing.output;
  const billTotal = inV + outV;
  const tokDonut = document.createElement('div');
  tokDonut.className = 'ctx-box';
  tokDonut.innerHTML =
    `<div class="ctx-box-t">Token 组成 <span class="dim">计费口径，按整个会话</span></div>` +
    `<div class="donut-wrap">${donut(
      [
        { v: inV, color: '#4f8ef7' },
        { v: outV, color: '#e8a33d' },
      ],
      fmtNum(billTotal),
      '计费 Token',
    )}<div class="lg">${legendRow('#4f8ef7', '输入', fmtNum(inV), billTotal ? Math.round((inV / billTotal) * 100) + '%' : '—')}${legendRow('#e8a33d', '输出', fmtNum(outV), billTotal ? Math.round((outV / billTotal) * 100) + '%' : '—')}</div></div>`;

  const modelMs = Math.max(0, d.activeMs - d.toolMs);
  const durDonut = document.createElement('div');
  durDonut.className = 'ctx-box';
  durDonut.innerHTML =
    `<div class="ctx-box-t">耗时 <span class="dim">按事件时间戳估算</span></div>` +
    `<div class="donut-wrap">${donut(
      [
        { v: modelMs, color: '#c7a6f0' },
        { v: d.toolMs, color: '#7fd6c2' },
      ],
      fmtDurLong(d.activeMs),
      '活跃时长',
    )}<div class="lg">${legendRow('#c7a6f0', '模型回合', fmtDurLong(modelMs), d.activeMs ? Math.round((modelMs / d.activeMs) * 100) + '%' : '—')}${legendRow('#7fd6c2', '工具运行', fmtDurLong(d.toolMs), d.activeMs ? Math.round((d.toolMs / d.activeMs) * 100) + '%' : '—')}</div></div>`;
  two.appendChild(tokDonut);
  two.appendChild(durDonut);
  stream.appendChild(two);

  // ---- 当前上下文组成条 ----
  const comp = d.composition;
  const compTotal = d.currentTokens || 1;
  const segs = [
    ['系统提示+工具定义', comp.system, '#b088f0'],
    ['用户消息', comp.user, '#4f8ef7'],
    ['助手回复', comp.assistant, '#e8a33d'],
    ['工具结果', comp.toolResult, '#7fd6c2'],
  ];
  const compBox = document.createElement('div');
  compBox.className = 'ctx-box wide';
  compBox.innerHTML =
    `<div class="ctx-box-t">当前上下文 <span class="dim">~${fmtNum(d.currentTokens)} tok${d.window ? ` / ${fmtNum(d.window)} · ${Math.round((d.currentTokens / d.window) * 100)}%` : ''}（估算）</span></div>` +
    `<div class="comp-bar">${segs.map(([, v, c]) => `<i style="flex:${Math.max(v, compTotal * 0.002)};background:${c}"></i>`).join('')}</div>` +
    `<div class="lg grid">${segs.map(([nm, v, c]) => legendRow(c, nm, '~' + fmtNum(v), Math.round((v / compTotal) * 100) + '%')).join('')}</div>`;
  stream.appendChild(compBox);

  // ---- 上下文趋势（柱图 + 压缩虚线） ----
  const trendBox = document.createElement('div');
  trendBox.className = 'ctx-box wide';
  const requests = d.trend.filter((t) => t.type === 'request');
  const maxTok = Math.max(...d.trend.map((t) => t.tokens), 1);
  const bars = d.trend
    .map((t) => {
      if (t.type === 'compaction') return `<i class="tbar mark" style="height:100%"></i>`;
      return `<i class="tbar" style="height:${Math.max(4, (t.tokens / maxTok) * 100)}%" title="第 ${t.turn} 轮 · ~${t.tokens.toLocaleString()} tok"></i>`;
    })
    .join('');
  trendBox.innerHTML =
    `<div class="ctx-box-t">上下文趋势 <span class="dim">${requests.length} 次请求 · 竖虚线 = 压缩重置（估算口径）</span></div>` +
    `<div class="trend">${bars}</div>` +
    `<div class="dim" style="font-size:10.5px">悬停柱体预览该请求的上下文规模。</div>`;
  stream.appendChild(trendBox);

  // ---- 上下文浏览器（每轮请求的组成估算） ----
  const browser = document.createElement('div');
  browser.className = 'ctx-box wide';
  let rows = '';
  let lastReq = 0;
  for (const t of d.trend) {
    if (t.type !== 'request') continue;
    rows += `<div class="prow"><span class="prow-t">第 ${t.turn} 轮请求</span><span class="prow-time">~${t.tokens.toLocaleString()} tok</span></div>`;
    lastReq = t.tokens;
  }
  browser.innerHTML = `<div class="ctx-box-t">上下文浏览器 <span class="dim">每次请求带了哪些内容（大小为估算）</span></div>${rows || '<div class="pc-empty">（无请求记录）</div>'}`;
  stream.appendChild(browser);
}

function reloadDialog() {
  if (state.sessionId) {
    state.lastSeq = 0;
    state.events = 0;
    state.toolRows.clear();
    state.approvalCards.clear();
    state.shownApprovals.clear();
    state.stats = { rounds: 0, steps: 0, tokens: 0 };
    $('stream').innerHTML = '';
    pollEvents();
  } else {
    showWelcomeStandalone();
  }
}

/* ---------------- 事件轮询 ---------------- */

const RENDERED_TYPES = new Set(['user', 'assistant', 'tool_call', 'tool_result', 'approval_request', 'approval_decision', 'note']);

async function pollEvents() {
  if (!state.sessionId) return;
  if (state.sending) return; // 流式进行中由 SSE 驱动渲染，轮询只做兜底
  if (state.tab === 'trace') { await pollTrace(); return; }
  if (state.tab !== 'dialog') return;
  let data;
  try {
    data = await api(`/api/sessions/${state.sessionId}/events?since=${state.lastSeq}`);
  } catch {
    return;
  }
  for (const ev of data.events) {
    if (ev.type !== 'user') removeThinking(); // 出现真实过程/回复才撤 loading；user 事件（去重跳过）不撤
    if (RENDERED_TYPES.has(ev.type)) state.events += 1;
    renderEvent(ev);
  }
  state.lastSeq = Math.max(state.lastSeq, data.lastSeq);
  await renderPendingApprovals();
  scrollBottom();
}

/** 轨迹 Tab：增量追加事件行 */
/* ---------------- 轨迹页 ---------------- */

const traceOpts = { collapseRounds: false, collapseTools: false, q: '' };

function traceBrief(ev) {
  switch (ev.type) {
    case 'user': return String(ev.text ?? '');
    case 'assistant': return String(ev.text ?? '') || '(调用工具)';
    case 'tool_call': return `${ev.name} ${truncate(ev.arguments, 90)}`;
    case 'tool_result': return `${ev.ok ? '✓' : '✗'} ${truncate(ev.preview, 90)}`;
    case 'approval_request': return `审批 ${ev.tool} → ${truncate(ev.detail, 60)}`;
    case 'approval_decision': return ev.approved ? '✓ 已允许' : '✗ 已拒绝';
    case 'note': return String(ev.text ?? '');
    case 'compaction': return `压缩 ${ev.covered ?? '?'} 条`;
    default: return '';
  }
}

function ms(a, b) {
  const x = Date.parse(a), y = Date.parse(b);
  return Math.max(0, y - x);
}

async function pollTrace() {
  if (!state.sessionId) return;
  let data;
  try {
    data = await api(`/api/sessions/${state.sessionId}/events?since=0`);
  } catch {
    return;
  }
  if (data.lastSeq === state.traceSeq) return; // 无新事件不重绘
  state.traceSeq = data.lastSeq;
  renderTracePage(data.events);
}

function renderTracePage(events) {
  const stream = $('stream');
  stream.innerHTML = '';

  // ---- 统计条 ----
  const evs = events.filter((e) => e.ts);
  const rounds = evs.filter((e) => e.type === 'user').length;
  const steps = evs.filter((e) => e.type === 'tool_call').length;
  const callTs = new Map();
  let toolMs = 0;
  for (const e of evs) {
    if (e.type === 'tool_call') callTs.set(String(e.callId), Date.parse(e.ts));
    else if (e.type === 'tool_result') {
      const t0 = callTs.get(String(e.callId));
      if (t0) toolMs += Math.max(0, Date.parse(e.ts) - t0);
    }
  }
  const totalMs = evs.length > 1 ? ms(evs[0].ts, evs[evs.length - 1].ts) : 0;
  const tokens = evs.reduce((acc, e) => acc + (e.usage && e.usage.total_tokens ? e.usage.total_tokens : 0), 0);

  const stats = document.createElement('div');
  stats.className = 'trace-stats';
  stats.innerHTML =
    `<b>${rounds}</b> 轮 <b>${steps}</b> 步` +
    `<span class="sep">·</span>工具 ${fmtDur(toolMs)}` +
    `<span class="sep">·</span>总用时 ${fmtDur(totalMs)}` +
    `<span class="sep">·</span>累计 <b>${tokens.toLocaleString()}</b> tok`;
  stream.appendChild(stats);

  // ---- 过滤控件 ----
  const ctrl = document.createElement('div');
  ctrl.className = 'trace-ctrl';
  ctrl.innerHTML =
    `<button type="button" class="tbtn ${traceOpts.collapseRounds ? 'on' : ''}" data-f="rounds">${traceOpts.collapseRounds ? '展开所有轮次' : '收起所有轮次'}</button>` +
    `<button type="button" class="tbtn ${traceOpts.collapseTools ? 'on' : ''}" data-f="tools">${traceOpts.collapseTools ? '展开工具调用' : '收起工具调用'}</button>` +
    `<input id="traceSearch" placeholder="搜索步骤内容…" value="${esc(traceOpts.q)}" />`;
  stream.appendChild(ctrl);
  ctrl.querySelector('[data-f="rounds"]').onclick = (e) => {
    traceOpts.collapseRounds = !traceOpts.collapseRounds;
    renderTracePage(events);
  };
  ctrl.querySelector('[data-f="tools"]').onclick = () => {
    traceOpts.collapseTools = !traceOpts.collapseTools;
    renderTracePage(events);
  };
  ctrl.querySelector('#traceSearch').addEventListener('input', (e) => {
    traceOpts.q = e.target.value.trim().toLowerCase();
    renderTracePage(events);
    const inp = $('traceSearch');
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  });

  // ---- 时间线（输入/模型/工具 三车道） ----
  const t0 = evs.length ? Date.parse(evs[0].ts) : 0;
  const t1 = evs.length ? Date.parse(evs[evs.length - 1].ts) : 0;
  const span = Math.max(1, t1 - t0);
  const tl = document.createElement('div');
  tl.className = 'timeline';
  const lane = (name, cls) => {
    const l = document.createElement('div');
    l.className = `lane ${cls}`;
    l.innerHTML = `<span class="lane-name">${name}</span><div class="lane-track"></div>`;
    return l;
  };
  const lIn = lane('输入', 'l-in');
  const lModel = lane('模型', 'l-model');
  const lTool = lane('工具', 'l-tool');
  const pct = (ts) => `${Math.min(100, Math.max(0, ((Date.parse(ts) - t0) / span) * 100))}%`;
  const toolBars = [];
  for (const e of evs) {
    if (e.type === 'user') {
      const tick = document.createElement('i');
      tick.className = 'tick in';
      tick.style.left = pct(e.ts);
      lIn.querySelector('.lane-track').appendChild(tick);
    } else if (e.type === 'assistant') {
      const tick = document.createElement('i');
      tick.className = 'tick model';
      tick.style.left = pct(e.ts);
      lModel.querySelector('.lane-track').appendChild(tick);
    } else if (e.type === 'tool_call') {
      toolBars.push([e, pct(e.ts)]);
    }
  }
  for (const [call, left] of toolBars) {
    const end = evs.find((x) => x.type === 'tool_result' && String(x.callId) === String(call.callId));
    const w = end ? Math.max(0.4, ((Date.parse(end.ts) - Date.parse(call.ts)) / span) * 100) : 0.5;
    const bar = document.createElement('i');
    bar.className = 'bar tool';
    bar.style.left = left;
    bar.style.width = `${w}%`;
    lTool.querySelector('.lane-track').appendChild(bar);
  }
  tl.appendChild(lIn);
  tl.appendChild(lModel);
  tl.appendChild(lTool);
  stream.appendChild(tl);

  // ---- 轮次分组步骤行 ----
  const turns = [];
  for (const e of evs) {
    if (e.type === 'user') turns.push([]);
    if (turns.length) turns[turns.length - 1].push(e);
    else if (e.type !== 'session_start') turns.push([e]);
  }
  const q = traceOpts.q;
  turns.forEach((items, idx) => {
    const nSteps = items.filter((e) => e.type === 'tool_call').length;
    const round = document.createElement('div');
    round.className = 'round' + (traceOpts.collapseRounds ? ' collapsed' : '');
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'round-head';
    head.innerHTML = `<span>第 ${idx + 1} 轮</span><span class="r-meta">${nSteps} 步 · ${items.length} 事件</span>`;
    head.onclick = () => round.classList.toggle('collapsed');
    round.appendChild(head);
    const bodyEl = document.createElement('div');
    bodyEl.className = 'round-body';
    let prevTs = items.length ? items[0].ts : null;
    for (const e of items) {
      const brief = traceBrief(e);
      if (q && !brief.toLowerCase().includes(q)) { prevTs = e.ts; continue; }
      const isTool = e.type === 'tool_call' || e.type === 'tool_result';
      const isUser = e.type === 'user';
      if (isTool && traceOpts.collapseTools) { prevTs = e.ts; continue; }
      const row = document.createElement('div');
      row.className = 'step-row';
      const badge = isUser ? '<span class="badge b-req">请求</span>'
        : isTool ? '<span class="badge b-tool">工具</span>'
        : e.type === 'assistant' ? '<span class="badge b-reply">回复</span>'
        : '<span class="badge">记录</span>';
      let right = '';
      if (e.usage && e.usage.total_tokens) right += ` <span class="tok">${(e.usage.prompt_tokens ?? 0).toLocaleString()} → ${(e.usage.completion_tokens ?? 0).toLocaleString()} tok</span>`;
      if (prevTs && e.ts) {
        const d = ms(prevTs, e.ts);
        if (d > 0) right += ` <span class="dur">${fmtDur(d)}</span>`;
      }
      row.innerHTML = `<span class="s-seq">#${e.seq}</span>${badge}<span class="s-tx">${esc(truncate(brief, 150))}</span><span class="s-meta">${right}</span>`;
      // 写操作一键回滚：write_file 行加 ↩ 按钮（恢复到该会话首次写入前状态）
      if (e.type === 'tool_call' && e.name === 'write_file') {
        let fp = '';
        try { fp = String(JSON.parse(e.arguments || '{}').file_path || ''); } catch { /* 忽略 */ }
        if (fp) {
          const rb = document.createElement('button');
          rb.type = 'button';
          rb.className = 'pbtn';
          rb.textContent = '↩ 回滚';
          rb.title = `恢复 ${fp} 到本会话写入前状态`;
          rb.onclick = async () => {
            if (!(await uiConfirm(`把 ${fp} 恢复为本会话首次写入前的状态？`, { title: '写操作回滚', danger: true, okText: '回滚' }))) return;
            try {
              const r = await api(`/api/rollback/${state.sessionId}`, { method: 'POST', body: JSON.stringify({ path: fp }) });
              appendNote(`↩ ${r.action || (r.restored ? '已回滚' : '无需回滚')}`);
            } catch (err) {
              appendNote(`回滚失败：${err.message}`, true);
            }
          };
          row.appendChild(rb);
        }
      }
      bodyEl.appendChild(row);
      prevTs = e.ts;
    }
    round.appendChild(bodyEl);
    stream.appendChild(round);
  });
  const el = $('streamScroll');
  el.scrollTop = 0;
}

function renderEvent(ev) {
  switch (ev.type) {
    case 'user':
      if (state.pendingUserText !== null && ev.text === state.pendingUserText) {
        state.pendingUserText = null; // 乐观块已渲染（时间戳即发送时刻），跳过
        // 补记 seq / 原文：重新生成需要从这条 user 消息回退
        const t = state.currentTurn || [...document.querySelectorAll('.turn')].pop();
        if (t && ev.seq) {
          t.dataset.userSeq = String(ev.seq);
          t.dataset.userText = String(ev.text ?? '');
        }
        break;
      }
      appendUser(ev.text, ev.ts, ev.seq);
      break;
    case 'assistant':
      if (ev.withToolCalls) {
        if (ev.text) appendThinkRow(ev.text);
      } else {
        if (typeof ev.usage === 'object' && ev.usage && ev.usage.total_tokens) {
          state.stats.tokens += ev.usage.total_tokens;
          updateStatusBar();
        }
        state.stats.rounds += 1;
        updateStatusBar();
        appendMsg('assistant', ev.text, ev.ts);
      }
      break;
    case 'tool_call':
      state.stats.steps += 1;
      updateStatusBar();
      renderToolCall(ev);
      break;
    case 'tool_result':
      renderToolResult(ev);
      break;
    case 'approval_request':
      renderApprovalSkeleton(ev);
      break;
    case 'approval_decision':
      markApprovalDecision(ev);
      break;
    case 'note':
      appendNote(ev.text);
      break;
    case 'compaction':
      appendNote(`📋 已压缩早期对话（${ev.covered ?? '?'} 条）—— 摘要已注入上下文`);
      break;
  }
}

/* ---------------- 渲染件（回合分组：「用时 X · N 个工具失败 ▸」摘要行） ---------------- */

function currentTurnEl() {
  return state.currentTurn && state.currentTurn.isConnected ? state.currentTurn : $('stream');
}

function fmtDur(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} 分 ${s} 秒`;
}

function fmtClock(ts) {
  const d = ts ? new Date(ts) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function appendUser(text, ts, seq) {
  // 回合容器：本轮所有过程与产物都在其中；最终回复到达时折叠为摘要行
  const turn = document.createElement('div');
  turn.className = 'turn';
  turn.dataset.steps = '0';
  turn.dataset.fails = '0';
  turn.dataset.start = ts ? String(Date.parse(ts)) : String(Date.now());
  if (seq) { turn.dataset.userSeq = String(seq); turn.dataset.userText = String(text ?? ''); }
  $('stream').appendChild(turn);
  state.currentTurn = turn;

  const block = document.createElement('div');
  block.className = 'msg user';
  block.innerHTML = `<div class="ut">${esc(text ?? '')}</div>` +
    `<div class="u-meta"><span class="u-time">${fmtClock(ts)}</span>` +
    `<button class="copy-btn" type="button" data-edit title="编辑并重发">${icon('pencil', 12)}</button>` +
    `<button class="copy-btn" type="button" data-quote title="引用这条消息">${icon('quote', 12)}</button>` +
    `<button class="copy-btn" type="button" data-copy title="复制">${icon('copy', 12)}</button></div>`;
  block.querySelector('[data-quote]').onclick = () => quoteIntoInput(text || '');
  block.querySelector('[data-copy]').onclick = () => {
    const btn = block.querySelector('[data-copy]');
    const done = () => { btn.innerHTML = icon('circleCheck', 12); setTimeout(() => { btn.innerHTML = icon('copy', 12); }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text ?? '').then(done).catch(done);
    } else { done(); }
  };
  block.querySelector('[data-edit]').onclick = () => {
    const input = $('input');
    input.value = text ?? '';
    fitInput();
    input.focus();
    // 编辑模式：记下截断点（该消息 seq），发送时先截断历史再重发
    if (seq) {
      state.editing = { seq };
      const banner = $('editBanner');
      banner.style.display = 'flex';
      banner.dataset.seq = String(seq);
      banner.firstChild && (banner.firstChild.textContent = `✎ 正在编辑第 ${seq} 条消息（发送后其后的内容将被替换）`);
    }
  };
  turn.appendChild(block);
  scrollBottom();
}

/** 回合结束：把工具/思考过程折叠为「用时 X · N 个工具 · M 失败 ▸」摘要行 */
function finalizeTurn(replyTs) {
  const turn = state.currentTurn;
  if (!turn || !turn.isConnected) return;
  // 收尾：移除流式光标（.streaming 的 ::after 闪烁块）
  for (const s of turn.querySelectorAll('.msg.assistant.streaming')) s.classList.remove('streaming');
  const steps = Number(turn.dataset.steps || 0);
  const fails = Number(turn.dataset.fails || 0);
  const start = Number(turn.dataset.start || 0);
  const end = replyTs ? Date.parse(replyTs) : Date.now();
  const dur = Math.max(0, end - start);

  const stepsBox = document.createElement('div');
  stepsBox.className = 'turn-steps';
  // 收集过程件（思考/工具/审批/便签）；最终回复留在折叠盒之外
  const kids = [...turn.children].slice(1).filter(
    (k) => !(k.classList && k.classList.contains('msg') && k.classList.contains('assistant')),
  );
  for (const k of kids) stepsBox.appendChild(k);
  const replyEl = [...turn.children].find(
    (k) => k.classList && k.classList.contains('msg') && k.classList.contains('assistant'),
  );
  if (stepsBox.children.length) {
    if (replyEl) turn.insertBefore(stepsBox, replyEl);
    else turn.appendChild(stepsBox);
  }

  const summary = document.createElement('div');
  summary.className = 'turn-summary';
  summary.innerHTML =
    `<span>用时 ${fmtDur(dur)}</span>` +
    (steps ? `<span class="sep">·</span><span>${steps} 个工具</span>` : '') +
    (fails ? `<span class="sep">·</span><span class="bad">${fails} 个工具失败</span>` : '') +
    '<span class="chev">▸</span>';
  summary.onclick = () => turn.classList.toggle('show-steps');
  if (stepsBox.parentNode === turn) turn.insertBefore(summary, stepsBox);
  else turn.appendChild(summary);

  turn.classList.add('done');
  state.currentTurn = null;
}

/** 把工作区文件引用（@路径）插入输入框光标处（拖拽工作区文件到对话框时调用） */
function insertWsRef(path) {
  if (state.view !== 'chat') switchView('chat');
  const input = $('input');
  const caret = input.selectionStart ?? input.value.length;
  const v = input.value;
  const before = v.slice(0, caret);
  const after = v.slice(caret);
  const piece = '@' + path + ' ';
  input.value = before + piece + after;
  input.focus();
  const pos = (before + piece).length;
  input.setSelectionRange(pos, pos);
  fitInput();
}

/** 引用一段内容到输入框（截断 100 字，多行加 > 前缀） */
function quoteIntoInput(text) {
  const t = String(text || '').trim();
  if (!t) return;
  const quoted = truncate(t, 100).split('\n').map((l) => '> ' + l).join('\n');
  const input = $('input');
  const existing = input.value.trim();
  input.value = quoted + '\n\n' + (existing ? existing + '\n\n' : '');
  input.focus();
  input.setSelectionRange(0, 0);
  fitInput();
}

/** 定位某条回复对应的原始提问：优先用回合 dataset，失败则从事件流回查（重渲染后仍可靠） */
async function locateTurnOrigin(div, getText) {
  const t = div.closest('.turn');
  let userSeq = Number((t && t.dataset.userSeq) || 0);
  let userText = (t && t.dataset.userText) || '';
  if (userSeq && userText) return { userSeq, userText };
  // 回退 1：事件流里按回复文本前缀找 assistant，再往前找最近 user
  let evs = [];
  try { evs = (await api(`/api/sessions/${state.sessionId}/events?since=0`)).events || []; } catch { evs = []; }
  const replyHead = String(getText() || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  let idx = -1;
  if (replyHead) {
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.type === 'assistant' && String(e.text || '').replace(/\s+/g, ' ').trim().slice(0, 40) === replyHead) { idx = i; break; }
    }
  }
  if (idx === -1) {
    // 回退 2：直接用最后一条 user（常见场景：重新生成最新回合）
    for (let i = evs.length - 1; i >= 0; i--) if (evs[i].type === 'user') { idx = i; break; }
  }
  for (let i = idx; i >= 0; i--) {
    if (evs[i].type === 'user') { userSeq = evs[i].seq; userText = String(evs[i].text || ''); break; }
  }
  if (userSeq && t) { t.dataset.userSeq = String(userSeq); t.dataset.userText = userText; } // 回填缓存
  return { userSeq, userText };
}

/** 给 assistant 消息挂悬停操作（⧉ 复制 / ↻ 重新生成 / ❝ 引用）；getText 支持流式动态文本 */
function attachAssistantActions(div, getText) {
  const cp = document.createElement('button');
  cp.type = 'button';
  cp.className = 'a-copy';
  cp.title = '复制回复';
  cp.innerHTML = icon('copy', 13);
  cp.onclick = () => {
    const done = () => { cp.innerHTML = icon('circleCheck', 13); setTimeout(() => { cp.innerHTML = icon('copy', 13); }, 1200); };
    const txt = String(getText() || '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done).catch(done);
    } else { done(); }
  };
  div.appendChild(cp);

  const regen = document.createElement('button');
  regen.type = 'button';
  regen.className = 'a-copy';
  regen.title = '重新生成此回复';
  regen.innerHTML = icon('refreshCw', 13);
  regen.onclick = async () => {
    const { userSeq, userText } = await locateTurnOrigin(div, getText);
    if (!userSeq || !userText) { appendNote('无法定位原消息（该会话事件流中找不到对应提问）', true); return; }
    if (!(await uiConfirm('重新生成这条回复？该回复之后的内容将被丢弃。', { title: '重新生成', okText: '重新生成' }))) return;
    try {
      await api(`/api/sessions/${state.sessionId}/truncate`, { method: 'POST', body: JSON.stringify({ beforeSeq: userSeq }) });
      cancelEditing();
      await openSession(state.sessionId, state.sessionTitle, { skipWelcome: true });
      $('input').value = userText;
      fitInput();
      send();
    } catch (e) {
      appendNote('重新生成失败：' + e.message, true);
    }
  };
  div.appendChild(regen);

  const q = document.createElement('button');
  q.type = 'button';
  q.className = 'a-copy';
  q.title = '引用此回复继续提问';
  q.innerHTML = icon('quote', 13);
  q.onclick = () => quoteIntoInput(String(getText() || ''));
  div.appendChild(q);
}

function appendMsg(kind, text, ts) {
  const turn = currentTurnEl();
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.innerHTML = `<div class="body md">${md(text)}</div>`;
  turn.appendChild(div);
  if (kind === 'assistant') {
    attachAssistantActions(div, () => text);
    if (ts) finalizeTurn(ts);
  }
  return div;
}

function appendNote(text, isErr) {
  const div = document.createElement('div');
  div.className = 'msg note' + (isErr ? ' err' : '');
  div.textContent = text ?? '';
  currentTurnEl().appendChild(div);
  scrollBottom();
}

/** 思考折叠行 */
function appendThinkRow(text) {
  const t = String(text ?? '').trim();
  if (!t) return;
  const div = document.createElement('div');
  div.className = 'think-row';
  div.innerHTML =
    '<span class="ic">ℋ</span>' +
    `<span class="tx">思考 · ${esc(truncate(t, 96))}</span>` +
    '<span class="chev">▶</span>' +
    `<div class="full">${esc(t)}</div>`;
  div.onclick = () => div.classList.toggle('open');
  currentTurnEl().appendChild(div);
  scrollBottom();
}

function showThinking() {
  removeThinking();
  const div = document.createElement('div');
  div.className = 'thinking';
  div.id = 'thinking';
  div.innerHTML = '<span class="dotA"><i></i><i></i><i></i></span> 正在处理…';
  currentTurnEl().appendChild(div);
  scrollBottom(true);
}
function removeThinking() {
  const t = $('thinking');
  if (t) t.remove();
}

/* ---------------- 工具行 ---------------- */

function renderToolCall(ev) {
  const row = document.createElement('div');
  row.className = 'tool-row run';
  row.innerHTML =
    '<span class="tdot"></span>' +
    `<span class="verb">${esc(toolVerb(ev.name))}</span>` +
    `<span class="target">${esc(truncate(toolTarget(ev.name, ev.arguments), 72))}</span>` +
    `<span class="stat" id="st-${esc(ev.callId)}">…</span>` +
    '<span class="chev">▶</span>' +
    `<div class="body">` +
    `<div class="label">参数</div><pre>${esc(pretty(ev.arguments))}</pre>` +
    `<div class="label" style="margin-top:6px">结果</div><pre id="out-${esc(ev.callId)}">等待执行…</pre>` +
    `</div>`;
  row.onclick = (e) => {
    if (e.target.closest('pre')) return;
    row.classList.toggle('open');
  };
  const turn = currentTurnEl();
  turn.appendChild(row);
  turn.dataset.steps = String(Number(turn.dataset.steps || 0) + 1);
  state.toolRows.set(ev.callId, { row, callTs: ev.ts ? Date.parse(ev.ts) : Date.now() });
  scrollBottom();
}

function renderToolResult(ev) {
  const rec = state.toolRows.get(ev.callId);
  if (!rec) return;
  const dur = rec.callTs && ev.ts ? Math.max(1, Date.parse(ev.ts) - rec.callTs) : null;
  const st = rec.row.querySelector(`#st-${cssEsc(ev.callId)}`);
  const diff = ev.data && ev.data.diff ? ev.data.diff : null;
  let stat = '';
  if (diff) stat = ` <span class="plus">+${diff.added}</span> <span class="minus">−${diff.removed}</span>`;
  else {
    const m = /（(\d[\d,]*) 字节）/.exec(ev.preview || '');
    if (ev.ok && m) stat = ` <span class="plus">+${m[1]}</span>`;
  }
  st.innerHTML = `${stat}${dur ? ` ${fmtDur(dur)}` : ''}`;
  rec.row.classList.remove('run');
  rec.row.classList.add(ev.ok ? 'ok' : 'fail');
  if (!ev.ok) {
    const turn = rec.row.closest('.turn');
    if (turn) turn.dataset.fails = String(Number(turn.dataset.fails || 0) + 1);
  }
  const out = rec.row.querySelector(`#out-${cssEsc(ev.callId)}`);
  if (diff && diff.text) {
    const wrap = document.createElement('div');
    wrap.className = 'diff';
    for (const line of String(diff.text).split('\n')) {
      const ln = document.createElement('div');
      ln.className = `diff-line ${line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx'}`;
      ln.textContent = line;
      wrap.appendChild(ln);
    }
    out.innerHTML = '';
    out.appendChild(wrap);
  } else {
    out.textContent = ev.preview || '(无输出)';
  }
}

/* ---------------- 审批卡 ---------------- */

function renderApprovalSkeleton(ev) {
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.dataset.approvalId = ev.approvalId;
  card.innerHTML =
    `<div class="title">⏸ 需要你的批准 · ${esc(ev.action)}</div>` +
    `<div class="detail">${esc(ev.tool)} → ${esc(ev.detail)}</div>` +
    `<div class="verdict wait" id="av-${esc(ev.approvalId)}">等待处理…</div>`;
  $('stream').appendChild(card);
  state.approvalCards.set(ev.approvalId, card);
  scrollBottom();
}

async function renderPendingApprovals() {
  let data;
  try {
    data = await api('/api/approvals/pending');
  } catch {
    return;
  }
  for (const p of data.pending) {
    if (p.sessionId !== state.sessionId || state.shownApprovals.has(p.id)) continue;
    // 仅可查看模式：待审卡引导用户切换权限（一键）
    if ((state.serverState || {}).mode === 'read-only') {
      state.shownApprovals.add(p.id);
      renderApprovalSkeleton({ type: 'approval_request', approvalId: p.id, tool: p.tool, action: p.action, detail: p.detail });
      const card0 = state.approvalCards.get(p.id);
      if (card0) {
        const v = card0.querySelector('.verdict');
        if (v) { v.innerHTML = '👁 当前为「仅可查看」模式，写入已被阻止'; v.className = 'verdict deny'; }
        const acts = card0.querySelector('.actions');
        if (acts) {
          acts.innerHTML = '<button class="allow" style="width:100%">切换为工作区权限后重试</button>';
          acts.querySelector('.allow').onclick = async (e) => {
            e.stopPropagation();
            try {
              await api('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'workspace-write', autoApprove: false }) });
              appendNote('🛡 已切换为工作区权限 —— 请重新让 agent 执行该写入');
              state.shownApprovals.delete(p.id);
              state.approvalCards.delete(p.id);
              card0.remove();
              renderPendingApprovals();
              loadState();
            } catch (err) {
              appendNote('切换失败：' + err.message, true);
            }
          };
        }
      }
      continue;
    }
    state.shownApprovals.add(p.id);
    let card = state.approvalCards.get(p.id);
    if (!card) {
      renderApprovalSkeleton({ type: 'approval_request', approvalId: p.id, tool: p.tool, action: p.action, detail: p.detail });
      card = state.approvalCards.get(p.id);
    }
    if (!card.querySelector('.actions')) {
      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.innerHTML = '<button class="allow">允许</button><button class="deny">拒绝</button>';
      actions.querySelector('.allow').onclick = (e) => {
        e.stopPropagation();
        const cb = card.querySelector('[data-remember]');
        decide(p.id, true, cb && cb.checked ? p.tool : undefined);
      };
      actions.querySelector('.deny').onclick = (e) => { e.stopPropagation(); decide(p.id, false); };
      const remember = document.createElement('label');
      remember.className = 'remember';
      remember.innerHTML = `<input type="checkbox" data-remember="${esc(p.tool)}" /> 本会话总是允许`;
      actions.insertBefore(remember, actions.querySelector('.deny'));
      card.insertBefore(actions, card.querySelector('.verdict'));
      scrollBottom();
    }
  }
}

async function decide(id, approved, rememberTool) {
  try {
    await api(`/api/approvals/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ approved, rememberTool, sessionId: state.sessionId }),
    });
  } catch (e) {
    appendNote(`审批提交失败：${e.message}`, true);
  }
}

function markApprovalDecision(ev) {
  const card = state.approvalCards.get(ev.approvalId);
  const v = card && card.querySelector('.verdict');
  if (!v) return;
  v.textContent = ev.approved ? '✓ 已允许' : '✗ 已拒绝';
  v.className = 'verdict ' + (ev.approved ? 'ok' : 'no');
  const actions = card.querySelector('.actions');
  if (actions) actions.remove();
}

/* ---------------- 发送 / 停止 ---------------- */

/* ---------------- 输入历史召回（↑ ↓ 键，最近 20 条） ---------------- */

let inputHistIdx = -1;
let memHist = []; // 内存历史（localStorage 被隔离/禁用时仍可用）

function getInputHistory() {
  let ls = [];
  try { ls = JSON.parse(localStorage.getItem('myagentInputHistory') || '[]') || []; } catch { }
  return ls.length > memHist.length ? ls : memHist;
}

function pushInputHistory(text) {
  if (memHist[memHist.length - 1] !== text) memHist.push(text);
  while (memHist.length > 20) memHist.shift();
  try {
    const h = getInputHistory();
    localStorage.setItem('myagentInputHistory', JSON.stringify(h));
  } catch { /* ignore */ }
  inputHistIdx = -1;
}

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || state.sending) return;
  if (state.tab !== 'dialog') switchTab('dialog'); // 发消息 = 回到对话视图
  pushInputHistory(text);
  input.focus(); // 发送后焦点回输入框（连续对话 + ↑ 召回的前提）
  // 编辑重发：先截断历史（该消息起全部丢弃），再走正常流式发送
  if (state.editing) {
    try {
      await api(`/api/sessions/${state.sessionId}/truncate`, {
        method: 'POST',
        body: JSON.stringify({ beforeSeq: state.editing.seq }),
      });
    } catch (e) {
      appendNote(`截断失败：${e.message}`, true);
      return;
    }
    cancelEditing();
    await openSession(state.sessionId, state.sessionTitle, { skipWelcome: true }); // 干净重渲染
    if (!text || state.sending) return;
  }
  state.sending = true;
  if (!state.sessionId) {
    await newSession(true);
    if (!state.sessionId) { state.sending = false; return; }
  }
  const w = $('welcome');
  if (w) w.remove();
  const btn = $('send');
  btn.disabled = false;
  btn.textContent = '■';
  btn.classList.add('stop');
  btn.title = '停止等待';
  input.value = '';
  fitInput();
  state.pendingUserText = text;
  appendUser(text);
  showThinking();
  state.events += 1;
  setSessStatus(true, '进行中');
  state.abortCtl = new AbortController();

  // 附件组装：文本内联 / 图片上传+多模态分片
  const payload = state.pendingFiles.length ? await buildPayload(text) : { text, parts: [], attachments: [] };
  state.pendingFiles = [];
  renderAttachChips();
  // ---- 流式（SSE）：逐 token 打字机；过程事件实时；■ 真中断 ----
  let streamBody = null;
  let streamText = '';
  let renderTimer = null;
  const flushStream = () => {
    if (streamBody) streamBody.innerHTML = md(streamText);
  };
  const ensureStreamBlock = () => {
    if (!streamBody) {
      removeThinking();
      const div = document.createElement('div');
      div.className = 'msg assistant streaming';
      div.innerHTML = '<div class="body md"></div>';
      currentTurnEl().appendChild(div);
      streamBody = div.querySelector('.body');
      streamText = '';
      attachAssistantActions(div, () => streamText); // 流式块同样有 复制/重新生成/引用
    }
  };
  const scheduleRender = () => {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      flushStream();
      scrollBottom();
    }, 60);
  };

  try {
    const wasPlanTurn = state.planMode === true; // 本轮是否计划模式（完成后提供执行入口）
    const res = await fetch(`/api/sessions/${state.sessionId}/turns/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        text: payload.text,
        ...(state.planMode ? { planMode: true } : {}),
        ...(payload.parts.length ? { parts: payload.parts } : {}),
        ...(payload.attachments.length ? { attachments: payload.attachments } : {}),
      }),
      signal: state.abortCtl.signal,
    });
    if (!res.ok || !res.body) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let evName = 'message';
        let payload = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) evName = line.slice(6).trim();
          else if (line.startsWith('data:')) payload += line.slice(5).trim();
        }
        if (!payload) continue;
        let data;
        try { data = JSON.parse(payload); } catch { continue; }

        if (evName === 'delta') {
          ensureStreamBlock();
          streamText += String(data.text ?? '');
          scheduleRender();
        } else if (evName === 'user') {
          if (typeof data.seq === 'number') state.lastSeq = Math.max(state.lastSeq, data.seq);
        } else if (evName === 'assistant') {
          if (typeof data.seq === 'number') state.lastSeq = Math.max(state.lastSeq, data.seq);
          if (data.withToolCalls) {
            if (data.text) appendThinkRow(data.text);
          } else if (streamBody) {
            streamText = String(data.text ?? streamText);
            flushStream();
          } else {
            appendMsg('assistant', data.text, data.ts);
          }
          state.stats.rounds += 1;
          if (data.usage && data.usage.total_tokens) state.stats.tokens += data.usage.total_tokens;
          updateStatusBar();
        } else if (evName === 'done') {
          if (streamBody) {
            streamText = String(data.reply ?? streamText);
            flushStream();
            streamBody = null;
          }
          finalizeTurn();
          setSessStatus(false, '完成');
          postToHost({ type: 'turn-done', title: state.sessionTitle || '' }); // 最小化时客户端弹气泡
          // 计划模式：回复完成后提供「按计划执行」入口（重发原消息，agent 此时有完整计划在上下文）
          if (wasPlanTurn) {
            state.planMode = false;
            const pb2 = $('planToggle');
            if (pb2) pb2.classList.remove('on');
            const t = state.currentTurn || [...document.querySelectorAll('.turn')].pop();
            const userText = (t && t.dataset.userText) || '';
            if (t && userText) {
              const exec = document.createElement('button');
              exec.type = 'button';
              exec.className = 'pbtn accent';
              exec.textContent = '▶ 按计划执行';
              exec.style.margin = '6px 0';
              exec.onclick = () => {
                state.planMode = false;
                const pb3 = $('planToggle');
                if (pb3) pb3.classList.remove('on');
                $('input').value = userText;
                fitInput();
                send();
              };
              t.appendChild(exec);
            }
          }
        } else if (evName === 'error') {
          removeThinking();
          appendNote(`发送失败：${data.message ?? '未知错误'}`, true);
          setSessStatus(false, '失败');
        } else if (evName === 'tool_call' || evName === 'tool_result' || evName === 'approval_request' || evName === 'approval_decision' || evName === 'note' || evName === 'compaction') {
          if (typeof data.seq === 'number') state.lastSeq = Math.max(state.lastSeq, data.seq);
          renderEvent({ type: evName, ...data });
          if (evName === 'tool_result' && data.preview && String(data.preview).includes('计划已更新')) loadTodos();
        }
      }
    }
    if (streamBody) { flushStream(); finalizeTurn(); } // 流异常结束但已有内容
    refreshSessions();
  } catch (e) {
    if (e.name === 'AbortError') {
      finalizeTurn();
      setSessStatus(false, '已中断');
    } else {
      removeThinking();
      appendNote(`发送失败：${e.message}`, true);
      setSessStatus(false, '失败');
    }
  } finally {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    state.sending = false;
    state.abortCtl = null;
    btn.textContent = '➤';
    btn.classList.remove('stop');
    btn.disabled = false;
    btn.title = '发送';
    input.focus();
    scrollBottom();
    pollEvents(); // 兜底补齐（lastSeq 已同步，不重复渲染）
  }
}

/** ■ 停止：本地断开等待 + 通知内核中止上游生成 */
function abortTurn() {
  if (state.abortCtl) state.abortCtl.abort();
  if (state.sessionId) {
    api(`/api/sessions/${state.sessionId}/abort`, { method: 'POST' }).catch(() => {});
  }
}

/* ---------------- 附件（文本内联 + 图片多模态分片） ---------------- */

function renderAttachChips() {
  const row = $('attachRow');
  if (!state.pendingFiles.length) {
    row.style.display = 'none';
    row.innerHTML = '';
    return;
  }
  row.style.display = 'flex';
  row.innerHTML = '';
  for (let i = 0; i < state.pendingFiles.length; i++) {
    const f = state.pendingFiles[i];
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.innerHTML =
      (f.kind === 'image' ? `<img src="${f.dataUrl}" alt="" />` : '<span>📄</span>') +
      `<span class="nm">${esc(f.name)}</span>` +
      '<button class="rm" type="button">✕</button>';
    chip.querySelector('.rm').onclick = () => {
      state.pendingFiles.splice(i, 1);
      renderAttachChips();
    };
    row.appendChild(chip);
  }
}

function handleFiles(files) {
  for (const file of files) {
    if (file.type && file.type.startsWith('image/')) {
      if (file.size > 6 * 1024 * 1024) { alert(`图片过大（>6MB）：${file.name}`); continue; }
      const rd = new FileReader();
      rd.onload = () => {
        state.pendingFiles.push({ kind: 'image', name: file.name, dataUrl: String(rd.result), mime: file.type });
        renderAttachChips();
      };
      rd.readAsDataURL(file);
    } else if (file.size <= 200 * 1024 && (/\.(md|txt|json|csv|log|ya?ml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|java|c|cpp|h|go|rs|sql|sh|bat|ps1|toml|ini|cfg)$/i.test(file.name) || (file.type && file.type.startsWith('text/')))) {
      const rd = new FileReader();
      rd.onload = () => {
        state.pendingFiles.push({ kind: 'text', name: file.name, text: String(rd.result) });
        renderAttachChips();
      };
      rd.readAsText(file);
    } else {
      alert(`暂不支持该附件（仅文本/代码 ≤200KB 与图片 ≤6MB）：${file.name}`);
    }
  }
}

/** 组装发送内容：文本附件内联；图片上传 + 多模态分片；返回 {text, parts, attachments} */
async function buildPayload(text) {
  let fullText = text;
  const parts = [];
  const uploadedPaths = [];
  for (const f of state.pendingFiles) {
    if (f.kind === 'text') {
      fullText += `\n\n[附件 ${f.name}]\n\`\`\`\n${f.text}\n\`\`\``;
      const up = await api('/api/upload', { method: 'POST', body: JSON.stringify({ name: f.name, base64: btoa(unescape(encodeURIComponent(f.text))), mime: 'text/plain' }) }).catch(() => null);
      if (up) uploadedPaths.push(up.path);
    } else {
      const up = await api('/api/upload', { method: 'POST', body: JSON.stringify({ name: f.name, base64: String(f.dataUrl).split(',')[1] || '', mime: f.mime }) }).catch(() => null);
      if (up) uploadedPaths.push(up.path);
      parts.push({ type: 'image_url', image_url: { url: f.dataUrl } });
    }
  }
  if (uploadedPaths.length) {
    fullText += `\n\n（附件已存工作区：${uploadedPaths.join('、')}）`;
  }
  return { text: fullText, parts, attachments: uploadedPaths };
}

/* ---- 设置页：模型端点 / API Key（零落盘）/ 无人值守 / 关于 ---- */

function renderSettingsPage() {
  const stream = $('stream');
  stream.innerHTML = '';
  const s = state.serverState || {};

  const modelCard = pageCard('模型接入', '在线生效并持久化（apiKey 除外：仅本次运行，零落盘）');
  const body = modelCard.querySelector('.pc-body');
  body.innerHTML =
    `<div class="form-row"><label>端点 baseUrl</label><input id="setBaseUrl" value="${esc(s.baseUrl || '')}" placeholder="http://127.0.0.1:8081/v1" /></div>` +
    `<div class="form-row"><label>模型名 model</label><input id="setModel" value="${esc(s.model || '')}" placeholder="qwen-local" /></div>` +
    `<div class="form-row"><label>API Key</label><input id="setKey" type="password" placeholder="本地端点可留空；仅本次运行有效，不写盘" /></div>` +
    `<div class="form-row"><label>无人值守</label><label class="switch"><input type="checkbox" id="setAuto" ${s.autoApprove ? 'checked' : ''} /><span>写操作自动放行（不再弹审批卡）</span></label></div>` +
    `<div class="ne-foot"><button class="pbtn accent" id="setSave">保存设置</button></div>`;
  stream.appendChild(modelCard);

  // MCP 连接器管理
  const mcpCard = pageCard('MCP 连接器', '增删 / 启停外部工具服务器；保存后重启客户端生效',
    '<button class="pbtn accent" id="mcpAdd">＋ 添加连接器</button><button class="pbtn" id="mcpSave">保存配置</button>');
  const mcpBody = mcpCard.querySelector('.pc-body');
  stream.appendChild(mcpCard);
  let mcpServers = [];
  const drawMcp = () => {
    mcpBody.innerHTML = mcpServers.length ? '' : '<div class="pc-empty">暂无连接器 —— 点右上「＋ 添加连接器」（当前内置：memory 记忆服务）</div>';
    for (const [i, sv] of mcpServers.entries()) {
      const row = document.createElement('div');
      row.className = 'prow';
      const transport = sv.url ? `HTTP ${esc(truncate(sv.url, 40))}` : `stdio ${esc(truncate(String(sv.command || '') + ' ' + (sv.args || []).join(' '), 46))}`;
      row.innerHTML =
        `<span class="prow-t">${esc(sv.name)}${sv.enabled === false ? ' <span class="dim">（停用）</span>' : ''}</span>` +
        `<span class="prow-time">${transport}</span>` +
        `<span class="prow-ops"><label class="switch"><input type="checkbox" data-en ${sv.enabled === false ? '' : 'checked'} /><span>${sv.enabled === false ? '停用' : '启用'}</span></label>` +
        `<button class="pbtn danger" data-del>删除</button></span>`;
      mcpBody.appendChild(row);
      row.querySelector('[data-en]').onchange = (e) => { sv.enabled = e.target.checked; drawMcp(); };
      row.querySelector('[data-del]').onclick = () => { mcpServers.splice(i, 1); drawMcp(); };
    }
  };
  (async () => {
    try {
      const d = await api('/api/mcp');
      mcpServers = d.servers || [];
      drawMcp();
    } catch (e) {
      mcpBody.innerHTML = `<div class="pc-empty">读取失败：${esc(e.message)}</div>`;
    }
  })();
  mcpCard.querySelector('#mcpAdd').onclick = () => {
    const name = prompt('连接器名称（如 filesystem）：');
    if (!name || !name.trim()) return;
    const kind = confirm('确定 = HTTP 远程服务器；取消 = 本地 stdio 命令');
    if (kind) {
      const url = prompt('服务器 URL（streamable http）：', 'http://');
      if (!url) return;
      mcpServers.push({ name: name.trim(), url: url.trim(), enabled: true });
    } else {
      const command = prompt('启动命令（$NODE = 当前 Node）：', 'npx');
      if (!command) return;
      const argsStr = prompt('参数（空格分隔）：', '-y @some/mcp-server');
      mcpServers.push({ name: name.trim(), command: command.trim(), args: (argsStr || '').split(' ').filter(Boolean), enabled: true });
    }
    drawMcp();
  };
  mcpCard.querySelector('#mcpSave').onclick = async () => {
    try {
      const r = await api('/api/mcp/config', { method: 'POST', body: JSON.stringify({ servers: mcpServers }) });
      appendNote(`🔌 MCP 配置已保存（${r.count} 个连接器）—— 重启客户端后生效`);
    } catch (e) {
      alert('保存失败：' + e.message);
    }
  };

  // 长期记忆管理
  const memCard = pageCard('长期记忆', 'agent 通过 memory_save 保存的持久记忆（MCP memory 服务）',
    '<button class="pbtn accent" id="memAdd">＋ 添加记忆</button><button class="pbtn" id="memRefresh">刷新</button>');
  const memBody = memCard.querySelector('.pc-body');
  stream.appendChild(memCard);
  let memRecords = [];
  let memKw = '';
  const drawMem = () => {
    const list = memRecords.filter((r) => !memKw || String(r.content).toLowerCase().includes(memKw));
    memBody.innerHTML =
      `<div class="form-row"><input id="memKw" placeholder="搜索记忆内容…" value="${esc(memKw)}" /></div>` +
      (list.length ? '' : `<div class="pc-empty">${memRecords.length ? '无匹配记忆' : '还没有任何记忆 —— agent 用 memory_save 保存，或点右上手工添加'}</div>`);
    for (const r of list) {
      const row = document.createElement('div');
      row.className = 'prow';
      row.innerHTML =
        `<span class="prow-t" style="flex:1;min-width:0;white-space:normal">${esc(String(r.content))}${r.tags && r.tags.length ? ` <span class="dim">[${esc(r.tags.join(','))}]</span>` : ''}</span>` +
        `<span class="prow-time">${esc(String(r.ts || '').slice(0, 16).replace('T', ' '))}</span>` +
        `<span class="prow-ops"><button class="pbtn" data-edit>编辑</button><button class="pbtn danger" data-del>删除</button></span>`;
      memBody.appendChild(row);
      row.querySelector('[data-edit]').onclick = () => {
        const nt = prompt('编辑记忆内容：', String(r.content));
        if (nt === null || !nt.trim() || nt.trim() === r.content) return;
        api('/api/memory/update', { method: 'POST', body: JSON.stringify({ i: r.i, content: nt.trim() }) })
          .then(loadMem)
          .catch((e) => alert('保存失败：' + e.message));
      };
      row.querySelector('[data-del]').onclick = async () => {
        if (!(await uiConfirm(`删除这条记忆？`, { title: '删除记忆', danger: true, okText: '删除' }))) return;
        api('/api/memory/delete', { method: 'POST', body: JSON.stringify({ i: r.i }) })
          .then(loadMem)
          .catch((e) => alert('删除失败：' + e.message));
      };
    }
    const kw = memBody.querySelector('#memKw');
    if (kw) kw.addEventListener('input', (e) => { memKw = e.target.value.trim().toLowerCase(); drawMem(); const k2 = memBody.querySelector('#memKw'); if (k2) { k2.focus(); k2.setSelectionRange(k2.value.length, k2.value.length); } });
  };
  const loadMem = async () => {
    try {
      memRecords = (await api('/api/memory')).records || [];
      drawMem();
    } catch (e) {
      memBody.innerHTML = `<div class="pc-empty">读取失败：${esc(e.message)}</div>`;
    }
  };
  memCard.querySelector('#memRefresh').onclick = loadMem;
  memCard.querySelector('#memAdd').onclick = () => {
    const f = memCard.querySelector('.mem-form') || document.createElement('div');
    if (memCard.querySelector('.mem-form')) { f.remove(); return; }
    f.className = 'mem-form tpl-form';
    f.innerHTML =
      `<div class="form-row"><label>记忆内容</label><textarea id="mfText" rows="3" placeholder="如：用户偏好深色界面"></textarea></div>` +
      `<div class="form-row"><label>标签（可选，逗号分隔）</label><input id="mfTags" placeholder="偏好,界面" /></div>` +
      `<div class="ne-foot"><button class="pbtn" id="mfCancel">取消</button><button class="pbtn accent" id="mfSave">保存</button></div>`;
    mcpCard.parentNode.insertBefore(f, mcpCard.nextSibling ? mcpCard.nextSibling : null);
    stream.insertBefore(f, memCard.nextSibling);
    f.querySelector('#mfCancel').onclick = () => f.remove();
    f.querySelector('#mfSave').onclick = async () => {
      const text = f.querySelector('#mfText').value.trim();
      if (!text) { alert('内容不能为空'); return; }
      const tags = f.querySelector('#mfTags').value.split(',').map((x) => x.trim()).filter(Boolean);
      try {
        await api('/api/memory', { method: 'POST', body: JSON.stringify({ content: text, tags }) });
        f.remove();
        loadMem();
      } catch (e) {
        alert('保存失败：' + e.message);
      }
    };
  };
  loadMem();

  // 数据备份与恢复
  const bkCard = pageCard('数据备份与恢复', '导出会话 / 记忆 / 任务 / 附件 / 笔记为单文件 JSON；导入还原（覆盖同名）');
  const bkBody = bkCard.querySelector('.pc-body');
  bkBody.innerHTML =
    `<div class="ne-foot" style="gap:8px;display:flex">` +
    `<button class="pbtn accent" id="bkExport">📤 导出备份</button>` +
    `<button class="pbtn" id="bkImport">📥 导入恢复</button>` +
    `<input type="file" id="bkFile" accept=".json" style="display:none" /></div>` +
    `<div class="pc-empty">备份内容：会话记录、长期记忆、任务清单、附件、笔记。恢复后建议重启客户端。</div>`;
  stream.appendChild(bkCard);
  bkCard.querySelector('#bkExport').onclick = async () => {
    try {
      const res = await fetch(`/api/backup/export`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `bugkiller-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      appendNote('📤 备份已导出');
    } catch (e) {
      appendNote('导出失败：' + e.message, true);
    }
  };
  bkCard.querySelector('#bkImport').onclick = () => bkCard.querySelector('#bkFile').click();
  bkCard.querySelector('#bkFile').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    f.text().then(async (text) => {
      let data;
      try { data = JSON.parse(text); } catch { alert('不是有效的备份文件'); return; }
      if (!data.files) { alert('备份文件缺少 files 字段'); return; }
      if (!(await uiConfirm(`导入将覆盖现有的会话 / 记忆 / 笔记等（共 ${Object.keys(data.files).length} 个文件），继续？`, { title: '导入恢复', okText: '导入' }))) return;
      try {
        const r = await api('/api/backup/import', { method: 'POST', body: JSON.stringify(data) });
        appendNote(`📥 已还原 ${r.restored} 个文件 —— 建议重启客户端使全部数据生效`);
        refreshSessions();
      } catch (err) {
        alert('导入失败：' + err.message);
      }
    });
  };
  const logCard = pageCard('内核日志', '实时查看内核运行日志（最近 400 行）',
    '<button class="pbtn accent" id="logOpen">打开日志查看器</button>');
  stream.appendChild(logCard);
  logCard.querySelector('#logOpen').onclick = () => {
    const old = $('logPanel');
    if (old) { old.remove(); return; }
    const panel = document.createElement('div');
    panel.id = 'logPanel';
    panel.className = 'log-panel';
    panel.innerHTML =
      `<div class="log-bar"><input id="logKw" placeholder="过滤关键词…" />` +
      `<label class="switch"><input type="checkbox" id="logAuto" checked /><span>自动刷新</span></label>` +
      `<button class="pbtn" id="logClear">清空</button><button class="pbtn" id="logClose">关闭</button></div>` +
      `<pre id="logPre" class="log-pre"></pre>`;
    stream.insertBefore(panel, logCard.nextSibling);
    const pre = panel.querySelector('#logPre');
    const kwIn = panel.querySelector('#logKw');
    let timer = null;
    const draw = async () => {
      try {
        const d = await api('/api/logs');
        const kw = kwIn.value.trim().toLowerCase();
        const lines = (d.lines || []).filter((l) => !kw || l.toLowerCase().includes(kw));
        const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
        pre.textContent = lines.join('\n') || '(空)';
        if (stick) pre.scrollTop = pre.scrollHeight;
      } catch { /* 忽略 */ }
    };
    const startAuto = () => {
      if (timer) { clearInterval(timer); timer = null; }
      if (panel.querySelector('#logAuto').checked) { draw(); timer = setInterval(draw, 2000); }
    };
    kwIn.addEventListener('input', draw);
    panel.querySelector('#logAuto').onchange = startAuto;
    panel.querySelector('#logClear').onclick = async () => {
      await api('/api/logs/clear', { method: 'POST' }).catch(() => {});
      draw();
    };
    panel.querySelector('#logClose').onclick = () => {
      if (timer) clearInterval(timer);
      panel.remove();
    };
    startAuto();
  };
  const auditCard = pageCard('审计日志', '全部会话的审批请求与决策留痕（工具执行守卫）',
    '<button class="pbtn accent" id="auditOpen">打开审计日志</button>');
  stream.appendChild(auditCard);
  auditCard.querySelector('#auditOpen').onclick = () => switchView('audit');

  // 提示词模板管理
  const tplCard = pageCard('提示词模板', '输入框里敲 # 快速插入；这里管理模板',
    '<button class="pbtn accent" id="tplNew">＋ 新建模板</button>');
  const tplBody = tplCard.querySelector('.pc-body');
  stream.appendChild(tplCard);
  const drawTplList = () => {
    const list = loadTemplates();
    tplBody.innerHTML = list.length ? '' : '<div class="pc-empty">还没有模板 —— 点右上「＋ 新建模板」</div>';
    for (const t2 of list) {
      const row = document.createElement('div');
      row.className = 'prow';
      row.innerHTML =
        `<span class="prow-t">#${esc(t2.name)}</span>` +
        `<span class="prow-time">${esc(truncate(String(t2.text).replace(/\n/g, ' '), 46))}</span>` +
        `<span class="prow-ops"><button class="pbtn" data-edit>编辑</button><button class="pbtn danger" data-del>删除</button></span>`;
      tplBody.appendChild(row);
      row.querySelector('[data-edit]').onclick = () => showTplForm(t2);
      row.querySelector('[data-del]').onclick = async () => {
        if (!(await uiConfirm(`删除模板「${t2.name}」？`, { danger: true, okText: '删除' }))) return;
        saveTemplates(loadTemplates().filter((x) => x.id !== t2.id));
        drawTplList();
      };
    }
  };
  const showTplForm = (editing) => {
    const old = tplCard.querySelector('.tpl-form');
    if (old) { old.remove(); if (!editing) return; }
    const f = document.createElement('div');
    f.className = 'tpl-form';
    f.innerHTML =
      `<div class="form-row"><label>名称</label><input id="tfName" placeholder="如：周报生成" value="${esc(editing ? editing.name : '')}" /></div>` +
      `<div class="form-row"><label>模板内容</label><textarea id="tfText" rows="5" placeholder="插入输入框的完整 prompt…">${esc(editing ? editing.text : '')}</textarea></div>` +
      `<div class="ne-foot"><button class="pbtn" id="tfCancel">取消</button><button class="pbtn accent" id="tfSave">保存</button></div>`;
    tplBody.insertBefore(f, tplBody.firstChild);
    f.querySelector('#tfCancel').onclick = () => f.remove();
    f.querySelector('#tfSave').onclick = () => {
      const name = f.querySelector('#tfName').value.trim();
      const text = f.querySelector('#tfText').value;
      if (!name || !text.trim()) { alert('名称与内容都不能为空'); return; }
      const list = loadTemplates();
      if (editing) {
        const i = list.findIndex((x) => x.id === editing.id);
        if (i >= 0) list[i] = { id: editing.id, name, text }; else list.push({ id: 'tpl-' + Date.now(), name, text });
      } else {
        list.push({ id: 'tpl-' + Date.now(), name, text });
      }
      saveTemplates(list);
      drawTplList();
    };
  };
  drawTplList();
  tplCard.querySelector('#tplNew').onclick = () => showTplForm(null);

  // 主题色
  const themeCard = pageCard('主题色', '界面强调色，立即生效并记住选择');
  const tBody = themeCard.querySelector('.pc-body');
  const current = loadTheme();
  const swatches = document.createElement('div');
  swatches.className = 'swatches';
  for (const t of THEME_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (t.value.toLowerCase() === String(current).toLowerCase() ? ' picked' : '');
    b.style.setProperty('--sw', t.value);
    b.title = t.name;
    b.innerHTML = `<span class="dot"></span><span class="nm">${esc(t.name)}</span>`;
    b.onclick = () => {
      applyTheme(t.value);
      saveTheme(t.value);
      for (const o of swatches.querySelectorAll('.swatch')) o.classList.toggle('picked', o === b);
    };
    swatches.appendChild(b);
  }
  tBody.appendChild(swatches);
  stream.appendChild(themeCard);
  // 视觉（多模态）端点：带图请求自动路由到它
  const visionCard = pageCard('视觉端点（多模态）', '配置后带图请求自动走这里；端点需支持 OpenAI 图片输入（如 llama.cpp + mmproj）');
  const vBody = visionCard.querySelector('.pc-body');
  vBody.innerHTML =
    `<div class="form-row"><label>视觉端点 baseUrl</label><input id="setVisUrl" value="${esc(s.vision?.baseUrl || '')}" placeholder="http://127.0.0.1:8082/v1（留空关闭）" /></div>` +
    `<div class="form-row"><label>视觉模型名</label><input id="setVisModel" value="${esc(s.vision?.model || '')}" placeholder="smolvlm-local" /></div>`;
  body.querySelector('#setSave').onclick = async () => {
    try {
      const payload = {
        baseUrl: body.querySelector('#setBaseUrl').value.trim(),
        model: body.querySelector('#setModel').value.trim(),
        autoApprove: body.querySelector('#setAuto').checked,
        vision: {
          baseUrl: vBody.querySelector('#setVisUrl').value.trim(),
          model: vBody.querySelector('#setVisModel').value.trim(),
        },
      };
      const key = body.querySelector('#setKey').value;
      if (key) payload.apiKey = key;
      await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
      await loadState();
      updatePlan();
      const el = body.querySelector('#setSave');
      el.textContent = '已保存 ✓';
      setTimeout(() => { el.textContent = '保存设置'; }, 1500);
    } catch (e) {
      alert('保存失败：' + e.message);
    }
  };
  stream.appendChild(visionCard);

  const about = pageCard('关于', '');
  about.querySelector('.pc-body').innerHTML =
    `<div class="kv"><span>版本</span><span class="v">BugKiller v0.2.0（正式版）</span></div>` +
    `<div class="kv"><span>内核</span><span class="v">Node ${esc(navigator.userAgent.includes('Chrome') ? '22 原生 TS' : '')} · 零 npm 依赖</span></div>` +
    `<div class="kv"><span>工作区</span><span class="v">${esc(s.workspaceRoot || '…')}</span></div>` +
    `<div class="kv"><span>数据</span><span class="v">data/（会话 JSONL · 凭据 DPAPI · 反馈）</span></div>`;
  stream.appendChild(about);
}

/* ---- 反馈：提交 + 我的反馈列表 ---- */

async function renderFeedbackPage() {
  const stream = $('stream');
  stream.innerHTML = '';

  const form = pageCard('问题反馈', '反馈保存在本地 data/feedback.jsonl');
  form.querySelector('.pc-body').innerHTML =
    `<textarea id="fbText" placeholder="遇到的问题 / 想要的功能…（Ctrl+Enter 提交）"></textarea>` +
    `<div class="ne-foot"><button class="pbtn accent" id="fbSend">提交反馈</button></div>`;
  stream.appendChild(form);
  const sendFb = async () => {
    const tx = form.querySelector('#fbText');
    if (!tx.value.trim()) return;
    try {
      await api('/api/feedback', { method: 'POST', body: JSON.stringify({ content: tx.value.trim() }) });
      tx.value = '';
      renderFeedbackPage();
    } catch (e) {
      alert('提交失败：' + e.message);
    }
  };
  form.querySelector('#fbSend').onclick = sendFb;
  form.querySelector('#fbText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) sendFb();
  });

  const listCard = pageCard('我的反馈', '');
  const body = listCard.querySelector('.pc-body');
  body.innerHTML = '<div class="pc-empty">加载中…</div>';
  stream.appendChild(listCard);
  try {
    const { items } = await api('/api/feedback');
    body.innerHTML = items.length ? '' : '<div class="pc-empty">还没有反馈记录</div>';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'prow';
      row.innerHTML =
        `<span class="prow-t" style="white-space:normal">${esc(it.content)}</span>` +
        `<span class="prow-time">${esc(new Date(it.ts).toLocaleString())}</span>`;
      body.appendChild(row);
    }
  } catch (e) {
    body.innerHTML = `<div class="pc-empty">读取失败：${esc(e.message)}</div>`;
  }
}

/* ---- 左下角账号菜单 ---- */

function closeAccountMenu() {
  const m = $('accMenu');
  if (m) m.remove();
}

function openAccountMenu() {
  closeAccountMenu();
  const menu = document.createElement('div');
  menu.id = 'accMenu';
  const mk = (icon, label, shortcut, fn, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls || '';
    b.innerHTML = `<span class="mi">${icon}</span><span class="ml">${label}</span>` + (shortcut ? `<span class="ms">${shortcut}</span>` : '');
    b.onclick = () => { closeAccountMenu(); fn(); };
    menu.appendChild(b);
  };
  mk('⚙', '设置', 'Ctrl+,', () => switchView('settings'));
  mk('❓', '问题反馈', '', () => switchView('feedback'));
  mk('📋', '我的反馈', '', () => switchView('feedback'));
  mk('⇥', '断开连接', '', () => {
    try { sessionStorage.removeItem('myagentToken'); } catch { /* ignore */ }
    location.reload();
  }, 'danger');
  const acct = $('account').getBoundingClientRect();
  menu.style.left = '10px';
  menu.style.bottom = (window.innerHeight - acct.top + 8) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', closeAccountMenu, { once: true }), 0);
}

/** 会话计划卡：读取 todo 工具的任务清单 */
async function loadTodos() {
  try {
    const d = await api(`/api/todos/${state.sessionId}`);
    const items = d.items || [];
    const done = items.filter((i) => i.status === 'completed').length;
    const prog = items.filter((i) => i.status === 'in_progress').length;
    $('planTx').textContent = items.length
      ? `会话计划 ${prog ? `${prog} 进行中 · ` : ''}${items.length - done} 待处理 · 完成 ${done}/${items.length}`
      : '就绪 · 等待任务';
    $('planCard').title = items.map((i) => `${i.status === 'completed' ? '✓' : '○'} ${i.text}`).join('\n');
  } catch {
    /* 无会话或读取失败保持现状 */
  }
}

/* ---------------- 输入框 ---------------- */

function fitInput() {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 190) + 'px';
}

/* ---------------- 启动 ---------------- */

function showWelcomeStandalone() {
  if (state.sessionId) return;
  state.events = 0;
  $('sessTitle').textContent = 'BugKiller';
  $('stream').innerHTML = '';
  $('send').disabled = false;
  renderWelcome();
}

function boot() {
  // 图标注入（iconify Lucide，data-icon 占位符统一填充）
  for (const el of document.querySelectorAll('[data-icon]')) {
    const name = el.getAttribute('data-icon');
    const size = el.classList.contains('hic') ? 13 : (el.classList.contains('ic') ? 15 : 16);
    el.innerHTML = icon(name, size);
  }
  // composer 按钮图标
  const wsBtn = $('wsBtn');
  if (wsBtn) {
    wsBtn.innerHTML = icon('folderTree', 14);
    wsBtn.onclick = () => openWsDrawer();
  }
  const attachBtn = $('attachBtn');
  if (attachBtn) attachBtn.innerHTML = icon('plus', 14);
  const paramsBtn = $('paramsBtn');
  if (paramsBtn) paramsBtn.innerHTML = icon('slidersHorizontal', 14);
  const sendBtn = $('send');
  if (sendBtn) sendBtn.innerHTML = icon('arrowUp', 14);
  const planBtn = document.createElement('button');
  planBtn.type = 'button';
  planBtn.className = 'cbtn';
  planBtn.id = 'planToggle';
  planBtn.title = '计划模式：agent 先出执行计划，确认后再动手';
  planBtn.innerHTML = `${icon('listFilter', 13)} 计划`;
  planBtn.onclick = () => {
    state.planMode = !state.planMode;
    planBtn.classList.toggle('on', state.planMode);
  };
  sendBtn.parentNode.insertBefore(planBtn, sendBtn);
  applyTheme(loadTheme());
  state.groups = loadGroups();
  state.collapsedGroups = loadSet('myagentGroupsCollapsed');
  $('newSession').onclick = () => newSession(false);
  $('send').onclick = () => (state.sending ? abortTurn() : send());
  $('sessionSearch').addEventListener('input', refreshSessions);
  $('archToggle').onclick = () => { state.showArchived = !state.showArchived; refreshSessions(); };
  $('searchToggle').onclick = () => {
    state.searchOpen = !state.searchOpen;
    $('searchRow').style.display = state.searchOpen ? 'flex' : 'none';
    if (state.searchOpen) $('sessionSearch').focus();
    else { $('sessionSearch').value = ''; refreshSessions(); }
  };
  $('projFilter').onclick = openProjFilterMenu;
  $('navProjects').onclick = () => switchView('projects');
  $('navOffice').onclick = () => switchView('office');
  $('navAgents').onclick = () => switchView('agents');
  $('modelSel').onclick = () => {
    const m = $('meta');
    m.style.display = m.style.display === 'none' ? 'block' : 'none';
   };
  $('paramsBtn').onclick = () => toggleParamsPanel();
  // 权限级别菜单：点击徽章切换 工作区权限 ⇄ 完全权限（无人值守）
  $('permBadge').onclick = (e) => {
    e.stopPropagation();
    const old = document.querySelector('.perm-menu');
    if (old) { old.remove(); return; }
    const s = state.serverState || {};
    const menu = document.createElement('div');
    menu.className = 'perm-menu';
    const cur = s.mode === 'read-only' ? 'ro' : (s.autoApprove ? 'full' : 'ws');
    const mk = (key, ic, label, desc) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pm-item' + (cur === key ? ' active' : '');
      b.innerHTML =
        `<span class="pm-ic">${icon(ic, 14)}</span>` +
        `<span class="pm-tx"><b>${esc(label)}</b><i>${esc(desc)}</i></span>` +
        (cur === key ? `<span class="pm-check">${icon('circleCheck', 14)}</span>` : '');
      b.onclick = async () => {
        menu.remove();
        if (cur === key) return; // 未变化
        const body = key === 'ro' ? { mode: 'read-only' }
          : key === 'full' ? { mode: 'workspace-write', autoApprove: true }
          : { mode: 'workspace-write', autoApprove: false };
        try {
          await api('/api/settings', { method: 'POST', body: JSON.stringify(body) });
          appendNote(key === 'ro' ? '👁 已切换为仅可查看（agent 写文件与命令被禁止）'
            : key === 'full' ? '⚡ 已切换为完全权限（写操作自动放行）'
            : '🛡 已切换为工作区权限（写操作需审批）');
          loadState();
        } catch (err) {
          appendNote('权限切换失败：' + err.message, true);
        }
      };
      menu.appendChild(b);
    };
    mk('ro', 'shield', '仅可查看', 'agent 只能读取，写文件与命令全部禁止');
    mk('ws', 'shieldCheck', '工作区权限', '写操作弹审批卡确认，仅限工作区内');
    mk('full', 'zap', '完全权限', '无人值守：写操作自动放行，不再弹卡');
    document.body.appendChild(menu);
    const r = e.currentTarget.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
    menu.style.top = Math.max(8, r.top - menu.offsetHeight - 8) + 'px';
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  };
  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => {
    handleFiles([...e.target.files]);
    e.target.value = '';
  };
  // 拖拽上传：整窗拖文件进来即附件
  const main = $('main');
  main.addEventListener('dragover', (e) => {
    e.preventDefault();
    $('composer').classList.add('drag-over');
  });
  main.addEventListener('dragleave', (e) => {
    if (e.target === main) $('composer').classList.remove('drag-over');
  });
  main.addEventListener('drop', (e) => {
    e.preventDefault();
    $('composer').classList.remove('drag-over');
    // 工作区文件拖入 → 插入 @路径 引用（模型会自动去读）
    const wsp = e.dataTransfer ? e.dataTransfer.getData('text/wspath') : '';
    if (wsp) { insertWsRef(wsp); return; }
    if (e.dataTransfer && e.dataTransfer.files.length) {
      switchView('chat');
      handleFiles([...e.dataTransfer.files]);
    }
  });
  // 粘贴图片：Ctrl+V 剪贴板图片直接进附件
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f) => f && f.type && f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      handleFiles(files);
    }
  });
  $('editCancel').onclick = () => {
    const input = $('input');
    input.value = '';
    fitInput();
    cancelEditing();
  };
  $('account').onclick = openAccountMenu;
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      switchView('settings');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openFindBar();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if ($('wsDrawer')) { closeWsDrawer(); return; }
      if (findState.open) { closeFindBar(); return; }
      const mm = $('meta');
      if (mm && mm.style.display !== 'none') { mm.style.display = 'none'; }
    }
  });
  for (const t of document.querySelectorAll('.tab')) t.onclick = () => switchTab(t.dataset.tab);
  const input = $('input');
  input.addEventListener('keydown', (e) => {
    if (tpl.open && tpl.items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); tpl.idx = (tpl.idx + 1) % tpl.items.length; renderTplPanel(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); tpl.idx = (tpl.idx - 1 + tpl.items.length) % tpl.items.length; renderTplPanel(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); runTpl(tpl.items[tpl.idx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); tpl.open = false; renderTplPanel(); return; }
    }
    if (mention.open && mention.items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mention.idx = (mention.idx + 1) % mention.items.length; renderMentionPanel(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mention.idx = (mention.idx - 1 + mention.items.length) % mention.items.length; renderMentionPanel(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); runMention(mention.items[mention.idx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); mention.open = false; renderMentionPanel(); return; }
    }
    if (slash.open && slash.items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slash.idx = (slash.idx + 1) % slash.items.length; renderSlashPanel(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slash.idx = (slash.idx - 1 + slash.items.length) % slash.items.length; renderSlashPanel(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); runSlash(slash.items[slash.idx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); slash.open = false; renderSlashPanel(); return; }
    }
    // 输入历史召回（终端习惯）：空输入 ↑ 进入浏览；浏览态中 ↑↓ 连续翻页；手动编辑退出浏览态
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !slash.open) {
      if (input.value === '') {
        const h = getInputHistory();
        if (h.length) {
          e.preventDefault();
          inputHistIdx = h.length - 1;
          input.value = h[inputHistIdx];
          input.setSelectionRange(input.value.length, input.value.length);
          return;
        }
      } else if (inputHistIdx !== -1) {
        e.preventDefault();
        const h = getInputHistory();
        inputHistIdx = Math.max(0, inputHistIdx - 1);
        input.value = h[inputHistIdx];
        input.setSelectionRange(input.value.length, input.value.length);
        return;
      }
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !slash.open && inputHistIdx !== -1) {
      e.preventDefault();
      const h = getInputHistory();
      if (inputHistIdx < h.length - 1) { inputHistIdx++; input.value = h[inputHistIdx]; }
      else { inputHistIdx = -1; input.value = ''; }
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    const v = $('input').value;
    if (inputHistIdx !== -1) {
      const h = getInputHistory();
      if (h[inputHistIdx] !== v) inputHistIdx = -1; // 手动编辑 → 退出历史浏览态
    }
    if (v === '') inputHistIdx = -1;
    if (v.indexOf('@') >= 0) mentionOnInput(); else if (mention.open) { mention.open = false; renderMentionPanel(); }
    if (v.indexOf('#') >= 0) tplOnInput(); else if (tpl.open) { tpl.open = false; renderTplPanel(); }
    slashOnInput();
    fitInput();
  });
  loadState();
  refreshSessions();
  showWelcomeStandalone();
  setInterval(pollEvents, 900);
  setInterval(refreshSessionsQuiet, 6000);
  setInterval(loadState, 15000);
  setInterval(() => { if (state.sessionId) loadTodos(); }, 3000);
}

/* ---------------- 斜杠命令系统（/ 命令面板 + 自动补全） ---------------- */

const SLASH_COMMANDS = [
  { cmd: '/new', desc: '新建会话', run: () => newSession(true) },
  { cmd: '/clear', desc: '刷新当前会话显示（重新加载事件流）', run: () => { if (state.sessionId) openSession(state.sessionId, state.sessionTitle); } },
  { cmd: '/export', desc: '导出当前会话为 Markdown', run: () => exportSession('md') },
  { cmd: '/export-json', desc: '导出当前会话为 JSONL 原始档', run: () => exportSession('json') },
  { cmd: '/model', desc: '切换模型预设（打开选择器）', run: () => $('modelSel').click() },
  { cmd: '/settings', desc: '打开设置页', run: () => switchView('settings') },
  { cmd: '/agents', desc: '打开云智能体页', run: () => switchView('agents') },
  { cmd: '/office', desc: '打开办公套件页', run: () => switchView('office') },
  { cmd: '/projects', desc: '打开项目 / 产品管理页', run: () => switchView('projects') },
  { cmd: '/pin', desc: '置顶 / 取消置顶当前会话', run: () => { if (state.sessionId) togglePin(state.sessionId); else appendNote('当前无会话', true); } },
  { cmd: '/audit', desc: '打开审计日志（审批决策时间线）', run: () => switchView('audit') },
  { cmd: '/params', desc: '调节模型参数（temperature / max tokens）', run: () => toggleParamsPanel() },
  { cmd: '/tpl', desc: '提示词模板：输入 # 或在此快速插入', run: () => { const input = $('input'); input.value = '#'; input.focus(); tplOnInput(); } },
  { cmd: '/help', desc: '列出全部命令', run: () => appendNote('可用命令：\n' + SLASH_COMMANDS.map((c) => `${c.cmd}  ${c.desc}`).join('\n')) },
];

async function exportSession(format) {
  if (!state.sessionId) { appendNote('当前无会话可导出', true); return; }
  const data = await api(`/api/sessions/${state.sessionId}/events?since=0`);
  const evs = data.events || [];
  const title = state.sessionTitle || state.sessionId;
  let content;
  if (format === 'json') {
    content = JSON.stringify(evs, null, 2);
  } else {
    const lines = [`# ${title}`, '', `> 导出于 ${new Date().toLocaleString()} · BugKiller`, ''];
    for (const e of evs) {
      if (e.type === 'session_start') continue;
      const ts = e.ts ? new Date(e.ts).toLocaleString() : '';
      if (e.type === 'user') lines.push(`## 🧑 用户（${ts}）`, '', String(e.text ?? ''), '');
      else if (e.type === 'assistant') lines.push(`## 🤖 助手（${ts}）`, '', String(e.text ?? ''), '');
      else if (e.type === 'tool_call') lines.push(`### 🔧 工具调用：${e.name}`, '', '```', truncate(e.arguments ?? '', 800), '```', '');
      else if (e.type === 'tool_result') lines.push(`### ↳ 结果${e.ok ? '' : '（失败）'}`, '', '```', truncate(e.preview ?? '', 800), '```', '');
      else if (e.type === 'note') lines.push(`> ${e.text ?? ''}`, '');
      else if (e.type === 'compaction') lines.push(`> 📋 已压缩早期对话（${e.covered ?? '?'} 条）`, '');
    }
    content = lines.join('\n');
  }
  const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title}.${format === 'json' ? 'json' : 'md'}`;
  a.click();
  URL.revokeObjectURL(a.href);
  appendNote(`📤 已导出会话「${truncate(title, 20)}」为 ${format.toUpperCase()}`);
}

let slash = { open: false, items: [], idx: 0 };

function slashList(kw) {
  const q = kw.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q));
}

function renderSlashPanel() {
  let p = $('slashPanel');
  if (!slash.open || !slash.items.length) { if (p) p.remove(); return; }
  if (!p) {
    p = document.createElement('div');
    p.id = 'slashPanel';
    $('composerWrap').appendChild(p);
  }
  p.innerHTML = slash.items.map((c, i) =>
    `<button type="button" class="sitem ${i === slash.idx ? 'active' : ''}" data-i="${i}"><b>${esc(c.cmd)}</b><span>${esc(c.desc)}</span></button>`).join('');
  for (const b of p.querySelectorAll('.sitem')) {
    b.onclick = () => runSlash(slash.items[+b.dataset.i]);
  }
  const act = p.querySelector('.sitem.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

function runSlash(c) {
  slash.open = false;
  renderSlashPanel();
  const input = $('input');
  input.value = '';
  fitInput();
  try { c.run(); } catch (e) { appendNote('命令执行失败：' + e.message, true); }
}

function slashOnInput() {
  const v = $('input').value;
  if (v.startsWith('/') && v.length <= 30 && !v.includes('\n')) {
    slash.open = true;
    slash.items = slashList(v.slice(1));
    slash.idx = 0;
    renderSlashPanel();
  } else if (slash.open) {
    slash.open = false;
    renderSlashPanel();
  }
}

if (!token) {
  document.getElementById('stream').innerHTML =
    '<div class="msg note err">缺少令牌：请使用服务启动时打印的完整地址打开本页。</div>';
} else {
  boot();
}
