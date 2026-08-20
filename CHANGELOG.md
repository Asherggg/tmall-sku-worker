# Changelog

本文件记录 Tmall SKU Worker 的版本更新。详细发布验证见 [`docs/release/`](docs/release/)。

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
