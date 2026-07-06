import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomInt } from 'node:crypto';

export type Source = 'wechat' | 'admin';

export type TaskRecord = {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'done' | 'canceled';
  due_at?: string;
  remind_at?: string;
  priority: 'low' | 'medium' | 'high';
  source: Source;
  raw_input: string;
  created_at: string;
};

export type BookmarkRecord = {
  id: string;
  title: string;
  url: string;
  tags: string[];
  summary: string;
  saved_at: string;
  source: Source;
  raw_input: string;
};

export type SubscriptionRecord = {
  id: string;
  name: string;
  price: number;
  currency: 'CNY' | 'USD' | 'HKD' | 'JPY' | 'EUR';
  billing_cycle: 'monthly' | 'yearly' | 'one_time';
  next_renewal_at?: string;
  remind_at?: string;
  status: 'active' | 'paused' | 'canceled';
  raw_input: string;
  created_at: string;
};

export type ReminderRecord = {
  id: string;
  title: string;
  remind_at?: string;
  related_type: 'task' | 'bookmark' | 'subscription' | 'standalone';
  related_page_id?: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'channel_unavailable' | 'cancelled';
  raw_input: string;
  created_at: string;
};

export type MessageLogRecord = {
  id: string;
  idempotency_key: string;
  raw_input: string;
  component: 'task' | 'bookmark' | 'subscription' | 'reminder' | 'unsupported';
  status: 'processed' | 'failed' | 'ignored';
  error?: string;
  created_at: string;
};

export type RetryJobRecord = {
  id: string;
  idempotency_key: string;
  raw_input: string;
  source: Source;
  component: MessageLogRecord['component'];
  status: 'failed' | 'retried';
  retry_count: number;
  last_error: string;
  created_at: string;
  retried_at?: string;
};

export type NotionRecords = {
  tasks: TaskRecord[];
  bookmarks: BookmarkRecord[];
  subscriptions: SubscriptionRecord[];
  reminders: ReminderRecord[];
};

export type ComponentKey = keyof NotionRecords;

export type BindingRecord = {
  id: string;
  openid_hash: string;
  instance_id: string;
  local_user_id: string;
  status: 'active' | 'revoked';
  bound_at: string;
  revoked_at?: string;
};

export type DemoSettings = {
  llm: {
    provider_name: string;
    base_url: string;
    model: string;
    temperature: number;
    supports_response_format: boolean;
    enabled: boolean;
    api_key_set: boolean;
  };
  notion: {
    token_set: boolean;
    databases: Record<keyof NotionRecords, string>;
  };
  gateway: {
    url: string;
    instance_id: string;
    relay_status: 'local' | 'connected' | 'offline';
  };
  wechat: {
    service_account_name: string;
    bound_openid_hash: string;
  };
  components: Record<ComponentKey, { enabled: boolean }>;
  security: {
    mask_secrets: boolean;
    debug_logging: boolean;
  };
};

export type Secrets = {
  llm_api_key?: string;
  notion_token?: string;
};

export type TemplateCheck = {
  template_version: string;
  status: 'ok' | 'failed';
  databases: Record<keyof NotionRecords, {
    database_id: string;
    status: 'ok' | 'failed';
    missing_fields: string[];
    wrong_type_fields: string[];
    missing_options: string[];
    last_checked_at: string;
  }>;
};

type StoreFile = NotionRecords & {
  processed_keys: string[];
  message_logs?: MessageLogRecord[];
  retry_jobs?: RetryJobRecord[];
  auth_codes?: AuthCodeRecord[];
  bindings?: BindingRecord[];
  settings?: DemoSettings;
  secrets?: Secrets;
};

type AuthCodeRecord = {
  id: string;
  code_hash: string;
  instance_id: string;
  local_user_id: string;
  expires_at: string;
  used_at?: string;
  created_at: string;
};

export class MemoryNotionAdapter {
  records: NotionRecords = {
    tasks: [],
    bookmarks: [],
    subscriptions: [],
    reminders: []
  };

  settings: DemoSettings = defaultSettings();

  secrets: Secrets = {};

  messageLogs: MessageLogRecord[] = [];

