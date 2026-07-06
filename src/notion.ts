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
      this.settings = mergeSettings(defaultSettings(), file.settings ?? {});
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        throw error;
      }
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
      settings: this.settings
    };
    await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  }
}

const templateFields: Record<keyof NotionRecords, string[]> = {
  tasks: ['Title', 'Status', 'Due At', 'Remind At', 'Priority', 'Source', 'Raw Input'],
  bookmarks: ['Title', 'URL', 'Tags', 'Summary', 'Saved At', 'Source', 'Raw Input'],
  subscriptions: ['Name', 'Price', 'Currency', 'Billing Cycle', 'Next Renewal At', 'Remind At', 'Status', 'Raw Input'],
  reminders: ['Title', 'Remind At', 'Status', 'Related Type', 'Related Page ID', 'Raw Input']
};

function defaultSettings(): DemoSettings {
  return {
    llm: {
      provider_name: 'Local rules',
      base_url: 'local://rules',
      model: 'v0-rule-parser',
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


