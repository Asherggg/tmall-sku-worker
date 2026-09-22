# 新增花型适配策略

## Strategy note

Strategy: `COOKIE_API`

Contract: `internal-unstable`

Evidence:

- observed request/state: `GET /tmall/publish.htm?id=<itemId>` 返回 HTML，其中 `window.Json.models.formValues` 包含 `saleProp`、`sku`、`oldsku`、`channelOption`，`components.saleProp.props.subItems` 包含销售属性元数据。
- observed write flow: `POST /tmall/asyncOpt.htm?optType=salePropValueChangeAsync` 返回预检 SKU 组合；自定义销售属性按页面提供的 `checkUrl` 先做异步校验；唯一业务写入是 `POST /tmall/submit.htm`。
- auth source: 应用专属有头 Edge Profile 的浏览器 Cookie；Worker 从同一 `BrowserContext` 读取 Cookie，并从 `XSRF-TOKEN` 构造当次 `X-XSRF-TOKEN` 请求头。认证材料只存在于内存。
- replay result: 既有线上验证中，两次 `/tmall/submit.htm` 均返回 HTTP 200 和明确 `models.globalMessage.type=success`；后续新鲜 GET 能解析非空表单并严格核对 SKU、销售属性和渠道。

该接口没有公开版本契约，因此每次执行都从当次服务端 bootstrap 读取完整模型和动态字段。缺少模型、属性元数据、渲染跟踪字段、明确成功信号或可唯一映射的组合时，流程必须在写前阻断；写后出现未知响应或最终回读不一致时进入 `needs_manual_review`，不能自动重试提交。

`channelOption` 只接受当次组件提供的现代值 `1`（纯电商）或 `2`（商场同款）。服务端表单仍可能保存旧值 `5` 或空值，但历史提交证据表明 `5` 会被当前提交契约以 `CHK_BASIC_ONEOF` 拒绝。适配器不得白名单旧值、不得省略该字段、不得从旧属性推断新值；任务须在任何 POST 前进入迁移状态，由运营显式选择后重新读取 bootstrap 并核对候选项。

UI 选择器不作为主路径：新增组合需要保留页面未显示在 Excel 中的完整 SKU 行字段，并对提交后的服务端模型做 150 秒有界回读。DOM 点击不能提供比服务端 bootstrap 更严格的组合映射和字段差异证据。页面仍只承担人工登录和风险验证，不执行自动点击、刷新或导航。

## Excel contract

只读取第一个非空工作表，表头必须包含以下八列，列顺序可以变化：

| 列 | 类型 | 规则 |
|---|---|---|
| `商品ID` | 数字字符串 | 按商品分组，禁止空值和非数字 |
| `规格` | 文本 | 精确匹配或新增对应销售属性值 |
| `颜色分类` | 文本 | 精确匹配或新增对应销售属性值 |
| `价格` | 十进制定价 | 必须大于 0，提交时规范化为两位小数 |
| `数量` | 整数 | 必须大于等于 0 |
| `商家编码` | 文本 | 可空；非空时同商品内不得重复 |
| `条形码` | 文本 | 可空；非空时保持原始字符串 |
| `备注` | 文本 | 可空；`原花型不增加新规格` 表示只处理该行明确组合，不给该花型补齐未列出的规格 |

公式单元格不参与自动计算；业务列包含公式时直接报错。Excel 中每一行都是该商品期望存在的一条明确 SKU 组合；Worker 读取线上快照后，按规格与颜色分类区分已存在组合和确需新增组合。样表可以直接创建批次：若所有组合已在线上存在且业务字段一致，任务以只读结果 `succeeded` 结束，提交次数为 0。

## Mutation invariants

1. 写前保存完整原始 `sku`、`saleProp`、`oldsku` 和原始 `channelOption` 快照及哈希；若人工迁移渠道，另存计划值，不能覆盖原始证据。
2. 原 SKU 行和 SKU ID 必须全部保留；Excel 明确列出的组合在线上不存在时才新增，不能与线上现有组合或同批其他行重复。
3. 新增行只覆盖 Excel 明确给出的价格、数量、商家编码和条形码；页面要求的其他字段从可唯一确定的同规格模板和预检结果继承。已存在组合只做字段核对，不提交。
4. 预检结果必须覆盖所有原组合和待新增组合；只允许忽略没有 SKU 身份及业务内容的笛卡尔积占位行。备注为“原花型不增加新规格”时，不得为该花型生成 Excel 未列出的规格组合。
5. 每个商品只发出一次 `/tmall/submit.htm`，不同商品允许最多两路只读准备/回读，所有提交继续使用 Worker 级串行写锁。
6. 最终回读必须保留原 SKU ID 和原业务字段，并为每个新增组合得到唯一的新 SKU ID。销售属性、价格、商家编码、条形码、图片、渠道及其他字段严格一致；`skuStock` 仍作为平台实时库存字段记录但不阻断一致性结果。
7. 旧渠道 `5` 或空值在任何预检/提交 POST 前停止。只有当前任务明确选择 `1/2` 并确认重试，且新鲜 bootstrap 仍返回相同旧值并唯一提供所选项时才可继续；环境变量、新建批次参数和自动重试均不能提供该选择。
8. 提交超时、响应未知、组合映射失败、商品身份不一致或 150 秒内未收敛，统一进入人工复核，不能自动重发写请求。
