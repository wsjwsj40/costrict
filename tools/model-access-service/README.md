# Model Access Service

用于替换现有 `model-proxy` 模型列表能力的轻量服务。它不代理模型请求，也不实现 Auto 路由。

## 接口

- `GET /ai-gateway/api/v1/models`：验证 JWT，从 Token 提取邮箱，按邮箱套餐返回模型。
- `GET /health`：健康检查。
- `GET /admin/`：内嵌管理页面。

管理页面使用 `admin.token` 登录。页面对数据库的修改通过同源、受管理员令牌保护的内部接口完成。

配置 `gateway.permissionUrl` 后，单个或批量修改用户套餐、删除用户套餐配置时，
服务会先调用网关权限接口。`gateway.completionModel` 会固定加入网关模型列表，且自动去重；
网关同步失败时套餐修改不会写入数据库。对应环境变量为
`MODEL_GATEWAY_PERMISSION_URL`、`MODEL_GATEWAY_TOKEN`、
`MODEL_GATEWAY_COMPLETION_MODEL` 和 `MODEL_GATEWAY_TIMEOUT_SECONDS`。

`MODEL_GATEWAY_SUPPORTED_MODELS_URL` 指向网关应用默认模型列表。模型启用或加入套餐前会先校验；
用户、套餐、禁用和删除操作会创建持久化同步任务，由后台按
`MODEL_GATEWAY_BATCH_SIZE` 分批处理并最多重试 `MODEL_GATEWAY_MAX_ATTEMPTS` 次。
管理页面的“同步任务”页每 3 秒刷新正在执行的任务。
用户权限页面支持多行邮箱分配、CSV 导入、列表多选后批量变更套餐，以及
批量删除显式配置。批量设置为默认 Free 套餐也会删除显式配置。

## 运行

首次部署需要先创建独立数据库。以下脚本需要连接到默认的 `postgres`
数据库执行，而不是连接到尚未创建的 `model_access`：

```bash
psql -h postgres -U zgsm -d postgres -f migrations/000_create_database.sql
```

新集群也可以把 `migrations/000_create_database.sql` 放进 PostgreSQL 的
`/docker-entrypoint-initdb.d`。该目录中的脚本只会在数据目录首次初始化时执行，
不会在已有数据库的 Pod 重启时重新执行。

复制并编辑配置：

```bash
cp config.example.yaml config.yaml
go run . -f config.yaml
```

管理页面：

```text
http://localhost:8080/admin/
```

模型列表：

```bash
curl -H "Authorization: Bearer <JWT>" \
  http://localhost:8080/ai-gateway/api/v1/models
```

## 数据规则

- `free` 是默认套餐。
- 没有显式配置的邮箱自动使用默认套餐。
- `auto` 是保留 ID，即使写入请求或导入文件也不会被返回。
- 模型 ID 必须和内部模型网关接受的 ID 一致。
- 服务启动时自动执行幂等数据库迁移。
