export const DEFAULT_CODEX_USER_AGENT =
  'codex-tui/0.146.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.146.0)';

const quotaKeyPattern = /^x-codex-(?:(.+)-)?(primary|secondary)-used-percent$/;

const scalar = (value) => (Array.isArray(value) ? value[0] : value);

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

export function selectCodexAccounts(payload) {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  return files.filter((file) => {
    const provider = firstText(file?.provider, file?.type).toLowerCase();
    return provider === 'codex' && String(file?.auth_index ?? '').trim() !== '';
  });
}

export function accountPage(accounts, requestedPage) {
  const pageSize = 30;
  const totalPages = Math.max(1, Math.ceil(accounts.length / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), totalPages);
  const start = (page - 1) * pageSize;
  return { items: accounts.slice(start, start + pageSize), page, totalPages };
}

export function quotaTone(remaining) {
  if (remaining >= 70) return 'high';
  if (remaining >= 30) return 'medium';
  return 'low';
}

export function accountTitle(account) {
  return firstText(account?.label, account?.email, account?.name) || 'Codex 账号';
}

export function planInfo(value) {
  const raw = String(value ?? '').trim();
  const plan = raw || 'FREE';
  const lower = plan.toLowerCase();
  if (lower.includes('team')) return { label: plan.toUpperCase(), tone: 'team' };
  if (lower.includes('pro')) return { label: plan.toUpperCase(), tone: 'pro' };
  if (lower.includes('plus')) return { label: plan.toUpperCase(), tone: 'plus' };
  return { label: plan.toUpperCase(), tone: 'neutral' };
}

export function accountPlan(account) {
  const tokenPlan = firstText(account?.id_token?.plan_type, account?.id_token?.planType);
  if (tokenPlan) return tokenPlan;
  return normalizedSignals(account?.quota?.signals).get('x-codex-plan-type') ?? '';
}

export function accountSubscriptionActiveUntil(account) {
  return first(
    account?.id_token,
    'chatgpt_subscription_active_until',
    'chatgptSubscriptionActiveUntil',
  );
}

export function accountStatus(account) {
  const message = String(account?.status_message ?? '').trim();
  const status = String(account?.status ?? '').trim().toLowerCase();
  const healthyMessage = ['ok', 'healthy', 'ready', 'success', 'available'].includes(message.toLowerCase());
  const unhealthyMessage = healthyMessage ? '' : message;
  if (account?.disabled) return { kind: 'waiting', label: '已停用', message: unhealthyMessage };
  if (account?.unavailable || status === 'error' || status === 'unavailable') {
    return { kind: 'error', label: '异常', message: unhealthyMessage || 'CPA 未提供异常说明' };
  }
  if (message && !healthyMessage) {
    return { kind: 'error', label: '异常', message };
  }
  if (!account?.quota?.observed_at) return { kind: 'waiting', label: '等待额度', message: '' };
  return { kind: 'normal', label: '正常', message: '' };
}

function normalizedSignals(signals) {
  const result = new Map();
  for (const [key, value] of Object.entries(signals ?? {})) {
    result.set(key.toLowerCase(), String(scalar(value) ?? '').trim());
  }
  return result;
}

function windowLabel(namespace, kind, minutes) {
  const duration = Number(minutes);
  let label;
  if (duration === 300) label = '5 小时窗口';
  else if (duration === 10080) label = '7 天窗口';
  else if (duration > 0 && duration % 1440 === 0) label = `${duration / 1440} 天窗口`;
  else if (duration > 0 && duration % 60 === 0) label = `${duration / 60} 小时窗口`;
  else if (duration > 0) label = `${duration} 分钟窗口`;
  else label = kind === 'primary' ? '主窗口' : '次窗口';

  if (!namespace) return label;
  if (namespace === 'code-review') return `Code Review · ${label}`;
  return `${namespace} · ${label}`;
}

function resetTime(resetAt, resetAfter, observedAt) {
  const absoluteRaw = firstText(resetAt);
  const absolute = Number(absoluteRaw);
  if (absoluteRaw && Number.isFinite(absolute) && absolute > 0) {
    return absolute < 1e12 ? absolute * 1000 : absolute;
  }
  const relativeRaw = firstText(resetAfter);
  const relative = Number(relativeRaw);
  const observed = Date.parse(observedAt ?? '');
  return relativeRaw && Number.isFinite(relative) && relative >= 0 && Number.isFinite(observed)
    ? observed + relative * 1000
    : null;
}

