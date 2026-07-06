# PRD：微信 + Notion 自部署 Mini Agent

## 1. 摘要

本需求书定义一个自部署 Mini Agent：用户通过同一个微信服务号发送消息，中心 Gateway 将消息路由到对应用户自己的 Agent 服务，再由该 Agent 调用用户自己的 LLM 和 Notion 配置完成处理。

第一版只支持四类固定组件：任务管理、收藏夹、软件订阅、提醒。Notion 只适配固定模板；LLM 使用 OpenAI-compatible API，可在后台更换；提醒遵守微信服务号消息发送限制，不承诺 100% 主动推送成功。

## 2. 产品原则

```text
公众号统一入口
用户数据自部署处理
LLM 可替换
Notion 固定模板
Gateway 不碰用户 Notion Token / LLM Key
提醒遵守微信发送限制
```

## 3. 角色与职责

| 角色 | 职责 |
|---|---|
| 公众号管理员 | 管理服务号、配置回调 URL、维护消息模板 |
| Gateway 管理员 | 部署中心 Gateway，维护实例注册、路由和发送通道 |
| 自部署用户 | 部署自己的 Agent，配置 LLM、Notion、组件和绑定 |
| 后端工程师 | 实现 Gateway、Relay、Agent、队列、Notion 适配 |
| 前端工程师 | 实现自部署网页后台 |
| 测试人员 | 验证微信链路、绑定、路由、Notion 写入、提醒和异常 |

## 4. 服务号可用性判断

服务号可用于本产品的主链路。

服务号可实现：

```text
接收用户消息
识别用户 openid
被动回复
客服消息窗口内回复
模板消息 / 订阅通知类提醒
菜单跳转后台或绑定页
```

服务号不能承诺：

```text
无限制主动推送提醒
每个自部署服务直接接入同一个服务号
绕过微信消息发送规则
```

结论：

```text
可以用服务号实现输入、绑定、路由和部分提醒。
同一个服务号必须只配置一个 Gateway 回调 URL。
提醒必须按微信允许的发送通道尝试发送。
```

## 5. 总体架构

```text
微信服务号
  -> 中心 Gateway
       - 微信验签
       - 消息去重
       - openid 绑定
       - 鉴权码登录
       - 消息队列
       - Agent Relay 管理
       - 微信发送通道
  -> WebSocket Agent Relay
  -> 用户自部署 Agent
       - Agent Core
       - OpenAI-compatible LLM Adapter
       - 固定组件：任务 / 收藏 / 订阅 / 提醒
       - Notion Adapter：REST / MCP
       - Reminder Scheduler
       - 本地后台
```

## 6. 核心模块

### 6.1 中心 Gateway

Gateway 是唯一配置在微信服务号后台的回调服务。

职责：

- 接收微信回调。
- 校验微信签名。
- 对消息去重。
- 快速响应微信服务器。
- 管理自部署实例。
- 管理 openid 和 instance 绑定。
- 将消息路由到正确 Agent。
- 管理 WebSocket Relay。
- 通过微信允许的通道发送回复或提醒。
- 保存最小必要日志。

Gateway 禁止保存：

- 用户 Notion Token。
- 用户 LLM API Key。
- 用户后台密码明文。
- 完整 Notion 页面内容。
- 长期完整原始消息记录，除非用户开启调试。

### 6.2 自部署 Agent

每个用户运行自己的 Agent 服务。

职责：

- 主动连接 Gateway。
- 生成微信登录鉴权码。
- 接收 Gateway 转发消息。
- 调用用户配置的 LLM。
- 执行固定组件逻辑。
- 写入或查询用户自己的 Notion。
- 本地调度提醒。
- 提供网页后台。
- 保存本地日志和失败重试任务。

### 6.3 Agent Relay

第一版使用 WebSocket。自部署 Agent 主动连接 Gateway，避免用户必须暴露公网 HTTPS。

要求：

- Agent 连接时必须带 `instance_id`、`timestamp`、`nonce`、`signature`。
- Gateway 只通过已认证连接下发消息。
- 连接断开时实例标记为 offline。
- 离线期间消息进入待投递队列。
- Agent 重连后可继续消费待处理消息。

## 7. 账号绑定流程

```text
1. 用户打开自部署后台。
2. 点击“生成微信登录码”。
3. Agent 向 Gateway 注册一次性 code。
4. 用户在服务号发送：登录 123456。
5. Gateway 校验 code。
6. Gateway 绑定 openid -> instance_id -> local_user_id。
7. Gateway 回复：登录成功。
```

支持命令：

```text
登录 123456
当前账号
解绑
切换 123456
```

绑定规则：

