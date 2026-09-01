import {
  accountPlan,
  accountStatus,
  accountTitle,
  buildRefreshRequest,
  formatReset,
  parseActiveQuota,
  parsePassiveQuota,
  planInfo,
  resolveRefreshUserAgent,
  safeUpstreamError,
  selectCodexAccounts,
  validateUserAgent,
} from './panel-logic.mjs';

const SESSION_KEY = 'cli-proxy-auth';
const SESSION_PREFIX = 'enc::v1::';
const POLL_INTERVAL = 10_000;
const state = {
  accounts: [],
  activeQuota: new Map(),
  activeErrors: new Map(),
  refreshing: new Set(),
  filter: 'all',
  polling: false,
  session: null,
  pluginConfig: {},
  cpaConfig: {},
  userAgent: '',
};

const elements = {
  banner: document.querySelector('#banner'),
  grid: document.querySelector('#account-grid'),
  tabs: document.querySelector('#tabs'),
  all: document.querySelector('#count-all'),
  normal: document.querySelector('#count-normal'),
  other: document.querySelector('#count-other'),
  theme: document.querySelector('#theme-button'),
  uaInput: document.querySelector('#ua-input'),
  uaSource: document.querySelector('#ua-source'),
  uaMessage: document.querySelector('#ua-message'),
  uaSave: document.querySelector('#ua-save'),
  uaReset: document.querySelector('#ua-reset'),
};

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function readSession() {
  const stored = localStorage.getItem(SESSION_KEY);
  if (!stored) throw new Error('未找到 CPA 管理登录信息，请先登录原生管理页面');
  let raw = stored;
  if (stored.startsWith(SESSION_PREFIX)) {
    const encrypted = decodeBase64(stored.slice(SESSION_PREFIX.length));
    const key = new TextEncoder().encode(`cli-proxy-api-webui::secure-storage|${window.location.host}|${navigator.userAgent}`);
    const plain = Uint8Array.from(encrypted, (byte, index) => byte ^ key[index % key.length]);
    raw = new TextDecoder().decode(plain);
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('CPA 管理登录信息无法读取，请重新登录'); }
  const session = parsed?.state ?? parsed;
  const apiBase = String(session?.apiBase ?? '').replace(/\/+$/, '');
  const managementKey = String(session?.managementKey ?? '');
  if (!apiBase || !managementKey) throw new Error('CPA 未保存管理登录信息，请在原生管理页面启用记住登录');
  let baseURL;
  try { baseURL = new URL(apiBase, window.location.origin); } catch { throw new Error('CPA 管理地址无效'); }
  if (baseURL.origin !== window.location.origin) throw new Error('CPA 管理地址与插件页面不一致');
  return { baseURL: baseURL.href.replace(/\/+$/, ''), managementKey };
}

