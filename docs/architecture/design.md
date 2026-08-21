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

- 源码直接启动默认 `demo`；v0.1.23 Windows 安装版由 Tauri host 显式启用 `tmall-publish-v2`。桌面 UI 只提供线上模式，批次预览列表在固定高度区域内滚动。适配器按服务端表单能力识别标准 SKU、SKU 明细和自定义销售属性异步校验，不按商品 ID 硬编码；最终回读使用 150 秒截止时间覆盖平台数据收敛，并只忽略可证明为空的笛卡尔积预检占位行。商品资料接口固定为 `http://10.21.16.213:9031/v1/materials/lookup`，国补流程固定开启；构建阶段从受控发布配置生成忽略提交的凭据资源，Tauri host 启动 Worker 时以环境变量注入。用户无需填写流程配置，发布凭据不进入 Git 源码、UI、任务状态或审计导出。国补默认复用该 Profile 的 MTop/OSS HTTP 接口，页面流程仅作显式 fallback。
- SKU 最终一致性校验覆盖规格、价格、商家编码、条码和其他业务字段，但不比较 `skuStock`；库存由天猫库存系统实时维护，重建期间的库存变化不再阻断任务成功。
- `live` 必须同时满足环境开关、批次确认词和任务快照校验。
- 一个 Profile 只有一个 Worker；同一账号同一时间只写一个 `itemId`。OMS、淘宝卖家中心和国补页面可在同一 Profile 的不同标签页中使用，但 Cookie 仍按域隔离，首次认证必须人工完成。
- 一个商品的完整线上阶段为：OMS 查询/禁用/回读 -> Doris 料号资料解析 -> Tmall 两阶段 SKU 重建/回读 -> 国补模板填充/上传/提交。
- 未知提交结果统一进入 `needs_manual_review`，禁止自动重试任何已发出的 OMS、Tmall 或国补写请求。

## 3. Worker HTTP 契约

监听 `127.0.0.1:19828`，所有响应为 JSON，并返回 `X-Request-Id`。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | Worker、Profile 和浏览器状态 |
| POST | `/browser/login` | 启动可见登录流程 |
| POST | `/browser/verify` | 检查同一 Profile 中的淘宝、OMS 和国补页面登录态；只读页面信号，不执行业务接口 |
| POST | `/browser/hide` | Win32 隐藏同一有头 Edge 窗口；不关闭、不重启、不切换 headless |
| GET | `/tasks` | 查询任务列表 |
| POST | `/tasks` | 创建批次任务 |
| POST | `/tasks/:id/plan` | 生成演练计划 |
| POST | `/tasks/:id/start` | 启动任务；live 需要确认词 |
| POST | `/tasks/:id/pause` | 仅演练任务在安全边界暂停；线上任务返回 409 |
| POST | `/tasks/:id/retry` | 仅重试已验证可重试阶段 |
| GET | `/tasks/:id` | 任务详情、时间线和差异 |
| GET | `/audit/export` | 导出脱敏审计 JSON |
| GET | `/inventory/health` | 查询 Doris 资料服务配置状态 |
| POST | `/inventory/lookup` | 按料号批量查询 69 码、品名和规格；只接受料号列表 |
| POST | `/browser/oms` | 在同一专属 Profile 打开 OMS 标签页，供人工登录 |
| POST | `/browser/subsidy` | 在同一专属 Profile 打开国补标签页，供人工登录 |

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

## 5. OMS、Doris 与 Tmall adapter 边界

- Edge 只提供人工登录后的认证上下文；任务执行使用 Playwright `BrowserContext.request` 共享该上下文的 Cookie，认证字段只存在于内存，不写入任务或审计。
- 写入流程是：完整表单快照 -> 临时唯一规格提交 -> 回读新 SKU -> 恢复原字段提交 -> 详情回读。
- 商品快照、销售属性元数据和动态提交字段直接从 `GET /tmall/publish.htm?id=<itemId>` 的服务端 bootstrap 解析；不读取或修改 `GlobalStore`。
- 商品资料服务固定使用 `http://10.21.16.213:9031/v1/materials/lookup`；发布构建必须提供 `INVENTORY_API_TOKEN`，并生成不进入 Git 的安装资源。Tauri 只把该值注入 Worker 环境，不写入任务状态或审计导出，运行时配置不能覆盖固定接口。

