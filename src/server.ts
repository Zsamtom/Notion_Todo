import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { MiniAgent } from './agent.ts';
import { parseWithLlm } from './llm.ts';
import { FileNotionAdapter } from './notion.ts';
import { html as pageHtml } from './page.ts';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
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
      const apiKey = secretValue(body.api_key);
      const notionToken = secretValue(body.notion_token);
      await notion.saveSettings({
        llm: {
          provider_name: String(body.provider_name ?? notion.settings.llm.provider_name),
          base_url: String(body.base_url ?? notion.settings.llm.base_url),
          model: String(body.model ?? notion.settings.llm.model),
          temperature: Number(body.temperature ?? notion.settings.llm.temperature),
          supports_response_format: boolValue(body.supports_response_format, notion.settings.llm.supports_response_format),
          enabled: boolValue(body.llm_enabled, notion.settings.llm.enabled),
          api_key_set: Boolean(apiKey) || notion.hasLlmKey()
        },
        notion: {
          token_set: Boolean(notionToken) || notion.hasNotionToken(),
          databases: {
            tasks: String(body.tasks_database_id ?? ''),
            bookmarks: String(body.bookmarks_database_id ?? ''),
            subscriptions: String(body.subscriptions_database_id ?? ''),
            reminders: String(body.reminders_database_id ?? '')
          }
        }
      });
      if (apiKey || notionToken) {
        await notion.saveSecrets({
          llm_api_key: apiKey,
          notion_token: notionToken
        });
      }
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
      return json(response, 200, await notion.checkTemplates());
    }

    if (request.method === 'POST' && url.pathname === '/api/llm/test') {
      if (!notion.settings.llm.enabled) {
        return json(response, 200, { ok: false, mode: 'off', message: 'LLM 已停用。' });
      }
      if (!notion.hasLlmKey() || notion.settings.llm.base_url.startsWith('local://')) {
        return json(response, 200, {
          ok: true,
          mode: 'local-rules',
          message: '未配置远端 LLM，当前使用本地规则解析。'
        });
      }
      const parsed = await parseWithLlm('新增任务测试 LLM 解析', 'admin', notion.settings.llm, notion.getLlmApiKey());
      return json(response, 200, {
        ok: true,
        mode: notion.settings.llm.model,
        parsed,
        message: 'LLM 解析可用。'
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

server.listen(port, host, () => {
  console.log(`WeChat + Notion Mini Agent: http://${host}:${port}`);
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
  const llmRemote = notion.settings.llm.enabled && notion.hasLlmKey() && !notion.settings.llm.base_url.startsWith('local://');
  return {
    gateway: { status: 'local', label: '本地手动入口' },
    relay: { status: 'local', label: 'V0 不连接 WebSocket Relay' },
    notion: { status: templateCheck.status, label: templateCheck.status === 'ok' ? '固定模板可写入' : '模板缺配置' },
    llm: {
      status: notion.settings.llm.enabled ? llmRemote ? 'ok' : 'local' : 'off',
      label: notion.settings.llm.enabled ? llmRemote ? '远端 LLM 已配置' : '本地规则解析可用' : 'LLM 已停用'
    }
  };
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return Boolean(value);
}

function secretValue(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
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
