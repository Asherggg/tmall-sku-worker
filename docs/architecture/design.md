# 天猫运营工作台架构设计

## 1. 决策

产品是 Windows 单机运营工作台：Tauri 2 负责原生窗口和本地能力，Vue 3/Vite 提供桌面壳、应用窗口管理器和运营应用，Node.js Worker 统一负责系统 Edge 生命周期、登录后的 Playwright CDP 连接、任务与审计。浏览器 Profile 是应用专属目录，不能复用用户日常 Edge Profile。

v0.1.29 采用模块化单体，不引入 iframe 或微前端。`SkuRebuildApp` 和 `AddPatternApp` 是两个独立、持久的应用模块，共享工作台状态和 Worker 契约；桌面快捷方式可以启动应用或定位 SKU 的任务中心/浏览器会话。应用窗口最小化或关闭时只改变前端可见性，模块实例继续保留，长期任务的事实状态始终由 Worker 持有。

```text
Tauri 2
├── Vue 3 + TypeScript + Vite
│   ├── Operations Desktop（快捷方式、窗口管理、任务栏、全局状态）
│   └── Applications
│       ├── SKU ID Rebuild（两阶段 ID 重建）
│       └── Add Pattern（Excel 明确组合新增）
├── Rust host（原生窗口、Worker 生命周期、文件路径）
└── Node Worker（本地 HTTP/JSON API）
    └── System Edge headed profile -> post-login Playwright CDP
```

## 2. 进程边界

### Tauri host

- 启动/停止 Worker。
- Windows 安装版把 bundled Node Worker 放入带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` 的 Job Object；Tauri host 退出时由 Job handle 关闭触发回收 Worker，避免 Node 子进程孤立并继续锁定 `runtime/node.exe`。Worker 后续启动的专属 Edge 自动脱离该 Job，宿主或安装器清理 Worker 时不会连带结束浏览器。
- 提供应用数据目录和 Profile 目录。
- 不读取 Cookie，不把 CDP 端口暴露到局域网。
- 生产安装包内置 Node runtime、Worker 脚本和 Playwright 运行包；开发模式允许 `TMALL_NODE_PATH` 指向本机 Node。

### Worker

- 源码直接启动默认 `demo`；v0.1.29 Windows 安装版由 Tauri host 显式启用 `tmall-publish-v2`。两个应用只提供线上模式。适配器按当次服务端表单能力识别标准 SKU、SKU 明细和自定义销售属性，不按商品 ID 硬编码。最终回读使用 150 秒截止时间、自适应轮询和模型流式接收。线上批次最多同时准备/回读 2 个不同商品，实际提交请求由 Worker 写锁串行。安装资源只包含核心 Worker、浏览器运行时和天猫适配器；ExcelJS 编译进前端资产，不复制到 Node Worker 资源。NSIS 预安装 hook 会按安装目录完整路径结束遗留的 bundled Node Worker，避免升级覆盖 `runtime/node.exe` 时被锁定。
- SKU 最终一致性校验覆盖规格、价格、商家编码、条码和其他业务字段，但不比较 `skuStock`；库存由天猫库存系统实时维护，重建期间的库存变化不再阻断任务成功。
- `live` 必须同时满足环境开关、批次确认词和任务快照校验。
- 一个 Profile 只有一个 Worker；同一账号的 `/tmall/submit.htm` 写请求始终串行，批次中的不同商品最多各自运行一个任务；首次淘宝认证必须人工完成。
- 一个商品的 SKU 重建线上阶段为：Tmall 快照 -> 临时规格提交/回读 -> 原业务字段恢复提交 -> 最终回读。
- 一个商品的新增花型线上阶段为：Tmall 快照 -> 明确组合规划 -> 零写入完成或单次合并提交 -> 最终回读。原 SKU 行和 SKU ID 始终保留。
- 未知提交结果统一进入 `needs_manual_review`，禁止自动重试任何已发出的 Tmall 写请求。

## 3. Worker HTTP 契约

监听 `127.0.0.1:19828`，所有响应为 JSON，并返回 `X-Request-Id`。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | Worker、Profile 和浏览器状态 |
| POST | `/browser/login` | 启动可见登录流程 |
| POST | `/browser/verify` | 检查同一 Profile 中的淘宝登录态；只读页面信号，不执行业务接口 |
| POST | `/browser/hide` | Win32 隐藏同一有头 Edge 窗口；不关闭、不重启、不切换 headless |
| GET | `/tasks?operation=<type>` | 查询全部任务或按 `sku_rebuild` / `add_pattern` 筛选 |
| POST | `/tasks` | 创建带 `operation` 的批次任务；新增花型携带规范化 Excel 行 |
| POST | `/tasks/:id/plan` | 生成演练计划 |
| POST | `/tasks/:id/start` | 启动任务；live 需要确认词 |
| POST | `/tasks/:id/pause` | 仅演练任务在安全边界暂停；线上任务返回 409 |
| POST | `/tasks/:id/retry` | 仅重试已验证可重试阶段；渠道迁移任务必须携带 `channelOption: "1" | "2"` 与 `confirmChannelMigration: true` |
| GET | `/tasks/:id` | 任务详情、时间线和差异 |
| GET | `/audit/export` | 导出脱敏审计 JSON |

开发阶段 Worker 可以使用内存/JSON 存储；SQLite 接口保持独立，方便切换。不要把完整 `jsonBody`、Cookie、Authorization、token 或签名写入审计。

## 4. 任务模型

```ts
type Mode = 'demo' | 'live';
type TaskOperation = 'sku_rebuild' | 'add_pattern';
type TaskStatus =
  | 'draft' | 'validated' | 'planned' | 'awaiting_confirmation'
  | 'queued' | 'reading_snapshot' | 'temp_submitting'
  | 'temp_verified' | 'restoring' | 'pattern_preparing'
  | 'pattern_submitting' | 'pattern_verifying' | 'final_verifying'
  | 'succeeded' | 'paused' | 'needs_manual_review' | 'failed';

