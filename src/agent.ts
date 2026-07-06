import type {
  BookmarkRecord,
  MemoryNotionAdapter,
  ReminderRecord,
  Source,
  SubscriptionRecord,
  TaskRecord
} from './notion.ts';
import { parseWithLlm } from './llm.ts';

type IncomingMessage = {
  idempotencyKey: string;
  text: string;
  source: Source;
};

export type AgentResult = {
  reply: string;
  component: 'task' | 'bookmark' | 'subscription' | 'reminder' | 'unsupported';
};

export type ParsedIntent =
  | { component: 'task'; action: 'create' | 'query' | 'update_status'; fields?: Partial<TaskRecord> }
  | { component: 'bookmark'; action: 'create' | 'query'; fields?: Partial<BookmarkRecord> }
  | { component: 'subscription'; action: 'create' | 'query' | 'update_status'; fields?: Partial<SubscriptionRecord> }
  | { component: 'reminder'; action: 'create' | 'query' | 'update_status'; fields?: Partial<ReminderRecord> }
  | { component: 'unsupported'; action: 'unsupported'; reply?: string };

export class MiniAgent {
  private readonly notion: MemoryNotionAdapter;

  constructor(notion: MemoryNotionAdapter) {
    this.notion = notion;
  }

  async handleMessage(message: IncomingMessage): Promise<AgentResult> {
    if (await this.notion.hasProcessed(message.idempotencyKey)) {
      return { component: 'unsupported', reply: '这条消息已处理过，不会重复写入。' };
    }

    let parsed: ParsedIntent = { component: 'unsupported', action: 'unsupported' };
    let result: AgentResult;
    try {
      parsed = await this.parseMessage(message);
      result = await this.runIntent(parsed, message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.notion.logMessage({
        idempotency_key: message.idempotencyKey,
        raw_input: message.text,
        component: parsed.component,
        status: 'failed',
        error: errorMessage
      });
      await this.notion.recordFailedJob({
        idempotency_key: message.idempotencyKey,
        raw_input: message.text,
        source: message.source,
        component: parsed.component,
        last_error: errorMessage
      });
      return {
        component: parsed.component,
        reply: `写入失败：${errorMessage}`
      };
    }
    await this.notion.markProcessed(message.idempotencyKey);
    await this.notion.logMessage({
      idempotency_key: message.idempotencyKey,
      raw_input: message.text,
      component: result.component,
      status: result.component === 'unsupported' ? 'ignored' : 'processed'
    });
    return result;
  }

  private async parseMessage(message: IncomingMessage): Promise<ParsedIntent> {
    if (this.notion.settings.llm.enabled && this.notion.hasLlmKey() && !this.notion.settings.llm.base_url.startsWith('local://')) {
      return parseWithLlm(message.text, message.source, this.notion.settings.llm, this.notion.getLlmApiKey());
    }
    return parseIntent(message.text, message.source);
  }

  private async runIntent(parsed: ParsedIntent, message: IncomingMessage): Promise<AgentResult> {
    if (parsed.component !== 'unsupported' && this.notion.settings.components[componentKey(parsed.component)].enabled === false) {
      return { component: parsed.component, reply: `${componentLabel(parsed.component)}组件已停用。` };
    }

    if (parsed.component === 'task' && parsed.action === 'update_status') {
      const task = latestMatch(this.notion.records.tasks, parsed.fields?.title);
      if (!task) return { component: 'task', reply: '没有找到可更新的任务。' };
      await this.notion.update_task_status(task.id, parsed.fields?.status ?? 'done');
      return { component: 'task', reply: `已更新任务：${task.title}` };
    }

    if (parsed.component === 'subscription' && parsed.action === 'update_status') {
      const subscription = latestMatch(this.notion.records.subscriptions, parsed.fields?.name);
      if (!subscription) return { component: 'subscription', reply: '没有找到可更新的订阅。' };
      await this.notion.update_subscription_status(subscription.id, parsed.fields?.status ?? 'canceled');
      return { component: 'subscription', reply: `已更新订阅：${subscription.name}` };
    }

    if (parsed.component === 'reminder' && parsed.action === 'update_status') {
      const reminder = latestMatch(this.notion.records.reminders, parsed.fields?.title);
      if (!reminder) return { component: 'reminder', reply: '没有找到可更新的提醒。' };
      await this.notion.update_reminder_status(reminder.id, parsed.fields?.status ?? 'cancelled');
      return { component: 'reminder', reply: `已更新提醒：${reminder.title}` };
    }

    if (parsed.component === 'task' && parsed.action === 'create') {
      const title = parsed.fields?.title;
      if (!title) return { component: 'task', reply: '任务缺少标题，请补充。' };
      const task = await this.notion.create_task({
        title,
        status: 'todo',
        priority: 'medium',
        due_at: parsed.fields?.due_at,
        remind_at: parsed.fields?.remind_at,
        source: message.source,
        raw_input: message.text
      });
      return { component: 'task', reply: `已添加任务：${task.title}` };
    }

    if (parsed.component === 'bookmark' && parsed.action === 'create') {
      const url = parsed.fields?.url;
      if (!url) return { component: 'bookmark', reply: '收藏缺少 URL，请补充。' };
      const bookmark = await this.notion.create_bookmark({
        title: parsed.fields?.title || url,
        url,
        tags: parsed.fields?.tags ?? [],
        summary: parsed.fields?.summary ?? '',
        source: message.source,
        raw_input: message.text
      });
      return { component: 'bookmark', reply: `已添加收藏：${bookmark.title}` };
    }

    if (parsed.component === 'subscription' && parsed.action === 'create') {
      const name = parsed.fields?.name;
      if (!name) return { component: 'subscription', reply: '订阅缺少名称，请补充。' };
      const subscription = await this.notion.create_subscription({
        name,
        price: parsed.fields?.price ?? 0,
        currency: parsed.fields?.currency ?? 'CNY',
        billing_cycle: parsed.fields?.billing_cycle ?? 'monthly',
        next_renewal_at: parsed.fields?.next_renewal_at,
        remind_at: parsed.fields?.remind_at,
        status: 'active',
        raw_input: message.text
      });
      return { component: 'subscription', reply: `已记录订阅：${subscription.name}` };
    }

    if (parsed.component === 'reminder' && parsed.action === 'create') {
      const title = parsed.fields?.title;
      if (!title) return { component: 'reminder', reply: '提醒缺少标题，请补充。' };
      const reminder = await this.notion.create_reminder({
        title,
        remind_at: parsed.fields?.remind_at,
        related_type: 'standalone',
        status: 'pending',
        raw_input: message.text
      });
      return { component: 'reminder', reply: `已添加提醒：${reminder.title}` };
    }

    if (parsed.action === 'query') {
      return this.query(parsed.component);
    }

    return {
      component: 'unsupported',
      reply: parsed.reply ?? '暂时只支持任务、收藏、订阅和提醒。'
    };
  }

  private async query(component: Exclude<ParsedIntent['component'], 'unsupported'>): Promise<AgentResult> {
    if (component === 'task') {
      const rows = await this.notion.query_tasks();
      return { component, reply: formatList('最近任务', rows.map((row) => row.title)) };
    }
    if (component === 'bookmark') {
      const rows = await this.notion.query_bookmarks();
      return { component, reply: formatList('最近收藏', rows.map((row) => row.title)) };
    }
    if (component === 'subscription') {
      const rows = await this.notion.query_subscriptions();
      return { component, reply: formatList('最近订阅', rows.map((row) => `${row.name} ${row.price}${row.currency}`)) };
    }
    const rows = await this.notion.query_reminders();
    return { component, reply: formatList('待提醒事项', rows.map((row) => row.title)) };
  }
}

export function parseIntent(text: string, source: Source): ParsedIntent {
  const trimmed = text.trim();
  const url = trimmed.match(/https?:\/\/\S+/)?.[0];

  if (hasAny(trimmed, ['查询', '查一下', '看看', '最近'])) {
    if (hasAny(trimmed, ['收藏', '书签', '链接'])) return { component: 'bookmark', action: 'query' };
    if (hasAny(trimmed, ['订阅', '续费', '支出'])) return { component: 'subscription', action: 'query' };
    if (hasAny(trimmed, ['提醒'])) return { component: 'reminder', action: 'query' };
    if (hasAny(trimmed, ['任务', '待办'])) return { component: 'task', action: 'query' };
  }

  if (hasAny(trimmed, ['完成', '做完', '结束']) && hasAny(trimmed, ['任务', '待办'])) {
    return { component: 'task', action: 'update_status', fields: { title: cleanupTitle(trimmed).replace(/完成|做完|结束|任务|待办/g, '').trim(), status: 'done' } };
  }

  if (hasAny(trimmed, ['取消', '暂停']) && hasAny(trimmed, ['订阅', '续费'])) {
    return { component: 'subscription', action: 'update_status', fields: { name: cleanupTitle(trimmed).replace(/取消|暂停|订阅|续费/g, '').trim(), status: trimmed.includes('暂停') ? 'paused' : 'canceled' } };
  }

  if (hasAny(trimmed, ['取消']) && hasAny(trimmed, ['提醒'])) {
    return { component: 'reminder', action: 'update_status', fields: { title: extractReminderTitle(trimmed).replace(/取消/g, '').trim(), status: 'cancelled' } };
  }

  if (url && hasAny(trimmed, ['收藏', '保存', '书签'])) {
    return {
      component: 'bookmark',
      action: 'create',
      fields: { title: extractTitleBeforeUrl(trimmed, url), url, tags: [], summary: '', source, raw_input: trimmed }
    };
  }

  if (hasAny(trimmed, ['订阅', '续费', '每月', '每年'])) {
    return { component: 'subscription', action: 'create', fields: extractSubscription(trimmed) };
  }

  if (hasAny(trimmed, ['提醒'])) {
    return { component: 'reminder', action: 'create', fields: { title: extractReminderTitle(trimmed), remind_at: extractDateTime(trimmed), raw_input: trimmed } };
  }

  if (hasAny(trimmed, ['任务', '待办', 'todo'])) {
    return { component: 'task', action: 'create', fields: { title: cleanupTitle(trimmed), status: 'todo', priority: 'medium', due_at: extractDateTime(trimmed), source, raw_input: trimmed } };
  }

  return { component: 'unsupported', action: 'unsupported' };
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function componentKey(component: Exclude<AgentResult['component'], 'unsupported'>): `${typeof component}s` {
  return `${component}s` as `${typeof component}s`;
}

function componentLabel(component: Exclude<AgentResult['component'], 'unsupported'>): string {
  return { task: '任务', bookmark: '收藏', subscription: '订阅', reminder: '提醒' }[component];
}

function latestMatch<T extends { title?: string; name?: string }>(rows: T[], needle?: string): T | undefined {
  const trimmed = needle?.trim();
  const reversed = [...rows].reverse();
  return trimmed ? reversed.find((row) => (row.title ?? row.name ?? '').includes(trimmed)) ?? reversed[0] : reversed[0];
}

function extractTitleBeforeUrl(text: string, url: string): string {
  return text.slice(0, text.indexOf(url)).replace(/收藏|保存|这篇文章|这条链接/g, '').trim() || url;
}

function extractReminderTitle(text: string): string {
  return cleanupTitle(text)
    .replace(/提醒我?/g, '')
    .replace(/明天|今天|后天|上午|下午|晚上|\d{1,2}[点:：]\d{0,2}/g, '')
    .trim() || text;
}

function cleanupTitle(text: string): string {
  return text.replace(/^(记录|新增|添加|创建|帮我)/, '').trim();
}

function extractSubscription(text: string): Partial<SubscriptionRecord> {
  const priceMatch = text.match(/(\d+(?:\.\d+)?)\s*(美元|美金|USD|元|CNY|人民币|日元|JPY|欧元|EUR|港币|HKD)?/i);
  const cycle = text.includes('每年') || text.includes('年付') ? 'yearly' : text.includes('一次') ? 'one_time' : 'monthly';
  const name = text
    .replace(/^(记录|新增|添加|创建)/, '')
    .replace(/每月|每年|月付|年付|订阅|续费/g, ' ')
    .replace(/\d+(?:\.\d+)?\s*(美元|美金|USD|元|CNY|人民币|日元|JPY|欧元|EUR|港币|HKD)?/gi, ' ')
    .replace(/\d{1,2}号.*/, ' ')
    .trim();
  return {
    name: name || '未命名订阅',
    price: priceMatch ? Number(priceMatch[1]) : 0,
    currency: currencyFromText(priceMatch?.[2]),
    billing_cycle: cycle,
    next_renewal_at: extractRenewalDay(text),
    raw_input: text
  };
}

function currencyFromText(value?: string): SubscriptionRecord['currency'] {
  if (!value) return 'CNY';
  const upper = value.toUpperCase();
  if (upper.includes('USD') || value.includes('美元') || value.includes('美金')) return 'USD';
  if (upper.includes('HKD') || value.includes('港币')) return 'HKD';
  if (upper.includes('JPY') || value.includes('日元')) return 'JPY';
  if (upper.includes('EUR') || value.includes('欧元')) return 'EUR';
  return 'CNY';
}

function extractRenewalDay(text: string): string | undefined {
  const day = Number(text.match(/(\d{1,2})号/)?.[1]);
  if (!day) return undefined;
  const date = new Date();
  date.setDate(day);
  date.setHours(9, 0, 0, 0);
  if (date.getTime() < Date.now()) date.setMonth(date.getMonth() + 1);
  return date.toISOString();
}

function extractDateTime(text: string): string | undefined {
  if (!hasAny(text, ['今天', '明天', '后天'])) return undefined;
  const date = new Date();
  if (text.includes('明天')) date.setDate(date.getDate() + 1);
  if (text.includes('后天')) date.setDate(date.getDate() + 2);
  const hour = Number(text.match(/(\d{1,2})点/)?.[1] ?? (text.includes('下午') ? 15 : 9));
  date.setHours(text.includes('下午') && hour < 12 ? hour + 12 : hour, 0, 0, 0);
  return date.toISOString();
}

function formatList(title: string, items: string[]): string {
  if (items.length === 0) return `${title}：暂无。`;
  return `${title}：\n${items.map((item, index) => `${index + 1}. ${item}`).join('\n')}`;
}

