# OpenShip 商品资料查询服务部署方案

> 归档说明：v0.1.25 纯 SKU ID 重建版不再打包或调用本服务。本文仅保留旧版本部署记录。

## 1. 目标

把 Doris 商品资料查询能力部署成一个独立的 HTTPS 服务，由 OpenShip 负责构建、发布、域名、TLS 和进程维护。桌面版 Tmall SKU Worker 只调用这个服务，不直连 Doris，也不携带 Doris 账号密码。

本方案服务的业务字段来自：

```text
数据库: guanyuan_back
数据表: ecommerce_sales_inventory_daily_report
字段: total_material_no, barcode, sub_material_name, specification, updated_at
```

当前数据核对结果：该表约有 7.7 万行，空 `barcode` 很少，但同一 `total_material_no` 可能存在多条记录，因此服务端必须处理缺失和多值冲突，不能直接取第一行。

## 2. 推荐拓扑

```text
Tmall SKU Worker (用户电脑)
        |
        | HTTPS + 用户/设备短期令牌
        v
OpenShip Route: https://inventory-api.example.com
        |
        v
inventory-api Container
        |
        | Doris MySQL 协议，内网访问
        v
Doris FE:9030
```

OpenShip 的控制台登录只保护 OpenShip 控制平面；业务 API 自身仍需做认证和权限校验。

推荐使用 OpenShip 自托管服务器模式，而不是把服务部署在普通用户电脑上。OpenShip 所在主机必须能通过内网、VPN 或防火墙白名单访问 Doris。

## 3. API 契约

### 健康检查

```http
GET /health
```

返回：

```json
{
  "ready": true,
  "service": "inventory-api",
  "version": "1.0.0"
}
```

健康检查不执行 Doris 查询；Doris 连通性使用独立的受保护诊断接口或启动探针验证。

### 批量查询

```http
POST /v1/materials/lookup
Authorization: Bearer <short-lived-token>
Content-Type: application/json
```

请求：

```json
{
  "materialNos": ["100001", "100003"]
}
```

约束：

- `materialNos` 必须是 1-500 个非空料号。
- 服务端删除重复料号并限制最大长度。
- 客户端不能传 SQL、表名或字段名。
- 查询只返回业务必需字段，不返回库存明细、数据库诊断信息或凭据。

成功响应：

```json
{
  "records": [
    {
      "materialNo": "100001",
      "barcode": "6927602628262",
      "subMaterialName": "昕柔全棉枕套",
      "specification": "48cm×74cm",
      "updatedAt": "2026-08-19T09:12:32Z"
    }
  ],
  "missing": [],
  "ambiguous": []
}
```

`ambiguous` 的料号必须由客户端进入人工复核，服务端不能静默选第一条：

```json
{
  "records": [],
  "missing": [],
  "ambiguous": ["128123"]
}
```

## 4. Doris 访问策略

服务端内部只生成固定 SQL，逻辑等价于：

```sql
SELECT
  total_material_no,
  barcode,
  sub_material_name,
  specification,
  updated_at
FROM guanyuan_back.ecommerce_sales_inventory_daily_report
WHERE total_material_no IN (...)
```

Doris 侧创建专用只读账号，只允许访问指定数据库/表和上述字段。不要使用管理员账号，不要开放写权限。

建议的网络规则：

```text
允许 inventory-api -> Doris FE:9030
拒绝公网 -> Doris:9030/8030
允许桌面端 -> inventory-api:443
```

如果 OpenShip 主机不能访问 Doris，需要先打通 VPN、专线或防火墙白名单；不要为了方便把 Doris 端口直接暴露到公网。

## 5. 仓库文件模板

建议单独建立仓库，例如：

```text
tmall-inventory-api/
 ├─ src/
 │  └─ server.ts
 ├─ package.json
 ├─ package-lock.json
 ├─ Dockerfile
 ├─ .dockerignore
 └─ openship.json
```

### Dockerfile

```dockerfile
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package*.json ./
COPY dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
```

服务必须监听：

```text
0.0.0.0:${PORT:-8080}
```

不能只监听 `127.0.0.1`，否则容器路由无法访问。

### openship.json

下面的值是模板。真实域名和 Secret 值在 OpenShip 部署配置中填写，不要把真实密码提交到 Git：

```json
{
  "$schema": "https://openship.io/openship.schema.json",
  "framework": "docker",
  "runtime": "docker",
  "port": 8080,
  "domains": ["inventory-api.example.com"],
  "env": {
    "PORT": "8080",
    "DORIS_HOST": {
      "value": "<DORIS_FE_HOST>",
      "secret": true
    },
    "DORIS_PORT": "9030",
    "DORIS_DATABASE": "guanyuan_back",
    "DORIS_USER": {
      "value": "<DORIS_READONLY_USER>",
      "secret": true
    },
    "DORIS_PASSWORD": {
      "value": "<DORIS_READONLY_PASSWORD>",
      "secret": true
    },
    "API_AUTH_MODE": "oidc",
    "API_ISSUER": {
      "value": "<OIDC_ISSUER>",
      "secret": true
    },
    "API_AUDIENCE": "tmall-sku-worker"
  },
  "resources": {
    "cpuCores": 1,
    "memoryMb": 512
  }
}
```

