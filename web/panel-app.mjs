import {
  accountPage,
  accountPlan,
  accountStatus,
  accountSubscriptionActiveUntil,
  accountTitle,
  buildRefreshRequest,
  buildResetCreditsRequest,
  dateTimeTone,
  formatRelativeDateTime,
  formatReset,
  formatUTC8DateTime,
  parseActiveQuota,
  parsePassiveQuota,
  parseResetCreditsAvailableCount,
  planInfo,
  quotaTone,
  resolveRefreshUserAgent,
  safeUpstreamError,
  selectCodexAccounts,
  validateUserAgent,
} from './panel-logic.mjs';

const SESSION_KEY = 'cli-proxy-auth';
const SESSION_PREFIX = 'enc::v1::';
const ACTIVE_QUOTA_KEY = 'cpa-cx-panel-active-quota-v1';
const POLL_INTERVAL = 30_000;
const state = {
  accounts: [],
  activeQuota: new Map(),
  activeErrors: new Map(),
  refreshing: new Set(),
  filter: 'all',
  page: 1,
  polling: false,
  session: null,
  pluginConfig: {},
  cpaConfig: {},
  userAgent: '',
};

const elements = {
  banner: document.querySelector('#banner'),
  grid: document.querySelector('#account-grid'),
  pagination: document.querySelector('#pagination'),
  tabs: document.querySelector('#tabs'),
  all: document.querySelector('#count-all'),
  quota: document.querySelector('#count-quota'),
  error: document.querySelector('#count-error'),
  tabAll: document.querySelector('#tab-all'),
  tabNormal: document.querySelector('#tab-normal'),
  tabError: document.querySelector('#tab-error'),
  tabWaiting: document.querySelector('#tab-waiting'),
  pollState: document.querySelector('#poll-state'),
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
  return active.quota;
}

function loadActiveQuota() {
  const raw = localStorage.getItem(ACTIVE_QUOTA_KEY);
  if (!raw) return;
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries)) throw new Error('已保存额度的格式无效');
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, value] = entry;
    if (typeof key !== 'string' || !Array.isArray(value?.quota?.windows)) continue;
    state.activeQuota.set(key, value);
  }
}

function saveActiveQuota() {
  localStorage.setItem(ACTIVE_QUOTA_KEY, JSON.stringify([...state.activeQuota]));
}

function reconcileActiveQuota() {
  const accounts = new Map(state.accounts.map((account) => [String(account.auth_index), account]));
  let changed = false;
  for (const [key, active] of state.activeQuota) {
    const account = accounts.get(key);
    const passiveObservedAt = account ? parsePassiveQuota(account).observedAt : null;
    if (!account || (passiveObservedAt && active.passiveObservedAt !== passiveObservedAt)) {
      state.activeQuota.delete(key);
      changed = true;
    }
  }
  if (changed) saveActiveQuota();
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
    if (reset) {
      value.append(createElement('span', 'quota-reset', reset));
      value.append(createElement('span', 'quota-reset-relative', `· ${formatRelativeDateTime(windowData.resetAt)}`));
    }
  }
  top.append(value);
  const track = createElement('div', 'track');
  const remaining = windowData.remaining ?? 0;
  const fill = createElement('div', `fill ${quotaTone(remaining)}`);
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
  const identity = createElement('div', 'identity');
  identity.append(createElement('span', `plan ${plan.tone}`, plan.label));
  const name = createElement('div', 'account-name', accountTitle(account));
  name.title = accountTitle(account);
  identity.append(name);
  head.append(identity);

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

  head.append(actions);
  card.append(head);

  const subscriptionActiveUntil = accountSubscriptionActiveUntil(account);
  const subscriptionUntil = formatUTC8DateTime(subscriptionActiveUntil) || '未知';
  const subscriptionRelative = formatRelativeDateTime(subscriptionActiveUntil);
  const subscriptionTone = dateTimeTone(subscriptionActiveUntil);
  const resetCreditsCount = quota.resetCreditsAvailableCount ?? null;
  const meta = createElement('div', 'account-meta');
  const subscriptionItem = createElement('span', `account-meta-item${subscriptionTone ? ` expiry-${subscriptionTone}` : ''}`);
  subscriptionItem.append(createElement('span', 'account-meta-label', '套餐到期'), createElement('span', 'account-meta-value', subscriptionUntil));
  if (subscriptionRelative) subscriptionItem.append(createElement('span', 'account-meta-relative', subscriptionRelative));
  meta.append(subscriptionItem);
  if (resetCreditsCount !== null) {
    const item = createElement('span', 'account-meta-item');
    item.append(createElement('span', 'account-meta-label', '主动重置次数'), createElement('span', 'account-meta-value', String(resetCreditsCount)));
    meta.append(item);
  } else if (quota.resetCreditsError) {
    const item = createElement('span', 'account-meta-item account-meta-failed');
    item.title = quota.resetCreditsError;
    item.append(createElement('span', 'account-meta-label', '主动重置次数'), createElement('span', 'account-meta-value', '获取失败'));
    meta.append(item);
  }
  card.append(meta);
  if (status.message) card.append(createElement('div', 'account-error', status.message));
  const list = createElement('div', 'quota-list');
  if (quota.windows.length) quota.windows.forEach((windowData) => list.append(renderWindow(windowData)));
  else list.append(createElement('div', 'account-empty', '暂无额度数据'));
  card.append(list);
  return card;
}

