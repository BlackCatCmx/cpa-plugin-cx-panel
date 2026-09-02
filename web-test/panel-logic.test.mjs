import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountPage,
  accountSubscriptionActiveUntil,
  accountStatus,
  buildRefreshRequest,
  buildResetCreditsRequest,
  dateTimeTone,
  formatRelativeDateTime,
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
} from '../web/panel-logic.mjs';

test('只选择带 auth_index 的 Codex 账号', () => {
  const result = selectCodexAccounts({ files: [
    { provider: 'codex', auth_index: '1' },
    { type: 'claude', auth_index: '2' },
    { provider: 'codex' },
  ] });
  assert.equal(result.length, 1);
});

test('同邮箱的不同 auth_index 不会合并', () => {
  const result = selectCodexAccounts({ files: [
    { provider: 'codex', auth_index: '1', email: 'same@example.com' },
    { provider: 'codex', auth_index: '2', email: 'same@example.com' },
  ] });
  assert.deepEqual(result.map((item) => item.auth_index), ['1', '2']);
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
