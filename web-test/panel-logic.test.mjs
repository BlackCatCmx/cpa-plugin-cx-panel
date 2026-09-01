import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountStatus,
  buildRefreshRequest,
  parseActiveQuota,
  parsePassiveQuota,
  planInfo,
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

test('账号错误与健康状态按 CPA 字段判断', () => {
  assert.deepEqual(accountStatus({ quota: {}, status_message: 'healthy' }), { kind: 'waiting', label: '等待额度', message: '' });
  assert.deepEqual(accountStatus({ quota: { observed_at: '2026-09-01T00:00:00Z' }, status_message: 'ok' }), { kind: 'normal', label: '正常', message: '' });
  assert.deepEqual(accountStatus({ unavailable: true }), { kind: 'error', label: '不可用', message: '凭证不可用，CPA 未提供状态说明' });
  assert.equal(accountStatus({ status_message: 'unauthorized' }).message, 'unauthorized');
});

test('GO 与 FREE 使用相同中性徽章', () => {
  assert.equal(planInfo('go').tone, 'neutral');
  assert.equal(planInfo('free').tone, 'neutral');
  assert.equal(planInfo('plus').tone, 'plus');
  assert.equal(planInfo('chatgpt-pro').tone, 'pro');
  assert.equal(planInfo('team').tone, 'team');
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
  });
  assert.equal(quota.planType, 'pro');
  assert.equal(quota.windows.length, 4);
  assert.equal(quota.windows[0].remaining, 89);
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

test('上游错误只提取安全错误字段', () => {
  assert.equal(safeUpstreamError({ status_code: 401, body: '{"error":{"message":"unauthorized"}}' }), '上游返回 401：unauthorized');
  assert.equal(safeUpstreamError({ status_code: 500, body: '<html>secret</html>' }), '上游返回 HTTP 500');
});
