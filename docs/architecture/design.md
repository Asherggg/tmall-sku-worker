# Tmall SKU Worker 架构设计

## 1. 决策

MVP 是 Windows 单机桌面应用：Tauri 2 负责窗口和本地能力，Vue 3/Vite 负责控制台，Node.js Worker 负责系统 Edge 生命周期和登录后的 Playwright CDP 连接，本地持久化负责任务与审计。浏览器 Profile 是应用专属目录，不能复用用户日常 Edge Profile。

```text
Tauri 2
├── Vue 3 + TypeScript + Vite UI
├── Rust host（窗口、Worker 生命周期、文件路径）
└── Node Worker（本地 HTTP/JSON API）
    └── System Edge headed profile -> post-login Playwright CDP
```

## 2. 进程边界

### Tauri host

- 启动/停止 Worker。
- 提供应用数据目录和 Profile 目录。
- 不读取 Cookie，不把 CDP 端口暴露到局域网。
- 生产安装包内置 Node runtime、Worker 脚本和 Playwright 运行包；开发模式允许 `TMALL_NODE_PATH` 指向本机 Node。

### Worker

- 源码直接启动默认 `demo`；v0.1.6 Windows 安装版由 Tauri host 显式启用 `tmall-publish-v1`。
- `live` 必须同时满足环境开关、批次确认词和任务快照校验。
- 一个 Profile 只有一个 Worker；同一账号同一时间只写一个 `itemId`。
- 未知提交结果统一进入 `needs_manual_review`，禁止自动重试写请求。

## 3. Worker HTTP 契约

监听 `127.0.0.1:19828`，所有响应为 JSON，并返回 `X-Request-Id`。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | Worker、Profile 和浏览器状态 |
| POST | `/browser/login` | 启动可见登录流程 |
| POST | `/browser/verify` | 检查当前页面登录态 |
| POST | `/browser/hide` | Win32 隐藏同一有头 Edge 窗口；不关闭、不重启、不切换 headless |
| GET | `/tasks` | 查询任务列表 |
| POST | `/tasks` | 创建批次任务 |
| POST | `/tasks/:id/plan` | 生成演练计划 |
| POST | `/tasks/:id/start` | 启动任务；live 需要确认词 |
| POST | `/tasks/:id/pause` | 仅演练任务在安全边界暂停；线上任务返回 409 |
| POST | `/tasks/:id/retry` | 仅重试已验证可重试阶段 |
| GET | `/tasks/:id` | 任务详情、时间线和差异 |
| GET | `/audit/export` | 导出脱敏审计 JSON |

开发阶段 Worker 可以使用内存/JSON 存储；SQLite 接口保持独立，方便切换。不要把完整 `jsonBody`、Cookie、Authorization、token 或签名写入审计。

## 4. 任务模型

```ts
type Mode = 'demo' | 'live';
type TaskStatus =
  | 'draft' | 'validated' | 'planned' | 'awaiting_confirmation'
  | 'queued' | 'reading_snapshot' | 'temp_submitting'
  | 'temp_verified' | 'restoring' | 'final_verifying'
  | 'succeeded' | 'paused' | 'needs_manual_review' | 'failed';

interface ItemTaskInput {
  itemId: string;
  skuIds: string[];
  expectedSkuCount?: number;
}
```

幂等键为 `batchId + itemId + sourceSnapshotHash`。成功任务不可自动重复写入；未知响应必须由人确认服务端状态后才能继续。

## 5. Tmall adapter 边界

- 读取和提交均在页面上下文使用当前登录态。
- 写入流程是：完整表单快照 -> 临时唯一规格提交 -> 回读新 SKU -> 恢复原字段提交 -> 详情回读。
- 每次提交成功后的回读优先使用同源 `GET /tmall/publish.htm?id=<itemId>` 解析服务端 bootstrap 表单，严格按销售属性组合合并运行时字段；解析、映射或身份校验失败时自动回退完整页面导航回读。
- 快速回读只优化读取路径，不改变两阶段提交、成功响应判定、字段比对或人工复核门槛；回读审计记录必须包含策略、HTTP 状态和耗时。
- 内部接口属于 `internal-unstable`；必须保存接口版本、状态码、业务码和回读证据。
- UI 语义操作只作为接口失效时的人工降级路径，不作为批处理主路径。
- 页面必须提供 `GlobalStore.engine`、完整 `formValues`、销售属性预检和内部 `button-submit:click` 事件；任一运行时契约缺失时不得执行 live，并返回可解释的错误码。
- `channelOption` 必须实时读取页面并落在页面当前允许的 `1`/`2` 白名单内，禁止重放历史值。

## 6. 失败与恢复

| 情况 | 处理 |
|---|---|
| 登录过期/验证码 | 暂停，显示打开登录窗口 |
| 读取失败 | 不写入，记录失败 |
| 临时提交明确失败 | 标记失败，可重新从快照开始 |
| 提交超时/响应未知 | `needs_manual_review`，禁止盲重试 |
| 快速回读解析/映射失败 | 自动执行完整页面回退；回退也失败则 `needs_manual_review` |
| 回读字段不一致 | `needs_manual_review`，输出差异 |
| Worker 崩溃 | 重启后扫描未完成任务，保持人工确认门槛 |

## 7. 部署

- 单机版：Tauri 直接启动 Node Worker，SQLite 在应用数据目录。
- 服务版（后续）：Fastify/API、SQLite/PostgreSQL 和 Worker 使用 Docker Compose；桌面客户端只调用 API。
- 不接管用户日常 Edge；Worker 只管理专属 `edge-profile-v2` 和固定回环 CDP 端口，登录期间不建立 CDP 会话。