async function managementFetch(path, options = {}, timeout = 15_000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${state.session.baseURL}/v0/management${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${state.session.managementKey}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('请求超时');
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function showBanner(message = '') {
  elements.banner.textContent = message;
  elements.banner.classList.toggle('show', Boolean(message));
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function refreshIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', 'M20 6v5h-5M4 18v-5h5m9.5-3a7 7 0 0 0-12-2.5L4 10m16 4-2.5 2.5A7 7 0 0 1 5.5 14');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function displayedQuota(account) {
  const key = String(account.auth_index);
  const passive = parsePassiveQuota(account);
  const active = state.activeQuota.get(key);
  if (!active) return passive;
  if (passive.observedAt && active.passiveObservedAt !== passive.observedAt) {
    state.activeQuota.delete(key);
    return passive;
  }
  return active.quota;
}

function renderWindow(windowData) {
  const row = createElement('div', 'quota-row');
  const top = createElement('div', 'quota-top');
  top.append(createElement('span', 'quota-label', windowData.label));
  const value = createElement('span', 'quota-value');
  if (windowData.invalidPercent) {
    value.textContent = '数据无效';
  } else {
    value.textContent = `${Math.round(windowData.remaining)}%`;
    const reset = formatReset(windowData.resetAt);
    if (reset) value.append(createElement('span', 'quota-reset', reset));
  }
  top.append(value);
  const track = createElement('div', 'track');
  const remaining = windowData.remaining ?? 0;
  const fill = createElement('div', `fill${remaining <= 0 ? ' empty' : remaining <= 25 ? ' low' : ''}`);
  fill.style.width = `${Math.max(0, Math.min(100, remaining))}%`;
  track.append(fill);
  row.append(top, track);
  return row;
}

function effectiveStatus(account) {
  const status = accountStatus(account);
  const activeError = state.activeErrors.get(String(account.auth_index));
  return activeError ? { kind: 'error', label: '刷新失败', message: activeError } : status;
}

function renderCard(account) {
  const key = String(account.auth_index);
  const quota = displayedQuota(account);
  const plan = planInfo(quota.planType || accountPlan(account));
  const status = effectiveStatus(account);
  const card = createElement('article', 'account-card');
  const head = createElement('div', 'account-head');
  head.append(createElement('span', `plan ${plan.tone}`, plan.label));
  head.append(createElement('div', 'account-name', accountTitle(account)));

  const actions = createElement('div', 'head-actions');
  actions.append(createElement('span', `status ${status.kind}`, status.label));
  const refresh = createElement('button', `refresh${state.refreshing.has(key) ? ' loading' : ''}`);
  refresh.type = 'button';
  refresh.title = account.disabled ? '已停用账号不能刷新额度' : '刷新额度';
  refresh.setAttribute('aria-label', `刷新 ${accountTitle(account)} 的额度`);
  refresh.disabled = Boolean(account.disabled) || state.refreshing.has(key);
  refresh.append(refreshIcon());
  refresh.addEventListener('click', () => refreshAccount(account));
  actions.append(refresh);

  const list = createElement('div', 'quota-list');
  if (quota.windows.length) quota.windows.forEach((windowData) => list.append(renderWindow(windowData)));
  else list.append(createElement('div', 'muted', '尚未采集到额度'));
  card.append(head, actions, list);
  if (status.message) card.append(createElement('div', 'account-error', status.message));
  return card;
}

function render() {
  const statuses = state.accounts.map(effectiveStatus);
  const normalCount = statuses.filter((item) => item.kind === 'normal').length;
  elements.all.textContent = String(state.accounts.length);
  elements.normal.textContent = String(normalCount);
  elements.other.textContent = String(state.accounts.length - normalCount);
  const visible = state.accounts.filter((account) => state.filter === 'all' || effectiveStatus(account).kind === state.filter);
  elements.grid.replaceChildren();
  if (!visible.length) {
    elements.grid.append(createElement('div', 'empty', state.accounts.length ? '该分类下没有账号' : '没有 Codex 账号'));
    return;
  }
  visible.forEach((account) => elements.grid.append(renderCard(account)));
}

async function pollAccounts({ initial = false } = {}) {
  if (state.polling || document.hidden) return;
  state.polling = true;
  try {
    const response = await managementFetch('/auth-files');
    state.accounts = selectCodexAccounts(response);
    showBanner('');
    render();
  } catch (error) {
    showBanner(`读取账号失败：${error.message}`);
    if (initial) render();
  } finally {
    state.polling = false;
  }
}

async function refreshAccount(account) {
  const key = String(account.auth_index);
  if (state.refreshing.has(key)) return;
  state.refreshing.add(key);
  state.activeErrors.delete(key);
  render();
  try {
    const request = buildRefreshRequest(account, state.userAgent);
    let response;
    try {
      response = await managementFetch('/api-call', { method: 'POST', body: JSON.stringify(request) }, 65_000);
    } catch (error) {
      throw new Error(`CPA 代发失败：${error.message}`);
    }
    const upstreamStatus = Number(response?.status_code);
    if (!Number.isInteger(upstreamStatus) || upstreamStatus < 200 || upstreamStatus >= 300) {
      throw new Error(safeUpstreamError(response));
    }
    let payload;
    try { payload = typeof response.body === 'string' ? JSON.parse(response.body) : response.body; }
    catch { throw new Error('上游额度响应不是有效 JSON'); }
    const quota = parseActiveQuota(payload);
    if (!quota.windows.length) throw new Error('上游响应中没有可用额度窗口');
    state.activeQuota.set(key, { passiveObservedAt: account?.quota?.observed_at ?? null, quota });
  } catch (error) {
    state.activeErrors.set(key, error.message);
  } finally {
    state.refreshing.delete(key);
    render();
  }
}

function applyUserAgent() {
  const resolved = resolveRefreshUserAgent(state.pluginConfig, state.cpaConfig);
  state.userAgent = resolved.value;
  elements.uaInput.value = String(state.pluginConfig?.refresh_user_agent ?? '');
  elements.uaInput.placeholder = resolved.value;
  elements.uaSource.textContent = `当前使用：${resolved.source}`;
}

async function saveUserAgent(value) {
  elements.uaMessage.textContent = '';
  try {
    validateUserAgent(value);
    await managementFetch(`/plugins/${pluginID}/config`, {
      method: 'PATCH',
      body: JSON.stringify({ refresh_user_agent: value }),
    });
    state.pluginConfig = { ...state.pluginConfig, refresh_user_agent: value };
    applyUserAgent();
    elements.uaMessage.textContent = '已保存';
  } catch (error) {
    elements.uaMessage.textContent = error.message;
  }
}

const pluginID = 'cpa-plugin-cx-panel';

elements.tabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  state.filter = button.dataset.filter;
  elements.tabs.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab === button));
  render();
});

elements.uaSave.addEventListener('click', () => saveUserAgent(elements.uaInput.value.trim()));
elements.uaReset.addEventListener('click', () => saveUserAgent(''));
elements.theme.addEventListener('click', () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('cpa-cx-panel-theme', root.dataset.theme);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollAccounts(); });

async function initialize() {
  const savedTheme = localStorage.getItem('cpa-cx-panel-theme');
  if (savedTheme === 'dark' || savedTheme === 'light') document.documentElement.dataset.theme = savedTheme;
  try {
    state.session = readSession();
    const [pluginConfig, cpaConfig] = await Promise.all([
      managementFetch(`/plugins/${pluginID}/config`),
      managementFetch('/config'),
    ]);
    state.pluginConfig = pluginConfig ?? {};
    state.cpaConfig = cpaConfig ?? {};
    applyUserAgent();
    await pollAccounts({ initial: true });
    window.setInterval(pollAccounts, POLL_INTERVAL);
  } catch (error) {
    showBanner(error.message);
    elements.grid.replaceChildren(createElement('div', 'empty', '无法连接 CPA 管理接口'));
  }
}

initialize();