- 一个 openid 同一时间只能绑定一个 active instance。
- 鉴权码一次性使用。
- 鉴权码 5 分钟过期。
- 只存 `code_hash`，不存明文 code。
- 重新绑定需要新 code。
- `解绑` 后该 openid 不能继续调用 Agent。

验收标准：

- 未登录不能创建 Notion 数据。
- 解绑后消息不再转发到旧 Agent。
- 切换后新消息只进入新 Agent。
- 过期或已使用 code 不能登录。

## 8. 普通消息处理流程

```text
1. 用户向服务号发送消息。
2. Gateway 校验微信签名。
3. Gateway 对消息去重。
4. Gateway 创建 incoming_message_job。
5. Gateway 快速返回微信服务器。
6. Gateway 根据 openid 查找 instance。
7. Gateway 通过 Relay 转发给自部署 Agent。
8. Agent 调用 LLM 做意图识别和字段抽取。
9. Agent 调用对应组件。
10. 组件写入或查询 Notion。
11. Agent 返回回复文本。
12. Gateway 通过微信允许的通道发送回复。
```

关键要求：

- 微信回调不能等待 LLM 或 Notion。
- LLM 超时不影响微信回调成功。
- 处理失败进入失败队列。
- 同一微信消息重试不会重复写 Notion。

## 9. 提醒流程

```text
1. 用户创建提醒。
2. Agent 写入 Notion Reminders 模板。
3. Agent 本地保存 reminder_send_job。
4. Scheduler 扫描到期提醒。
5. Agent 请求 Gateway 发送提醒。
6. Gateway 选择可用微信发送通道。
7. Agent 记录发送结果。
```

提醒状态机：

```text
pending 待提醒
sending 发送中
sent 已发送
failed 发送失败
channel_unavailable 微信通道不可用
cancelled 已取消
```

发送规则：

- 优先使用微信允许的消息通道。
- 无法发送时保留失败状态和原因。
- 后台可手动重试。
- 不承诺所有提醒都能主动推送到微信。
- 重复调度不能重复发送同一提醒。

## 10. 固定组件

### 10.1 任务管理

支持意图：

- 新增任务
- 查询任务
- 更新任务状态

字段：

```text
title
status: todo / doing / done / canceled
due_at
remind_at
priority: low / medium / high
source
raw_input
```

### 10.2 收藏夹

支持意图：

- 新增收藏
- 查询最近收藏
- 按标签查询收藏

字段：

```text
title
url
tags
summary
saved_at
source
raw_input
```

第一版不做网页自动抓取。标题缺失时用 URL 作为标题。

### 10.3 软件订阅

支持意图：

- 新增订阅
- 查询本月续费
- 查询月度订阅支出
- 更新订阅状态

字段：

```text
name
price
currency: CNY / USD / HKD / JPY / EUR
billing_cycle: monthly / yearly / one_time
next_renewal_at
remind_at
status: active / paused / canceled
raw_input
```

取消订阅只修改本地记录状态，不执行外部服务取消。

### 10.4 提醒

支持意图：

- 新增独立提醒
- 查询待提醒事项
- 取消提醒

字段：

```text
title
remind_at
related_type: task / bookmark / subscription / standalone
related_page_id
status
raw_input
```

第一版不删除提醒记录，只允许改为 cancelled。

## 11. LLM 需求

LLM 使用 OpenAI-compatible API。

后台配置：

```text
provider_name
base_url
api_key
model
temperature
supports_response_format
enabled
```

请求格式：

```http
POST {base_url}/chat/completions
Authorization: Bearer {api_key}
Content-Type: application/json
```

LLM 输出格式：

```json
{
  "intent": "create_reminder",
  "component": "reminder",
  "fields": {
    "title": "跟进报价",
    "remind_at": "2026-07-07T15:00:00+08:00"
  },
  "needs_confirmation": false,
  "confidence": 0.92
}
```

保护规则：

- 优先使用 `response_format=json_object`。
- 不支持时降级为 prompt JSON。
- JSON 解析失败时不执行写入。
- 缺少必填字段时向用户追问。
- 低置信度时要求确认。
- LLM 不能直接调用 Notion MCP。
- LLM 不能读取或输出密钥。
- LLM 不能决定删除数据。

## 12. Notion 需求

底层可选：

- Notion REST API
- Notion MCP

业务层必须统一走 `NotionAdapter`。

允许方法：

```text
create_task(fields)
query_tasks(view)
update_task_status(task_id, status)
create_bookmark(fields)
query_bookmarks(view)
create_subscription(fields)
query_subscriptions(view)
update_subscription_status(subscription_id, status)
create_reminder(fields)
query_reminders(view)
update_reminder_status(reminder_id, status)
```