- 规格预检直接调用 `POST /tmall/asyncOpt.htm?optType=salePropValueChangeAsync`；`newColorSelect` 自定义值校验同样使用页面协议的 `POST /tmall/asyncOpt.htm`，请求体携带 `jsonBody:{text}` 与当次 `globalExtendInfo`，不能回退旧版 `GET + keyword`。预检组合键同时兼容平台返回的 `pid-value` 与 `pid--value`，规范化后仍须逐项校验属性 ID、值 ID 和组合唯一性。两次写入直接调用 `POST /tmall/submit.htm`，使用当次 bootstrap 的完整 `formValues`、`globalExtendInfo` 和渲染跟踪字段。
- SKU 明细页修改销售属性时，若同名 `skuParam_p-*` 原本镜像该属性，临时值必须同步更新；用于区分同一销售属性组合的独立 SKU 参数必须保留。
- 每次提交后只通过 HTTP GET 轮询服务端 bootstrap，并按临时商家编码或销售属性组合进行一一映射。解析、映射或身份校验失败时直接进入人工复核，不回退页面导航。
- 回读优化不改变两阶段提交、成功响应判定、字段比对或人工复核门槛；回读审计记录必须包含策略、HTTP 状态、轮询次数和耗时。最终回读以最终提交后 150 秒为截止时间，按 2 秒间隔执行只读 GET，并在截止点执行最后一次新鲜回读；仍不一致时保持人工复核，不能重复提交。
- 内部接口属于 `internal-unstable`；必须保存接口版本、状态码、业务码和回读证据。
- 批处理期间禁止 `page.evaluate`、`GlobalStore.setProps`、`button.emit('click')`、页面刷新和页面导航；UI 操作只保留为人工处理路径。
- 服务端 bootstrap、完整 `formValues`、销售属性元数据或直接提交字段任一缺失时不得执行 live，并返回可解释的错误码。
- `channelOption` 必须从当次服务端 bootstrap 读取并落在 `1`/`2` 白名单内，禁止重放历史值。

OMS 适配器只允许访问 `https://gateway.shuixing.com/oms-system/base/platformGoods/queryPage` 和 `/base/platformGoods/enable`。查询使用平台商品数字 ID 的 `baseImc09` 字段，SKU ID 使用返回记录的 `baseImc13` 字段。查询结果必须包含与任务一致的商品 ID 和记录 ID；禁用使用记录 ID 列表，提交后重新查询并确认全部匹配记录为禁用。OMS 的 CAS 会话通过同一 Edge Profile 的 `BrowserContext.request` 复用，并附加页面登录后保存在内存中的 `Cas-Auth-Token`，不读取或导出 Cookie。

Doris 适配器只允许固定数据库/表和固定字段查询。每个料号必须得到唯一一致的记录；`barcode`、`sub_material_name`、`specification` 任一关键字段缺失都不能继续。Doris 凭据只从运行时环境读取，不写入状态、审计或模板。

国补适配器默认使用已登录 Edge Profile 的 `BrowserContext.request` 走纯 HTTP 链路：动态读取 `_m_h5_tk` 前缀计算当次 MTop 签名，调用已捕获验证的模板 `EXPORT`/`QUERY_PROGRESS`、OSS 上传配置、文件 `IMPORT` 和商品列表回读接口。签名、Cookie、OSS Policy、临时 URL、上传 key 和完整请求体只存在于内存，不写入任务或审计。`IMPORT` 前必须先持久化外部写入状态；该请求不因 token、超时或未知响应自动重试。提交后按商品 ID 回读，并逐项确认新 SKU ID、69 码、国补品名和规格，全部一致才报告成功。

页面驱动的“手动输入商品 ID -> 下载模板 -> 上传 XLSX -> 提交”流程保留为显式 fallback，可通过 `TMALL_SUBSIDY_TRANSPORT=page` 启用；默认值为 `api`。纯接口流程一旦开始，不因接口失败自动切换页面提交，避免重复写入。模板中旧/新 SKU ID 无法匹配、模板 69 码与映射不一致、H/I/O/P/Q 填充不完整、OSS 上传失败、提交响应未知或列表回读不一致时停止并进入人工复核。

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
