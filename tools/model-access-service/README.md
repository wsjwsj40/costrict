# Model Access Service

用于替换现有 `model-proxy` 模型列表能力的轻量服务。它不代理模型请求，也不实现 Auto 路由。

## 接口

- `GET /ai-gateway/api/v1/models`：验证 JWT，从 Token 提取邮箱，按邮箱套餐返回模型。
- `GET /health`：健康检查。
- `GET /admin/`：内嵌管理页面。

管理页面使用 `admin.token` 登录。页面对数据库的修改通过同源、受管理员令牌保护的内部接口完成。

配置 `gateway.baseUrl` 后，`gateway.completionModel` 会固定加入网关模型列表并自动去重。用户或套餐
修改会先写入数据库并创建持久化同步任务，由后台异步更新网关；失败项会按配置重试。对应环境变量为
`MODEL_GATEWAY_BASE_URL`、`MODEL_GATEWAY_TOKEN`、
`MODEL_GATEWAY_COMPLETION_MODEL` 和 `MODEL_GATEWAY_TIMEOUT_SECONDS`。

服务会在 `MODEL_GATEWAY_BASE_URL` 后拼接权限修改和默认模型列表接口。模型启用或加入套餐前会先校验；
用户、套餐、禁用和删除操作会创建持久化同步任务，由后台按
`MODEL_GATEWAY_BATCH_SIZE` 分批处理并最多重试 `MODEL_GATEWAY_MAX_ATTEMPTS` 次。
管理页面的“同步任务”页每 3 秒刷新正在执行的任务。
用户权限页面支持多行邮箱分配、CSV 导入、列表多选后批量变更套餐，以及
批量删除用户记录。把用户设置为默认套餐仍会保留用户记录，方便后续修改默认套餐模型时同步全部已知用户。
套餐页面支持创建、重命名、设置默认套餐和删除非默认套餐；删除时必须选择接收用户的目标套餐。

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

- 首次请求模型列表的用户会自动登记为当前默认套餐，并异步创建一次网关权限同步任务。
- 后续请求不会重复创建首次同步任务；修改默认套餐时可覆盖所有已经访问过的默认套餐用户。

- 初始化时 `free` 是默认套餐，管理员可以把其他套餐设为默认；任意时刻必须且只能有一个默认套餐。
- 所有访问过模型列表的邮箱都会持久化；降级到默认套餐不会删除用户记录。
- `auto` 是保留 ID，即使写入请求或导入文件也不会被返回。
- 模型 ID 必须和内部模型网关接受的 ID 一致。
- 服务启动时自动执行幂等数据库迁移。
