export function html(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WeChat + Notion Mini Agent</title>
  <style>
    :root { color-scheme: light; font-family: Arial, "Microsoft YaHei", sans-serif; background: #f6f7f9; color: #1f2328; }
    body { margin: 0; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 18px; }
    h1 { margin: 0; font-size: 26px; line-height: 1.2; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    h3 { margin: 0 0 8px; font-size: 15px; }
    label { display: grid; gap: 6px; font-size: 13px; color: #4b5563; }
    input, select, textarea { width: 100%; box-sizing: border-box; padding: 10px 12px; font: inherit; border: 1px solid #c8d0d9; border-radius: 6px; background: #fff; color: #1f2328; }
    textarea { min-height: 96px; resize: vertical; }
    button { min-height: 38px; padding: 8px 13px; border: 0; border-radius: 6px; background: #1769e0; color: #fff; font: inherit; cursor: pointer; }
    button.secondary { background: #e8edf3; color: #1f2328; }
    button.danger { background: #b42318; }
    button:disabled { opacity: .58; cursor: wait; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    nav button { background: transparent; color: #4b5563; border: 1px solid #d8dee6; }
    nav button.active { background: #1f2328; color: #fff; border-color: #1f2328; }
    section.view[hidden] { display: none; }
    .panel { background: #fff; border: 1px solid #d8dee6; border-radius: 6px; padding: 16px; margin-bottom: 14px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .metric { background: #fff; border: 1px solid #d8dee6; border-radius: 6px; padding: 14px; }
    .metric strong { display: block; font-size: 24px; margin-top: 3px; }
    .status { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 3px 9px; font-size: 12px; background: #eef6ee; color: #176b35; }
    .status.warn { background: #fff7e6; color: #8a5400; }
    .muted { color: #6b7280; font-size: 13px; }
    .check { display: flex; align-items: center; gap: 8px; }
    .check input { width: auto; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d8dee6; border-radius: 6px; overflow: hidden; }
    th, td { padding: 10px; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: top; font-size: 13px; }
    th { color: #4b5563; background: #f3f4f6; font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    pre { white-space: pre-wrap; background: #111827; color: #e5e7eb; padding: 14px; border-radius: 6px; overflow: auto; }
    @media (max-width: 760px) {
      main { padding: 16px; }
      header, .two { display: block; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      table { display: block; overflow-x: auto; }
    }
    @media (max-width: 420px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>WeChat + Notion Mini Agent</h1>
        <div class="muted">本地自部署控制台</div>
      </div>
      <div id="topStatus" class="status warn">加载中</div>
    </header>

    <nav aria-label="后台页面">
      <button class="active" data-view="dashboard">Dashboard</button>
      <button data-view="gateway">Gateway</button>
      <button data-view="binding">微信绑定</button>
      <button data-view="llm">LLM</button>
      <button data-view="notion">Notion</button>
      <button data-view="components">组件</button>
      <button data-view="message">消息</button>
      <button data-view="logs">日志</button>
      <button data-view="reminders">提醒队列</button>
      <button data-view="retry">失败重试</button>
      <button data-view="security">安全</button>
    </nav>

    <section id="view-dashboard" class="view">
      <div id="metrics" class="grid"></div>
      <div id="health" class="grid" style="margin-top:10px"></div>
      <section class="panel">
        <h2>快速测试</h2>
        <div class="row">
          <button id="testGateway" class="secondary">测试 Gateway</button>
          <button id="testLlm" class="secondary">测试 LLM</button>
          <button id="checkTemplate" class="secondary">检查 Notion 模板</button>
        </div>
      </section>
    </section>

    <section id="view-gateway" class="view panel" hidden>
      <h2>Gateway 连接</h2>
      <div class="two">
        <label>Gateway URL <input id="gateway_url"></label>
        <label>Instance ID <input id="instance_id"></label>
        <label>Relay 状态
          <select id="relay_status"><option value="local">local</option><option value="connected">connected</option><option value="offline">offline</option></select>
        </label>
        <label>服务号名称 <input id="service_account_name"></label>
      </div>
      <div class="row" style="margin-top:12px"><button id="saveGateway">保存 Gateway</button></div>
    </section>

    <section id="view-binding" class="view panel" hidden>
      <h2>微信绑定</h2>
      <p class="muted">本地模拟“登录 123456”：服务端只保存 code hash 和 openid hash。</p>
      <div class="two">
        <label>登录码 <input id="login_code" readonly></label>
        <label>模拟 OpenID <input id="openid" value="local-openid"></label>
      </div>
      <div class="row" style="margin-top:12px">
        <button id="genCode">生成登录码</button>
        <button id="simulateLogin" class="secondary">模拟绑定</button>
        <button id="unbind" class="danger">解绑</button>
      </div>
      <pre id="bindingInfo">未加载</pre>
    </section>

    <section id="view-llm" class="view panel" hidden>
      <h2>LLM 设置</h2>
      <div class="two">
        <label>Provider <input id="provider_name"></label>
        <label>Base URL <input id="base_url"></label>
        <label>Model <input id="model"></label>
        <label>Temperature <input id="temperature" type="number" min="0" max="2" step="0.1"></label>
        <label>API Key <input id="api_key" type="password" autocomplete="off"></label>
      </div>
      <div class="row" style="margin-top:12px">
        <label class="check"><input id="llm_enabled" type="checkbox">启用 LLM</label>
        <label class="check"><input id="supports_response_format" type="checkbox">JSON 输出</label>
        <button id="saveLlm">保存 LLM</button>
      </div>
    </section>

    <section id="view-notion" class="view panel" hidden>
      <h2>Notion 设置</h2>
      <div class="two">
        <label>Notion Token <input id="notion_token" type="password" autocomplete="off"></label>
        <label>Tasks Database <input id="tasks_database_id"></label>
        <label>Bookmarks Database <input id="bookmarks_database_id"></label>
        <label>Subscriptions Database <input id="subscriptions_database_id"></label>
        <label>Reminders Database <input id="reminders_database_id"></label>
      </div>
      <div class="row" style="margin-top:12px"><button id="saveNotion">保存 Notion</button></div>
      <div id="templateTable" style="margin-top:12px"></div>
    </section>

    <section id="view-components" class="view panel" hidden>
      <h2>组件设置</h2>
      <div id="componentSettings" class="two"></div>
      <div class="row" style="margin-top:12px"><button id="saveComponents">保存组件</button></div>
    </section>

    <section id="view-message" class="view panel" hidden>
      <h2>手动消息</h2>
      <textarea id="message" placeholder="例如：明天下午3点提醒我跟进报价"></textarea>
      <div class="row" style="margin-top:10px">
        <button id="send">发送到本地 Agent</button>
        <button class="secondary sample" data-text="新增任务写周报">任务</button>
        <button class="secondary sample" data-text="收藏 https://example.com">收藏</button>
        <button class="secondary sample" data-text="记录 Cursor Pro 每月20美元，8号续费">订阅</button>
        <button class="secondary sample" data-text="明天下午3点提醒我跟进报价">提醒</button>
      </div>
      <pre id="reply">等待输入...</pre>
    </section>

    <section id="view-logs" class="view panel" hidden><h2>消息日志</h2><div id="logs"></div></section>
    <section id="view-reminders" class="view panel" hidden><h2>提醒队列</h2><div id="reminders"></div></section>
    <section id="view-retry" class="view panel" hidden><h2>失败重试</h2><div id="retries"></div></section>

    <section id="view-security" class="view panel" hidden>
      <h2>安全设置</h2>
      <div class="row">
        <label class="check"><input id="mask_secrets" type="checkbox">密钥脱敏显示</label>
        <label class="check"><input id="debug_logging" type="checkbox">调试日志</label>
      </div>
      <div class="row" style="margin-top:12px"><button id="saveSecurity">保存安全设置</button></div>
      <pre id="rawState"></pre>
    </section>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    const labels = { tasks: '任务', bookmarks: '收藏', subscriptions: '订阅', reminders: '提醒' };
    let lastState;

    async function api(path, body) {
      const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }

    async function loadState() {
      lastState = await fetch('/api/state').then((res) => res.json());
      render(lastState);
    }

    function render(state) {
      const records = state.records;
      const stats = state.stats || {};
      const settings = state.settings;
      $('topStatus').className = state.templateCheck.status === 'ok' ? 'status' : 'status warn';
      $('topStatus').textContent = 'Gateway ' + state.health.gateway.status + ' / Notion ' + state.templateCheck.status;
      $('metrics').innerHTML = Object.keys(labels).map((key) => metric(labels[key], records[key].length)).join('') +
        metric('今日消息', stats.todayMessages || 0) + metric('失败任务', stats.failedJobs || 0) + metric('待提醒', stats.pendingReminders || 0) + metric('绑定', state.binding ? '已绑定' : '未绑定');
      $('health').innerHTML = Object.keys(state.health).map((key) => '<div class="metric"><span class="' + (state.health[key].status === 'ok' || state.health[key].status === 'local' ? 'status' : 'status warn') + '">' + escapeHtml(key) + ': ' + escapeHtml(state.health[key].status) + '</span><div class="muted" style="margin-top:8px">' + escapeHtml(state.health[key].label) + '</div></div>').join('');
      fillSettings(settings);
      $('bindingInfo').textContent = JSON.stringify({ active_binding: state.binding || null, openid_hash: settings.wechat.bound_openid_hash || null }, null, 2);
      $('templateTable').innerHTML = table(['数据库', '状态', 'ID', '缺少字段'], Object.keys(state.templateCheck.databases).map((key) => {
        const item = state.templateCheck.databases[key];
        return [labels[key], item.status, item.database_id || '-', item.missing_fields.join(', ')];
      }));
      $('componentSettings').innerHTML = Object.keys(labels).map((key) => '<label class="check"><input class="componentToggle" data-key="' + key + '" type="checkbox" ' + (settings.components[key].enabled ? 'checked' : '') + '>' + labels[key] + '</label>').join('');
      $('logs').innerHTML = table(['时间', '组件', '状态', '输入', '错误'], (state.messageLogs || []).map((log) => [shortTime(log.created_at), log.component, log.status, log.raw_input, log.error || '']));
      $('reminders').innerHTML = actionTable(['提醒时间', '状态', '标题', '操作'], (records.reminders || []).map((item) => [shortTime(item.remind_at || ''), item.status, item.title, reminderActions(item)]));
      $('retries').innerHTML = actionTable(['时间', '组件', '状态', '输入', '错误', '操作'], (state.retryJobs || []).map((job) => [shortTime(job.created_at), job.component, job.status, job.raw_input, job.last_error, job.status === 'failed' ? '<button class="secondary retry" data-id="' + job.id + '">重试</button>' : '']));
      $('rawState').textContent = JSON.stringify({ settings: settings, binding: state.binding }, null, 2);
    }

    function fillSettings(settings) {
      $('gateway_url').value = settings.gateway.url;
      $('instance_id').value = settings.gateway.instance_id;
      $('relay_status').value = settings.gateway.relay_status;
      $('service_account_name').value = settings.wechat.service_account_name;
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
      $('mask_secrets').checked = settings.security.mask_secrets;
      $('debug_logging').checked = settings.security.debug_logging;
    }

    function metric(label, value) {
      return '<div class="metric">' + escapeHtml(label) + '<strong>' + escapeHtml(value) + '</strong></div>';
    }

    function table(headers, rows) {
      if (!rows.length) return '<p class="muted">暂无记录</p>';
      return '<table><thead><tr>' + headers.map((h) => '<th>' + escapeHtml(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + row.map((cell) => '<td>' + escapeHtml(String(cell)) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    }

    function actionTable(headers, rows) {
      if (!rows.length) return '<p class="muted">暂无记录</p>';
      return '<table><thead><tr>' + headers.map((h) => '<th>' + escapeHtml(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + row.map((cell, index) => '<td>' + (index === row.length - 1 ? cell : escapeHtml(String(cell))) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    }

    function reminderActions(item) {
      if (item.status !== 'pending') return '';
      return '<button class="secondary reminderStatus" data-id="' + item.id + '" data-status="sent">标记已发</button> <button class="danger reminderStatus" data-id="' + item.id + '" data-status="cancelled">取消</button>';
    }

    function shortTime(value) {
      return value ? String(value).replace('T', ' ').replace(/\\.\\d{3}Z$/, 'Z') : '-';
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    async function saveSettings(extra) {
      await api('/api/settings', {
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
      });
      $('api_key').value = '';
      $('notion_token').value = '';
      await loadState();
      if (extra) $('reply').textContent = extra;
    }

    document.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const tab = target.closest('nav button');
      if (tab) {
        document.querySelectorAll('nav button').forEach((button) => button.classList.toggle('active', button === tab));
        document.querySelectorAll('.view').forEach((view) => view.hidden = view.id !== 'view-' + tab.dataset.view);
      }
      const retry = target.closest('.retry');
      if (retry) render((await api('/api/retry', { id: retry.dataset.id })).state);
      const reminder = target.closest('.reminderStatus');
      if (reminder) render(await api('/api/reminder/status', { id: reminder.dataset.id, status: reminder.dataset.status }));
    });

    document.querySelectorAll('.sample').forEach((button) => button.addEventListener('click', () => { $('message').value = button.dataset.text; }));
    $('send').onclick = async () => { const data = await api('/api/message', { text: $('message').value }); $('reply').textContent = data.reply; render(data.state); };
    $('testGateway').onclick = async () => { $('reply').textContent = JSON.stringify(await api('/api/gateway/test'), null, 2); };
    $('testLlm').onclick = async () => { $('reply').textContent = JSON.stringify(await api('/api/llm/test'), null, 2); };
    $('checkTemplate').onclick = async () => { $('reply').textContent = JSON.stringify(await api('/api/notion/check-template'), null, 2); await loadState(); };
    $('saveGateway').onclick = async () => render(await api('/api/gateway/settings', { url: $('gateway_url').value, instance_id: $('instance_id').value, relay_status: $('relay_status').value, service_account_name: $('service_account_name').value }));
    $('saveLlm').onclick = () => saveSettings('LLM 设置已保存。');
    $('saveNotion').onclick = () => saveSettings('Notion 设置已保存。');
    $('saveComponents').onclick = async () => {
      const components = {};
      document.querySelectorAll('.componentToggle').forEach((input) => { components[input.dataset.key] = { enabled: input.checked }; });
      render(await api('/api/components', { components }));
    };
    $('saveSecurity').onclick = async () => render(await api('/api/security', { mask_secrets: $('mask_secrets').checked, debug_logging: $('debug_logging').checked }));
    $('genCode').onclick = async () => { const data = await api('/api/auth-code'); $('login_code').value = data.code; $('bindingInfo').textContent = JSON.stringify(data, null, 2); };
    $('simulateLogin').onclick = async () => { const data = await api('/api/binding/login', { code: $('login_code').value, openid: $('openid').value }); render(data.state); };
    $('unbind').onclick = async () => { const data = await api('/api/binding/unbind'); render(data.state); };
    loadState();
  </script>
</body>
</html>`;
}
