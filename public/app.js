/* galaxy-collapse WebUI：无构建、原生 ES 模块。 */

const state = {
  route: 'queue',
  appState: null,
  settings: null,
  subscriptions: [],
  drafts: [],
  queue: [],
  logs: [],
  draftStatus: '',
  logLevel: '',
  logScope: '',
  logQuery: '',
  editing: null,
  loading: false,
};

const STATUS_LABELS = {
  DRAFT: ['草稿', ''],
  REVIEWING: ['审核中', 'info'],
  APPROVED: ['已通过', 'ok'],
  REJECTED: ['已拒绝', 'danger'],
  NEEDS_REVIEW: ['待人工', 'warn'],
  QUEUED: ['排队中', 'soft'],
  PUBLISHING: ['发布中', 'info'],
  PUBLISHED: ['已发布', 'ok'],
  FAILED: ['失败', 'danger'],
  CANCELLED: ['已取消', ''],
  MANUAL: ['手工', ''],
};

const QUEUE_LABELS = {
  QUEUED: ['排队中', 'soft'],
  PUBLISHING: ['发布中', 'info'],
  PUBLISHED: ['已发布', 'ok'],
  FAILED: ['失败', 'danger'],
  CANCELLED: ['已取消', ''],
};

const $ = selector => document.querySelector(selector);

const esc = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const fmtTime = ms => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');

function badge(text, cls = '') {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function statusBadge(status) {
  const [label, cls] = STATUS_LABELS[status] ?? [status, ''];
  return badge(label, cls);
}

function queueBadge(status) {
  const [label, cls] = QUEUE_LABELS[status] ?? [status, ''];
  return badge(label, cls);
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || `请求失败（HTTP ${response.status}）`);
    error.code = data?.error?.code;
    error.details = data?.error?.details;
    throw error;
  }
  return data;
}

function toast(message, kind = '') {
  const wrap = $('#toasts');
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  wrap.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 220);
  }, kind === 'error' ? 5200 : 3200);
}

function syncThemeUi() {
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const toggle = $('#theme-toggle');
  if (toggle) toggle.setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#080c13' : '#f1f4f9');
}

function setBusy(busy) {
  state.loading = busy;
  for (const button of document.querySelectorAll('[data-action]')) {
    if (button.dataset.keepEnabled) continue;
    button.disabled = busy;
  }
}

// ------------------------------------------------------------------ routing

function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  return ['queue', 'drafts', 'logs', 'manual', 'settings'].includes(raw) ? raw : 'queue';
}

function renderNav() {
  for (const link of document.querySelectorAll('[data-route]')) {
    link.classList.toggle('active', link.dataset.route === state.route);
  }
  const routeLabels = {
    queue: '发布队列',
    drafts: '草稿',
    logs: '日志',
    manual: '手工加入',
    settings: '设置',
  };
  $('#crumb').textContent = routeLabels[state.route] || routeLabels.queue;
}

async function loadRoute(quiet = false) {
  state.route = currentRoute();
  renderNav();
  try {
    if (state.route === 'queue') {
      await Promise.all([loadState(), loadQueue()]);
      renderQueue();
    } else if (state.route === 'drafts') {
      await Promise.all([loadState(), loadDrafts()]);
      renderDrafts();
    } else if (state.route === 'logs') {
      await loadLogs();
      renderLogs();
    } else if (state.route === 'settings') {
      await Promise.all([loadState(), loadSettings(), loadSubscriptions()]);
      renderSettings();
    } else {
      await loadState();
      renderManual();
    }
    renderStatusChips();
  } catch (error) {
    if (!quiet) toast(error.message, 'error');
    $('#view').innerHTML = `<div class="notice danger">加载失败：${esc(error.message)}</div>`;
  }
}

async function loadState() {
  state.appState = await api('/api/state');
}

async function loadQueue() {
  state.queue = (await api('/api/queue?limit=200')).items;
}

async function loadDrafts() {
  const query = state.draftStatus ? `?status=${encodeURIComponent(state.draftStatus)}&limit=100` : '?limit=100';
  state.drafts = (await api(`/api/drafts${query}`)).items;
}

async function loadLogs() {
  const params = new URLSearchParams();
  if (state.logLevel) params.set('level', state.logLevel);
  if (state.logScope) params.set('scope', state.logScope);
  if (state.logQuery) params.set('q', state.logQuery);
  params.set('limit', '150');
  state.logs = (await api(`/api/logs?${params}`)).items;
}

async function loadSettings() {
  state.settings = (await api('/api/settings')).values;
}

async function loadSubscriptions() {
  state.subscriptions = (await api('/api/subscriptions')).items;
}

// ------------------------------------------------------------------ chrome

function renderStatusChips() {
  const s = state.appState;
  const chips = $('#status-chips');
  if (!s) {
    chips.innerHTML = '';
    return;
  }
  const source = s.source || {};
  const subscriptions = source.subscriptions || [];
  const cookies = s.cookies || {};
  const gamekee = cookies.gamekee || {};
  const bili = cookies.bilibili || {};
  const queueOk = s.gate?.allowed;
  const count = source.count ?? subscriptions.length;
  chips.innerHTML = [
    badge(`${count} 个订阅${source.autoSync ? ' · 自动' : ''}`, count ? 'soft' : 'warn'),
    badge(`队列 ${queueOk ? '可发布' : (s.gate?.details?.paused ? '已暂停' : '受限')}`, queueOk ? 'ok' : 'warn'),
    badge(`GameKee ${gamekee.valid ? '已登录' : '未就绪'}`, gamekee.valid ? 'ok' : 'danger'),
    badge(`B 站 ${bili.hasSessdata ? '已配置 Cookie' : '匿名'}`, bili.hasSessdata ? 'ok' : ''),
  ].join('');
  renderNav();
}

// ------------------------------------------------------------------ queue view

