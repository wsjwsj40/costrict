# 技能市场（SkillHub）接口文档

> 状态：后端契约整理（未实测，以真实环境与 Swagger 为准）
> 面向：VSCode 编程助手插件（外网开发，基地址留空，内网部署后填入）
> 来源：内网技能市场后端接口文档
> 关联：`docs/dicode-skill-market.md`（插件侧实施规划，本文件对应其第 4 阶段「真实接口接入」）
> 日期：2026-11-18

**插件能力边界**：仅做技能**检索、概览文档查看、详情查看、版本查看、下载安装**。
发布 / 管理 / 审核等能力只在平台 Web 端完成，不在插件范围内。

> 基地址在文档中以 `<IP>` 占位，真实内外网地址不入库。

---

## 目录

1. [环境配置](#1-环境配置)
2. [认证](#2-认证)
3. [通用约定](#3-通用约定)
4. [接口清单](#4-接口清单)
   - [4.1 技能查询](#41-技能查询)
   - [4.2 技能详情](#42-技能详情)
   - [4.3 版本列表](#43-版本列表)
   - [4.4 版本详情](#44-版本详情)
   - [4.5 概览文档（SKILL.md）](#45-概览文档skillmd)
   - [4.6 下载最新已发布版本](#46-下载最新已发布版本)
   - [4.7 下载指定版本](#47-下载指定版本)
5. [插件调用流程](#5-插件调用流程)
6. [错误码与异常处理](#6-错误码与异常处理)
7. [注意事项](#7-注意事项)

---

## 1. 环境配置

| 环境变量 | 说明 | 值 |
|----------|------|-----|
| `SKILLHUB_BASE_URL` | 后端基地址 | **留空**，内网部署后填入，如 `http://<IP>:9099` |

- URL **无** `/dev-api` 等前缀，直接拼接接口路径。
- 变量为空时，插件应**禁用远程功能并给出提示**，不得报错崩溃。

---

## 2. 认证

插件使用平台账号登录，所有接口需携带 JWT。

```http
POST {BASE}/login
Content-Type: application/x-www-form-urlencoded

username=xxx&password=xxx
```

**响应**

```json
{ "code": 200, "msg": "登录成功", "token": "<JWT>", "success": true }
```

- 后续所有请求携带请求头：`Authorization: Bearer <token>`
- token 过期返回 `code 401`，插件需**重新登录**。
- 若平台开启登录验证码：先 `GET /captchaImage` 获取 `uuid` 与验证码图片，登录时附带 `code`、`uuid`。
- 插件账号需在平台侧分配技能查询 / 下载相关权限：`system:skill:list`、`system:skill:query`、`system:skill:download`。无权限时接口返回「无权限」错误（见第 6 节）。

---

## 3. 通用约定

**JSON 接口统一响应外层**

```json
{
  "code": 200,
  "msg": "...",
  "success": true,
  "time": "...",
  "业务字段": "..."
}
```

- 判断成功以 `success == true` 为准（不要只看 `code`）。
- 业务字段**与 `code` 平级展开**，**不在** `data` 下。

**文件 / 下载接口**：直接返回原始字节流，非 JSON。失败时可能返回 JSON 错误体，需按 `Content-Type` 分流处理。

**分页**：`/search`、`/versions` 使用 `page`（**从 0 开始**）+ `size`。

**路径参数**：`{namespace}`、`{slug}`、`{version}` 均需 URL-encode；`{namespace}`、`{slug}` 一律取自查询结果的对应字段。

**字段命名**：所有字段为 camelCase。

---

## 4. 接口清单

统一前缀：`{SKILLHUB_BASE_URL}/system/skillhub/skills`（下文省略）

| # | 方法 | 路径 | 用途 |
|---|------|------|------|
| 1 | GET | `/search` | 技能查询（列表 / 搜索共用） |
| 2 | GET | `/{namespace}/{slug}` | 技能详情 |
| 3 | GET | `/{namespace}/{slug}/versions` | 版本列表 |
| 4 | GET | `/{namespace}/{slug}/versions/{version}` | 版本详情 |
| 5 | GET | `/{namespace}/{slug}/versions/{version}/file?path=SKILL.md` | 概览文档（SKILL.md 原文） |
| 6 | GET | `/{namespace}/{slug}/download` | 下载最新已发布版本 ZIP |
| 7 | GET | `/{namespace}/{slug}/versions/{version}/download` | 下载指定版本 ZIP |

---

### 4.1 技能查询

**用途**：插件的技能搜索框与技能列表页。返回当前登录用户可见的技能摘要（公开的 + 有权限的命名空间技能），支持关键词、标签、排序、分页。

```http
GET /search?q=pdf&label=文档处理&sort=relevance&page=0&size=20
```

**请求参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `q` | string | 关键词，可选；不传 = 浏览全部 |
| `label` | string | 分类标签筛选，可选（取值可用返回中的 `labelStats`） |
| `sort` | string | `newest`（默认）/ `relevance` / `downloads` / `rating` |
| `page` | int | 页码，**从 0 开始** |
| `size` | int | 每页大小，默认 20 |

**响应示例**

```json
{
  "code": 200,
  "msg": "搜索成功",
  "success": true,
  "items": [
    {
      "id": 1,
      "slug": "pdf-tools",
      "displayName": "PDF 工具",
      "summary": "处理 PDF 的技能",
      "icon": "data:image/png;base64,...",
      "status": "ACTIVE",
      "visibility": "PUBLIC",
      "downloadCount": 42,
      "starCount": 3,
      "ratingAvg": 4.5,
      "ratingCount": 6,
      "namespace": "global",
      "skillLabel": "文档处理",
      "needApiKey": false,
      "createdByName": "张三",
      "createdByDept": "AI平台部",
      "createdAt": "2026-01-01T10:00:00Z",
      "updatedAt": "2026-02-01T10:00:00Z"
    }
  ],
  "total": 100,
  "page": 0,
  "size": 20,
  "labelStats": [
    { "label": "文档处理", "count": 12 }
  ],
  "has_next": false
}
```

**字段说明**

| 字段 | 说明 |
|------|------|
| `slug` | 技能唯一标识，与 `namespace` 组成后续接口路径 |
| `displayName` | 展示名 |
| `summary` | 简介，列表副标题 |
| `icon` | 图标，base64 data URL，可直接渲染 |
| `namespace` | 命名空间 slug，后续接口路径参数 |
| `skillLabel` | 分类标签 |
| `needApiKey` | 运行是否需要 API Key（可在 UI 提示用户） |
| `createdByName` / `createdByDept` | 作者显示名 / 部门 |
| `total` | 符合条件的总条数 |
| `labelStats` | 各分类标签的技能数，可做筛选下拉 |
| `has_next` | 是否还有下一页 |

---

### 4.2 技能详情

**用途**：用户点开某个技能时展示详情面板（元信息、统计、当前发布版本指针）。

```http
GET /{namespace}/{slug}
```

**响应示例**（业务字段平级，节选关键项）

```json
{
  "code": 200,
  "msg": "response.success.read",
  "success": true,
  "id": 1,
  "slug": "pdf-tools",
  "displayName": "PDF 工具",
  "summary": "...",
  "icon": "data:image/png;base64,...",
  "namespace": "global",
  "namespaces": ["global", "ai-tools"],
  "labels": ["文档处理"],
  "status": "ACTIVE",
  "visibility": "PUBLIC",
  "skillLabel": "文档处理",
  "needApiKey": false,
  "downloadCount": 42,
  "starCount": 3,
  "ratingAvg": 4.5,
  "ratingCount": 6,
  "createdByName": "张三",
  "createdByDept": "AI平台部",
  "createdAt": "...",
  "updatedAt": "...",
  "headlineVersion": { "id": 11, "version": "1.2.0", "status": "PUBLISHED" },
  "publishedVersion": { "id": 11, "version": "1.2.0", "status": "PUBLISHED" }
}
```

**关键字段**

| 字段 | 说明 |
|------|------|
| `namespaces` | 所属全部命名空间（`namespace` 为主命名空间 slug） |
| `headlineVersion` | 头条 / 推荐展示版本 |
| `publishedVersion` | **当前已发布版本**；查看概览、下载指定版本时使用其 `version` 值 |

---

### 4.3 版本列表

**用途**：展示版本历史（版本号、changelog、发布时间），供用户选择要查看 / 安装的版本。

```http
GET /{namespace}/{slug}/versions?page=0&size=20
```

**响应示例**

```json
{
  "code": 200,
  "success": true,
  "items": [
    {
      "id": 11,
      "version": "1.2.0",
      "status": "PUBLISHED",
      "changelog": "修复 xxx",
      "fileCount": 5,
      "totalSize": 102400,
      "publishedAt": "2026-03-01T10:00:00Z",
      "downloadReady": true,
      "createdByName": "张三"
    }
  ],
  "total": 3,
  "page": 0,
  "size": 20
}
```

**字段说明**

| 字段 | 说明 |
|------|------|
| `version` | 版本号，用作版本相关接口路径参数 |
| `status` | 仅 `PUBLISHED` 可被普通用户查看 / 下载 |
| `changelog` | 变更说明 |
| `fileCount` | 包内文件数 |
| `totalSize` | 包总大小（字节） |
| `downloadReady` | 下载包是否就绪 |

- 按发布时间**倒序**，`items[0]` 为最新版本。
- 安装前检查：`status === "PUBLISHED" && downloadReady === true`。

---

### 4.4 版本详情

**用途**：查看单个版本的完整信息。

```http
GET /{namespace}/{slug}/versions/{version}
```

**响应形式**：业务字段平级，即 4.3 中单个 `items[i]` 的全部字段，另含 `parsedMetadataJson`（解析后的元数据）。

---

### 4.5 概览文档（SKILL.md）

**用途**：渲染技能详情中的「概览」Tab。返回该版本包内 `SKILL.md` 的**原文内容**（Markdown），与平台前端的概览展示同源。

```http
GET /{namespace}/{slug}/versions/{version}/file?path=SKILL.md
```

- `path` 为 query 参数，固定传 `SKILL.md`（需 URL-encode）。

**响应**

| 情况 | 说明 |
|------|------|
| 成功 | HTTP 200，`Content-Type: application/octet-stream`，**body 为 SKILL.md 的 UTF-8 原始文本**（无 JSON 包装），按文本读取后交给 Markdown 渲染器 |
| 失败 | 返回 JSON 错误体（`success == false`），按 `Content-Type` 判断 |

---

### 4.6 下载最新已发布版本

**用途**：安装技能的主入口，下载最新版 ZIP 包。

```http
GET /{namespace}/{slug}/download
```

**响应**

| 情况 | 说明 |
|------|------|
| 成功 | HTTP 200，**ZIP 二进制流**；`Content-Type: application/zip`；`Content-Disposition: attachment; filename="xxx.zip"`（`filename` 为 URL-encoded，解析后作为本地文件名） |
| 失败 | JSON 错误体，或 HTTP 403 / 404 |

- 超时建议 ≥ **60s**（应用服务器流式传输）。

---

### 4.7 下载指定版本

**用途**：用户显式选择历史版本时，下载该版本 ZIP。

```http
GET /{namespace}/{slug}/versions/{version}/download
```

**响应**：与 [4.6](#46-下载最新已发布版本) 完全一致（ZIP 流）。仅 `PUBLISHED` 且当前用户有权限的版本可下载。

---

## 5. 插件调用流程

```
登录 /login                                    → token（缓存复用，401 时重登）
检索  GET /search (q, page, size)              → 渲染技能列表
详情  GET /{namespace}/{slug}                  → 渲染详情，取 publishedVersion.version
概览  GET /{namespace}/{slug}/versions/{v}/file?path=SKILL.md → Markdown 渲染
版本  GET /{namespace}/{slug}/versions         → 版本历史 / 选择安装版本
安装  GET /{namespace}/{slug}/download         → 收 ZIP → 解压到本地技能目录
```

**安装目录建议**：`{skillsDir}/{namespace}--{slug}/`，避免重名冲突。

---

## 6. 错误码与异常处理

| 状态 | 语义 | 插件处理建议 |
|------|------|--------------|
| `401` | token 失效 / 未登录 | 清除缓存 token，跳转重新登录，原请求重试一次 |
| `403` | 账号缺少对应权限 | 提示「无权限」，引导到平台调整角色权限（不改 token） |
| `404` | 技能 / 版本不存在，或当前账号无权可见 | 提示资源不可用，刷新列表 |
| 下载接口返回 JSON | 下载失败 | 按 `Content-Type` 分流：`application/json` → 解析错误体；`application/zip` → 写文件 |

> 鉴权类与资源类错误在所有接口中表现一致，建议在 HTTP 封装层统一拦截处理。

---

## 7. 注意事项

1. **404 语义**：技能 / 版本不存在，**或当前账号无权可见**；**403 语义**：账号缺少对应权限，需到平台调整角色权限。
2. 接口以**内网实测**与后端 Swagger（`{BASE}/docs`）为准。
3. 后端源码位置：`backend/module_skillhub/controller/skill_controller.py`。