OpenShip 支持把 `{ "value": "...", "secret": true }` 作为加密 Secret 保存。即使如此，建议首次部署后再在 OpenShip 控制台替换占位值，并检查日志中没有打印环境变量。

v0.1.23 使用统一发布凭据：构建时从受控发布配置生成 Git 忽略的安装资源，安装版不要求用户录入 Token。凭据轮换时必须重新构建和分发安装包，并使旧凭据按发布计划失效。

## 6. OpenShip 部署步骤

在有权访问 OpenShip 和 Doris 的部署主机上执行：

```bash
# 1. 拉取服务仓库
git clone <inventory-api-repository>
cd tmall-inventory-api

# 2. 登录/连接 OpenShip 后初始化项目
openship init

# 3. 校验声明文件
openship config validate

# 4. 首次部署
openship deploy
```

也可以将仓库连接到 OpenShip 控制台，由 OpenShip 从 Git 分支自动部署。生产环境建议固定生产分支和镜像版本，开启部署失败自动回滚。

部署后验证：

```bash
curl -fsS https://inventory-api.example.com/health

curl -fsS -X POST \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <short-lived-token>' \
  https://inventory-api.example.com/v1/materials/lookup \
  -d '{"materialNos":["100001"]}'
```

验证重点：

- `/health` 返回 200。
- 未认证请求返回 401/403。
- 空料号、超过 500 个料号、非法 JSON 返回 400。
- 已知料号能返回 `barcode`、`subMaterialName`、`specification`。
- 不存在料号进入 `missing`。
- 多条冲突记录进入 `ambiguous`。
- 日志不出现 Doris 密码、Authorization、完整 SQL 或完整请求体。

## 7. 桌面端接入改动

v0.1.23 Worker 固定使用：

```text
INVENTORY_API_BASE_URL=http://10.21.16.213:9031
INVENTORY_API_PATH=/v1/materials/lookup
INVENTORY_API_TOKEN=<release-config-token>
```

地址、路径和国补开关由代码固定；Token 由 Tauri 从安装资源注入 Worker 子进程，用户侧不提供流程配置入口。

请求体只包含料号：

```json
{"materialNos":["100047"]}
```

服务可以返回单条资料对象，也可以返回 `{ records: [...] }`；Worker 会识别 `materialNo` 和 `barcode`，并将返回的 `barcode` 用于补全空的 69 码。

请求附加发布版本对应的统一令牌。桌面端不再使用以下生产配置：

```text
DORIS_MYSQL_HOST
DORIS_MYSQL_PORT
DORIS_MYSQL_USER
DORIS_MYSQL_PASSWORD
```

当前项目的 `/inventory/lookup` 可以保留为 Worker 内部接口，但其后端实现应从“本机 Doris 查询”切换为“调用 OpenShip 上的 inventory-api”。这样 UI 和批处理流程无需知道 Doris 细节。

OMS 登录态、淘宝登录态和国补登录态仍只保留在用户本机的专属 Edge Profile 中，不发送到 inventory-api。

## 8. 上线前验收

### 数据正确性

- 用 3 个已知料号核对 69 码、品名、规格。
- 用一个不存在料号验证 `missing`。
- 找一个同料号多记录样本验证 `ambiguous`，确认不会取第一条。
- 核对字符串前导零不会丢失，尤其是条码和料号。

### 安全性

- Doris 只读账号不能执行写操作。
- Doris 端口不对公网开放。
- 未认证调用无法查询。
- 发布令牌只能访问固定商品资料查询接口。
- OpenShip Secret 不会出现在 Git、Docker 镜像层、构建日志和应用审计中。

### 可运维性

- 配置 `/health` 和容器重启策略。
- 设置请求超时 5-10 秒、数据库连接池上限和单请求料号上限。
- 对常用资料做短时缓存，但发生 `ambiguous` 时不能缓存成确定结果。
- OpenShip 开启自动部署前，先通过 staging 域名验证一批数据。
- 服务不可用时，桌面任务应停在 `needs_manual_review`，不能继续线上写入。

## 9. 凭据处理说明

当前开发环境能够通过已配置的 Doris 连接执行查询，但 Doris 的 URL、账号和密码不写入本方案、源码、Dockerfile 或 `openship.json` 的提交版本。v0.1.23 的商品资料 API Token 从发布机受控配置生成到 Git 忽略的 Tauri 安装资源；构建日志、桌面 UI、任务状态和审计导出不输出该值。部署时在凭据轮换后同步生成新安装包。
