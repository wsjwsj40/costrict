# DiCode 内网更新服务

这是一个无数据库、单二进制的 VSIX 更新服务。服务读取发布配置，自动计算
VSIX 的 SHA-256，并提供版本清单和下载接口。配置文件或 VSIX 发生变化后，
下一次请求会自动加载新版本。

## 本地运行

```bash
cp release.example.json release.json
# 修改 release.json，并将 VSIX 放到其中的 vsixPath
go run . -addr :8080 -config ./release.json
```

接口：

- `GET /api/v1/releases/latest`：最新版本清单
- `GET /api/v1/releases/latest/download`：下载当前发布的 VSIX
- `GET /healthz`：健康检查

## Docker

```bash
docker build -t dicode-update-server .
docker run --rm -p 8080:8080 \
  -e UPDATE_SERVER_CONFIG_DIR=/app/update-config \
  -e UPDATE_SERVER_RELEASES_DIR=/app/update-releases \
  -v "$PWD/release.json:/app/update-config/release.json:ro" \
  -v "$PWD/releases:/app/update-releases:ro" \
  dicode-update-server
```

可配置的运行变量：

- `UPDATE_SERVER_CONFIG_DIR`：配置目录，默认 `/config`
- `UPDATE_SERVER_RELEASES_DIR`：VSIX 目录，默认 `/releases`
- `UPDATE_SERVER_CONFIG`：配置文件完整路径；设置后优先于配置目录
- `UPDATE_SERVER_ADDR`：监听地址，默认 `:8080`

`release.json` 的 `vsixPath` 推荐只填写文件名，例如
`"vsixPath": "dicode-3.1.0.vsix"`，服务会在 `UPDATE_SERVER_RELEASES_DIR`
中寻找。仍然支持绝对路径，绝对路径不会与发布目录拼接。

如果已经在本地编译好静态二进制，可以使用纯运行时镜像：

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags="-s -w" -o dicode-update-server .

docker build -f Dockerfile.binary -t dicode-update-server:binary .
```

生产环境建议由 Nginx、Ingress 或网关终止 HTTPS。

构建插件时将更新地址固化进 VSIX：

```bash
DICODE_UPDATE_MANIFEST_URL=https://updates.example.internal/api/v1/releases/latest \
  pnpm vsix:dicode
```

用户安装后不需要配置更新地址。如果隔离内网只能使用 HTTP，构建时需要显式允许：

```bash
DICODE_UPDATE_MANIFEST_URL=http://updates.example.internal/api/v1/releases/latest \
DICODE_UPDATE_ALLOW_INSECURE_HTTP=true \
  pnpm vsix:dicode
```

## 发布新版本

1. 构建新的 VSIX，文件名应包含版本号。
2. 将 VSIX 放入挂载的 `releases` 目录。
3. 原子替换 `release.json`，更新 `version`、`vsixPath`、更新说明等字段。
4. 请求版本清单，确认版本号、下载地址和 SHA-256。

文件名改变后旧下载 URL 会立即失效；如需灰度或保留多个历史版本，可在网关
前增加对象存储，或扩展服务为多通道发布。
