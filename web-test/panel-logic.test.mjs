import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  accountPage,
  accountSubscriptionActiveUntil,
  accountStatus,
  buildQuotaSnapshot,
  buildClaudeProfileRequest,
  buildStatusToggleRequest,
  buildRefreshRequest,
  buildResetCreditsRequest,
  dateTimeTone,
  formatRelativeDateTime,
  formatUTC8DateTime,
  mergeClaudeQuota,
  mergePassiveQuota,
  parseActiveQuota,
  parseClaudeProfile,
  parsePassiveQuota,
  parseResetCreditsAvailableCount,
  planInfo,
  quotaTone,
  resolveClaudeUserAgents,
  resolveRefreshUserAgent,
  safeUpstreamError,
  selectQuotaAccounts,
  shouldInvalidateAccountCache,
  shouldInvalidateActiveQuota,
  shouldRefreshClaudeProfile,
  validateUserAgent,
} from '../web/panel-logic.mjs';

test('只选择带 auth_index 的 Codex 和 Claude 账号，Claude 在前且同类保留原顺序', () => {
  const result = selectQuotaAccounts({ files: [
    { provider: 'codex', auth_index: '1' },
    { type: 'claude', auth_index: '2' },
    { provider: 'codex', auth_index: '4' },
    { type: 'claude', auth_index: '5' },
    { provider: 'codex' },
    { provider: 'gemini', auth_index: '3' },
  ] });
  assert.deepEqual(result.map((item) => item.auth_index), ['2', '5', '1', '4']);
});

test('同邮箱的不同 auth_index 不会合并', () => {
  const result = selectQuotaAccounts({ files: [
    { provider: 'codex', auth_index: '1', email: 'same@example.com' },
    { provider: 'codex', auth_index: '2', email: 'same@example.com' },
  ] });
  assert.deepEqual(result.map((item) => item.auth_index), ['1', '2']);
});

test('异常账号响应不能被当作空列表，合法空列表仍可返回', () => {
  for (const payload of [null, {}, { files: null }, { files: {} }]) {
    assert.throws(() => selectQuotaAccounts(payload), /账号列表响应格式无效/);
  }
  assert.deepEqual(selectQuotaAccounts({ files: [] }), []);
});

test('凭证状态切换同时使用文件名和 auth_index', () => {
  assert.deepEqual(
    buildStatusToggleRequest({ name: 'codex-user.json', auth_index: 'index-1', disabled: false }),
    { name: 'codex-user.json', auth_index: 'index-1', disabled: true },
  );
  assert.deepEqual(
    buildStatusToggleRequest({ name: 'codex-user.json', auth_index: 'index-1', disabled: true }),
    { name: 'codex-user.json', auth_index: 'index-1', disabled: false },
  );
  assert.throws(() => buildStatusToggleRequest({ auth_index: 'index-1' }), /文件名/);
});

test('账号列表固定每页 30 个并校正页码', () => {
  const accounts = Array.from({ length: 65 }, (_, index) => ({ auth_index: String(index + 1) }));
  const second = accountPage(accounts, 2);
  assert.equal(second.items.length, 30);
  assert.equal(second.items[0].auth_index, '31');
  assert.equal(second.totalPages, 3);
  const overflow = accountPage(accounts, 9);
  assert.equal(overflow.page, 3);
  assert.equal(overflow.items.length, 5);
});

test('额度颜色阈值与 CPA 原生前端一致', () => {
  assert.equal(quotaTone(70), 'high');
  assert.equal(quotaTone(69), 'medium');
  assert.equal(quotaTone(30), 'medium');
  assert.equal(quotaTone(29), 'low');
});

test('账号错误与健康状态按 CPA 字段判断', () => {
  assert.deepEqual(accountStatus({ quota: {}, status_message: 'healthy' }), { kind: 'waiting', label: '等待额度', message: '' });
  assert.deepEqual(accountStatus({ quota: { observed_at: '2026-09-01T00:00:00Z' }, status_message: 'ok' }), { kind: 'normal', label: '正常', message: '' });
  assert.deepEqual(accountStatus({ unavailable: true }), { kind: 'error', label: '异常', message: 'CPA 未提供异常说明' });
  assert.equal(accountStatus({ status_message: 'unauthorized' }).message, 'unauthorized');
});

test('GO 与 FREE 使用相同中性徽章', () => {
  assert.equal(planInfo('go').tone, 'neutral');
  assert.equal(planInfo('free').tone, 'neutral');
  assert.equal(planInfo('plus').tone, 'plus');
  assert.equal(planInfo('chatgpt-pro').tone, 'pro');
  assert.equal(planInfo('team').tone, 'team');
});

