import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MiniAgent } from './agent.ts';
import { MemoryNotionAdapter } from './notion.ts';

test('creates one task for duplicate message deliveries', async () => {
  const notion = new MemoryNotionAdapter();
  const agent = new MiniAgent(notion);

  const first = await agent.handleMessage({
    idempotencyKey: 'wechat-msg-1',
    text: '明天下午3点提醒我跟进报价',
    source: 'wechat'
  });
  const second = await agent.handleMessage({
    idempotencyKey: 'wechat-msg-1',
    text: '明天下午3点提醒我跟进报价',
    source: 'wechat'
  });

  assert.match(first.reply, /已添加提醒/);
  assert.match(second.reply, /已处理过/);
  assert.equal(notion.records.reminders.length, 1);
});

test('creates bookmarks and uses the URL as fallback title', async () => {
  const notion = new MemoryNotionAdapter();
  const agent = new MiniAgent(notion);

  const result = await agent.handleMessage({
    idempotencyKey: 'wechat-msg-2',
    text: '收藏 https://example.com 这篇文章',
    source: 'wechat'
  });

  assert.match(result.reply, /已添加收藏/);
  assert.equal(notion.records.bookmarks[0]?.title, 'https://example.com');
});

test('creates all four V0 demo record types', async () => {
  const notion = new MemoryNotionAdapter();
  const agent = new MiniAgent(notion);

  await agent.handleMessage({
    idempotencyKey: 'admin-task',
    text: '新增任务写周报',
    source: 'admin'
  });
  await agent.handleMessage({
    idempotencyKey: 'admin-bookmark',
    text: '收藏 https://example.com',
    source: 'admin'
  });
  await agent.handleMessage({
    idempotencyKey: 'admin-subscription',
    text: '记录 Cursor Pro 每月20美元，5号续费',
    source: 'admin'
  });
  await agent.handleMessage({
    idempotencyKey: 'admin-reminder',
    text: '明天下午3点提醒我跟进报价',
    source: 'admin'
  });

  assert.equal(notion.records.tasks.length, 1);
  assert.equal(notion.records.bookmarks.length, 1);
  assert.equal(notion.records.subscriptions.length, 1);
  assert.equal(notion.records.reminders.length, 1);
});

test('blocks writes when a fixed Notion template is not configured', async () => {
  const notion = new MemoryNotionAdapter();
  const agent = new MiniAgent(notion);

  await notion.saveSettings({ notion: { token_set: false, databases: { tasks: '' } } });
  const blocked = await agent.handleMessage({
    idempotencyKey: 'admin-template-retry',
    text: '新增任务写周报',
    source: 'admin'
  });

  await notion.saveSettings({ notion: { token_set: false, databases: { tasks: 'local_tasks' } } });
  const retried = await agent.handleMessage({
    idempotencyKey: 'admin-template-retry',
    text: '新增任务写周报',
    source: 'admin'
  });

  assert.match(blocked.reply, /写入失败/);
  assert.match(retried.reply, /已添加任务/);
  assert.equal(notion.records.tasks.length, 1);
});

test('records failed writes for manual retry', async () => {
  const notion = new MemoryNotionAdapter();
  const agent = new MiniAgent(notion);

  await notion.saveSettings({ notion: { token_set: false, databases: { reminders: '' } } });
  const result = await agent.handleMessage({
    idempotencyKey: 'admin-failed-reminder',
    text: '明天下午3点提醒我跟进报价',
    source: 'admin'
  });

  assert.match(result.reply, /写入失败/);
  assert.equal(notion.messageLogs[0]?.status, 'failed');
  assert.equal(notion.retryJobs.length, 1);
  assert.equal(notion.retryJobs[0]?.idempotency_key, 'admin-failed-reminder');
});

test('does not write unsupported messages', async () => {
  const notion = new MemoryNotionAdapter();
  const agent = new MiniAgent(notion);

  const result = await agent.handleMessage({
    idempotencyKey: 'wechat-msg-3',
    text: '帮我订一张机票',
    source: 'wechat'
  });

  assert.match(result.reply, /暂时只支持/);
  assert.equal(notion.records.tasks.length, 0);
  assert.equal(notion.records.bookmarks.length, 0);
  assert.equal(notion.records.subscriptions.length, 0);
  assert.equal(notion.records.reminders.length, 0);
});

test('does not write disabled components', async () => {
  const notion = new MemoryNotionAdapter();
  const agent = new MiniAgent(notion);

  await notion.saveSettings({ components: { reminders: { enabled: false } } });
  const result = await agent.handleMessage({
    idempotencyKey: 'admin-disabled-reminder',
    text: '明天下午3点提醒我跟进报价',
    source: 'admin'
  });

  assert.match(result.reply, /提醒组件已停用/);
  assert.equal(notion.records.reminders.length, 0);
});

test('updates task status from a message', async () => {
  const notion = new MemoryNotionAdapter();
  const agent = new MiniAgent(notion);

  await agent.handleMessage({
    idempotencyKey: 'admin-status-task-create',
    text: '新增任务写周报',
    source: 'admin'
  });
  const result = await agent.handleMessage({
    idempotencyKey: 'admin-status-task-done',
    text: '完成任务写周报',
    source: 'admin'
  });

  assert.match(result.reply, /已更新任务/);
  assert.equal(notion.records.tasks[0]?.status, 'done');
});

test('binds a local openid with a one-time auth code', async () => {
  const notion = new MemoryNotionAdapter();
  const authCode = await notion.createAuthCode();
  const binding = await notion.bindOpenid(authCode.code, 'openid-1');

  assert.equal(binding.status, 'active');
  assert.equal(notion.activeBinding()?.id, binding.id);
  await assert.rejects(() => notion.bindOpenid(authCode.code, 'openid-1'), /已使用/);
});