interface ItemTaskInput {
  operation: TaskOperation;
  itemId: string;
  skuIds?: string[];
  expectedSkuCount?: number;
  patternRows?: PatternSkuInput[];
}
```

幂等键为 `batchId + itemId + sourceSnapshotHash`。成功任务不可自动重复写入；未知响应必须由人确认服务端状态后才能继续。

## 5. Tmall adapter 边界

- Edge 只提供人工登录后的认证上下文；任务执行使用 Playwright `BrowserContext.request` 共享该上下文的 Cookie，认证字段只存在于内存，不写入任务或审计。
- SKU 重建写入流程是：完整表单快照 -> 临时唯一规格提交 -> 回读新 SKU -> 恢复原字段提交 -> 详情回读。唯一预期持久变化是 SKU ID。
- 新增花型以 Excel 明确组合为目标集：适配器保留快照中每个原 SKU 对象和 ID，只追加缺少行；如果全部存在且价格/商家编码/条码匹配，不调用预检或提交；如需新增，每个商品只发出一次合并提交。
- 商品快照、销售属性元数据和动态提交字段直接从 `GET /tmall/publish.htm?id=<itemId>` 的服务端 bootstrap 解析；不读取或修改 `GlobalStore`。
- 原规格、价格、库存、商家编码、条码、图片和其他业务字段只取自本次天猫快照。本版本不调用外部资料接口，不补全空字段，也不向其他业务系统提交结果。
- 规格预检直接调用 `POST /tmall/asyncOpt.htm?optType=salePropValueChangeAsync`；`newColorSelect` 自定义值校验同样使用页面协议的 `POST /tmall/asyncOpt.htm`，请求体携带 `jsonBody:{text}` 与当次 `globalExtendInfo`。预检组合键同时兼容平台返回的 `pid-value` 与 `pid--value`，规范化后仍须逐项校验属性 ID、值 ID 和组合唯一性。SKU 重建两阶段各一次提交；新增花型至多一次提交。两类提交均直接调用 `POST /tmall/submit.htm`，使用当次 bootstrap 的完整 `formValues`、`globalExtendInfo` 和渲染跟踪字段。
- 新增花型销售属性键必须由服务端表单元数据唯一映射到规格与颜色；自定义值必须通过容量和异步校验。新行的必填字段只可从唯一线上模板继承，歧义、缺失、重复组合、商家编码/条码冲突均在写入前失败。
- 新增花型最终回读逐项确认原 SKU ID 未变、原业务字段未变、每条新组合恰好存在一次、新 SKU ID 唯一；库存只采用平台实时值。
- 每次提交后只通过 HTTP GET 轮询服务端 bootstrap，并按临时商家编码或销售属性组合进行一一映射。回读优先在服务端模型结束处停止接收 HTML，解析失败时回退完整 GET；解析、映射或身份校验失败时直接进入人工复核，不回退页面导航。
- 回读审计记录必须包含策略、传输方式、HTTP 状态、轮询次数和耗时。最终回读以最终提交后 150 秒为截止时间，使用自适应只读 GET，并在截止点执行最后一次新鲜回读；仍不一致时保持人工复核，不能重复提交。
- 批处理期间禁止 `page.evaluate`、`GlobalStore.setProps`、`button.emit('click')`、页面刷新和页面导航。
- 服务端 bootstrap、完整 `formValues`、销售属性元数据或直接提交字段任一缺失时不得执行 live，并返回可解释的错误码。
- `channelOption` 默认必须原样取自当次服务端 bootstrap 且落在 `1`/`2` 白名单内，禁止重放历史值。旧值 `5` 或空值只触发 `channel_option_migration_required`，并保证此前只执行发布页 GET。
- 渠道迁移只接受任务级人工选择 `1`（纯电商）或 `2`（商场同款），不读取环境变量，也不接受创建批次时预填。重试时必须重新读取 bootstrap，并同时验证观察到的旧值未变化、所选值在 `components.channelOption.props.dataSource` 中恰好出现一次；任一条件不满足继续零写入阻断。
- 若新增花型输入全部为已存在组合，即使操作者为通过旧值校验做出选择，任务仍保持零 POST，线上旧渠道也不会被伪报为已修改。

## 6. 失败与恢复

| 情况 | 处理 |
|---|---|
| 登录过期/验证码 | 暂停，显示打开登录窗口 |
| 读取失败 | 不写入，记录失败 |
| 临时提交明确失败 | 标记失败，可重新从快照开始 |
| 提交超时/响应未知 | `needs_manual_review`，禁止盲重试 |
| 纯接口回读解析/映射失败 | 有界重试只读 GET；仍失败则 `needs_manual_review`，不操作页面 |
| 回读字段不一致 | `needs_manual_review`，输出差异 |
| Worker 崩溃 | 重启后扫描未完成任务，保持人工确认门槛 |

## 7. 部署

- 单机版：Tauri 直接启动 Node Worker，SQLite 在应用数据目录。
- 服务版（后续）：Fastify/API、SQLite/PostgreSQL 和 Worker 使用 Docker Compose；桌面客户端只调用 API。
- 不接管用户日常 Edge；Worker 只管理专属 `edge-profile-v2` 和固定回环 CDP 端口，登录期间不建立 CDP 会话。
