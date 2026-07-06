import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { MiniAgent } from './agent.ts';
import { FileNotionAdapter } from './notion.ts';
import { html as pageHtml } from './page.ts';

const port = Number(process.env.PORT ?? 3000);
const notion = new FileNotionAdapter(resolve('data/notion-store.json'));
await notion.load();
const agent = new MiniAgent(notion);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

    if (request.method === 'GET' && url.pathname === '/') {
      return send(response, 200, pageHtml(), 'text/html; charset=utf-8');
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      return json(response, 200, state());
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json(response, 200, health());
    }

    if (request.method === 'POST' && url.pathname === '/api/message') {
      const body = await readJson(request);
      const text = String(body.text ?? '').trim();
      if (!text) return json(response, 400, { error: 'text is required' });
      const result = await agent.handleMessage({
        idempotencyKey: String(body.idempotencyKey ?? `admin-${Date.now()}-${Math.random()}`),
        text,
        source: 'admin'
      });
      return json(response, 200, { ...result, state: state() });
    }

    if (request.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readJson(request);
      await notion.saveSettings({
        llm: {
          provider_name: String(body.provider_name ?? notion.settings.llm.provider_name),
          base_url: String(body.base_url ?? notion.settings.llm.base_url),
          model: String(body.model ?? notion.settings.llm.model),
          temperature: Number(body.temperature ?? notion.settings.llm.temperature),
          supports_response_format: boolValue(body.supports_response_format, notion.settings.llm.supports_response_format),
          enabled: boolValue(body.llm_enabled, notion.settings.llm.enabled),
          api_key_set: Boolean(body.api_key) || notion.settings.llm.api_key_set
        },
        notion: {
          token_set: Boolean(body.notion_token) || notion.settings.notion.token_set,
          databases: {
            tasks: String(body.tasks_database_id ?? ''),
            bookmarks: String(body.bookmarks_database_id ?? ''),
            subscriptions: String(body.subscriptions_database_id ?? ''),
            reminders: String(body.reminders_database_id ?? '')
          }
        }
      });
      return json(response, 200, state());
    }

    if (request.method === 'POST' && url.pathname === '/api/gateway/settings') {
      const body = await readJson(request);
      await notion.saveSettings({
        gateway: {
          url: String(body.url ?? notion.settings.gateway.url),
          instance_id: String(body.instance_id ?? notion.settings.gateway.instance_id),
          relay_status: body.relay_status === 'connected' || body.relay_status === 'offline' ? body.relay_status : 'local'
        },
        wechat: {
          service_account_name: String(body.service_account_name ?? notion.settings.wechat.service_account_name)
        }
      });
      return json(response, 200, state());
    }

    if (request.method === 'POST' && url.pathname === '/api/components') {
      const body = await readJson(request);
      await notion.saveSettings({ components: normalizeComponents(body.components) });
      return json(response, 200, state());
    }

    if (request.method === 'POST' && url.pathname === '/api/security') {
      const body = await readJson(request);
      await notion.saveSettings({
        security: {
          mask_secrets: boolValue(body.mask_secrets, notion.settings.security.mask_secrets),
          debug_logging: boolValue(body.debug_logging, notion.settings.security.debug_logging)
        }
      });
      return json(response, 200, state());
    }

    if (request.method === 'POST' && url.pathname === '/api/auth-code') {
      return json(response, 200, await notion.createAuthCode());
    }

    if (request.method === 'POST' && url.pathname === '/api/binding/login') {
      const body = await readJson(request);
      const binding = await notion.bindOpenid(String(body.code ?? ''), String(body.openid ?? 'local-openid'));
      return json(response, 200, { binding, state: state() });
    }

    if (request.method === 'POST' && url.pathname === '/api/binding/unbind') {
      return json(response, 200, { ok: await notion.unbindActiveBinding(), state: state() });
    }

    if (request.method === 'POST' && url.pathname === '/api/gateway/test') {
      return json(response, 200, {
        ok: true,
        mode: 'local-demo',
        message: 'V0 本地 Demo 未连接真实微信 Gateway，手动消息入口可用。'
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/notion/check-template') {
      return json(response, 200, notion.validateTemplates());
    }

    if (request.method === 'POST' && url.pathname === '/api/llm/test') {
      return json(response, 200, {
        ok: notion.settings.llm.enabled,
        mode: notion.settings.llm.model,
        message: notion.settings.llm.enabled ? '本地规则解析可用。' : 'LLM 已停用。'
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/retry') {
      const body = await readJson(request);
      const job = notion.findRetryJob(String(body.id ?? ''));
      if (!job) return json(response, 404, { error: 'retry job not found' });
      if (job.status !== 'failed') return json(response, 409, { error: 'retry job is not failed' });
      const result = await agent.handleMessage({
        idempotencyKey: job.idempotency_key,
        text: job.raw_input,
        source: job.source
      });
      if (!result.reply.startsWith('写入失败')) {
        await notion.markRetryJobRetried(job.id);
      }
      return json(response, 200, { ...result, state: state() });
    }

    if (request.method === 'POST' && url.pathname === '/api/task/status') {
      const body = await readJson(request);
      const record = await notion.update_task_status(String(body.id ?? ''), taskStatus(String(body.status ?? 'todo')));
      return record ? json(response, 200, state()) : json(response, 404, { error: 'task not found' });
    }

    if (request.method === 'POST' && url.pathname === '/api/subscription/status') {
      const body = await readJson(request);
      const record = await notion.update_subscription_status(String(body.id ?? ''), subscriptionStatus(String(body.status ?? 'active')));
      return record ? json(response, 200, state()) : json(response, 404, { error: 'subscription not found' });
    }

    if (request.method === 'POST' && url.pathname === '/api/reminder/status') {
      const body = await readJson(request);
      const record = await notion.update_reminder_status(String(body.id ?? ''), reminderStatus(String(body.status ?? 'pending')));
      return record ? json(response, 200, state()) : json(response, 404, { error: 'reminder not found' });
    }

    return json(response, 404, { error: 'not found' });
  } catch (error) {
    return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, () => {
  console.log(`WeChat + Notion Mini Agent V0: http://localhost:${port}`);
});

function state(): object {
  const today = new Date().toISOString().slice(0, 10);
  return {
    records: notion.records,
    messageLogs: notion.messageLogs,
    retryJobs: notion.retryJobs,
    binding: notion.activeBinding(),
    settings: notion.settings,
    templateCheck: notion.validateTemplates(),
    health: health(),
    stats: {
      todayMessages: notion.messageLogs.filter((log) => log.created_at.startsWith(today)).length,
      failedJobs: notion.retryJobs.filter((job) => job.status === 'failed').length,
      pendingReminders: notion.records.reminders.filter((item) => item.status === 'pending').length
    }
  };
}

function health(): object {
  const templateCheck = notion.validateTemplates();
  return {
    gateway: { status: 'local', label: '本地手动入口' },
    relay: { status: 'local', label: 'V0 不连接 WebSocket Relay' },
    notion: { status: templateCheck.status, label: templateCheck.status === 'ok' ? '固定模板可写入' : '模板缺配置' },
    llm: { status: notion.settings.llm.enabled ? 'ok' : 'off', label: notion.settings.llm.enabled ? '本地规则解析可用' : 'LLM 已停用' }
  };
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return Boolean(value);
}

function normalizeComponents(value: unknown): typeof notion.settings.components {
  const next = { ...notion.settings.components };
  if (value && typeof value === 'object') {
    for (const key of ['tasks', 'bookmarks', 'subscriptions', 'reminders'] as const) {
      const item = (value as Record<string, { enabled?: unknown }>)[key];
      if (item) next[key] = { enabled: Boolean(item.enabled) };
    }
  }
  return next;
}

function taskStatus(value: string): 'todo' | 'doing' | 'done' | 'canceled' {
  return ['todo', 'doing', 'done', 'canceled'].includes(value) ? value as 'todo' | 'doing' | 'done' | 'canceled' : 'todo';
}

function subscriptionStatus(value: string): 'active' | 'paused' | 'canceled' {
  return ['active', 'paused', 'canceled'].includes(value) ? value as 'active' | 'paused' | 'canceled' : 'active';
}

function reminderStatus(value: string): 'pending' | 'sending' | 'sent' | 'failed' | 'channel_unavailable' | 'cancelled' {
  return ['pending', 'sending', 'sent', 'failed', 'channel_unavailable', 'cancelled'].includes(value)
    ? value as 'pending' | 'sending' | 'sent' | 'failed' | 'channel_unavailable' | 'cancelled'
    : 'pending';
}

function readJson(request: typeof import('node:http').IncomingMessage.prototype): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function json(response: typeof import('node:http').ServerResponse.prototype, status: number, body: unknown): void {
  send(response, status, JSON.stringify(body, null, 2), 'application/json; charset=utf-8');
}

function send(response: typeof import('node:http').ServerResponse.prototype, status: number, body: string, contentType: string): void {
  response.writeHead(status, { 'content-type': contentType });
  response.end(body);
}

function html(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WeChat + Notion Mini Agent</title>
  <style>
    :root { color-scheme: light dark; font-family: Arial, "Microsoft YaHei", sans-serif; }
    body { margin: 0; background: #f7f8fa; color: #1f2328; }
    main { max-width: 1040px; margin: 0 auto; padding: 28px; }
    h1 { margin: 0 0 16px; font-size: 28px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    section { margin-top: 18px; }
    label { display: grid; gap: 6px; font-size: 13px; color: #4b5563; }
    input, textarea { width: 100%; box-sizing: border-box; padding: 10px 12px; font: inherit; border: 1px solid #c8d0d9; border-radius: 6px; background: white; color: #1f2328; }
    textarea { min-height: 92px; resize: vertical; }
    button { padding: 9px 14px; border: 0; border-radius: 6px; background: #1b6ef3; color: white; font: inherit; cursor: pointer; }
    button.secondary { background: #e5e7eb; color: #1f2328; }
    button.tab { background: transparent; color: #4b5563; border: 1px solid #d8dee6; }
    button.tab.active { background: #1f2328; color: white; border-color: #1f2328; }
    button:disabled { opacity: .6; cursor: wait; }
    pre { white-space: pre-wrap; background: #111827; color: #e5e7eb; padding: 14px; border-radius: 6px; overflow: auto; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .panel, .metric { background: white; border: 1px solid #d8dee6; border-radius: 6px; padding: 14px; }
    .metric strong { display: block; font-size: 24px; margin-top: 4px; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .checkbox { display: flex; align-items: center; gap: 8px; }
    .checkbox input { width: auto; }
    .tabs { display: flex; flex-wrap: wrap; gap: 8px; }
    .view[hidden] { display: none; }
    .status { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .status-item { background: white; border: 1px solid #d8dee6; border-radius: 6px; padding: 14px; }
    .status-item strong { display: block; margin-bottom: 6px; }
    .muted { color: #6b7280; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d8dee6; border-radius: 6px; overflow: hidden; }
    th, td { padding: 10px; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: top; font-size: 13px; }
    th { color: #4b5563; background: #f3f4f6; font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    @media (max-width: 760px) { main { padding: 18px; } .grid, .two { grid-template-columns: 1fr; } }
    @media (max-width: 760px) { .status { grid-template-columns: 1fr; } table { display: block; overflow-x: auto; } }
  </style>
</head>
<body>
  <main>
    <h1>WeChat + Notion Mini Agent</h1>
    <nav class="tabs" aria-label="后台页面">
      <button class="tab active" data-view="dashboard">Dashboard</button>
      <button class="tab" data-view="settings">设置</button>
      <button class="tab" data-view="message">手动消息</button>
      <button class="tab" data-view="queue">日志与重试</button>
      <button class="tab" data-view="raw">原始状态</button>
    </nav>
    <section id="view-dashboard" class="view">
      <section class="grid" id="metrics"></section>
      <section class="status" id="health"></section>
      <section class="panel">
        <h2>组件状态</h2>
        <div class="two" id="components"></div>
        <div class="row">
          <button id="testGateway" class="secondary">测试 Gateway</button>
          <button id="testLlmDash" class="secondary">测试 LLM</button>
          <button id="checkTemplateDash" class="secondary">检查 Notion 模板</button>
        </div>
      </section>
    </section>
    <section id="view-settings" class="panel view" hidden>
      <h2>设置</h2>
      <div class="two">
        <label>LLM Provider
          <input id="provider_name">
        </label>
        <label>LLM Base URL
          <input id="base_url">
        </label>
        <label>Model
          <input id="model">
        </label>
        <label>Temperature
          <input id="temperature" type="number" min="0" max="2" step="0.1">
        </label>
        <label>API Key
          <input id="api_key" type="password" autocomplete="off">
        </label>
        <label>Notion Token
          <input id="notion_token" type="password" autocomplete="off">
        </label>
        <label>Tasks Database
          <input id="tasks_database_id">
        </label>
        <label>Bookmarks Database
          <input id="bookmarks_database_id">
        </label>
        <label>Subscriptions Database
          <input id="subscriptions_database_id">
        </label>
        <label>Reminders Database
          <input id="reminders_database_id">
        </label>
      </div>
      <div class="row">
        <label class="checkbox"><input id="llm_enabled" type="checkbox"> LLM 启用</label>
        <label class="checkbox"><input id="supports_response_format" type="checkbox"> JSON 输出</label>
      </div>
      <div class="row">
        <button id="saveSettings">保存设置</button>
        <button id="testLlm" class="secondary">测试 LLM</button>
        <button id="checkTemplate" class="secondary">检查模板</button>
      </div>
    </section>
    <section id="view-message" class="panel view" hidden>
      <h2>手动消息</h2>
      <textarea id="message" placeholder="例如：明天下午3点提醒我跟进报价"></textarea>
      <div class="row">
        <button id="send">发送到本地 Agent</button>
        <button class="secondary sample" data-text="新增任务写周报">任务</button>
        <button class="secondary sample" data-text="收藏 https://example.com">收藏</button>
        <button class="secondary sample" data-text="记录 Cursor Pro 每月20美元，5号续费">订阅</button>
        <button class="secondary sample" data-text="明天下午3点提醒我跟进报价">提醒</button>
      </div>
      <pre id="reply">等待输入...</pre>
    </section>
    <section id="view-queue" class="view" hidden>
      <section class="panel">
        <h2>消息日志</h2>
        <div id="logs"></div>
      </section>
      <section class="panel">
        <h2>失败重试</h2>
        <div id="retries"></div>
      </section>
      <section class="panel">
        <h2>提醒队列</h2>
        <div id="reminders"></div>
      </section>
    </section>
    <section id="view-raw" class="view" hidden>
      <pre id="records"></pre>
    </section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    const labels = { tasks: '任务', bookmarks: '收藏', subscriptions: '订阅', reminders: '提醒' };
    let settingsLoaded = false;

    async function loadState() {
      render(await fetch('/api/state').then((res) => res.json()));
    }

    function render(state) {
      const records = state.records ?? state;
      const templateStatus = state.templateCheck?.status ?? 'unknown';
      const settings = state.settings;
      const stats = state.stats ?? {};
      $('metrics').innerHTML = Object.entries(labels).map(([key, label]) =>
        '<div class="metric">' + label + '<strong>' + (records[key]?.length ?? 0) + '</strong></div>'
      ).join('') +
        '<div class="metric">模板<strong>' + templateStatus + '</strong></div>' +
        '<div class="metric">今日消息<strong>' + (stats.todayMessages ?? 0) + '</strong></div>' +
        '<div class="metric">失败任务<strong>' + (stats.failedJobs ?? 0) + '</strong></div>' +
        '<div class="metric">待提醒<strong>' + (stats.pendingReminders ?? 0) + '</strong></div>';
      $('health').innerHTML = Object.entries(state.health ?? {}).map(([key, item]) =>
        '<div class="status-item"><strong>' + escapeHtml(key) + ': ' + escapeHtml(item.status) + '</strong><span class="muted">' + escapeHtml(item.label) + '</span></div>'
      ).join('');
      $('components').innerHTML = Object.entries(labels).map(([key, label]) =>
        '<div><strong>' + label + '</strong><div class="muted">' + (records[key]?.length ?? 0) + ' 条本地记录</div></div>'
      ).join('');
      $('logs').innerHTML = table(['时间', '组件', '状态', '输入', '错误'], (state.messageLogs ?? []).map((log) => [
        shortTime(log.created_at),
        log.component,
        log.status,
        log.raw_input,
        log.error ?? ''
      ]));
      $('retries').innerHTML = retryTable(state.retryJobs ?? []);
      $('reminders').innerHTML = table(['提醒时间', '状态', '标题'], (records.reminders ?? []).map((item) => [
        item.remind_at ? shortTime(item.remind_at) : '未设置',
        item.status,
        item.title
      ]));
      $('records').textContent = JSON.stringify(state, null, 2);
      if (settings && !settingsLoaded) {
        $('provider_name').value = settings.llm.provider_name;
        $('base_url').value = settings.llm.base_url;
        $('model').value = settings.llm.model;
        $('temperature').value = settings.llm.temperature;
        $('llm_enabled').checked = settings.llm.enabled;
        $('supports_response_format').checked = settings.llm.supports_response_format;
        $('api_key').placeholder = settings.llm.api_key_set ? '已保存，留空保留' : '';
        $('notion_token').placeholder = settings.notion.token_set ? '已保存，留空保留' : '';
        $('tasks_database_id').value = settings.notion.databases.tasks;
        $('bookmarks_database_id').value = settings.notion.databases.bookmarks;
        $('subscriptions_database_id').value = settings.notion.databases.subscriptions;
        $('reminders_database_id').value = settings.notion.databases.reminders;
        settingsLoaded = true;
      }
    }

    function table(headers, rows) {
      if (rows.length === 0) return '<p class="muted">暂无记录</p>';
      return '<table><thead><tr>' + headers.map((header) => '<th>' + escapeHtml(header) + '</th>').join('') +
        '</tr></thead><tbody>' + rows.map((row) =>
          '<tr>' + row.map((cell) => '<td>' + escapeHtml(String(cell)) + '</td>').join('') + '</tr>'
        ).join('') + '</tbody></table>';
    }

    function retryTable(rows) {
      if (rows.length === 0) return '<p class="muted">暂无失败任务</p>';
      return '<table><thead><tr><th>时间</th><th>组件</th><th>状态</th><th>输入</th><th>错误</th><th></th></tr></thead><tbody>' +
        rows.map((job) => '<tr><td>' + escapeHtml(shortTime(job.created_at)) + '</td><td>' + escapeHtml(job.component) +
          '</td><td>' + escapeHtml(job.status) + '</td><td>' + escapeHtml(job.raw_input) + '</td><td>' +
          escapeHtml(job.last_error) + '</td><td>' + (job.status === 'failed' ? '<button class="secondary retry" data-id="' + escapeHtml(job.id) + '">重试</button>' : '') + '</td></tr>'
        ).join('') + '</tbody></table>';
    }

    function shortTime(value) {
      return String(value).replace('T', ' ').replace(/\\.\\d{3}Z$/, 'Z');
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    $('send').onclick = async () => {
      $('send').disabled = true;
      try {
        const res = await fetch('/api/message', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: $('message').value })
        });
        const data = await res.json();
        $('reply').textContent = data.reply ?? JSON.stringify(data, null, 2);
        render(data.state ?? await fetch('/api/state').then((stateRes) => stateRes.json()));
      } finally {
        $('send').disabled = false;
      }
    };

    $('saveSettings').onclick = async () => {
      const body = {
        provider_name: $('provider_name').value,
        base_url: $('base_url').value,
        model: $('model').value,
        temperature: $('temperature').value,
        api_key: $('api_key').value,
        notion_token: $('notion_token').value,
        llm_enabled: $('llm_enabled').checked,
        supports_response_format: $('supports_response_format').checked,
        tasks_database_id: $('tasks_database_id').value,
        bookmarks_database_id: $('bookmarks_database_id').value,
        subscriptions_database_id: $('subscriptions_database_id').value,
        reminders_database_id: $('reminders_database_id').value
      };
      const state = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }).then((res) => res.json());
      settingsLoaded = false;
      $('api_key').value = '';
      $('notion_token').value = '';
      $('reply').textContent = '设置已保存。';
      render(state);
    };

    $('testLlm').onclick = async () => {
      $('reply').textContent = JSON.stringify(await fetch('/api/llm/test', { method: 'POST' }).then((res) => res.json()), null, 2);
    };

    $('checkTemplate').onclick = async () => {
      $('reply').textContent = JSON.stringify(await fetch('/api/notion/check-template', { method: 'POST' }).then((res) => res.json()), null, 2);
      await loadState();
    };

    $('testGateway').onclick = async () => {
      $('reply').textContent = JSON.stringify(await fetch('/api/gateway/test', { method: 'POST' }).then((res) => res.json()), null, 2);
      showView('message');
    };

    $('testLlmDash').onclick = () => $('testLlm').click();
    $('checkTemplateDash').onclick = () => $('checkTemplate').click();

    document.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const tab = target.closest('.tab');
      if (tab) showView(tab.dataset.view);
      const retry = target.closest('.retry');
      if (retry) {
        retry.setAttribute('disabled', 'true');
        const data = await fetch('/api/retry', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: retry.dataset.id })
        }).then((res) => res.json());
        $('reply').textContent = data.reply ?? JSON.stringify(data, null, 2);
        render(data.state ?? await fetch('/api/state').then((res) => res.json()));
      }
    });

    function showView(name) {
      for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== 'view-' + name;
      for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.view === name);
    }

    for (const button of document.querySelectorAll('.sample')) {
      button.onclick = () => { $('message').value = button.dataset.text; };
    }

    loadState();
  </script>
</body>
</html>`;
}