function quotaWindow(key, label, used, resetAt) {
  const raw = used === null || used === undefined ? '' : String(used).trim();
  const number = Number(raw);
  const valid = raw !== '' && Number.isFinite(number) && number >= 0 && number <= 100;
  return {
    key,
    label,
    remaining: valid ? 100 - number : null,
    invalidPercent: !valid,
    resetAt,
  };
}

export function parsePassiveQuota(account) {
  const signals = normalizedSignals(account?.quota?.signals);
  const windows = [];
  for (const [key, used] of signals) {
    const match = key.match(quotaKeyPattern);
    if (!match) continue;
    const namespace = match[1] ?? '';
    const kind = match[2];
    const prefix = key.slice(0, -'used-percent'.length);
    const displayName = signals.get(`${prefix}limit-name`) || namespace;
    const minutes = signals.get(`${prefix}window-minutes`);
    windows.push(quotaWindow(
      `${namespace || 'root'}-${kind}`,
      windowLabel(displayName.toLowerCase() === 'code-review' ? 'code-review' : displayName, kind, minutes),
      used,
      resetTime(signals.get(`${prefix}reset-at`), signals.get(`${prefix}reset-after-seconds`), account?.quota?.observed_at),
    ));
  }
  const order = (window) => window.key.startsWith('root-') ? 0 : window.key.startsWith('code-review-') ? 1 : 2;
  windows.sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label, 'zh-CN'));
  return { planType: accountPlan(account), observedAt: account?.quota?.observed_at ?? null, windows };
}

function first(object, ...keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
}

function activeReset(window) {
  return resetTime(first(window, 'reset_at', 'resetAt'), first(window, 'reset_after_seconds', 'resetAfterSeconds'), new Date().toISOString());
}