  retryJobs: RetryJobRecord[] = [];

  authCodes: AuthCodeRecord[] = [];

  bindings: BindingRecord[] = [];

  protected processedKeys = new Set<string>();

  async hasProcessed(idempotencyKey: string): Promise<boolean> {
    return this.processedKeys.has(idempotencyKey);
  }

  async markProcessed(idempotencyKey: string): Promise<void> {
    this.processedKeys.add(idempotencyKey);
    await this.persist();
  }

  async logMessage(fields: Omit<MessageLogRecord, 'id' | 'created_at'>): Promise<MessageLogRecord> {
    const record = { id: newId('log'), created_at: now(), ...fields };
    this.messageLogs.unshift(record);
    this.messageLogs = this.messageLogs.slice(0, 50);
    await this.persist();
    return record;
  }

  async recordFailedJob(fields: Omit<RetryJobRecord, 'id' | 'status' | 'retry_count' | 'created_at'>): Promise<RetryJobRecord> {
    const existing = this.retryJobs.find((job) => job.idempotency_key === fields.idempotency_key && job.status === 'failed');
    if (existing) {
      existing.retry_count += 1;
      existing.last_error = fields.last_error;
      await this.persist();
      return existing;
    }
    const record = { id: newId('retry'), status: 'failed' as const, retry_count: 0, created_at: now(), ...fields };
    this.retryJobs.unshift(record);
    await this.persist();
    return record;
  }

  findRetryJob(id: string): RetryJobRecord | undefined {
    return this.retryJobs.find((job) => job.id === id);
  }

  async markRetryJobRetried(id: string): Promise<void> {
    const job = this.findRetryJob(id);
    if (!job) return;
    job.status = 'retried';
    job.retry_count += 1;
    job.retried_at = now();
    await this.persist();
  }

  async create_task(fields: Omit<TaskRecord, 'id' | 'created_at'>): Promise<TaskRecord> {
    this.assertTemplateReady('tasks');
    const record = { id: newId('task'), created_at: now(), ...fields };
    this.records.tasks.push(record);
    await this.persist();
    return record;
  }

  async create_bookmark(fields: Omit<BookmarkRecord, 'id' | 'saved_at'>): Promise<BookmarkRecord> {
    this.assertTemplateReady('bookmarks');
    const record = { id: newId('bookmark'), saved_at: now(), ...fields };
    this.records.bookmarks.push(record);
    await this.persist();
    return record;
  }

  async create_subscription(fields: Omit<SubscriptionRecord, 'id' | 'created_at'>): Promise<SubscriptionRecord> {
    this.assertTemplateReady('subscriptions');
    const record = { id: newId('subscription'), created_at: now(), ...fields };
    this.records.subscriptions.push(record);
    await this.persist();
    return record;
  }

  async create_reminder(fields: Omit<ReminderRecord, 'id' | 'created_at'>): Promise<ReminderRecord> {
    this.assertTemplateReady('reminders');
    const record = { id: newId('reminder'), created_at: now(), ...fields };
    this.records.reminders.push(record);
    await this.persist();
    return record;
  }

  async update_task_status(taskId: string, status: TaskRecord['status']): Promise<TaskRecord | undefined> {
    const record = this.records.tasks.find((item) => item.id === taskId);
    if (!record) return undefined;
    record.status = status;
    await this.persist();
    return record;
  }

  async update_subscription_status(subscriptionId: string, status: SubscriptionRecord['status']): Promise<SubscriptionRecord | undefined> {
    const record = this.records.subscriptions.find((item) => item.id === subscriptionId);
    if (!record) return undefined;
    record.status = status;
    await this.persist();
    return record;
  }

  async update_reminder_status(reminderId: string, status: ReminderRecord['status']): Promise<ReminderRecord | undefined> {
    const record = this.records.reminders.find((item) => item.id === reminderId);
    if (!record) return undefined;
    record.status = status;
    await this.persist();
    return record;
  }

  async query_tasks(): Promise<TaskRecord[]> {
    return [...this.records.tasks].reverse().slice(0, 10);
  }

  async query_bookmarks(): Promise<BookmarkRecord[]> {
    return [...this.records.bookmarks].reverse().slice(0, 10);
  }