test('从 CPA 解码后的 id_token 读取套餐到期时间', () => {
  assert.equal(accountSubscriptionActiveUntil({
    id_token: { chatgpt_subscription_active_until: 1788711000 },
  }), 1788711000);
  assert.equal(accountSubscriptionActiveUntil({ id_token: {} }), null);
  assert.equal(formatUTC8DateTime('2026-09-07T00:10:00Z'), '2026-09-07 08:10');
  assert.equal(formatUTC8DateTime(1788711000), '2026-09-07 00:10');
  assert.equal(formatUTC8DateTime(0), '');
  assert.equal(formatUTC8DateTime('invalid'), '');
});

test('停用快照保留套餐到期、额度和主动重置次数', () => {
  const quota = {
    planType: 'pro',
    resetCreditsAvailableCount: 2,
    windows: [],
  };
  assert.deepEqual(buildQuotaSnapshot({
    id_token: { chatgpt_subscription_active_until: 1788711000 },
  }, quota), {
    ...quota,
    subscriptionActiveUntil: 1788711000,
  });
});

test('套餐到期相对时间按天、小时和分钟显示', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  assert.equal(formatRelativeDateTime('2026-09-03T12:00:00Z', now), '2天后');
  assert.equal(formatRelativeDateTime('2026-09-01T05:59:00Z', now), '5小时后');
  assert.equal(formatRelativeDateTime(now + 45 * 60 * 1000, now), '45分钟后');
  assert.equal(formatRelativeDateTime('2026-08-31T23:45:00Z', now), '15分钟前');
  assert.equal(formatRelativeDateTime(null, now), '');
});

test('套餐到期颜色区分正常、临期和过期', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  assert.equal(dateTimeTone('2026-09-03T00:00:01Z', now), 'valid');
  assert.equal(dateTimeTone('2026-09-02T00:00:00Z', now), 'soon');
  assert.equal(dateTimeTone('2026-08-31T23:59:59Z', now), 'expired');
  assert.equal(dateTimeTone(null, now), '');
});

test('解析被动额度和动态额度窗口', () => {
  const quota = parsePassiveQuota({ quota: {
    observed_at: '2026-09-01T00:00:00Z',
    signals: {
      'X-Codex-Primary-Used-Percent': '22',
      'X-Codex-Primary-Window-Minutes': '300',
      'X-Codex-Primary-Reset-At': '1788224400',
      'X-Codex-Code-Review-Primary-Used-Percent': '9',
      'X-Codex-Code-Review-Primary-Window-Minutes': '300',
      'X-Codex-Additional-Spark-Primary-Used-Percent': '25',
      'X-Codex-Additional-Spark-Primary-Window-Minutes': '60',
      'X-Codex-Additional-Spark-Primary-Limit-Name': 'GPT Spark',
      'X-Codex-Credits-Balance': '42',
    },
  } });
  assert.equal(quota.windows.length, 3);
  assert.equal(quota.windows[0].label, '5 小时窗口');
  assert.equal(quota.windows[0].remaining, 78);
  assert.match(quota.windows[1].label, /Code Review/);
  assert.match(quota.windows[2].label, /GPT Spark/);
});

test('停用账号保留主动额度直到启用后出现新被动快照', () => {
  const active = { quota: { observedAt: '2026-09-01T00:00:00Z' } };
  const changedQuota = { observed_at: '2026-09-02T00:00:00Z', signals: { 'X-Codex-Primary-Used-Percent': '20' } };
  assert.equal(shouldInvalidateActiveQuota({ disabled: true, quota: changedQuota }, active), false);
  assert.equal(shouldInvalidateActiveQuota({ disabled: false, quota: changedQuota }, active), true);
  assert.equal(shouldInvalidateActiveQuota(null, active), true);
});

test('解析主动额度 snake_case 响应', () => {
  const quota = parseActiveQuota({
    plan_type: 'pro',
    rate_limit: {
      primary_window: { used_percent: 11, limit_window_seconds: 18000, reset_at: 1788224400 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 60 },
    },
    code_review_rate_limit: {
      primary_window: { used_percent: 2, limit_window_seconds: 18000, reset_at: 1788224400 },
    },
    additional_rate_limits: [{
      limit_name: 'GPT Spark',
      rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 3600, reset_at: 1788224400 } },
    }],
    rate_limit_reset_credits: { available_count: 2 },
  });
  assert.equal(quota.planType, 'pro');
  assert.equal(quota.windows.length, 4);
  assert.equal(quota.windows[0].remaining, 89);
  assert.equal(quota.resetCreditsAvailableCount, 2);
});

