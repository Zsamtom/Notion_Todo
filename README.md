# Notion_Todo
通过微信交互，notion作为记忆体的 mini agent

## 本地启动

```bash
npm start
```

打开 `http://127.0.0.1:3000`。没填 API 时使用本地规则解析和本地文件存储；在页面里填入 LLM API Key、Notion Token 和四个 Database ID 后，会走 OpenAI-compatible LLM 与 Notion REST。

Notion 数据库字段名需和需求书一致：

- Tasks: `Title`, `Status`, `Due At`, `Remind At`, `Priority`, `Source`, `Raw Input`
- Bookmarks: `Title`, `URL`, `Tags`, `Summary`, `Saved At`, `Source`, `Raw Input`
- Subscriptions: `Name`, `Price`, `Currency`, `Billing Cycle`, `Next Renewal At`, `Remind At`, `Status`, `Raw Input`
- Reminders: `Title`, `Remind At`, `Status`, `Related Type`, `Related Page ID`, `Raw Input`

也可以用环境变量预填密钥：

```bash
LLM_API_KEY=... NOTION_TOKEN=... npm start
```