  async query_subscriptions(): Promise<SubscriptionRecord[]> {
    return [...this.records.subscriptions].reverse().slice(0, 10);
  }

  async query_reminders(): Promise<ReminderRecord[]> {
    return [...this.records.reminders]
      .filter((item) => item.status === 'pending')
      .sort((a, b) => String(a.remind_at).localeCompare(String(b.remind_at)));
  }

  async saveSettings(settings: Partial<DemoSettings>): Promise<void> {
    this.settings = mergeSettings(this.settings, settings);
    await this.persist();
  }

  async saveSecrets(secrets: Secrets): Promise<void> {
    this.secrets = { ...this.secrets, ...withoutEmptySecrets(secrets) };
    this.settings = mergeSettings(this.settings, {
      llm: { api_key_set: this.hasLlmKey() },
      notion: { token_set: this.hasNotionToken() }
    });
    await this.persist();
  }

  hasLlmKey(): boolean {
    return Boolean(this.getLlmApiKey());
  }

  getLlmApiKey(): string {
    return this.secrets.llm_api_key ?? process.env.LLM_API_KEY ?? '';
  }

  hasNotionToken(): boolean {
    return Boolean(this.getNotionToken());
  }

  getNotionToken(): string {
    return this.secrets.notion_token ?? process.env.NOTION_TOKEN ?? '';
  }

  async createAuthCode(localUserId = 'admin'): Promise<{ code: string; expires_at: string }> {
    const code = String(randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    this.authCodes.unshift({
      id: newId('code'),
      code_hash: hashValue(code),
      instance_id: this.settings.gateway.instance_id,
      local_user_id: localUserId,
      expires_at: expiresAt,
      created_at: now()
    });
    this.authCodes = this.authCodes.slice(0, 20);
    await this.persist();
    return { code, expires_at: expiresAt };
  }

  async bindOpenid(code: string, openid: string): Promise<BindingRecord> {
    const authCode = this.authCodes.find((item) => item.code_hash === hashValue(code));
    if (!authCode) throw new Error('登录码不存在');
    if (authCode.used_at) throw new Error('登录码已使用');
    if (Date.parse(authCode.expires_at) < Date.now()) throw new Error('登录码已过期');

    const openidHash = hashValue(openid);
    for (const binding of this.bindings) {
      if (binding.openid_hash === openidHash && binding.status === 'active') {
        binding.status = 'revoked';
        binding.revoked_at = now();
      }
    }

    authCode.used_at = now();
    const binding = {
      id: newId('binding'),
      openid_hash: openidHash,
      instance_id: authCode.instance_id,
      local_user_id: authCode.local_user_id,
      status: 'active' as const,
      bound_at: now()
    };
    this.bindings.unshift(binding);
    this.settings = mergeSettings(this.settings, { wechat: { bound_openid_hash: maskHash(openidHash) } });
    await this.persist();
    return binding;
  }

  async unbindActiveBinding(): Promise<boolean> {
    const binding = this.activeBinding();
    if (!binding) return false;
    binding.status = 'revoked';
    binding.revoked_at = now();
    this.settings = mergeSettings(this.settings, { wechat: { bound_openid_hash: '' } });
    await this.persist();
    return true;
  }

  activeBinding(): BindingRecord | undefined {
    return this.bindings.find((binding) => binding.status === 'active');
  }

  validateTemplates(): TemplateCheck {
    const checkedAt = now();
    const databases = Object.fromEntries(
      (Object.keys(templateFields) as (keyof NotionRecords)[]).map((key) => {
        const databaseId = this.settings.notion.databases[key]?.trim() ?? '';
        return [key, {
          database_id: databaseId,
          status: databaseId ? 'ok' : 'failed',
          missing_fields: databaseId ? [] : templateFields[key],
          wrong_type_fields: [],
          missing_options: [],
          last_checked_at: checkedAt
        }];
      })
    ) as TemplateCheck['databases'];

    return {
      template_version: 'local-v0',
      status: Object.values(databases).every((item) => item.status === 'ok') ? 'ok' : 'failed',
      databases
    };
  }

  async checkTemplates(): Promise<TemplateCheck> {
    return this.validateTemplates();
  }

  protected async persist(): Promise<void> {
  }

  private assertTemplateReady(key: keyof NotionRecords): void {
    const result = this.validateTemplates().databases[key];
    if (result.status !== 'ok') {
      throw new Error(`${key} template is missing: ${result.missing_fields.join(', ')}`);
    }
  }
}

export class FileNotionAdapter extends MemoryNotionAdapter {
  private readonly filePath: string;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const file = JSON.parse(await readFile(this.filePath, 'utf8')) as StoreFile;
      this.records = {
        tasks: file.tasks ?? [],
        bookmarks: file.bookmarks ?? [],
        subscriptions: file.subscriptions ?? [],
        reminders: file.reminders ?? []
      };
      this.processedKeys = new Set(file.processed_keys ?? []);
      this.messageLogs = file.message_logs ?? [];
      this.retryJobs = file.retry_jobs ?? [];
      this.authCodes = file.auth_codes ?? [];
      this.bindings = file.bindings ?? [];
      this.secrets = file.secrets ?? {};
      if (process.env.LLM_API_KEY) this.secrets.llm_api_key = process.env.LLM_API_KEY;
      if (process.env.NOTION_TOKEN) this.secrets.notion_token = process.env.NOTION_TOKEN;
      this.settings = mergeSettings(defaultSettings(), file.settings ?? {});
      this.settings = mergeSettings(this.settings, {
        llm: { api_key_set: this.hasLlmKey() },
        notion: { token_set: this.hasNotionToken() }
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        throw error;
      }
      this.secrets = withoutEmptySecrets({
        llm_api_key: process.env.LLM_API_KEY,
        notion_token: process.env.NOTION_TOKEN
      });
      this.settings = mergeSettings(this.settings, {
        llm: { api_key_set: this.hasLlmKey() },
        notion: { token_set: this.hasNotionToken() }
      });
    }
  }