test('解析主动重置次数及可用明细回退', () => {
  assert.equal(parseResetCreditsAvailableCount({ availableCount: '3' }), 3);
  assert.equal(parseResetCreditsAvailableCount({ credits: [
    { reset_type: 'codex_rate_limits', status: 'available' },
    { resetType: 'codex_rate_limits', status: 'used' },
  ] }), 1);
  assert.equal(parseResetCreditsAvailableCount({}), null);
});

test('缺失或越界百分比明确标为无效', () => {
  const missing = parseActiveQuota({ rateLimit: { primaryWindow: { limitWindowSeconds: 18000, resetAt: 1788224400 } } });
  const overflow = parseActiveQuota({ rateLimit: { primaryWindow: { usedPercent: 120, limitWindowSeconds: 18000, resetAt: 1788224400 } } });
  assert.equal(missing.windows[0].invalidPercent, true);
  assert.equal(overflow.windows[0].invalidPercent, true);
});

test('UA 优先级与空值继承语义', () => {
  const cpa = { 'codex-header-defaults': { 'user-agent': 'cpa-ua' } };
  assert.deepEqual(resolveRefreshUserAgent({ refresh_user_agent: 'plugin-ua' }, cpa), { value: 'plugin-ua', source: '插件设置' });
  assert.deepEqual(resolveRefreshUserAgent({ refresh_user_agent: '' }, cpa), { value: 'cpa-ua', source: 'CPA 配置' });
  assert.throws(() => validateUserAgent('bad\r\nvalue'), /控制字符/);
});

test('构造固定的主动刷新请求', () => {
  const request = buildRefreshRequest({ auth_index: '8', id_token: { chatgpt_account_id: 'account-1' } }, 'test-ua');
  assert.equal(request.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(request.header.Authorization, 'Bearer $TOKEN$');
  assert.equal(request.header['Chatgpt-Account-Id'], 'account-1');
  assert.equal(request.header['User-Agent'], 'test-ua');
});

test('Claude 一个版本号生成额度和资料 UA，留空恢复默认版本', () => {
  const config = { refresh_user_agent: 'codex-custom', claude_client_version: ' 2.1.311 ' };
  assert.deepEqual(resolveClaudeUserAgents(config), {
    version: '2.1.311', usage: 'claude-cli/2.1.311 (external, cli)',
    profile: 'claude-code/2.1.311', source: '插件设置',
  });
  assert.deepEqual(resolveClaudeUserAgents({ claude_client_version: ' ' }), {
    version: '2.1.295', usage: 'claude-cli/2.1.295 (external, cli)',
    profile: 'claude-code/2.1.295', source: '内置默认值',
  });
  assert.equal(resolveRefreshUserAgent(config, {}).value, 'codex-custom');
});

test('Claude 版本设置拒绝完整 UA 和不完整版本号', () => {
  assert.throws(() => resolveClaudeUserAgents({ claude_client_version: 'claude-cli/2.1.311 (external, cli)' }), /版本号格式/);
  assert.throws(() => resolveClaudeUserAgents({ claude_client_version: '2.1' }), /版本号格式/);
});

test('Claude 资料缺失、无成功时间或已满 24 小时才需要重新获取', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const profile = { planType: 'Pro' };
  assert.equal(shouldRefreshClaudeProfile(undefined, now, now), true);
  assert.equal(shouldRefreshClaudeProfile(profile, undefined, now), true);
  assert.equal(shouldRefreshClaudeProfile(profile, now - day + 1, now), false);
  assert.equal(shouldRefreshClaudeProfile(profile, now - day, now), true);
});

test('同索引账号邮箱变化时清除旧缓存，邮箱大小写和首尾空格不影响身份', () => {
  const cached = { accountEmail: 'old@example.com', quota: { windows: [] }, profile: { planType: 'Pro' } };
  assert.equal(shouldInvalidateAccountCache({ email: 'new@example.com' }, cached), true);
  assert.equal(shouldInvalidateAccountCache({ email: ' OLD@example.com ' }, cached), false);
  assert.equal(shouldInvalidateAccountCache({ email: 'new@example.com' }, undefined), false);
  assert.equal(shouldInvalidateAccountCache({ email: 'new@example.com' }, { profile: cached.profile }), true);
  assert.equal(shouldInvalidateAccountCache({}, { quota: cached.quota }), false);
});

