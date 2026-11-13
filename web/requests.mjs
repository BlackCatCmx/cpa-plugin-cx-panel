const dialog = document.querySelector('#request-dialog');
const rows = document.querySelector('#request-rows');
const message = document.querySelector('#request-message');
const title = document.querySelector('#request-title');
const mismatch = document.querySelector('#request-mismatch');
const session = document.querySelector('#request-session');
const older = document.querySelector('#request-older');
const refresh = document.querySelector('#request-refresh');
let current = null;
let records = [];
let next = '';
let controller = null;
let pageBefore = '';
let recordingEnabled = false;

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function modelNameDiffers(record) {
  return Boolean(record.ResponseModel?.trim()) && record.Model?.trim().toLowerCase() !== record.ResponseModel.trim().toLowerCase();
}

function renderRecords() {
  rows.replaceChildren();
  if (!records.length) rows.append(node('div', 'request-empty', '暂无符合条件的请求记录'));
  for (const record of records) {
    const item = node('details', `request-item${modelNameDiffers(record) ? ' request-mismatch' : ''}`);
    const summary = node('summary', 'request-row');
    const time = new Date(record.RequestedAt);
    summary.append(node('span', 'request-time', time.toLocaleString('zh-CN', { hour12: false })));
    const model = node('span', 'request-model');
    model.append(node('strong', '', record.Model || '未知模型'));
    model.append(node('span', 'request-response', record.ResponseModel ? `↳ ${record.ResponseModel}` : '↳ 上游模型未知'));
    if (modelNameDiffers(record)) model.append(node('span', 'request-badge', '名称不一致'));
    summary.append(model);
    for (const key of ['CacheReadTokens', 'CacheCreationTokens']) {
      summary.append(node('span', 'request-tokens', Number(record.Detail?.[key] ?? 0).toLocaleString('zh-CN')));
    }
    summary.append(node('span', record.Failed ? 'request-failed' : 'request-ok', record.Failed ? `失败${record.StatusCode ? ` ${record.StatusCode}` : ''}` : '成功'));
    item.append(summary);
    const detail = node('div', 'request-detail');
    const values = [
      ['客户端别名', record.Alias || '—'], ['请求模型', record.Model || '—'],
      ['上游返回模型', record.ResponseModel || '未知'], ['输入 token', record.Detail?.InputTokens ?? 0],
      ['输出 token', record.Detail?.OutputTokens ?? 0], ['思考等级', record.ReasoningEffort || '—'],
      ['会话', record.SessionID || '未知'], ['请求 ID', record.RequestID], ['Trace ID', record.TraceID || '—'],
    ];
    for (const [label, value] of values) {
      const field = node('div', '');
      field.append(node('span', '', `${label}：`), node('code', '', String(value)));
      detail.append(field);
    }
    if (record.SessionID) {
      const filter = node('button', 'button', '只看此会话');
      filter.type = 'button';
      filter.addEventListener('click', () => { session.value = record.SessionID; load(); });
      detail.append(filter);
    }
    item.append(detail);
    rows.append(item);
  }
  older.hidden = !next;
}

async function load(before = '') {
  pageBefore = before;
  controller?.abort();
  const request = new AbortController();
  controller = request;
  message.textContent = '正在读取……';
  rows.replaceChildren();
  records = [];
  next = '';
  older.hidden = true;
  const query = new URLSearchParams({ auth: String(current.account.auth_index), mismatch: mismatch.checked ? '1' : '0', session: session.value.trim(), before });
  try {
    const body = await current.managementFetch(`/plugins/cpa-plugin-cx-panel/requests?${query}`, { signal: request.signal });
    if (request !== controller || !dialog.open) return;
    records = body.records;
    recordingEnabled = body.enabled;
    next = body.next;
    message.textContent = body.write_error ? `日志写入失败：${body.write_error}` : `${body.enabled ? '记录中' : '记录已关闭'} · 本页 ${records.length} 条 · 按记录写入顺序倒序`;
    if (body.skipped) message.textContent += ` · 读取时跳过 ${body.skipped} 条损坏记录`;
    message.classList.toggle('request-failed', Boolean(body.write_error || body.skipped));
    renderRecords();
  } catch (error) {
    if (request !== controller || error.name === 'AbortError') return;
    message.textContent = `读取失败：${error.message}`;
    message.classList.add('request-failed');
  }
}

export function requestHistoryButton(account, managementFetch) {
  const button = node('button', 'request-history', '查看请求与缓存 →');
  button.type = 'button';
  button.addEventListener('click', () => {
    current = { account, managementFetch };
    title.textContent = `Claude 请求 · ${account.email || account.name || account.auth_index}`;
    mismatch.checked = false;
    session.value = '';
    dialog.showModal();
    load();
  });
  return button;
}

document.querySelector('#request-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { controller?.abort(); controller = null; records = []; rows.replaceChildren(); });
mismatch.addEventListener('change', () => load());
session.addEventListener('change', () => load());
refresh.addEventListener('click', () => load());
older.addEventListener('click', () => load(next));
document.querySelector('#request-export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob(records.map((record) => `${JSON.stringify(record)}\n`), { type: 'application/x-ndjson' }));
  const link = node('a', '');
  link.href = url;
  link.download = 'claude-requests.jsonl';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
setInterval(() => { if (dialog.open && recordingEnabled && !document.hidden && !pageBefore && !rows.querySelector('details[open]')) load(); }, 30_000);