  protected override async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const file: StoreFile = {
      ...this.records,
      processed_keys: [...this.processedKeys],
      message_logs: this.messageLogs,
      retry_jobs: this.retryJobs,
      auth_codes: this.authCodes,
      bindings: this.bindings,
      settings: this.settings,
      secrets: this.secrets
    };
    await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  }

  override async create_task(fields: Omit<TaskRecord, 'id' | 'created_at'>): Promise<TaskRecord> {
    const page = await this.createPage('tasks', taskProperties(fields));
    if (!page) return super.create_task(fields);
    const record = { id: page.id, created_at: now(), ...fields };
    this.records.tasks.push(record);
    await this.persist();
    return record;
  }

  override async create_bookmark(fields: Omit<BookmarkRecord, 'id' | 'saved_at'>): Promise<BookmarkRecord> {
    const page = await this.createPage('bookmarks', bookmarkProperties(fields));
    if (!page) return super.create_bookmark(fields);
    const record = { id: page.id, saved_at: now(), ...fields };
    this.records.bookmarks.push(record);
    await this.persist();
    return record;
  }

  override async create_subscription(fields: Omit<SubscriptionRecord, 'id' | 'created_at'>): Promise<SubscriptionRecord> {
    const page = await this.createPage('subscriptions', subscriptionProperties(fields));
    if (!page) return super.create_subscription(fields);
    const record = { id: page.id, created_at: now(), ...fields };
    this.records.subscriptions.push(record);
    await this.persist();
    return record;
  }

  override async create_reminder(fields: Omit<ReminderRecord, 'id' | 'created_at'>): Promise<ReminderRecord> {
    const page = await this.createPage('reminders', reminderProperties(fields));
    if (!page) return super.create_reminder(fields);
    const record = { id: page.id, created_at: now(), ...fields };
    this.records.reminders.push(record);
    await this.persist();
    return record;
  }

  override async update_task_status(taskId: string, status: TaskRecord['status']): Promise<TaskRecord | undefined> {
    if (this.isRemotePage(taskId)) await this.updatePage(taskId, { Status: selectProp(status) });
    return super.update_task_status(taskId, status);
  }

  override async update_subscription_status(subscriptionId: string, status: SubscriptionRecord['status']): Promise<SubscriptionRecord | undefined> {
    if (this.isRemotePage(subscriptionId)) await this.updatePage(subscriptionId, { Status: selectProp(status) });
    return super.update_subscription_status(subscriptionId, status);
  }

  override async update_reminder_status(reminderId: string, status: ReminderRecord['status']): Promise<ReminderRecord | undefined> {
    if (this.isRemotePage(reminderId)) await this.updatePage(reminderId, { Status: selectProp(status) });
    return super.update_reminder_status(reminderId, status);
  }

  override async query_tasks(): Promise<TaskRecord[]> {
    const pages = await this.queryPages('tasks');
    if (!pages) return super.query_tasks();
    this.records.tasks = pages.map(taskFromPage);
    await this.persist();
    return this.records.tasks;
  }

  override async query_bookmarks(): Promise<BookmarkRecord[]> {
    const pages = await this.queryPages('bookmarks');
    if (!pages) return super.query_bookmarks();
    this.records.bookmarks = pages.map(bookmarkFromPage);
    await this.persist();
    return this.records.bookmarks;
  }

  override async query_subscriptions(): Promise<SubscriptionRecord[]> {
    const pages = await this.queryPages('subscriptions');
    if (!pages) return super.query_subscriptions();
    this.records.subscriptions = pages.map(subscriptionFromPage);
    await this.persist();
    return this.records.subscriptions;
  }

  override async query_reminders(): Promise<ReminderRecord[]> {
    const pages = await this.queryPages('reminders', {
      filter: { property: 'Status', select: { equals: 'pending' } },
      sorts: [{ property: 'Remind At', direction: 'ascending' }]
    });
    if (!pages) return super.query_reminders();
    this.records.reminders = pages.map(reminderFromPage);
    await this.persist();
    return this.records.reminders;
  }

  override async checkTemplates(): Promise<TemplateCheck> {
    if (!this.hasNotionToken()) return this.validateTemplates();
    const checkedAt = now();
    const databases = Object.fromEntries(
      await Promise.all((Object.keys(templateSpecs) as (keyof NotionRecords)[]).map(async (key) => {
        const databaseId = this.remoteDatabaseId(key);
        if (!databaseId) {
          return [key, {
            database_id: this.settings.notion.databases[key] ?? '',
            status: 'failed',
            missing_fields: templateFields[key],
            wrong_type_fields: [],
            missing_options: [],
            last_checked_at: checkedAt
          }];
        }
        try {
          const database = await this.notionFetch<NotionDatabase>(`/databases/${encodeURIComponent(databaseId)}`);
          return [key, checkDatabase(key, database, checkedAt)];
        } catch (error) {
          return [key, {
            database_id: databaseId,
            status: 'failed',
            missing_fields: [],
            wrong_type_fields: [error instanceof Error ? error.message : String(error)],
            missing_options: [],
            last_checked_at: checkedAt
          }];
        }
      }))
    ) as TemplateCheck['databases'];

    return {
      template_version: 'notion-rest-v1',
      status: Object.values(databases).every((item) => item.status === 'ok') ? 'ok' : 'failed',
      databases
    };
  }

  private async createPage(key: keyof NotionRecords, properties: NotionProperties): Promise<NotionPage | undefined> {
    const databaseId = this.remoteDatabaseId(key);
    if (!databaseId) return undefined;
    return this.notionFetch<NotionPage>('/pages', {
      method: 'POST',
      body: JSON.stringify({ parent: { database_id: databaseId }, properties })
    });
  }

  private async updatePage(pageId: string, properties: NotionProperties): Promise<void> {
    await this.notionFetch(`/pages/${encodeURIComponent(pageId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties })
    });
  }

  private async queryPages(key: keyof NotionRecords, extra: Record<string, unknown> = {}): Promise<NotionPage[] | undefined> {
    const databaseId = this.remoteDatabaseId(key);
    if (!databaseId) return undefined;
    const body = { page_size: 10, sorts: [{ timestamp: 'created_time', direction: 'descending' }], ...extra };
    const result = await this.notionFetch<{ results: NotionPage[] }>(`/databases/${encodeURIComponent(databaseId)}/query`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    return result.results;
  }

  private remoteDatabaseId(key: keyof NotionRecords): string {
    const databaseId = this.settings.notion.databases[key]?.trim() ?? '';
    return this.hasNotionToken() && databaseId && !databaseId.startsWith('local_') ? databaseId : '';
  }

  private isRemotePage(id: string): boolean {
    return this.hasNotionToken() && !/^(task|bookmark|subscription|reminder)_/.test(id);
  }

  private async notionFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`https://api.notion.com/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.getNotionToken()}`,
        'content-type': 'application/json',
        'notion-version': '2022-06-28',
        ...(init.headers ?? {})
      }
    });
    const body = await response.json().catch(() => ({})) as { message?: string };
    if (!response.ok) throw new Error(body.message ?? `Notion API ${response.status}`);
    return body as T;
  }
}