test('Claude 主动刷新使用 OAuth usage 与专属请求头', () => {
  const agents = resolveClaudeUserAgents({ claude_client_version: '2.1.311' });
  const request = buildRefreshRequest({ type: 'claude', auth_index: '9' }, agents.usage);
  assert.equal(request.url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(request.header.Authorization, 'Bearer $TOKEN$');
  assert.equal(request.header.Accept, 'application/json, text/plain, */*');
  assert.equal(request.header['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(request.header['User-Agent'], 'claude-cli/2.1.311 (external, cli)');
  assert.equal(request.header['Chatgpt-Account-Id'], undefined);
  assert.throws(() => buildRefreshRequest({ type: 'claude', auth_index: '9' }, 'bad\r\nua'), /控制字符/);
});

test('Claude 资料请求复用凭证索引和独立 UA，无需凭证自带套餐字段', () => {
  const defaults = resolveClaudeUserAgents({});
  const defaultRequest = buildClaudeProfileRequest({ type: 'claude', auth_index: '9' }, defaults.profile);
  assert.equal(defaultRequest.header['User-Agent'], 'claude-code/2.1.295');
  const agents = resolveClaudeUserAgents({ claude_client_version: '2.1.311' });
  const request = buildClaudeProfileRequest({ type: 'claude', auth_index: '9' }, agents.profile);
  assert.equal(request.url, 'https://api.anthropic.com/api/oauth/profile');
  assert.equal(request.header.Authorization, 'Bearer $TOKEN$');
  assert.equal(request.header.Accept, 'application/json, text/plain, */*');
  assert.equal(request.header['User-Agent'], 'claude-code/2.1.311');
  assert.equal(request.header['anthropic-beta'], undefined);
  assert.equal(request.header['Cache-Control'], 'no-cache');
});

test('Claude 资料区分 Max 倍数，并读取真实订阅开通时间和状态', () => {
  for (const [tier, label] of [['default_claude_max_5x', 'Max 5x'], ['default_claude_max_20x', 'Max 20x']]) {
    const result = parseClaudeProfile({ account: { has_claude_max: true }, organization: {
      rate_limit_tier: tier, subscription_created_at: '2026-09-13T00:00:00Z', subscription_status: 'active',
    } });
    assert.equal(result.planType, label);
    assert.equal(result.subscriptionCreatedAt, Date.parse('2026-09-13T00:00:00Z'));
    assert.equal(result.subscriptionStatus, 'active');
    assert.equal(result.subscriptionActiveUntil, undefined);
    assert.equal(planInfo(result.planType).tone, 'pro');
  }
});

test('Claude Team 组织优先于个人套餐，缺少资料不能误显示 Free', () => {
  assert.equal(parseClaudeProfile({ account: { has_claude_max: true }, organization: {
    organization_type: 'claude_team', subscription_status: 'active',
  } }).planType, 'Team');
  assert.equal(parseClaudeProfile({ account: { has_claude_pro: true }, organization: {} }).planType, 'Pro');
  assert.equal(parseClaudeProfile({ account: { has_claude_pro: false, has_claude_max: false }, organization: {} }).planType, 'Free');
  assert.equal(parseClaudeProfile({ account: { has_claude_pro: false, has_claude_max: false }, organization: {
    organization_type: 'claude_enterprise',
  } }).planType, '');
  assert.equal(parseClaudeProfile({ account: {}, organization: {} }).planType, '');
  assert.throws(() => parseClaudeProfile({ error: 'unauthorized' }), /资料响应格式无效/);
});

test('停用快照不丢失已查询的 Claude 资料', () => {
  const quota = { ...parseClaudeProfile({ account: { has_claude_max: true }, organization: {
    subscription_created_at: '2026-09-13T00:00:00Z',
  } }), windows: [] };
  assert.equal(buildQuotaSnapshot({ type: 'claude' }, quota).subscriptionCreatedAt, quota.subscriptionCreatedAt);
});

test('Claude 主动百分比、模型窗口与 ISO 重置时间', () => {
  const quota = parseActiveQuota({
    five_hour: { utilization: 12, resets_at: '2026-10-05T12:00:00Z' },
    seven_day: { utilization: 53, resets_at: null },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 0, resets_at: null },
    extra_usage: { is_enabled: true, utilization: 20 },
  }, 'claude');
  assert.deepEqual(quota.windows.map((window) => window.remaining), [88, 47, 100, 80]);
  assert.equal(quota.windows[0].resetAt, Date.parse('2026-10-05T12:00:00Z'));
  assert.equal(quota.windows[1].resetAt, null);
  assert.equal(quota.resetCreditsAvailableCount, undefined);
});

test('Claude Fable 模型窗口优先使用已启用的 limits 数据', () => {
  const quota = parseActiveQuota({
    iguana_necktie: { utilization: 10 },
    limits: [
      { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable 5' } }, percent: 20 },
      { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable 5' } }, percent: 30, is_active: true },
    ],
  }, 'claude');
  assert.equal(quota.windows.length, 1);
  assert.equal(quota.windows[0].remaining, 70);
});

test('Claude 新版通用周额度、Fable 和带金额的云端会话额度分别解析', () => {
  const quota = parseActiveQuota({
    five_hour: null,
    seven_day: null,
    limits: [
      { kind: 'session', percent: 7, is_active: true, scope: null },
      { kind: 'weekly_all', percent: 6, is_active: false, scope: null },
      { kind: 'weekly_all', percent: 26, is_active: true, scope: null },
      { kind: 'weekly_scoped', percent: 42, is_active: true,
        scope: { model: { display_name: 'Fable' } }, resets_at: '2026-10-30T01:59:00Z' },
    ],
    iguana_necktie: { utilization: 5, limit_dollars: 100, used_dollars: 5, remaining_dollars: 95,
      resets_at: '2026-11-05T07:59:00Z' },
  }, 'claude');
  assert.deepEqual(quota.windows.map(({ key, label, remaining }) => ({ key, label, remaining })), [
    { key: 'five_hour', label: '5 小时窗口', remaining: 93 },
    { key: 'seven_day', label: '7 天窗口', remaining: 74 },
    { key: 'seven_day_fable', label: 'Fable 5 · 7 天窗口', remaining: 58 },
    { key: 'cloud_session_credits', label: '云端会话额度', remaining: 95 },
  ]);
  assert.equal(quota.windows[2].resetAt, Date.parse('2026-10-30T01:59:00Z'));
  assert.equal(quota.windows[3].resetAt, Date.parse('2026-11-05T07:59:00Z'));
});

test('Claude 顶层通用窗口与 limits 重复时只显示一次，金额字段不冒充 Fable', () => {
  const quota = parseActiveQuota({
    five_hour: { utilization: 10 }, seven_day: { utilization: 20 },
    limits: [{ kind: 'session', percent: 10 }, { kind: 'weekly_all', percent: 20 }],
    iguana_necktie: { utilization: 5, remaining_dollars: 95 },
  }, 'claude');
  assert.deepEqual(quota.windows.map((window) => window.key), ['five_hour', 'seven_day', 'cloud_session_credits']);
  assert.equal(quota.windows.some((window) => window.label.includes('Fable')), false);
});

test('Claude 旧版 Fable 字段和被动 7d_oi 对应同一个独立窗口', () => {
  for (const key of ['seven_day_overage_included', 'iguana_necktie']) {
    const quota = parseActiveQuota({ [key]: { utilization: 35 } }, 'claude');
    assert.equal(quota.windows[0].key, 'seven_day_fable');
    assert.equal(quota.windows[0].remaining, 65);
  }
  const quota = parsePassiveQuota({ provider: 'claude', quota: { signals: {
    'Anthropic-Ratelimit-Unified-7d-Utilization': '0.2',
    'Anthropic-Ratelimit-Unified-7d_oi-Utilization': '0.35',
  } } });
  assert.deepEqual(quota.windows.map((window) => window.key), ['seven_day', 'seven_day_fable']);
  assert.equal(quota.windows[1].label, 'Fable 5 · 7 天窗口');
});

test('Claude 部分被动快照只更新有效窗口，保留其余额度及原始采集时间', () => {
  const cached = parseActiveQuota({
    five_hour: { utilization: 10 }, seven_day: { utilization: 20, resets_at: '2026-10-30T01:59:00Z' },
    iguana_necktie: { utilization: 30 },
  }, 'claude');
  cached.observedAt = '2026-10-26T01:00:00Z';
  const account = { provider: 'claude', quota: { observed_at: '2026-10-26T02:00:00Z', signals: {
    'Anthropic-Ratelimit-Unified-5h-Utilization': '0.21',
    'Anthropic-Ratelimit-Unified-7d-Utilization': 'invalid',
  } } };
  assert.equal(shouldInvalidateActiveQuota(account, { quota: cached }), true);
  const merged = mergePassiveQuota(account, cached);
  assert.deepEqual(merged.windows.map((window) => window.remaining), [79, 80, 70]);
  assert.equal(merged.observedAt, account.quota.observed_at);
  assert.equal(merged.windows[0].observedAt, undefined);
  assert.equal(merged.windows[1].observedAt, cached.observedAt);
  assert.equal(merged.windows[1].resetAt, cached.windows[1].resetAt);
  assert.equal(merged.windows[2].observedAt, cached.observedAt);
  assert.equal(cached.windows[0].remaining, 90);

  const reloaded = JSON.parse(JSON.stringify(merged));
  const next = mergePassiveQuota({ provider: 'claude', quota: { observed_at: '2026-10-26T03:00:00Z', signals: {
    'Anthropic-Ratelimit-Unified-7d_oi-Utilization': '0.4',
  } } }, reloaded);
  assert.deepEqual(next.windows.map((window) => window.remaining), [79, 80, 60]);
  assert.equal(next.windows[0].observedAt, account.quota.observed_at);
  assert.equal(next.windows[1].observedAt, cached.observedAt);
  assert.equal(next.windows[2].observedAt, undefined);
});

test('Claude 部分主动结果保留通用周额度及原始采集时间，完整结果更新全部窗口', () => {
  const cached = parseActiveQuota({
    five_hour: { utilization: 10 },
    seven_day: { utilization: 20, resets_at: '2026-10-30T01:59:00Z' },
    seven_day_overage_included: { utilization: 30 },
  }, 'claude');
  cached.observedAt = '2026-10-26T01:00:00Z';
  const partial = parseActiveQuota({
    five_hour: { utilization: 0 },
    seven_day: null,
    seven_day_overage_included: { utilization: 8 },
  }, 'claude');
  partial.observedAt = '2026-10-26T02:00:00Z';
  const merged = mergeClaudeQuota(partial, cached);
  assert.deepEqual(merged.windows.map((window) => window.key), ['five_hour', 'seven_day', 'seven_day_fable']);
  assert.deepEqual(merged.windows.map((window) => window.remaining), [100, 80, 92]);
  assert.equal(merged.observedAt, partial.observedAt);
  assert.equal(merged.windows[0].observedAt, undefined);
  assert.equal(merged.windows[1].observedAt, cached.observedAt);
  assert.equal(merged.windows[1].resetAt, cached.windows[1].resetAt);
  assert.equal(merged.windows[2].observedAt, undefined);

  const reloaded = JSON.parse(JSON.stringify(merged));
  const repeated = mergeClaudeQuota(partial, reloaded);
  assert.equal(repeated.windows[1].observedAt, cached.observedAt);
  const complete = parseActiveQuota({
    five_hour: { utilization: 15 }, seven_day: { utilization: 25 },
    seven_day_overage_included: { utilization: 35 },
  }, 'claude');
  const updated = mergeClaudeQuota(complete, repeated);
  assert.deepEqual(updated.windows.map((window) => window.remaining), [85, 75, 65]);
  assert.equal(updated.windows.some((window) => window.observedAt), false);
  assert.equal(cached.windows[0].remaining, 90);
});

test('Claude 首次主动刷新保留当前被动周额度，无效主动数值不覆盖有效额度', () => {
  const passive = parsePassiveQuota({ provider: 'claude', quota: {
    observed_at: '2026-10-26T01:00:00Z', signals: {
      'Anthropic-Ratelimit-Unified-7d-Utilization': '0.2',
    },
  } });
  const active = parseActiveQuota({
    five_hour: { utilization: 0 }, seven_day: { utilization: null },
    seven_day_overage_included: { utilization: 8 },
  }, 'claude');
  const merged = mergeClaudeQuota(active, passive);
  const weekly = merged.windows.find((window) => window.key === 'seven_day');
  assert.equal(weekly.remaining, 80);
  assert.equal(weekly.observedAt, passive.observedAt);
  assert.deepEqual(mergeClaudeQuota(active, undefined), active);
});

test('Claude 较早的被动快照补齐缺失周窗口，同时保留较新的主动额度', () => {
  const cached = parseActiveQuota({
    five_hour: { utilization: 30 }, seven_day_overage_included: { utilization: 8 },
  }, 'claude');
  cached.observedAt = '2026-10-27T11:01:00Z';
  const account = { provider: 'claude', quota: { observed_at: '2026-10-27T11:00:00Z', signals: {
    'Anthropic-Ratelimit-Unified-5h-Utilization': '0.4',
    'Anthropic-Ratelimit-Unified-7d-Utilization': '0.13',
  } } };
  assert.equal(shouldInvalidateActiveQuota(account, { quota: cached }), true);
  const merged = mergePassiveQuota(account, cached);
  const windows = new Map(merged.windows.map((window) => [window.key, window]));
  assert.equal(windows.get('five_hour').remaining, 70);
  assert.equal(windows.get('five_hour').observedAt, cached.observedAt);
  assert.equal(windows.get('seven_day').remaining, 87);
  assert.equal(windows.get('seven_day_fable').remaining, 92);
  assert.equal(shouldInvalidateActiveQuota(account, { quota: merged }), false);
});

test('Claude 按窗口采集时间更新周额度，整卡较新的时间不阻挡旧窗口更新', () => {
  const cached = parseActiveQuota({ five_hour: { utilization: 30 } }, 'claude');
  cached.observedAt = '2026-10-27T11:02:00Z';
  cached.windows.push({ key: 'seven_day', label: '7 天窗口', remaining: 90,
    invalidPercent: false, observedAt: '2026-10-27T11:00:00Z' });
  const account = { provider: 'claude', quota: { observed_at: '2026-10-27T11:01:00Z', signals: {
    'Anthropic-Ratelimit-Unified-5h-Utilization': '0.4',
    'Anthropic-Ratelimit-Unified-7d-Utilization': '0.13',
  } } };
  assert.equal(shouldInvalidateActiveQuota(account, { quota: cached }), true);
  const merged = mergePassiveQuota(account, cached);
  assert.deepEqual(merged.windows.map((window) => window.remaining), [70, 87]);
  assert.equal(merged.windows[0].observedAt, cached.observedAt);
  assert.equal(merged.windows[1].observedAt, undefined);
  assert.equal(shouldInvalidateActiveQuota(account, { quota: merged }), false);
  assert.equal(shouldInvalidateActiveQuota({ ...account, disabled: true }, { quota: cached }), false);
});

test('Claude 已保存的旧窗口键与新被动窗口合并时不重复', () => {
  for (const fableKey of ['7d_oi', 'iguana_necktie']) {
    const cached = { observedAt: '2026-10-26T01:00:00Z', windows: [
      { key: '5h', label: '5 小时窗口', remaining: 90, invalidPercent: false },
      { key: '7d', label: '7 天窗口', remaining: 80, invalidPercent: false },
      { key: fableKey, label: '7 天窗口 · 含额外用量', remaining: 70, invalidPercent: false },
    ] };
    const merged = mergePassiveQuota({ provider: 'claude', quota: { observed_at: '2026-10-26T02:00:00Z', signals: {
      'Anthropic-Ratelimit-Unified-5h-Utilization': '0.2',
      'Anthropic-Ratelimit-Unified-7d_oi-Utilization': '0.4',
    } } }, cached);
    assert.deepEqual(merged.windows.map((window) => window.key), ['five_hour', 'seven_day', 'seven_day_fable']);
    assert.deepEqual(merged.windows.map((window) => window.remaining), [80, 80, 60]);
  }
});

test('Claude 被动 utilization 为比例，主动 utilization 为百分比', () => {
  const account = { provider: 'claude', quota: {
    observed_at: '2026-10-05T00:00:00Z',
    signals: {
      'Anthropic-Ratelimit-Unified-5h-Utilization': '0.12',
      'Anthropic-Ratelimit-Unified-5h-Reset': '1791201600',
      'Anthropic-Ratelimit-Unified-7d-Utilization': '0',
      'Anthropic-Ratelimit-Unified-Fallback-Percentage': '0.5',
    },
  } };
  const quota = parsePassiveQuota(account);
  assert.deepEqual(quota.windows.map((window) => window.remaining), [88, 100]);
  assert.equal(quota.windows[0].resetAt, 1791201600000);
  assert.equal(shouldInvalidateActiveQuota(account, undefined), true);
  assert.equal(shouldInvalidateActiveQuota(account, { quota }), false);
});

test('Claude 被动只有状态或无效用量时保留主动缓存', () => {
  const account = { provider: 'claude', quota: { observed_at: '2026-10-05T00:00:00Z', signals: {
    'Anthropic-Ratelimit-Unified-Status': 'allowed',
    'Anthropic-Ratelimit-Unified-5h-Utilization': '',
  } } };
  assert.equal(parsePassiveQuota(account).windows[0].invalidPercent, true);
  assert.equal(shouldInvalidateActiveQuota(account, { quota: { observedAt: '2026-10-04T00:00:00Z' } }), false);
  assert.equal(parseActiveQuota({ five_hour: { utilization: null } }, 'claude').windows[0].invalidPercent, true);
});

for (const [provider, signal, used] of [
  ['claude', 'Anthropic-Ratelimit-Unified-5h-Utilization', '0.2'],
  ['codex', 'X-Codex-Primary-Used-Percent', '20'],
]) {
  test(`${provider} 只有更新且有效的被动用量才能替换已保存额度`, () => {
    const account = { provider, quota: {
      observed_at: '2026-10-05T02:00:00Z', signals: { [signal]: used },
    } };
    const cached = { quota: { ...parsePassiveQuota(account), observedAt: '2026-10-05T01:00:00Z' } };
    assert.equal(shouldInvalidateActiveQuota(account, undefined), true);
    assert.equal(shouldInvalidateActiveQuota(account, cached), true);
    for (const observed_at of ['2026-10-05T00:00:00Z', cached.quota.observedAt]) {
      assert.equal(shouldInvalidateActiveQuota({ ...account, quota: { ...account.quota, observed_at } }, cached), false);
    }
    for (const signals of [{}, { 'Retry-After': '60' }, { [signal]: '-1' }, { [signal]: 'invalid' }]) {
      assert.equal(shouldInvalidateActiveQuota({ ...account, quota: { ...account.quota, signals } }, cached), false);
    }
    assert.equal(shouldInvalidateActiveQuota({ provider, quota: {} }, cached), false);
  });
}

test('Claude 真实超额用量显示剩余零，负数仍为无效', () => {
  const passive = parsePassiveQuota({ provider: 'claude', quota: { signals: {
    'Anthropic-Ratelimit-Unified-7d_oi-Utilization': '1.02',
  } } });
  assert.equal(passive.windows[0].remaining, 0);
  assert.equal(passive.windows[0].invalidPercent, false);
  const active = parseActiveQuota({
    seven_day: { utilization: 105 }, five_hour: { utilization: -1 },
  }, 'claude');
  assert.equal(active.windows[1].remaining, 0);
  assert.equal(active.windows[0].invalidPercent, true);
});

test('构造只读的主动重置次数请求', () => {
  const request = buildResetCreditsRequest({ auth_index: '8' }, 'test-ua');
  assert.equal(request.method, 'GET');
  assert.match(request.url, /rate-limit-reset-credits$/);
  assert.equal(request.header['OpenAI-Beta'], 'codex-1');
  assert.equal(request.header.Originator, 'Codex Desktop');
});

test('上游错误只提取安全错误字段', () => {
  assert.equal(safeUpstreamError({ status_code: 401, body: '{"error":{"message":"unauthorized"}}' }), '上游返回 401：unauthorized');
  assert.equal(safeUpstreamError({ status_code: 500, body: '<html>secret</html>' }), '上游返回 HTTP 500');
});

const source = readFileSync(new URL('../web/panel-app.mjs', import.meta.url), 'utf8');
const sessionCode = source.match(/^const SESSION_(?:KEY|PREFIX) = .+;$/gm).join('\n') + '\n' +
  source.slice(source.indexOf('function decodeBase64('), source.indexOf('async function managementFetch('));
const storedSession = 'enc::v2::GE4aWREGClpDVkMRGUQ1BBEQSwAYGxEXBQFfAlwXHxNPAh0dDgANS0sMBB4EQ0cCVggSGgILDEAVHBszHFRDSktZEhYWWAJfQ16B29iU86pRWE0ABAoAEQEVE34ECxIaHx4BDE4RAQEGEUUPBhcdCxBCD1JTHQo=';

function readSession(stored, userAgent = 'Chrome/test') {
  const location = new URL('https://cpa.example.test');
  return runInNewContext(sessionCode + '\nreadSession();', {
    localStorage: { getItem: () => stored },
    location,
    window: { location },
    navigator: { userAgent },
    atob,
    TextEncoder,
    TextDecoder,
    URL,
  });
}

test('读取 CPA v2 登录信息，浏览器 UA 变化后仍能读取', () => {
  for (const ua of ['Chrome/old', 'Chrome/new']) {
    const session = readSession(storedSession, ua);
    assert.equal(session.baseURL, 'https://cpa.example.test');
    assert.equal(session.managementKey, 'test-key-中文');
  }
});

test('登录数据格式无效时明确提示版本匹配问题', () => {
  assert.throws(() => readSession('enc::v1::retired'), /格式无效.*版本匹配/);
  assert.throws(() => readSession('{'), /格式无效.*版本匹配/);
});

test('未登录或未保存管理密钥时明确报错', () => {
  assert.throws(() => readSession(null), /登录/);
  assert.throws(() => readSession(JSON.stringify({ state: { apiBase: 'https://cpa.example.test' } })), /记住/);
});

test('拒绝向其他站点发送管理密钥', () => {
  const raw = JSON.stringify({ state: { apiBase: 'https://other.example.test', managementKey: 'test-key' } });
  assert.throws(() => readSession(raw), /不一致|同源/);
});