function render() {
  const statuses = state.accounts.map(effectiveStatus);
  const normalCount = statuses.filter((item) => item.kind === 'normal').length;
  const errorCount = statuses.filter((item) => item.kind === 'error').length;
  const waitingCount = statuses.filter((item) => item.kind === 'waiting').length;
  const quotaCount = state.accounts.filter((account) => displayedQuota(account).windows.length > 0).length;
  elements.all.textContent = String(state.accounts.length);
  elements.quota.textContent = String(quotaCount);
  elements.error.textContent = String(errorCount);
  elements.tabAll.textContent = String(state.accounts.length);
  elements.tabNormal.textContent = String(normalCount);
  elements.tabError.textContent = String(errorCount);
  elements.tabWaiting.textContent = String(waitingCount);
  const filtered = state.accounts.filter((account) => state.filter === 'all' || effectiveStatus(account).kind === state.filter);
  const paged = accountPage(filtered, state.page);
  state.page = paged.page;
  elements.grid.replaceChildren();
  elements.pagination.replaceChildren();
  elements.pagination.hidden = paged.totalPages <= 1;
  if (!filtered.length) {
    elements.grid.append(createElement('div', 'empty', state.accounts.length ? '该分类下没有账号' : '没有 Codex 账号'));
    return;
  }
  paged.items.forEach((account) => elements.grid.append(renderCard(account)));
  if (paged.totalPages > 1) {
    const previous = createElement('button', 'pagination-button', '上一页');
    previous.type = 'button';
    previous.disabled = paged.page === 1;
    previous.addEventListener('click', () => { state.page -= 1; render(); });
    const status = createElement('span', 'pagination-status', `第 ${paged.page} / ${paged.totalPages} 页 · 共 ${filtered.length} 个账号`);
    const next = createElement('button', 'pagination-button', '下一页');
    next.type = 'button';
    next.disabled = paged.page === paged.totalPages;
    next.addEventListener('click', () => { state.page += 1; render(); });
    elements.pagination.append(previous, status, next);
  }
}

async function pollAccounts({ initial = false } = {}) {
  if (state.polling || document.hidden) return;
  state.polling = true;
  try {
    const response = await managementFetch('/auth-files');
    state.accounts = selectCodexAccounts(response);
    reconcileActiveQuota();
    showBanner('');
    elements.pollState.textContent = '刚刚更新';
    render();
  } catch (error) {
    showBanner(`读取账号失败：${error.message}`);
    elements.pollState.textContent = '更新失败';
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
    try {
      const resetResponse = await managementFetch('/api-call', {
        method: 'POST',
        body: JSON.stringify(buildResetCreditsRequest(account, state.userAgent)),
      });
      const resetStatus = Number(resetResponse?.status_code);
      if (!Number.isInteger(resetStatus) || resetStatus < 200 || resetStatus >= 300) {
        throw new Error(safeUpstreamError(resetResponse));
      }
      let resetPayload;
      try { resetPayload = typeof resetResponse.body === 'string' ? JSON.parse(resetResponse.body) : resetResponse.body; }
      catch { throw new Error('主动重置次数响应不是有效 JSON'); }
      const count = parseResetCreditsAvailableCount(resetPayload);
      if (count === null) throw new Error('主动重置次数响应格式无效');
      quota.resetCreditsAvailableCount = count;
    } catch (error) {
      if (quota.resetCreditsAvailableCount === null) quota.resetCreditsError = error.message;
    }
    state.activeQuota.set(key, { passiveObservedAt: account?.quota?.observed_at ?? null, quota });
    saveActiveQuota();
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
  state.page = 1;
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
    loadActiveQuota();
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