type NotionProperties = Record<string, Record<string, unknown>>;
type NotionPage = {
  id: string;
  created_time?: string;
  properties: Record<string, NotionProperty>;
};
type NotionDatabase = {
  id: string;
  properties: Record<string, { type: string; select?: { options?: { name: string }[] }; multi_select?: { options?: { name: string }[] } }>;
};
type NotionProperty = {
  title?: { plain_text?: string }[];
  rich_text?: { plain_text?: string }[];
  select?: { name?: string };
  multi_select?: { name?: string }[];
  number?: number;
  url?: string;
  date?: { start?: string };
};

const templateSpecs = {
  tasks: {
    Title: { type: 'title' },
    Status: { type: 'select', options: ['todo', 'doing', 'done', 'canceled'] },
    'Due At': { type: 'date' },
    'Remind At': { type: 'date' },
    Priority: { type: 'select', options: ['low', 'medium', 'high'] },
    Source: { type: 'select', options: ['wechat', 'admin'] },
    'Raw Input': { type: 'rich_text' }
  },
  bookmarks: {
    Title: { type: 'title' },
    URL: { type: 'url' },
    Tags: { type: 'multi_select' },
    Summary: { type: 'rich_text' },
    'Saved At': { type: 'date' },
    Source: { type: 'select', options: ['wechat', 'admin'] },
    'Raw Input': { type: 'rich_text' }
  },
  subscriptions: {
    Name: { type: 'title' },
    Price: { type: 'number' },
    Currency: { type: 'select', options: ['CNY', 'USD', 'HKD', 'JPY', 'EUR'] },
    'Billing Cycle': { type: 'select', options: ['monthly', 'yearly', 'one_time'] },
    'Next Renewal At': { type: 'date' },
    'Remind At': { type: 'date' },
    Status: { type: 'select', options: ['active', 'paused', 'canceled'] },
    'Raw Input': { type: 'rich_text' }
  },
  reminders: {
    Title: { type: 'title' },
    'Remind At': { type: 'date' },
    Status: { type: 'select', options: ['pending', 'sending', 'sent', 'failed', 'channel_unavailable', 'cancelled'] },
    'Related Type': { type: 'select', options: ['task', 'bookmark', 'subscription', 'standalone'] },
    'Related Page ID': { type: 'rich_text' },
    'Raw Input': { type: 'rich_text' }
  }
} satisfies Record<keyof NotionRecords, Record<string, { type: string; options?: string[] }>>;

