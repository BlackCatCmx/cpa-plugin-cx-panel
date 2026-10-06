import {
  accountPage,
  accountPlan,
  accountProvider,
  accountStatus,
  accountSubscriptionActiveUntil,
  accountTitle,
  buildQuotaSnapshot,
  buildClaudeProfileRequest,
  buildStatusToggleRequest,
  buildRefreshRequest,
  buildResetCreditsRequest,
  dateTimeTone,
  formatRelativeDateTime,
  formatReset,
  formatUTC8DateTime,
  parseActiveQuota,
  parseClaudeProfile,
  parsePassiveQuota,
  parseResetCreditsAvailableCount,
  planInfo,
  quotaTone,
  resolveRefreshUserAgent,
  safeUpstreamError,
  selectQuotaAccounts,
  shouldInvalidateActiveQuota,
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
  statusUpdating: new Set(),
  filter: 'all',
  page: 1,
  polling: false,
  session: null,
  pluginConfig: {},
  cpaConfig: {},
  userAgent: '',
  claudeUserAgent: '',
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
  claudeUaInput: document.querySelector('#claude-ua-input'),
  claudeUaSource: document.querySelector('#claude-ua-source'),
  claudeUaMessage: document.querySelector('#claude-ua-message'),
  claudeUaSave: document.querySelector('#claude-ua-save'),
  claudeUaReset: document.querySelector('#claude-ua-reset'),
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
  return { ...(active.quota ?? passive), ...active.profile };
}

function loadActiveQuota() {
  const raw = localStorage.getItem(ACTIVE_QUOTA_KEY);
  if (!raw) return;
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries)) throw new Error('已保存额度的格式无效');
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, value] = entry;
    if (typeof key !== 'string' || (!Array.isArray(value?.quota?.windows) && !value?.profile && !value?.profileError)) continue;
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
    if (!account || (active.quota && shouldInvalidateActiveQuota(account, active))) {
      if (account && accountProvider(account) === 'claude' && (active.profile || active.profileError)) {
        state.activeQuota.set(key, { profile: active.profile, profileError: active.profileError });
      } else state.activeQuota.delete(key);
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
  if (activeError) return { kind: 'error', label: '刷新失败', message: activeError };
  if (status.kind === 'waiting' && !account.disabled && displayedQuota(account).windows.some((window) => !window.invalidPercent)) {
    return { kind: 'normal', label: '正常', message: '' };
  }
  return status;
}

