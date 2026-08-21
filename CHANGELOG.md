# Changelog

本文件记录 Tmall SKU Worker 的版本更新。详细发布验证见 [`docs/release/`](docs/release/)。

## [0.1.23] - 2026-08-21

### 固定工作流

- 商品资料服务固定为 `http://10.21.16.213:9031/v1/materials/lookup`，运行时配置不能覆盖。
- 国补流程固定开启，桌面 UI 不再显示流程配置入口。
- 访问凭据由发布构建生成到忽略提交的安装资源，Tauri 启动 Worker 时直接注入；用户只需完成三个站点登录。
- 发布构建缺少固定凭据时直接失败，避免生成无法执行线上批次的安装包。

## [0.1.22] - 2026-08-21

### 流程配置

- 新增应用内“流程配置”页，可填写 Doris 商品资料服务地址、查询路径和访问令牌，并启用国补流程。
- Token 只写入用户应用数据目录；保存后前端只能看到“已配置”状态，不会回显 Token。
- Tauri host 在首次启动时迁移显式旧配置路径、旧一级目录配置或受支持的旧环境变量，覆盖升级保留现有配置。
- Worker `/health` 返回精确缺失项，不再把三站登录成功误写成 OMS、Doris、SKU 重建和国补均未配置。

### 验证

- `npm test`: 63/63 passed。
- `npm run build`: passed。
- `cargo test --manifest-path src-tauri/Cargo.toml`: 2/2 passed。
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed。

## [0.1.21] - 2026-08-21

### 国补纯接口

- 默认复用已登录专属 Edge Profile 的 `BrowserContext.request`，通过动态 MTop 签名完成模板导出、OSS 上传配置、文件导入和商品列表回读。
- `IMPORT` 保留外部写入门禁且不自动重试；响应未知或回读不一致进入人工复核。
- 提交后严格比对新 SKU ID、69 码、国补品名和规格；页面驱动流程保留为 `TMALL_SUBSIDY_TRANSPORT=page` 显式 fallback。
- 商品 `1061776009736` 已完成真实纯接口 `IMPORT`，提交只发送一次，服务端首次列表回读严格确认 9 个 SKU ID、69 码、国补品名和规格全部一致。

## [0.1.20] - 2026-08-20

### 国补流程

- 兼容当前国补页面的“手动输入商品 ID -> 下载模板 -> 上传 XLSX -> 提交”流程。
- 保留旧版商品 ID/替换 SKU ID 流程兼容分支。
- 上传完成后才允许进入最终提交；模板映射不完整、H/I/O/P/Q 填充不完整或上传未完成时停止。
- 实测商品 `1061776009736`：9 条 SKU 映射、9 行模板填充、最终提交和提交后列表回读全部成功。

### 运行时与配置

- 修复捆绑 ExcelJS 的 `readable-stream` 版本冲突，安装包可以读取真实国补 XLSX 模板。
- 通过应用数据目录 `runtime-config.json` 持久化远程资料 API 配置，不依赖 Explorer 的旧环境变量。
- 保留 150 秒最终回读截止时间和淘宝/OMS/国补三页面登录验证。

### 验证

- `npm test`: 56/56 passed。
- `npm run build`: passed。
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed。
- NSIS 安装包：`Tmall SKU Worker_0.1.20_x64-setup.exe`。

## [0.1.19] - 2026-08-20

- 增加应用数据目录运行时配置文件和远程商品资料 API 支持。
- 修复安装版运行时配置无法从 Explorer 环境继承的问题。

## [0.1.18] - 2026-08-20

- 最终回读扩展到 150 秒截止窗口。
- 登录检查同时验证淘宝、OMS 和国补页面。

## [0.1.17] - 2026-08-20

- 增加 OMS 商品禁用、Doris 料号补全和国补模板工作流。
- 增加 SKU 明细页和自定义销售属性兼容。

## [0.1.16] - 2026-08-17

- 兼容多种商品详情页和 SKU 预检组合格式。