const templateFields = Object.fromEntries(
  Object.entries(templateSpecs).map(([key, value]) => [key, Object.keys(value)])
) as Record<keyof NotionRecords, string[]>;

function taskProperties(fields: Omit<TaskRecord, 'id' | 'created_at'>): NotionProperties {
  return cleanProps({
    Title: titleProp(fields.title),
    Status: selectProp(fields.status),
    'Due At': dateProp(fields.due_at),
    'Remind At': dateProp(fields.remind_at),
    Priority: selectProp(fields.priority),
    Source: selectProp(fields.source),
    'Raw Input': textProp(fields.raw_input)
  });
}

function bookmarkProperties(fields: Omit<BookmarkRecord, 'id' | 'saved_at'>): NotionProperties {
  return cleanProps({
    Title: titleProp(fields.title || fields.url),
    URL: { url: fields.url },
    Tags: { multi_select: fields.tags.map((name) => ({ name })) },
    Summary: textProp(fields.summary),
    'Saved At': dateProp(now()),
    Source: selectProp(fields.source),
    'Raw Input': textProp(fields.raw_input)
  });
}

function subscriptionProperties(fields: Omit<SubscriptionRecord, 'id' | 'created_at'>): NotionProperties {
  return cleanProps({
    Name: titleProp(fields.name),
    Price: { number: fields.price },
    Currency: selectProp(fields.currency),
    'Billing Cycle': selectProp(fields.billing_cycle),
    'Next Renewal At': dateProp(fields.next_renewal_at),
    'Remind At': dateProp(fields.remind_at),
    Status: selectProp(fields.status),
    'Raw Input': textProp(fields.raw_input)
  });
}