function renderQueue() {
  const s = state.appState;
  const gate = s.gate;
  const details = gate.details || {};
  const publishedToday = details.publishedToday ?? 0;
  const dailyLimit = details.dailyLimit ?? 0;
  const pauseButton = details.paused
    ? '<button class="btn ok" data-action="resume">恢复队列</button>'
    : '<button class="btn" data-action="pause">暂停队列</button>';
  const gateNotice = gate.allowed
    ? ''
    : `<div class="notice ${details.paused ? 'warn' : 'info'}">当前不可自动发布：${esc(gate.reason)}</div>`;

  const rows = state.queue.map(item => {
    const contentUrl = item.content_id
      ? `https://www.gamekee.com/${esc(s.publish.alias)}/${esc(item.content_id)}.html`
      : '';
    const actions = [];
    if (item.state === 'QUEUED' || item.state === 'FAILED') {
      actions.push(`<button class="btn sm primary" data-action="queue-publish" data-id="${item.id}">立即发布</button>`);
    }
    if (item.state === 'FAILED') {
      actions.push(`<button class="btn sm" data-action="queue-retry" data-id="${item.id}">重试</button>`);
    }
    if (item.state === 'QUEUED' || item.state === 'FAILED') {
      actions.push(`<button class="btn sm danger" data-action="queue-cancel" data-id="${item.id}">取消</button>`);
    }
    if (item.state === 'PUBLISHED' && contentUrl) {
      actions.push(`<a class="btn sm" target="_blank" rel="noopener" href="${contentUrl}">打开发布页</a>`);
    }
    return `<tr>
      <td class="mono">#${item.id}</td>
      <td>
        <div class="title">${esc(item.draft_title || '（草稿已删除）')}</div>
        <div class="meta">草稿 #${item.draft_id}${item.published_at ? ` · ${esc(fmtTime(item.published_at))}` : ''}${item.content_id ? ` · GameKee #${esc(item.content_id)}` : ''}</div>
      </td>
      <td>${queueBadge(item.state)}</td>
      <td class="mono">${item.attempts ?? 0}</td>
      <td><div class="reason">${item.last_error ? esc(item.last_error) : '<span class="muted">—</span>'}</div></td>
      <td><div class="actions">${actions.join('') || '<span class="muted">—</span>'}</div></td>
    </tr>`;
  }).join('');

  $('#view').innerHTML = `
    <div class="page-head">
      <div>
        <h1>发布队列</h1>
        <p>审核通过的内容在这里按窗口、间隔与日限排队发布到 GameKee。</p>
      </div>
      <div class="toolbar">
        <button class="btn primary" data-action="sync">立即同步 B 站</button>
        ${pauseButton}
        <button class="btn" data-action="refresh">刷新</button>
      </div>
    </div>

    ${gateNotice}

    <div class="stats">
      <div class="stat">
        <div class="label">今日发布</div>
        <div class="value">${publishedToday}<span class="muted" style="font-size:14px"> / ${dailyLimit}</span></div>
        <div class="hint">${esc(details.timeZone || '')} · 本地 ${esc(details.localTime || '')}</div>
      </div>
      <div class="stat">
        <div class="label">发布窗口</div>
        <div class="value" style="font-size:17px">${esc(details.windowStart || '—')} – ${esc(details.windowEnd || '—')}</div>
        <div class="hint">${details.inWindow ? '当前在窗口内' : '当前在窗口外'}</div>
      </div>
      <div class="stat">
        <div class="label">自动发布</div>
        <div class="value" style="font-size:17px">${s.publish.autoPublish ? '已开启' : '已关闭'}</div>
        <div class="hint">最小间隔 ${details.intervalSeconds ?? '—'} 秒</div>
      </div>
      <div class="stat">
        <div class="label">自动审核</div>
        <div class="value" style="font-size:17px">${s.publish.autoReview ? '已开启' : '已关闭'}</div>
        <div class="hint">富文本模式 editor_type=${s.publish.editorType}</div>
      </div>
    </div>

    <div class="card">
      <header>
        <h2>队列项（${state.queue.length}）</h2>
        <span class="sub">${s.syncRunning ? '正在同步 B 站…' : `上次同步：${esc(fmtTime(s.source.lastSyncAt))}`}</span>
      </header>
      <div class="table-wrap">
        ${state.queue.length ? `<table>
          <thead><tr><th>ID</th><th>标题</th><th>状态</th><th>尝试</th><th>最近错误</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>` : `<div class="empty"><strong>队列为空</strong>审核通过的内容会自动出现在这里；也可以先在「草稿」里手动入队。</div>`}
      </div>
    </div>
  `;
}

// ------------------------------------------------------------------ drafts view

function renderDrafts() {
  const options = [
    ['', '全部状态'],
    ['DRAFT', '草稿'],
    ['REVIEWING', '审核中'],
    ['APPROVED', '已通过'],
    ['NEEDS_REVIEW', '待人工'],
    ['QUEUED', '排队中'],
    ['PUBLISHED', '已发布'],
    ['REJECTED', '已拒绝'],
    ['FAILED', '失败'],
  ].map(([value, label]) => `<option value="${value}" ${state.draftStatus === value ? 'selected' : ''}>${label}</option>`).join('');

  const rows = state.drafts.map(draft => {
    const review = draft.review;
    const reason = review?.reason ? `<div class="meta">${esc(review.stage)} · ${esc(review.reason)}</div>` : '';
    const actions = [
      `<button class="btn sm" data-action="draft-edit" data-id="${draft.id}">编辑/预览</button>`,
    ];
    if (draft.status !== 'PUBLISHED') {
      actions.push(`<button class="btn sm" data-action="draft-review" data-id="${draft.id}">审核</button>`);
      if (draft.status !== 'APPROVED') actions.push(`<button class="btn sm ok" data-action="draft-approve" data-id="${draft.id}">通过</button>`);
      actions.push(`<button class="btn sm danger" data-action="draft-reject" data-id="${draft.id}">拒绝</button>`);
      if (['APPROVED', 'DRAFT', 'FAILED'].includes(draft.status)) actions.push(`<button class="btn sm" data-action="draft-queue" data-id="${draft.id}">入队</button>`);
      actions.push(`<button class="btn sm primary" data-action="draft-publish" data-id="${draft.id}">立即发布</button>`);
    } else {
      actions.push(`<button class="btn sm" data-action="draft-update" data-id="${draft.id}">更新已发布文章</button>`);
    }
    return `<tr>
      <td class="mono">#${draft.id}</td>
      <td>
        <div class="title">${esc(draft.title || '（无标题）')}</div>
        <div class="meta">${draft.sourceUrl ? `<a href="${esc(draft.sourceUrl)}" target="_blank" rel="noopener">${esc(draft.sourceKind || 'source')}</a>` : '手工创建'}${draft.sourceAuthor ? ` · ${esc(draft.sourceAuthor)}` : ''}</div>
      </td>
      <td>${statusBadge(draft.status)}${reason}</td>
      <td class="mono">${(draft.images || []).length}</td>
      <td class="mono">${esc(fmtTime(draft.updatedAt))}</td>
      <td><div class="actions">${actions.join('')}</div></td>
    </tr>`;
  }).join('');

  $('#view').innerHTML = `
    <div class="page-head">
      <div>
        <h1>草稿</h1>
        <p>每一篇都是可编辑的 Markdown；保存后重新审核，通过后可入队或立即发布。</p>
      </div>
      <div class="toolbar">
        <button class="btn primary" data-action="sync">立即同步</button>
        <button class="btn" data-action="refresh">刷新</button>
      </div>
    </div>
    <div class="card">
      <header>
        <h2>草稿（${state.drafts.length}）</h2>
        <div class="filters">
          <select id="draft-status">${options}</select>
        </div>
      </header>
      <div class="table-wrap">
        ${state.drafts.length ? `<table>
          <thead><tr><th>ID</th><th>标题</th><th>状态 / 审核</th><th>图</th><th>更新</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>` : '<div class="empty"><strong>还没有草稿</strong>点「立即同步」抓取 B 站内容，或到「手工加入」粘贴链接。</div>'}
      </div>
    </div>
  `;
}

// ------------------------------------------------------------------ logs view

function renderLogs() {
  const levels = ['', 'debug', 'info', 'warn', 'error'];
  const scopes = ['', 'system', 'sync', 'review', 'publish', 'queue', 'http', 'auth'];
  const rows = state.logs.map(log => `
    <tr>
      <td class="mono">${esc(fmtTime(log.ts))}</td>
      <td>${badge(log.level, log.level === 'error' ? 'danger' : log.level === 'warn' ? 'warn' : log.level === 'info' ? 'info' : '')}</td>
      <td class="mono">${esc(log.scope)}</td>
      <td class="mono">${esc(log.event)}</td>
      <td class="log-message">
        ${esc(log.message)}
        ${log.details ? `<details><summary class="muted mono">详情</summary><pre class="log-details">${esc(JSON.stringify(log.details, null, 2))}</pre></details>` : ''}
      </td>
    </tr>`).join('');

  $('#view').innerHTML = `
    <div class="page-head">
      <div><h1>日志</h1><p>同步、审核、发布与队列的关键事件；凭证与 Cookie 已脱敏。</p></div>
      <div class="toolbar">
        <button class="btn" data-action="log-refresh">刷新</button>
        <button class="btn ghost" data-action="log-clear-filter">清空筛选</button>
      </div>
    </div>
    <div class="card">
      <header>
        <h2>最近事件</h2>
        <div class="filters">
          <select id="log-level">${levels.map(level => `<option value="${level}" ${state.logLevel === level ? 'selected' : ''}>${level || '全部级别'}</option>`).join('')}</select>
          <select id="log-scope">${scopes.map(scope => `<option value="${scope}" ${state.logScope === scope ? 'selected' : ''}>${scope || '全部模块'}</option>`).join('')}</select>
          <input id="log-query" type="search" placeholder="搜索关键字…" value="${esc(state.logQuery)}">
        </div>
      </header>
      <div class="table-wrap">
        ${state.logs.length ? `<table><thead><tr><th>时间</th><th>级别</th><th>模块</th><th>事件</th><th>内容</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty"><strong>没有日志</strong>运行同步或发布后这里会记录事件。</div>'}
      </div>
    </div>
  `;
}

// ------------------------------------------------------------------ manual view

function renderManual() {
  $('#view').innerHTML = `
    <div class="page-head">
      <div><h1>手工加入</h1><p>粘贴 B 站专栏/图文链接，或直接写一篇 Markdown 草稿。</p></div>
    </div>
    <div class="card">
      <header><h2>新建草稿</h2><span class="sub">创建后按设置自动审核</span></header>
      <div class="body">
        <form id="manual-form">
          <div class="section">
            <div class="section-title">方式一：B 站链接 / ID</div>
            <div class="grid">
              <div class="field">
                <label for="manual-url">链接或 ID</label>
                <input id="manual-url" name="url" type="text" placeholder="https://www.bilibili.com/read/cv123 或 opus/456">
                <span class="help">支持 read/cv、opus 链接；纯数字需选择类型。</span>
              </div>
              <div class="field">
                <label for="manual-kind">类型（纯数字时）</label>
                <select id="manual-kind" name="kind">
                  <option value="auto">自动识别</option>
                  <option value="article">专栏</option>
                  <option value="opus">图文动态（opus）</option>
                </select>
              </div>
            </div>
          </div>
          <div class="section">
            <div class="section-title">方式二：直接写 Markdown</div>
            <div class="grid">
              <div class="field">
                <label for="manual-title">标题</label>
                <input id="manual-title" name="title" type="text" placeholder="留空则取正文第一行">
              </div>
              <div class="field">
                <label for="manual-author">作者（可选）</label>
                <input id="manual-author" name="author" type="text" placeholder="署名">
              </div>
            </div>
            <div class="field" style="margin-top:12px">
              <label for="manual-markdown">正文 Markdown</label>
              <textarea id="manual-markdown" name="markdown" rows="12" placeholder="支持标题、列表、引用、**粗体**、[链接](https://…) 与 ![图片](https://…)"></textarea>
              <span class="help">填写正文时不使用上面的链接；两者都填时以链接为准。</span>
            </div>
          </div>
          <div class="toolbar" style="margin-top:16px">
            <button class="btn primary" type="submit" data-keep-enabled>创建草稿</button>
            <span class="muted">图片会在发布时自动上传到 GameKee OBS。</span>
          </div>
        </form>
        <div id="manual-result"></div>
      </div>
    </div>
  `;
}

// ------------------------------------------------------------------ settings view

function field({ key, label, type = 'text', help = '', placeholder = '', value, min, max, step, options, secret = false }) {
  const id = `set-${key}`;
  let control;
  if (type === 'select') {
    control = `<select id="${id}" data-setting="${key}">${options.map(([val, text]) => `<option value="${val}" ${String(value) === String(val) ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>`;
  } else if (type === 'checkbox') {
    return `<div class="field check"><input id="${id}" type="checkbox" data-setting="${key}" ${value ? 'checked' : ''}><label for="${id}">${esc(label)}</label></div>`;
  } else if (type === 'textarea') {
    control = `<textarea id="${id}" data-setting="${key}" rows="6" placeholder="${esc(placeholder)}"${secret ? ' data-secret="1"' : ''}>${esc(value ?? '')}</textarea>`;
  } else {
    control = `<input id="${id}" type="${secret ? 'password' : type}" data-setting="${key}" value="${esc(secret ? '' : (value ?? ''))}" placeholder="${esc(placeholder)}"${min !== undefined ? ` min="${min}"` : ''}${max !== undefined ? ` max="${max}"` : ''}${step !== undefined ? ` step="${step}"` : ''}${secret ? ' data-secret="1" autocomplete="new-password"' : ''}>`;
  }
  return `<div class="field"><label for="${id}">${esc(label)}</label>${control}${help ? `<span class="help">${esc(help)}</span>` : ''}</div>`;
}

function renderSettings() {
  const v = state.settings;
  const subs = state.subscriptions || [];
  const rows = subs.map(sub => `<tr>
    <td>
      <div class="title">${esc(sub.name || `mid ${sub.mid}`)}</div>
      <div class="meta mono">mid ${esc(sub.mid)}</div>
    </td>
    <td>${sub.mode === 'article' ? '专栏' : '动态'}${sub.includeForwards ? ' · 含转发' : ''}</td>
    <td class="mono">${esc(fmtTime(sub.subscribedAt))}</td>
    <td class="mono">${esc(fmtTime(sub.lastSyncAt))}${sub.lastError ? `<div class="meta">${esc(sub.lastError)}</div>` : ''}</td>
    <td>${badge(sub.enabled ? '启用' : '暂停', sub.enabled ? 'ok' : 'warn')}</td>
    <td><div class="actions">
      <button class="btn sm primary" data-action="subscription-sync" data-id="${sub.id}" ${sub.enabled ? '' : 'disabled'}>同步</button>
      <button class="btn sm" data-action="subscription-toggle" data-id="${sub.id}" data-enabled="${sub.enabled ? '0' : '1'}">${sub.enabled ? '暂停' : '启用'}</button>
      <button class="btn sm danger" data-action="subscription-delete" data-id="${sub.id}">删除</button>
    </div></td>
  </tr>`).join('');
  const maskedKey = v.aiApiKeySet ? `已保存（${v.aiApiKey || '****'}）` : '未设置';
  $('#view').innerHTML = `
    <div class="page-head">
      <div><h1>设置</h1><p>所有设置即时生效并持久化到 SQLite；Cookie 可粘贴或使用文件，接口只返回状态与掩码。</p></div>
      <div class="toolbar">
        <button class="btn" type="button" data-action="settings-reload">重新读取</button>
        <button class="btn primary" form="settings-form" type="submit">保存设置</button>
      </div>
    </div>
    <form id="settings-form">
      <div class="card">
        <header><h2>订阅账号</h2><span class="sub">从订阅时刻起抓取全部新动态</span></header>
        <div class="body">
          ${subs.length ? `<div class="table-wrap">
            <table>
              <thead><tr><th>账号</th><th>模式</th><th>订阅时间</th><th>最近同步</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>` : `<div class="notice info">还没有订阅账号。添加后，从这一刻起该账号发布的动态/专栏会自动进入草稿流程；订阅前的历史内容请用「手工加入」。</div>`}
          <div class="grid" id="subscription-fields" style="margin-top:16px">
            <div class="field">
              <label for="sub-mid">B 站 UID</label>
              <input id="sub-mid" type="text" inputmode="numeric" placeholder="数字 UID，例如 2">
            </div>
            <div class="field">
              <label for="sub-name">备注名（可选）</label>
              <input id="sub-name" type="text" placeholder="例如 碧诗">
            </div>
            <div class="field">
              <label for="sub-mode">抓取模式</label>
              <select id="sub-mode">
                <option value="dynamic">动态（全部类型）</option>
                <option value="article">专栏</option>
              </select>
            </div>
            <div class="field check">
              <input id="sub-forwards" type="checkbox" checked>
              <label for="sub-forwards">包含转发（保留原动态正文）</label>
            </div>
          </div>
          ${v.sourceAutoSync ? '' : '<div class="notice warn">定时同步未开启：新订阅只会在手动点「同步」时抓取。建议打开下方「定时同步全部订阅」。</div>'}
          <div class="toolbar" style="margin-top:10px">
            <button class="btn primary" type="button" data-action="subscription-add">添加订阅</button>
            <span class="muted">订阅后只处理新内容；历史内容请单独「手工加入」。</span>
          </div>
          <div class="grid" style="margin-top:18px">
            ${field({ key: 'sourceAutoSync', label: '定时同步全部订阅', type: 'checkbox', value: v.sourceAutoSync })}
            ${field({ key: 'sourceSyncIntervalSeconds', label: '同步间隔（秒）', type: 'number', value: v.sourceSyncIntervalSeconds, min: 60, max: 86400 })}
            ${field({ key: 'syncMaxNewPerRun', label: '单轮最多新建草稿', type: 'number', value: v.syncMaxNewPerRun, min: 1, max: 200, help: '达到上限时本轮标记 truncated，下一轮继续' })}
            ${field({ key: 'biliCookieFile', label: 'B 站 Cookie 文件（可选）', value: v.biliCookieFile, placeholder: 'Netscape 格式文件路径', help: '匿名可抓公开内容；配置 SESSDATA 可提高成功率' })}
          </div>
          <div class="toolbar" style="margin-top:12px">
            <button class="btn" type="button" data-action="test-target" data-target="bilibili">测试 B 站连通</button>
            <span class="muted">上次同步：${esc(fmtTime(v.lastSyncAt))}</span>
          </div>
        </div>
      </div>

      <div class="card">
        <header><h2>GameKee 目标</h2><span class="sub">发布到 /ba/editor 的文章格式</span></header>
        <div class="body">
          ${field({ key: 'gamekeeCookieText', label: '直接粘贴 GameKee Cookies（推荐）', type: 'textarea', secret: true, value: '', placeholder: v.gamekeeCookieTextSet ? '已保存（留空表示不修改）' : 'userToken=...; userUid=...; obs_client_params=...（也支持 JSON 或 Netscape 格式）', help: '粘贴后优先使用这里；留空则使用下面的 Cookie 文件。保存后点「检查 GameKee 登录」验证。' })}
          <div class="grid" style="margin-top:14px">
            ${field({ key: 'gamekeeCookieFile', label: 'GameKee Cookie 文件（备选）', value: v.gamekeeCookieFile, placeholder: 'Netscape 导出，含 userToken / userUid / obs_client_params' })}
            ${field({ key: 'gamekeeAlias', label: '游戏分区 alias', value: v.gamekeeAlias, placeholder: 'ba' })}
            ${field({ key: 'gamekeeGameId', label: 'game-id', value: v.gamekeeGameId, placeholder: '829' })}
            ${field({ key: 'gamekeeType', label: '文章类型 type', type: 'number', value: v.gamekeeType, min: 1, max: 100, help: '4 = 综合' })}
            ${field({ key: 'gamekeeTag', label: '标签 tag', value: v.gamekeeTag, placeholder: '2', help: '2 = 默认；9 = 安装教程' })}
            ${field({ key: 'editorType', label: '编辑器格式', type: 'select', value: v.editorType, options: [['1', '富文本 JSON（editor_type=1）'], ['0', 'HTML（editor_type=0）']] })}
            ${field({ key: 'maxTitleLength', label: '标题最大长度', type: 'number', value: v.maxTitleLength, min: 10, max: 200 })}
            ${field({ key: 'includeAttribution', label: '追加转载声明与原文链接', type: 'checkbox', value: v.includeAttribution })}
          </div>
          <div class="toolbar" style="margin-top:14px">
            <button class="btn" type="button" data-action="test-target" data-target="gamekee">检查 GameKee 登录</button>
            ${v.gamekeeCookieTextSet ? '<button class="btn ghost" type="button" data-action="clear-gamekee-cookie">清除已保存 Cookies</button>' : ''}
          </div>
        </div>
      </div>

      <div class="card">
        <header><h2>发布调度</h2><span class="sub">窗口 / 间隔 / 日限</span></header>
        <div class="body">
          <div class="grid">
            ${field({ key: 'autoPublish', label: '自动发布（审核通过后自动排队）', type: 'checkbox', value: v.autoPublish })}
            ${field({ key: 'paused', label: '暂停队列', type: 'checkbox', value: v.paused })}
            ${field({ key: 'publishIntervalSeconds', label: '最小间隔（秒）', type: 'number', value: v.publishIntervalSeconds, min: 10, max: 86400 })}
            ${field({ key: 'dailyLimit', label: '每日上限', type: 'number', value: v.dailyLimit, min: 1, max: 10000 })}
            ${field({ key: 'publishWindowStart', label: '窗口开始 HH:mm', value: v.publishWindowStart })}
            ${field({ key: 'publishWindowEnd', label: '窗口结束 HH:mm', value: v.publishWindowEnd })}
            ${field({ key: 'timeZone', label: '时区', value: v.timeZone, help: '例如 Asia/Shanghai' })}
          </div>
        </div>
      </div>

      <div class="card">
        <header><h2>自动审核</h2><span class="sub">关键字 + AI 提示词</span></header>
        <div class="body">
          <div class="grid">
            ${field({ key: 'autoReview', label: '新草稿自动审核', type: 'checkbox', value: v.autoReview })}
            ${field({ key: 'aiEnabled', label: '启用 AI 审核（关键字未命中时）', type: 'checkbox', value: v.aiEnabled })}
            ${field({ key: 'aiOnError', label: 'AI 失败时', type: 'select', value: v.aiOnError, options: [['review', '转人工'], ['approve', '自动通过'], ['reject', '自动拒绝']] })}
          </div>
          <div class="grid" style="margin-top:14px">
            ${field({ key: 'keywordAllow', label: '自动通过关键词（换行/逗号分隔）', type: 'textarea', value: v.keywordAllow, help: '命中任一词直接通过' })}
            ${field({ key: 'keywordBlock', label: '自动拒绝关键词', type: 'textarea', value: v.keywordBlock, help: '命中任一词直接拒绝（优先级最高）' })}
            ${field({ key: 'keywordFlag', label: '强制人工关键词', type: 'textarea', value: v.keywordFlag, help: '命中后转人工，即使 AI 通过' })}
          </div>
          <div class="grid" style="margin-top:14px">
            ${field({ key: 'aiBaseUrl', label: 'AI Base URL', value: v.aiBaseUrl, placeholder: 'https://api.openai.com/v1' })}
            ${field({ key: 'aiModel', label: '模型', value: v.aiModel, placeholder: 'gpt-4o-mini' })}
            ${field({ key: 'aiApiKey', label: 'API Key', secret: true, value: '', placeholder: maskedKey, help: '留空表示不修改已保存的 Key' })}
            ${field({ key: 'aiMinConfidence', label: '最低置信度', type: 'number', value: v.aiMinConfidence, min: 0, max: 1, step: 0.05, help: '低于该值的通过结论会转人工' })}
          </div>
          <div class="field" style="margin-top:14px">
            <label for="set-aiPrompt">审核提示词</label>
            <textarea id="set-aiPrompt" data-setting="aiPrompt" rows="14">${esc(v.aiPrompt)}</textarea>
            <span class="help">支持占位符 {{title}} {{author}} {{sourceUrl}} {{content}}；要求模型只输出 JSON 结论。</span>
          </div>
          <div class="toolbar" style="margin-top:14px">
            <button class="btn" type="button" data-action="test-target" data-target="ai">测试 AI 审核</button>
          </div>
        </div>
      </div>

      <div class="settings-actions">
        <span class="muted">保存后立即生效，无需重启</span>
        <button class="btn primary" type="submit">保存设置</button>
      </div>
    </form>
  `;
}

// ------------------------------------------------------------------ editor modal

function openModal(title, bodyHtml, footHtml) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-foot').innerHTML = footHtml;
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  $('#modal').classList.add('hidden');
  state.editing = null;
}

function previewDoc(html) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    *{box-sizing:border-box}
    html{background:#e9edf3}
    body{max-width:820px;min-height:100vh;margin:0 auto;padding:48px 56px;background:#fbfcfe;color:#273247;font:16px/1.85 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 0 32px rgba(39,50,71,.06);overflow-wrap:break-word}
    img{max-width:100%;height:auto;border:1px solid #e3e7ee;border-radius:8px}
    h1,h2,h3,h4,h5{color:#172033;line-height:1.35;letter-spacing:-.025em;margin:1.45em 0 .6em}
    h1{margin-top:0;font-size:2em}h2{font-size:1.5em;padding-bottom:.35em;border-bottom:1px solid #e4e8ef}h3{font-size:1.2em}
    p{margin:.8em 0}ul,ol{padding-left:1.5em}li+li{margin-top:.25em}
    blockquote{border-left:3px solid #a78bfa;margin:1.2em 0;padding:.35em 0 .35em 18px;background:#f4f2fb;color:#59677c}
    a{color:#6d4bc3;text-underline-offset:3px}
    code{padding:.15em .35em;border-radius:4px;background:#eef1f6;color:#59407e;font: .88em ui-monospace,SFMono-Regular,Consolas,monospace}
    pre{background:#f0f3f7;border:1px solid #dfe5ed;border-radius:8px;padding:16px;overflow:auto;line-height:1.65}
    pre code{padding:0;background:none;color:inherit}
    hr{border:0;border-top:1px solid #e2e7ef;margin:2em 0}
    table{width:100%;border-collapse:collapse}th,td{padding:8px 10px;border:1px solid #dfe5ed;text-align:left}th{background:#f0f3f7}
    .muted{color:#8a96a8}
    @media(max-width:600px){body{padding:30px 24px}h1{font-size:1.7em}}
  </style></head><body>${html || '<p class="muted">（空正文）</p>'}</body></html>`;
}

async function openEditor(id) {
  const detail = await api(`/api/drafts/${id}`);
  state.editing = detail;
  const draft = detail.draft;
  const publication = detail.publication;
  openModal(`草稿 #${draft.id} · ${(STATUS_LABELS[draft.status] ?? [draft.status])[0]}`, `
    <div class="editor-split">
      <div>
        <div class="field" style="margin-bottom:10px">
          <label for="draft-title">标题</label>
          <input id="draft-title" type="text" value="${esc(draft.title)}" maxlength="200">
        </div>
        <div class="field">
          <label for="draft-markdown">正文（Markdown）</label>
          <textarea id="draft-markdown">${esc(draft.markdown)}</textarea>
        </div>
        <div class="meta" style="margin-top:8px">
          ${draft.sourceUrl ? `<a href="${esc(draft.sourceUrl)}" target="_blank" rel="noopener">查看来源</a>` : '手工草稿'}
          ${draft.review?.reason ? ` · 审核：${esc(draft.review.reason)}` : ''}
          ${publication ? ` · 已发布 <a href="${esc(publication.url)}" target="_blank" rel="noopener">#${esc(publication.content_id)}</a>` : ''}
        </div>
      </div>
      <div>
        <div class="field">
          <label>预览（基于已保存内容）</label>
          <iframe id="preview-frame" class="preview-frame" sandbox="allow-same-origin"></iframe>
        </div>
      </div>
    </div>
    <div class="notice info" style="margin-top:12px">图片预览使用原站地址；发布时会先转存到 GameKee CDN。修改正文后会重置为「草稿」并需要重新审核。</div>
  `, `
    <button class="btn primary" data-action="editor-save">保存</button>
    <button class="btn" data-action="editor-review">保存并重新审核</button>
    <button class="btn ok" data-action="editor-approve">通过</button>
    <button class="btn danger" data-action="editor-reject">拒绝</button>
    <button class="btn" data-action="editor-queue">入队</button>
    <button class="btn primary" data-action="editor-publish">立即发布</button>
    ${publication ? '<button class="btn" data-action="editor-update">更新已发布文章</button>' : ''}
    <span class="spacer" style="flex:1"></span>
    <button class="btn ghost" data-action="modal-close">关闭</button>
  `);
  const frame = $('#preview-frame');
  if (frame) frame.srcdoc = previewDoc(detail.preview?.html ?? '');
}

async function saveEditor() {
  const editing = state.editing;
  if (!editing) return null;
  const title = $('#draft-title').value.trim();
  const markdown = $('#draft-markdown').value;
  const result = await api(`/api/drafts/${editing.draft.id}`, { method: 'PATCH', body: { title, markdown } });
  toast('已保存', 'ok');
  return result.draft;
}

async function refreshEditor() {
  const editing = state.editing;
  if (!editing) return;
  await openEditor(editing.draft.id);
}

async function afterDraftChange() {
  await Promise.all([loadState(), loadDrafts(), loadQueue()]);
  renderStatusChips();
  if (state.route === 'drafts') renderDrafts();
  if (state.route === 'queue') renderQueue();
  if (!$('#modal').classList.contains('hidden')) await refreshEditor();
}

// ------------------------------------------------------------------ action handling

async function handleAction(button) {
  const action = button.dataset.action;
  const id = Number(button.dataset.id);
  switch (action) {
    case 'toggle-theme': {
      const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = theme;
      try {
        localStorage.setItem('gc-theme', theme);
      } catch (error) { /* 隐私模式下仅切换当前页面 */ }
      syncThemeUi();
      return;
    }
    case 'refresh':
    case 'log-refresh':
    case 'settings-reload':
      await loadRoute();
      return;
    case 'sync': {
      setBusy(true);
      toast('正在同步 B 站，请稍候…');
      const result = await api('/api/sync', { method: 'POST' });
      if (result.skipped) toast('已有同步任务在运行', '');
      else toast(`同步完成：新建 ${result.created.length} 篇，失败 ${result.errors.length} 篇`, result.errors.length ? 'error' : 'ok');
      await loadRoute();
      setBusy(false);
      return;
    }
    case 'pause':
      await api('/api/queue/pause', { method: 'POST' });
      toast('队列已暂停', 'ok');
      await loadRoute();
      return;
    case 'resume':
      await api('/api/queue/resume', { method: 'POST' });
      toast('队列已恢复', 'ok');
      await loadRoute();
      return;
    case 'queue-publish': {
      setBusy(true);
      try {
        await api(`/api/queue/${id}/publish`, { method: 'POST', body: { force: true } });
        toast('发布成功', 'ok');
      } finally {
        setBusy(false);
      }
      await loadRoute();
      return;
    }
    case 'queue-retry':
      await api(`/api/queue/${id}/retry`, { method: 'POST' });
      toast('已重置为待发布', 'ok');
      await loadRoute();
      return;
    case 'queue-cancel':
      await api(`/api/queue/${id}/cancel`, { method: 'POST' });
      toast('已取消', 'ok');
      await loadRoute();
      return;
    case 'draft-edit':
      await openEditor(id);
      return;
    case 'draft-review': {
      setBusy(true);
      const result = await api(`/api/drafts/${id}/review`, { method: 'POST' });
      toast(`审核结果：${result.draft.status}`, result.draft.status === 'REJECTED' ? 'error' : 'ok');
      await afterDraftChange();
      setBusy(false);
      return;
    }
    case 'draft-approve':
      await api(`/api/drafts/${id}/approve`, { method: 'POST', body: { reason: '列表人工通过' } });
      toast('已通过', 'ok');
      await afterDraftChange();
      return;
    case 'draft-reject': {
      const reason = window.prompt('拒绝理由', '人工拒绝');
      if (reason === null) return;
      await api(`/api/drafts/${id}/reject`, { method: 'POST', body: { reason } });
      toast('已拒绝', 'ok');
      await afterDraftChange();
      return;
    }
    case 'draft-queue':
      await api(`/api/drafts/${id}/queue`, { method: 'POST' });
      toast('已入队（发布受窗口/日限/间隔约束）', 'ok');
      await afterDraftChange();
      return;
    case 'draft-publish': {
      if (!window.confirm('立即发布会忽略窗口、日限与间隔限制，确认？')) return;
      setBusy(true);
      try {
        const result = await api(`/api/drafts/${id}/publish`, { method: 'POST', body: { force: true } });
        toast(`发布成功${result.result?.contentId ? `：#${result.result.contentId}` : ''}`, 'ok');
      } finally {
        setBusy(false);
      }
      await afterDraftChange();
      return;
    }
    case 'draft-update': {
      const detail = await api(`/api/drafts/${id}`);
      if (!detail.publication) {
        toast('没有找到发布记录', 'error');
        return;
      }
      if (!window.confirm(`将把当前内容覆盖更新到 GameKee #${detail.publication.content_id}，确认？`)) return;
      setBusy(true);
      try {
        await api(`/api/publications/${detail.publication.id}/update`, { method: 'POST', body: {} });
        toast('已更新到 GameKee', 'ok');
      } finally {
        setBusy(false);
      }
      await afterDraftChange();
      return;
    }
    case 'editor-save':
      setBusy(true);
      try {
        await saveEditor();
        await afterDraftChange();
      } finally {
        setBusy(false);
      }
      return;
    case 'editor-review': {
      setBusy(true);
      try {
        const draft = await saveEditor();
        const result = await api(`/api/drafts/${draft.id}/review`, { method: 'POST' });
        toast(`审核结果：${result.draft.status}`, result.draft.status === 'REJECTED' ? 'error' : 'ok');
        await afterDraftChange();
      } finally {
        setBusy(false);
      }
      return;
    }
    case 'editor-approve':
      await saveEditor();
      await api(`/api/drafts/${state.editing.draft.id}/approve`, { method: 'POST', body: { reason: '编辑器人工通过' } });
      toast('已通过', 'ok');
      await afterDraftChange();
      return;
    case 'editor-reject': {
      const reason = window.prompt('拒绝理由', '人工拒绝');
      if (reason === null) return;
      await saveEditor();
      await api(`/api/drafts/${state.editing.draft.id}/reject`, { method: 'POST', body: { reason } });
      toast('已拒绝', 'ok');
      await afterDraftChange();
      return;
    }
    case 'editor-queue':
      await saveEditor();
      await api(`/api/drafts/${state.editing.draft.id}/queue`, { method: 'POST' });
      toast('已入队', 'ok');
      await afterDraftChange();
      return;
    case 'editor-publish': {
      if (!window.confirm('立即发布会忽略窗口/日限/间隔，确认？')) return;
      setBusy(true);
      try {
        await saveEditor();
        const result = await api(`/api/drafts/${state.editing.draft.id}/publish`, { method: 'POST', body: { force: true } });
        toast(`发布成功${result.result?.contentId ? `：#${result.result.contentId}` : ''}`, 'ok');
        closeModal();
        await afterDraftChange();
      } finally {
        setBusy(false);
      }
      return;
    }
    case 'editor-update': {
      const publication = state.editing?.publication;
      if (!publication) return;
      if (!window.confirm(`将当前内容覆盖更新到 GameKee #${publication.content_id}，确认？`)) return;
      setBusy(true);
      try {
        await saveEditor();
        await api(`/api/publications/${publication.id}/update`, { method: 'POST', body: {} });
        toast('已更新到 GameKee', 'ok');
        await afterDraftChange();
      } finally {
        setBusy(false);
      }
      return;
    }
    case 'modal-close':
      closeModal();
      return;
    case 'clear-gamekee-cookie': {
      if (!window.confirm('清除已保存的 GameKee Cookies？清除后将改用 Cookie 文件（如有）。')) return;
      await api('/api/settings', { method: 'PATCH', body: { values: { gamekeeCookieText: '' } } });
      toast('已清除', 'ok');
      await loadRoute();
      return;
    }
    case 'subscription-add': {
      const mid = String($('#sub-mid')?.value ?? '').trim();
      const name = String($('#sub-name')?.value ?? '').trim();
      const mode = $('#sub-mode')?.value === 'article' ? 'article' : 'dynamic';
      const includeForwards = Boolean($('#sub-forwards')?.checked);
      if (!/^\d{1,20}$/.test(mid)) {
        toast('B 站 UID 必须是数字', 'error');
        return;
      }
      setBusy(true);
      try {
        await api('/api/subscriptions', { method: 'POST', body: { mid, name, mode, includeForwards } });
        toast('订阅已添加，从此刻开始抓取新内容', 'ok');
      } finally {
        setBusy(false);
      }
      await loadRoute();
      return;
    }
    case 'subscription-sync': {
      setBusy(true);
      toast('正在同步该订阅，请稍候…');
      try {
        const result = await api(`/api/subscriptions/${id}/sync`, { method: 'POST' });
        if (result.skipped) toast('已有同步任务在运行', '');
        else toast(`同步完成：新草稿 ${result.created.length}，失败 ${result.errors.length}`, result.errors.length ? 'error' : 'ok');
      } finally {
        setBusy(false);
      }
      await loadRoute();
      return;
    }
    case 'subscription-toggle': {
      const enabled = button.dataset.enabled === '1';
      await api(`/api/subscriptions/${id}`, { method: 'PATCH', body: { enabled } });
      toast(enabled ? '订阅已启用' : '订阅已暂停', 'ok');
      await loadRoute();
      return;
    }
    case 'subscription-delete': {
      if (!window.confirm('删除该订阅？已生成的草稿会保留；之后不再抓取该账号。')) return;
      await api(`/api/subscriptions/${id}`, { method: 'DELETE' });
      toast('订阅已删除', 'ok');
      await loadRoute();
      return;
    }
    case 'test-target': {
      const target = button.dataset.target;
      button.disabled = true;
      try {
        const result = await api('/api/settings/test', { method: 'POST', body: { target } });
        toast(result.message, result.ok ? 'ok' : 'error');
      } finally {
        button.disabled = false;
      }
      return;
    }
    case 'log-clear-filter':
      state.logLevel = '';
      state.logScope = '';
      state.logQuery = '';
      await loadLogs();
      renderLogs();
      return;
    default:
      return;
  }
}

// ------------------------------------------------------------------ event wiring

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  event.preventDefault();
  handleAction(button).catch(error => {
    toast(error.message || String(error), 'error');
    setBusy(false);
  });
});

document.addEventListener('change', event => {
  const target = event.target;
  if (target.id === 'draft-status') {
    state.draftStatus = target.value;
    loadRoute().catch(error => toast(error.message, 'error'));
  }
  if (target.id === 'log-level') {
    state.logLevel = target.value;
    loadRoute().catch(error => toast(error.message, 'error'));
  }
  if (target.id === 'log-scope') {
    state.logScope = target.value;
    loadRoute().catch(error => toast(error.message, 'error'));
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && ['sub-mid', 'sub-name'].includes(event.target.id)) {
    event.preventDefault();
    const add = document.querySelector('[data-action="subscription-add"]');
    if (add) add.click();
    return;
  }
  if (event.key === 'Enter' && event.target.id === 'log-query') {
    state.logQuery = event.target.value;
    loadRoute().catch(error => toast(error.message, 'error'));
  }
  if (event.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal();
});

$('#modal').addEventListener('click', event => {
  if (event.target.id === 'modal') closeModal();
});

document.addEventListener('submit', event => {
  if (event.target.id === 'manual-form') {
    event.preventDefault();
    submitManual(event.target).catch(error => {
      const box = $('#manual-result');
      if (box) box.innerHTML = `<div class="notice danger">${esc(error.message)}</div>`;
      else toast(error.message, 'error');
    });
  }
  if (event.target.id === 'settings-form') {
    event.preventDefault();
    saveSettings().catch(error => toast(error.message, 'error'));
  }
});

async function submitManual(form) {
  const formData = new FormData(form);
  const payload = {
    url: String(formData.get('url') || '').trim(),
    kind: String(formData.get('kind') || 'auto'),
    title: String(formData.get('title') || '').trim(),
    author: String(formData.get('author') || '').trim(),
    markdown: String(formData.get('markdown') || ''),
  };
  if (!payload.url && !payload.markdown.trim()) {
    throw new Error('请填写 B 站链接，或粘贴 Markdown 正文');
  }
  const submit = form.querySelector('button[type=submit]');
  submit.disabled = true;
  try {
    const result = await api('/api/manual', { method: 'POST', body: payload });
    const draft = result.draft;
    $('#manual-result').innerHTML = `<div class="notice info manual-result">
      已创建草稿 #${draft.id}：<strong>${esc(draft.title)}</strong> · ${esc(draft.status)}${result.existing ? '（已存在，直接复用）' : ''}
      ${draft.review?.reason ? `<div class="muted">审核：${esc(draft.review.reason)}</div>` : ''}
      <div style="margin-top:8px"><a class="btn sm" href="#/drafts">去草稿列表</a></div>
    </div>`;
    toast('草稿已创建', 'ok');
    form.reset();
  } finally {
    submit.disabled = false;
  }
}

async function saveSettings() {
  const payload = {};
  for (const input of document.querySelectorAll('[data-setting]')) {
    const key = input.dataset.setting;
    if (input.type === 'checkbox') payload[key] = input.checked;
    else if (input.type === 'number') payload[key] = Number(input.value);
    else if (input.dataset.secret === '1') {
      if (input.value.trim()) payload[key] = input.value.trim();
    } else payload[key] = input.value;
  }
  const result = await api('/api/settings', { method: 'PATCH', body: { values: payload } });
  state.settings = result.values;
  toast('设置已保存并即时生效', 'ok');
  await loadState();
  renderStatusChips();
  renderSettings();
}

// ------------------------------------------------------------------ boot

window.addEventListener('hashchange', () => {
  closeModal();
  loadRoute().catch(error => toast(error.message, 'error'));
});

setInterval(() => {
  if (document.hidden) return;
  if (!['queue', 'drafts'].includes(state.route)) return;
  if (!$('#modal').classList.contains('hidden')) return;
  const active = document.activeElement;
  if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return;
  loadRoute(true).catch(() => {});
}, 5000);

if (!location.hash) location.hash = '#/queue';
syncThemeUi();
loadRoute().catch(error => toast(error.message, 'error'));
