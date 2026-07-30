# Model Access Service

用于替换现有 `model-proxy` 模型列表能力的轻量服务。它不代理模型请求，也不实现 Auto 路由。

## 接口

- `GET /ai-gateway/api/v1/models`：验证 JWT，从 Token 提取邮箱，按邮箱套餐返回模型。
- `GET /health`：健康检查。
- `GET /admin/`：内嵌管理页面。

管理页面使用 `admin.token` 登录。页面对数据库的修改通过同源、受管理员令牌保护的内部接口完成。

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