function reminderProperties(fields: Omit<ReminderRecord, 'id' | 'created_at'>): NotionProperties {
  return cleanProps({
    Title: titleProp(fields.title),
    'Remind At': dateProp(fields.remind_at),
    Status: selectProp(fields.status),
    'Related Type': selectProp(fields.related_type),
    'Related Page ID': textProp(fields.related_page_id ?? ''),
    'Raw Input': textProp(fields.raw_input)
  });
}

function taskFromPage(page: NotionPage): TaskRecord {
  return {
    id: page.id,
    title: propText(page.properties.Title),
    status: oneOf(propSelect(page.properties.Status), ['todo', 'doing', 'done', 'canceled'], 'todo'),
    due_at: propDate(page.properties['Due At']),
    remind_at: propDate(page.properties['Remind At']),
    priority: oneOf(propSelect(page.properties.Priority), ['low', 'medium', 'high'], 'medium'),
    source: oneOf(propSelect(page.properties.Source), ['wechat', 'admin'], 'admin'),
    raw_input: propText(page.properties['Raw Input']),
    created_at: page.created_time ?? now()
  };
}

function bookmarkFromPage(page: NotionPage): BookmarkRecord {
  return {
    id: page.id,
    title: propText(page.properties.Title) || propUrl(page.properties.URL),
    url: propUrl(page.properties.URL),
    tags: page.properties.Tags?.multi_select?.map((item) => item.name ?? '').filter(Boolean) ?? [],
    summary: propText(page.properties.Summary),
    saved_at: propDate(page.properties['Saved At']) ?? page.created_time ?? now(),
    source: oneOf(propSelect(page.properties.Source), ['wechat', 'admin'], 'admin'),
    raw_input: propText(page.properties['Raw Input'])
  };
}

function subscriptionFromPage(page: NotionPage): SubscriptionRecord {
  return {
    id: page.id,
    name: propText(page.properties.Name),
    price: page.properties.Price?.number ?? 0,
    currency: oneOf(propSelect(page.properties.Currency), ['CNY', 'USD', 'HKD', 'JPY', 'EUR'], 'CNY'),
    billing_cycle: oneOf(propSelect(page.properties['Billing Cycle']), ['monthly', 'yearly', 'one_time'], 'monthly'),
    next_renewal_at: propDate(page.properties['Next Renewal At']),
    remind_at: propDate(page.properties['Remind At']),
    status: oneOf(propSelect(page.properties.Status), ['active', 'paused', 'canceled'], 'active'),
    raw_input: propText(page.properties['Raw Input']),
    created_at: page.created_time ?? now()
  };
}

function reminderFromPage(page: NotionPage): ReminderRecord {
  return {
    id: page.id,
    title: propText(page.properties.Title),
    remind_at: propDate(page.properties['Remind At']),
    related_type: oneOf(propSelect(page.properties['Related Type']), ['task', 'bookmark', 'subscription', 'standalone'], 'standalone'),
    related_page_id: propText(page.properties['Related Page ID']) || undefined,
    status: oneOf(propSelect(page.properties.Status), ['pending', 'sending', 'sent', 'failed', 'channel_unavailable', 'cancelled'], 'pending'),
    raw_input: propText(page.properties['Raw Input']),
    created_at: page.created_time ?? now()
  };
}

