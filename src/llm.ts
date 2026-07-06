import type {
  BookmarkRecord,
  DemoSettings,
  ReminderRecord,
  Source,
  SubscriptionRecord,
  TaskRecord
} from './notion.ts';
import type { ParsedIntent } from './agent.ts';

type LlmIntent = {
  intent?: string;
  component?: string;
  action?: string;
  fields?: Record<string, unknown>;
  needs_confirmation?: boolean;
  confidence?: number;
};

export async function parseWithLlm(text: string, source: Source, settings: DemoSettings['llm'], apiKey: string): Promise<ParsedIntent> {
  const response = await fetch(chatCompletionsUrl(settings.base_url), {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: settings.temperature,
      ...(settings.supports_response_format ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        {
          role: 'system',
          content: [
            '你是微信消息意图解析器，只输出 JSON。',
            'component 只能是 task/bookmark/subscription/reminder/unsupported。',
            'action 只能是 create/query/update_status/unsupported。',
            '不要删除数据，不要输出密钥，不要调用任何工具。',
            '字段：task title status due_at remind_at priority；bookmark title url tags summary；subscription name price currency billing_cycle next_renewal_at remind_at status；reminder title remind_at related_type related_page_id status。',
            '时间字段用 ISO 8601 字符串；不确定就 needs_confirmation=true。'
          ].join('\n')
        },
        { role: 'user', content: text }
      ]
    })
  });
  const body = await response.json().catch(() => ({})) as { choices?: { message?: { content?: string } }[]; message?: string; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? body.message ?? `LLM API ${response.status}`);
  return normalizeLlmIntent(jsonFromContent(body.choices?.[0]?.message?.content ?? ''), text, source);
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function jsonFromContent(content: string): LlmIntent {
  const cleaned = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned) as LlmIntent;
}

function normalizeLlmIntent(value: LlmIntent, rawInput: string, source: Source): ParsedIntent {
  if (value.needs_confirmation || (value.confidence !== undefined && value.confidence < 0.6)) {
    return { component: 'unsupported', action: 'unsupported', reply: '我不确定要怎么处理，请明确说“任务 / 收藏 / 订阅 / 提醒”。' };
  }
  const inferred = inferFromIntent(value.intent);
  const component = oneOf(value.component, ['task', 'bookmark', 'subscription', 'reminder', 'unsupported'], inferred.component);
  const action = oneOf(value.action, ['create', 'query', 'update_status', 'unsupported'], inferred.action);
  const fields = value.fields && typeof value.fields === 'object' ? value.fields : {};
  if (component === 'task') return { component, action: taskAction(action), fields: taskFields(fields, rawInput, source) };
  if (component === 'bookmark') return { component, action: bookmarkAction(action), fields: bookmarkFields(fields, rawInput, source) };
  if (component === 'subscription') return { component, action: subscriptionAction(action), fields: subscriptionFields(fields, rawInput) };
  if (component === 'reminder') return { component, action: reminderAction(action), fields: reminderFields(fields, rawInput) };
  return { component: 'unsupported', action: 'unsupported' };
}

function inferFromIntent(intent?: string): { component: ParsedIntent['component']; action: ParsedIntent['action'] } {
  const value = intent ?? '';
  const action = value.startsWith('query') ? 'query' : value.includes('update') ? 'update_status' : value.includes('create') ? 'create' : 'unsupported';
  if (value.includes('task')) return { component: 'task', action };
  if (value.includes('bookmark')) return { component: 'bookmark', action };
  if (value.includes('subscription')) return { component: 'subscription', action };
  if (value.includes('reminder')) return { component: 'reminder', action };
  return { component: 'unsupported', action: 'unsupported' };
}

function taskFields(fields: Record<string, unknown>, rawInput: string, source: Source): Partial<TaskRecord> {
  return {
    title: stringField(fields.title),
    status: oneOf(fields.status, ['todo', 'doing', 'done', 'canceled'], 'todo'),
    due_at: stringField(fields.due_at),
    remind_at: stringField(fields.remind_at),
    priority: oneOf(fields.priority, ['low', 'medium', 'high'], 'medium'),
    source,
    raw_input: rawInput
  };
}

function bookmarkFields(fields: Record<string, unknown>, rawInput: string, source: Source): Partial<BookmarkRecord> {
  return {
    title: stringField(fields.title),
    url: stringField(fields.url),
    tags: Array.isArray(fields.tags) ? fields.tags.map(String) : [],
    summary: stringField(fields.summary) ?? '',
    source,
    raw_input: rawInput
  };
}

function subscriptionFields(fields: Record<string, unknown>, rawInput: string): Partial<SubscriptionRecord> {
  return {
    name: stringField(fields.name),
    price: numberField(fields.price) ?? 0,
    currency: oneOf(fields.currency, ['CNY', 'USD', 'HKD', 'JPY', 'EUR'], 'CNY'),
    billing_cycle: oneOf(fields.billing_cycle, ['monthly', 'yearly', 'one_time'], 'monthly'),
    next_renewal_at: stringField(fields.next_renewal_at),
    remind_at: stringField(fields.remind_at),
    status: oneOf(fields.status, ['active', 'paused', 'canceled'], 'active'),
    raw_input: rawInput
  };
}

function reminderFields(fields: Record<string, unknown>, rawInput: string): Partial<ReminderRecord> {
  return {
    title: stringField(fields.title),
    remind_at: stringField(fields.remind_at),
    related_type: oneOf(fields.related_type, ['task', 'bookmark', 'subscription', 'standalone'], 'standalone'),
    related_page_id: stringField(fields.related_page_id),
    status: oneOf(fields.status, ['pending', 'sending', 'sent', 'failed', 'channel_unavailable', 'cancelled'], 'pending'),
    raw_input: rawInput
  };
}

function taskAction(value: string): 'create' | 'query' | 'update_status' {
  return value === 'query' || value === 'update_status' ? value : 'create';
}

function bookmarkAction(value: string): 'create' | 'query' {
  return value === 'query' ? value : 'create';
}

function subscriptionAction(value: string): 'create' | 'query' | 'update_status' {
  return value === 'query' || value === 'update_status' ? value : 'create';
}

function reminderAction(value: string): 'create' | 'query' | 'update_status' {
  return value === 'query' || value === 'update_status' ? value : 'create';
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}