禁止：

- 任意 workspace 搜索。
- 任意页面写入。
- 删除页面。
- 批量编辑。
- 自动修改 Notion 数据库结构。
- LLM 直接使用 Notion MCP 全量工具。

固定模板：

```text
Tasks:
  Title, Status, Due At, Remind At, Priority, Source, Raw Input

Bookmarks:
  Title, URL, Tags, Summary, Saved At, Source, Raw Input

Subscriptions:
  Name, Price, Currency, Billing Cycle, Next Renewal At, Remind At, Status, Raw Input

Reminders:
  Title, Remind At, Status, Related Type, Related Page ID, Raw Input
```

模板校验：

- Database ID 是否存在。
- 必需字段是否存在。
- 字段类型是否正确。
- select 选项是否完整。
- Integration 是否有访问权限。

校验失败时禁止写入，并在后台显示具体错误。

## 13. 网页后台需求

页面：

```text
Dashboard
Gateway 连接
微信绑定
LLM 设置
Notion 设置
组件设置
消息日志
提醒队列
失败重试
安全设置
```

Dashboard 展示：

- Gateway 在线状态。
- Relay 连接状态。
- Notion 模板状态。
- LLM 连接状态。
- 今日消息数。
- 失败任务数。
- 待发送提醒数。

自部署体验要求：

- 提供 docker compose。
- 首次启动向导。
- 健康检查页。
- 一键测试 Gateway、LLM、Notion。
- 明确显示当前服务号连接状态。

## 14. 数据模型

Gateway 表：

```text
instances(id, instance_id, instance_secret_hash, status, last_seen_at, created_at)
wechat_bindings(id, openid_hash, instance_id, local_user_id, status, bound_at, revoked_at)
auth_codes(id, code_hash, instance_id, local_user_id, expires_at, used_at, created_at)
incoming_message_jobs(id, wechat_msg_key, openid_hash, instance_id, status, created_at)
agent_delivery_jobs(id, message_job_id, instance_id, status, retry_count, last_error)
send_jobs(id, openid_hash, instance_id, channel, content, status, error_code, created_at, sent_at)
```

自部署 Agent 表：

```text
local_users(id, username, password_hash, created_at)
settings(key, encrypted_value, updated_at)
message_logs(id, gateway_job_id, raw_input, intent, component, fields_json, status, error)
notion_write_jobs(id, type, idempotency_key, payload_json, status, retry_count, last_error)
reminder_send_jobs(id, notion_page_id, title, remind_at, status, retry_count, last_error, sent_at)
```

## 15. 逻辑保护需求

### 15.1 微信回调保护

- 每次回调校验微信签名。
- 回调只做验签、去重、入队、快速返回。
- 不在回调中等待 LLM 或 Notion。
- 微信重复推送不能重复创建业务数据。

去重 key：

```text
优先 MsgId
否则 hash(openid + CreateTime + MsgType + Content)
```

### 15.2 幂等保护

- 每条业务动作生成 `idempotency_key`。
- Notion 写入前检查本地处理记录。
- 手动重试复用同一个 `idempotency_key`。
- 重试同一 job 不产生重复 Notion 页面。

### 15.3 路由保护

- 未绑定 openid 不能调用 Agent。
- 一个 openid 只能有一个 active binding。
- Agent 离线时消息进入待投递队列。
- 不同 instance 的消息和日志不能串读。

### 15.4 实例认证保护

Agent 到 Gateway 请求必须包含：

```text
instance_id
timestamp
nonce
signature
```

签名：

```text
HMAC_SHA256(instance_secret, method + path + timestamp + nonce + body_hash)
```

要求：

- 拒绝过期 timestamp。
- 拒绝重复 nonce。
- 拒绝错误 signature。

### 15.5 鉴权码保护

- 只存 code hash。
- 5 分钟过期。
- 一次性使用。
- 登录失败限流。
- 频繁生成 code 限流。

### 15.6 密钥和日志保护

- 微信 app secret 只在 Gateway。
- LLM API Key 只在自部署 Agent。
- Notion Token 只在自部署 Agent。
- 密钥 UI 脱敏。
- 密钥不进日志。
- openid 优先存 hash。
- 原始消息日志只存在自部署 Agent。

### 15.7 失败重试保护

需要队列：

```text
incoming_message_jobs
agent_delivery_jobs
notion_write_jobs
reminder_send_jobs
```

规则：

- 短暂错误自动重试。
- 超过次数进入 dead letter。
- 后台支持手动重试。
- 所有重试必须幂等。
- Agent 离线、LLM 超时、Notion 失败、微信发送失败均有状态。