function renderCard(account) {
  const key = String(account.auth_index);
  const quota = displayedQuota(account);
  const isClaude = accountProvider(account) === 'claude';
  const plan = planInfo(quota.planType || accountPlan(account));
  const status = effectiveStatus(account);
  const card = createElement('article', `account-card${account.disabled ? ' account-disabled' : ''}`);
  const head = createElement('div', 'account-head');
  const identity = createElement('div', 'identity');
  identity.append(createElement('span', 'plan neutral', isClaude ? 'Claude' : 'Codex'));
  identity.append(createElement('span', `plan ${plan.tone}`, isClaude && !quota.planType ? '未知套餐' : plan.label));
  const name = createElement('div', 'account-name', accountTitle(account));
  name.title = accountTitle(account);
  identity.append(name);
  head.append(identity);

  const actions = createElement('div', 'head-actions');
  const statusUpdating = state.statusUpdating.has(key);
  const canToggleStatus = account.runtime_only !== true && Boolean(String(account.name ?? '').trim());
  const statusButton = createElement(
    'button',
    `status status-toggle ${status.kind}${account.disabled ? ' credential-disabled' : ''}${statusUpdating ? ' updating' : ''}`,
    statusUpdating ? '处理中' : status.label,
  );
  statusButton.type = 'button';
  statusButton.title = canToggleStatus
    ? account.disabled ? '点击启用凭证' : '点击停用凭证'
    : '运行时凭证不能在此切换状态';
  statusButton.setAttribute('aria-label', statusButton.title);
  statusButton.disabled = !canToggleStatus || statusUpdating || state.refreshing.has(key);
  statusButton.addEventListener('click', () => toggleAccountStatus(account));
  actions.append(statusButton);
  const refresh = createElement('button', `refresh${state.refreshing.has(key) ? ' loading' : ''}`);
  refresh.type = 'button';
  refresh.title = account.disabled ? '已停用账号不能刷新额度' : '刷新额度';
  refresh.setAttribute('aria-label', `刷新 ${accountTitle(account)} 的额度`);
  refresh.disabled = Boolean(account.disabled) || state.refreshing.has(key) || statusUpdating;
  refresh.append(refreshIcon());
  refresh.addEventListener('click', () => refreshAccount(account));
  actions.append(refresh);

  head.append(actions);
  card.append(head);

  const subscriptionActiveUntil = quota.subscriptionActiveUntil ?? accountSubscriptionActiveUntil(account);
  const subscriptionUntil = formatUTC8DateTime(subscriptionActiveUntil) || '未知';
  const subscriptionRelative = formatRelativeDateTime(subscriptionActiveUntil);
  const subscriptionTone = dateTimeTone(subscriptionActiveUntil);
  const resetCreditsCount = quota.resetCreditsAvailableCount ?? null;
  const meta = createElement('div', 'account-meta');
  const subscriptionItem = createElement('span', `account-meta-item${subscriptionTone ? ` expiry-${subscriptionTone}` : ''}`);
  subscriptionItem.append(createElement('span', 'account-meta-label', '套餐到期'), createElement('span', 'account-meta-value', subscriptionUntil));
  if (subscriptionRelative) subscriptionItem.append(createElement('span', 'account-meta-relative', subscriptionRelative));
  if (!isClaude) meta.append(subscriptionItem);
  else {
    const createdItem = createElement('span', 'account-meta-item');
    createdItem.append(createElement('span', 'account-meta-label', '套餐开通'),
      createElement('span', 'account-meta-value', formatUTC8DateTime(quota.subscriptionCreatedAt) || '未知'));
    meta.append(createdItem);
    const subscriptionStatus = quota.subscriptionStatus;
    if (subscriptionStatus) {
      const item = createElement('span', 'account-meta-item');
      item.append(createElement('span', 'account-meta-label', '订阅状态'),
        createElement('span', 'account-meta-value', subscriptionStatus === 'active' ? '有效' : subscriptionStatus));
      meta.append(item);
    }
    if (state.activeQuota.get(key)?.profileError) {
      const item = createElement('span', 'account-meta-item account-meta-failed');
      item.title = state.activeQuota.get(key).profileError;
      item.append(createElement('span', 'account-meta-label', '套餐资料'), createElement('span', 'account-meta-value', '获取失败'));
      meta.append(item);
    }
  }
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
  {
    const source = state.activeQuota.get(key)?.quota ? '主动缓存' : '被动采集';
    const updatedAt = formatUTC8DateTime(quota.observedAt);
    const item = createElement('span', 'account-meta-item');
    item.append(createElement('span', 'account-meta-label', updatedAt ? source : '额度更新'),
      createElement('span', 'account-meta-value', updatedAt || '等待数据'));
    meta.append(item);
  }
  card.append(meta);
  if (status.message) card.append(createElement('div', 'account-error', status.message));
  const profileError = state.activeQuota.get(key)?.profileError;
  if (profileError) card.append(createElement('div', 'account-error', `套餐资料获取失败：${profileError}`));
  const list = createElement('div', 'quota-list');
  if (quota.windows.length) quota.windows.forEach((windowData) => list.append(renderWindow(windowData)));
  else list.append(createElement('div', 'account-empty', isClaude ? '暂无额度数据，点击刷新或等待业务请求采集' : '暂无额度数据'));
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
    elements.grid.append(createElement('div', 'empty', state.accounts.length ? '该分类下没有账号' : '没有 Codex 或 Claude 账号'));
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
    state.accounts = selectQuotaAccounts(response);
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

async function toggleAccountStatus(account) {
  const key = String(account.auth_index);
  if (state.statusUpdating.has(key) || state.refreshing.has(key)) return;
  state.statusUpdating.add(key);
  showBanner('');
  render();
  try {
    const request = buildStatusToggleRequest(account);
    const response = await managementFetch('/auth-files/status', {
      method: 'PATCH',
      body: JSON.stringify(request),
    });
    const disabled = Boolean(response?.disabled);
    if (disabled) {
      const quota = displayedQuota(account);
      state.activeQuota.set(key, {
        ...state.activeQuota.get(key),
        passiveObservedAt: account?.quota?.observed_at ?? null,
        quota: buildQuotaSnapshot(account, quota),
      });
      saveActiveQuota();
    }
    state.accounts = state.accounts.map((item) =>
      String(item.auth_index) === key ? { ...item, disabled } : item,
    );
  } catch (error) {
    showBanner(`更新凭证状态失败：${error.message}`);
  } finally {
    state.statusUpdating.delete(key);
    render();
  }
}

async function refreshAccount(account) {
  const key = String(account.auth_index);
  if (state.refreshing.has(key)) return;
  state.refreshing.add(key);
  state.activeErrors.delete(key);
  render();
  try {
    const request = buildRefreshRequest(account, accountProvider(account) === 'claude' ? state.claudeUserAgent : state.userAgent);
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
    const quota = parseActiveQuota(payload, accountProvider(account));
    if (!quota.windows.length) throw new Error('上游响应中没有可用额度窗口');
    let profile;
    let profileError;
    if (accountProvider(account) === 'claude') {
      try {
        const profileResponse = await managementFetch('/api-call', {
          method: 'POST', body: JSON.stringify(buildClaudeProfileRequest(account, state.claudeUserAgent)),
        }, 65_000);
        const profileStatus = Number(profileResponse?.status_code);
        if (!Number.isInteger(profileStatus) || profileStatus < 200 || profileStatus >= 300) {
          throw new Error(safeUpstreamError(profileResponse));
        }
        let profilePayload;
        try { profilePayload = typeof profileResponse.body === 'string' ? JSON.parse(profileResponse.body) : profileResponse.body; }
        catch { throw new Error('Claude 资料响应不是有效 JSON'); }
        profile = parseClaudeProfile(profilePayload);
      } catch (error) {
        profileError = error.message;
      }
    }
    if (accountProvider(account) !== 'claude') {
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
    }
    state.activeQuota.set(key, { passiveObservedAt: account?.quota?.observed_at ?? null, quota, profile, profileError });
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
  const claude = resolveRefreshUserAgent(state.pluginConfig, state.cpaConfig, 'claude');
  state.claudeUserAgent = claude.value;
  elements.claudeUaInput.value = String(state.pluginConfig?.claude_refresh_user_agent ?? '');
  elements.claudeUaInput.placeholder = claude.value;
  elements.claudeUaSource.textContent = `当前使用：${claude.source}`;
}

async function saveUserAgent(value, provider = 'codex') {
  const field = provider === 'claude' ? 'claude_refresh_user_agent' : 'refresh_user_agent';
  const message = provider === 'claude' ? elements.claudeUaMessage : elements.uaMessage;
  message.textContent = '';
  try {
    validateUserAgent(value);
    await managementFetch(`/plugins/${pluginID}/config`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value }),
    });
    state.pluginConfig = { ...state.pluginConfig, [field]: value };
    applyUserAgent();
    message.textContent = '已保存';
  } catch (error) {
    message.textContent = error.message;
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
elements.claudeUaSave.addEventListener('click', () => saveUserAgent(elements.claudeUaInput.value.trim(), 'claude'));
elements.claudeUaReset.addEventListener('click', () => saveUserAgent('', 'claude'));
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