function activeMinutes(window) {
  const minutes = Number(first(window, 'window_minutes', 'windowMinutes'));
  if (Number.isFinite(minutes) && minutes > 0) return minutes;
  const seconds = Number(first(window, 'limit_window_seconds', 'limitWindowSeconds'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : null;
}

function appendActiveWindows(result, limit, namespace, displayName) {
  if (!limit || typeof limit !== 'object') return;
  for (const kind of ['primary', 'secondary']) {
    const window = first(limit, `${kind}_window`, `${kind}Window`, kind);
    if (!window || typeof window !== 'object') continue;
    const used = first(window, 'used_percent', 'usedPercent');
    result.push(quotaWindow(
      `${namespace || 'root'}-${kind}`,
      windowLabel(displayName, kind, activeMinutes(window)),
      used,
      activeReset(window),
    ));
  }
}

export function parseActiveQuota(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('额度响应格式无效');
  const windows = [];
  appendActiveWindows(windows, first(payload, 'rate_limit', 'rateLimit', 'rate_limits', 'rateLimits'), '', '');
  appendActiveWindows(windows, first(payload, 'code_review_rate_limit', 'codeReviewRateLimit', 'code_review_rate_limits', 'codeReviewRateLimits'), 'code-review', 'code-review');

  const additional = first(payload, 'additional_rate_limits', 'additionalRateLimits');
  if (Array.isArray(additional)) {
    additional.forEach((item, index) => {
      const name = String(first(item, 'limit_name', 'limitName', 'metered_feature', 'meteredFeature', 'name') ?? `额外额度 ${index + 1}`);
      appendActiveWindows(windows, first(item, 'rate_limit', 'rateLimit') ?? item, `additional-${index}`, name);
    });
  } else if (additional && typeof additional === 'object') {
    Object.entries(additional).forEach(([name, item], index) => {
      appendActiveWindows(windows, first(item, 'rate_limit', 'rateLimit') ?? item, `additional-${index}`, name);
    });
  }
  return {
    planType: first(payload, 'plan_type', 'planType') ?? '',
    observedAt: new Date().toISOString(),
    resetCreditsAvailableCount: parseResetCreditsAvailableCount(
      first(payload, 'rate_limit_reset_credits', 'rateLimitResetCredits'),
    ),
    windows,
  };
}

export function parseResetCreditsAvailableCount(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = first(payload, 'available_count', 'availableCount');
  const count = Number(raw);
  if (raw !== null && raw !== '' && Number.isFinite(count) && count >= 0) return count;
  if (!Array.isArray(payload.credits)) return null;
  return payload.credits.filter((credit) => {
    if (!credit || typeof credit !== 'object') return false;
    const type = firstText(credit.reset_type, credit.resetType);
    const status = firstText(credit.status);
    return type === 'codex_rate_limits' && status === 'available';
  }).length;
}

export function resolveRefreshUserAgent(pluginConfig, cpaConfig) {
  const configured = String(pluginConfig?.refresh_user_agent ?? '').trim();
  if (configured) return { value: configured, source: '插件设置' };
  const inherited = String(cpaConfig?.['codex-header-defaults']?.['user-agent'] ?? '').trim();
  if (inherited) return { value: inherited, source: 'CPA 配置' };
  return { value: DEFAULT_CODEX_USER_AGENT, source: 'CPA 默认值' };
}

export function validateUserAgent(value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('User-Agent 不能包含控制字符');
  if (value.length > 1024) throw new Error('User-Agent 不能超过 1024 个字符');
}

export function buildRefreshRequest(account, userAgent) {
  const authIndex = String(account?.auth_index ?? '').trim();
  if (!authIndex) throw new Error('账号缺少 auth_index');
  validateUserAgent(userAgent);
  const header = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
  };
  const accountID = String(account?.id_token?.chatgpt_account_id ?? account?.id_token?.chatgptAccountId ?? '').trim();
  if (accountID) header['Chatgpt-Account-Id'] = accountID;
  return {
    auth_index: authIndex,
    method: 'GET',
    url: 'https://chatgpt.com/backend-api/wham/usage',
    header,
  };
}

export function buildResetCreditsRequest(account, userAgent) {
  const request = buildRefreshRequest(account, userAgent);
  return {
    ...request,
    url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
    header: {
      ...request.header,
      Accept: 'application/json',
      'OpenAI-Beta': 'codex-1',
      Originator: 'Codex Desktop',
    },
  };
}

export function safeUpstreamError(response) {
  const status = Number(response?.status_code);
  let body = response?.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const message = typeof body?.error === 'string' ? body.error
    : typeof body?.error?.message === 'string' ? body.error.message
      : typeof body?.message === 'string' ? body.message : '';
  return message ? `上游返回 ${status || '错误'}：${message}` : `上游返回 HTTP ${status || '错误'}`;
}

export function formatReset(value) {
  if (!Number.isFinite(value)) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function dateLikeTimestamp(value) {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '' || raw === null || raw === undefined || typeof raw === 'boolean') return null;
  const numeric = Number(raw);
  const instant = Number.isFinite(numeric)
    ? numeric > 0 ? new Date(numeric < 1e11 ? numeric * 1000 : numeric) : null
    : new Date(raw);
  return instant && Number.isFinite(instant.getTime()) ? instant.getTime() : null;
}

export function formatUTC8DateTime(value) {
  const timestamp = dateLikeTimestamp(value);
  if (timestamp === null) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestamp).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const relativeDateTimeFormatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'always' });

export function formatRelativeDateTime(value, now = Date.now()) {
  const timestamp = dateLikeTimestamp(value);
  if (timestamp === null) return '';
  const delta = timestamp - now;
  const sign = delta < 0 ? -1 : 1;
  const absolute = Math.abs(delta);
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const minute = 60 * 1000;
  let unit;
  let amount;
  if (absolute >= day) {
    unit = 'day';
    amount = Math.floor(absolute / day);
  } else if (absolute >= hour) {
    unit = 'hour';
    amount = Math.floor(absolute / hour);
  } else {
    unit = 'minute';
    amount = Math.max(1, Math.floor(absolute / minute));
  }
  return relativeDateTimeFormatter.format(sign * amount, unit);
}

export function dateTimeTone(value, now = Date.now()) {
  const timestamp = dateLikeTimestamp(value);
  if (timestamp === null) return '';
  const remaining = timestamp - now;
  if (remaining <= 0) return 'expired';
  return remaining <= 24 * 60 * 60 * 1000 ? 'soon' : 'valid';
}