function checkDatabase(key: keyof NotionRecords, database: NotionDatabase, checkedAt: string): TemplateCheck['databases'][keyof NotionRecords] {
  const spec = templateSpecs[key];
  const missingFields: string[] = [];
  const wrongTypeFields: string[] = [];
  const missingOptions: string[] = [];
  for (const [name, expected] of Object.entries(spec)) {
    const actual = database.properties[name];
    if (!actual) {
      missingFields.push(name);
      continue;
    }
    if (actual.type !== expected.type) wrongTypeFields.push(`${name}: ${actual.type} != ${expected.type}`);
    const options = expected.type === 'multi_select' ? actual.multi_select?.options : actual.select?.options;
    const names = new Set(options?.map((option) => option.name) ?? []);
    for (const option of expected.options ?? []) {
      if (!names.has(option)) missingOptions.push(`${name}.${option}`);
    }
  }
  return {
    database_id: database.id,
    status: missingFields.length || wrongTypeFields.length || missingOptions.length ? 'failed' : 'ok',
    missing_fields: missingFields,
    wrong_type_fields: wrongTypeFields,
    missing_options: missingOptions,
    last_checked_at: checkedAt
  };
}

function titleProp(value: string): NotionProperties[string] {
  return { title: [{ text: { content: value.slice(0, 2000) } }] };
}

function textProp(value: string): NotionProperties[string] {
  return { rich_text: value ? [{ text: { content: value.slice(0, 2000) } }] : [] };
}

function selectProp(name: string): NotionProperties[string] {
  return { select: { name } };
}

function dateProp(value?: string): NotionProperties[string] | undefined {
  return value ? { date: { start: value } } : undefined;
}

function cleanProps(value: Record<string, NotionProperties[string] | undefined>): NotionProperties {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, NotionProperties[string]] => Boolean(entry[1])));
}

function propText(prop?: NotionProperty): string {
  return [...(prop?.title ?? []), ...(prop?.rich_text ?? [])].map((item) => item.plain_text ?? '').join('');
}

function propSelect(prop?: NotionProperty): string | undefined {
  return prop?.select?.name;
}

function propUrl(prop?: NotionProperty): string {
  return prop?.url ?? '';
}

function propDate(prop?: NotionProperty): string | undefined {
  return prop?.date?.start;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function withoutEmptySecrets(secrets: Secrets): Secrets {
  return Object.fromEntries(Object.entries(secrets).filter(([, value]) => Boolean(value?.trim()))) as Secrets;
}

function defaultSettings(): DemoSettings {
  return {
    llm: {
      provider_name: 'OpenAI-compatible',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      temperature: 0,
      supports_response_format: true,
      enabled: true,
      api_key_set: false
    },
    notion: {
      token_set: false,
      databases: {
        tasks: 'local_tasks',
        bookmarks: 'local_bookmarks',
        subscriptions: 'local_subscriptions',
        reminders: 'local_reminders'
      }
    },
    gateway: {
      url: 'local://gateway',
      instance_id: 'local-instance',
      relay_status: 'local'
    },
    wechat: {
      service_account_name: '本地服务号模拟',
      bound_openid_hash: ''
    },
    components: {
      tasks: { enabled: true },
      bookmarks: { enabled: true },
      subscriptions: { enabled: true },
      reminders: { enabled: true }
    },
    security: {
      mask_secrets: true,
      debug_logging: false
    }
  };
}

function mergeSettings(current: DemoSettings, next: Partial<DemoSettings>): DemoSettings {
  return {
    llm: { ...current.llm, ...(next.llm ?? {}) },
    notion: {
      ...current.notion,
      ...(next.notion ?? {}),
      databases: { ...current.notion.databases, ...(next.notion?.databases ?? {}) }
    },
    gateway: { ...current.gateway, ...(next.gateway ?? {}) },
    wechat: { ...current.wechat, ...(next.wechat ?? {}) },
    components: { ...current.components, ...(next.components ?? {}) },
    security: { ...current.security, ...(next.security ?? {}) }
  };
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function maskHash(value: string): string {
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}
