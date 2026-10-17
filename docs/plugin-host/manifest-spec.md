# Codeg Extended 插件清单规范 (codeg-plugin.json)

本文档是 Codeg Extended 插件系统 v2 的清单规范说明，面向所有插件作者。清单文件名必须为 `codeg-plugin.json`，置于插件根目录下。

---

## 一、基本概念与文件位置

每个插件在文件系统中作为一个独立目录存在，目录名必须与插件的 `id` 保持完全一致：

```text
<plugins-root>/<plugin-id>/
├── codeg-plugin.json       # 必须：插件元数据清单
├── dist/index.js           # 可选：前端单文件 ESM 入口
├── styles/main.css         # 可选：CSS 样式文件
└── backend/server.py       # 可选：后台守护服务入口
```

宿主使用 JSON Schema 校验清单合法性。规范 Schema 可参考同目录下的 [`codeg-plugin.schema.json`](./codeg-plugin.schema.json)。

---

## 二、清单字段总览

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "apiVersion": 1,
  "engines": {
    "pluginHost": ">=1.0.0 <2.0.0"
  },
  "description": "插件功能简述",
  "author": "Author Name",
  "category": "tools",
  "icon": "sparkles",
  "permissions": [
    "ui",
    "network"
  ],
  "main": "dist/index.js",
  "styles": [
    "styles/main.css"
  ],
  "configSchema": {
    "type": "object",
    "properties": {
      "endpoint": {
        "type": "string",
        "title": "API 端点",
        "default": "https://api.example.com"
      },
      "apiKey": {
        "type": "string",
        "title": "API 密钥",
        "format": "secret"
      }
    },
    "required": ["endpoint"]
  },
  "backend": {
    "command": "${python}",
    "args": ["backend/server.py"],
    "env": {
      "PORT": "${port}",
      "TOKEN": "${token}"
    },
    "port": 18080,
    "healthcheck": {
      "path": "/healthz",
      "timeoutMs": 10000
    },
    "restart": "on-failure"
  },
  "contributes": {
    "quickMessages": [
      {
        "title": "Code Review",
        "content": "Please review this code for correctness and readability."
      }
    ]
  }
}
```

---

## 三、字段详细说明

### 3.1 核心标识字段（必填）

| 字段 | 类型 | 说明 | 约束 |
|---|---|---|---|
| `id` | `string` | 插件唯一标识符 | 正则 `^[a-z0-9][a-z0-9-]{1,63}$`。小写字母或数字开头，可包含连字符 `-`，长度 2~64 位。必须与父目录名严格一致。 |
| `name` | `string` | 插件展示名称 | 不能为空，不能全为空格。 |
| `version` | `string` | 插件语义化版本 | 必须符合 SemVer 2.0 规范（例如 `1.0.0`、`2.1.3-beta.1`）。 |
| `apiVersion` | `number` | 插件系统 API 协议版本 | 当前版本必须为 `1`。 |
| `engines` | `object` | 宿主环境依赖要求 | 必须包含 `pluginHost` 属性。 |
| `engines.pluginHost` | `string` | 支持的宿主版本范围 | npm 风格语义化版本范围（例如 `>=1.0.0 <2.0.0`）。当前宿主版本为 `1.0.0`。 |

### 3.2 元信息与分类（可选）

| 字段 | 类型 | 说明 | 取值范围 |
|---|---|---|---|
| `description` | `string` | 插件简介 | 用于在插件设置面板中展示给用户。 |
| `author` | `string` | 插件作者或组织 | 文本说明。 |
| `category` | `string` | 功能分类 | `appearance`（界面外观）、`model-provider`（模型供应商）、`tools`（扩展工具）、`workflow`（工作流/自动化）、`utility`（常用辅助）。 |
| `icon` | `string` | 插件图标 | 内置图标名称（如 `sparkles`、`terminal`）或插件目录内的相对图片路径（如 `icon.png`）。 |

### 3.3 权限声明（`permissions`）

插件需如实声明所需的宿主特权能力：

- `ui`：允许注入 CSS 样式及向界面插槽注册组件。
- `process`：允许启动和管理本地后台进程（即声明了 `backend` 字段）。
- `modelProviders`：允许向 Codeg 注册模型通道提供方。
- `mcp`：允许注册与管理 MCP (Model Context Protocol) 外部服务。
- `quickMessages`：允许向输入框上方快捷消息栏注册预设提示词。
- `network`：允许插件前端或后台发起外部网络请求。

### 3.4 前端入口与样式（`main` / `styles`）

- `main`：前端单文件 ESM 相对路径（通常为 `dist/index.js`）。
  - **安全约束**：必须是相对路径，严禁使用以 `/`、`\` 开头的绝对路径，严禁包含 `..` 上级目录逃逸。该文件在磁盘上必须真实存在。
- `styles`：CSS 相对文件路径数组（例如 `["styles/style.css"]`）。
  - 插件启用时由宿主自动读取并注入到文档中；停用时自动卸载，不留残留。列表中每个文件在磁盘上必须真实存在。

### 3.5 配置项表单定义（`configSchema`）

`configSchema` 是轻量级 JSON Schema 的子集，用于让宿主自动生成设置表单：

```json
{
  "type": "object",
  "properties": {
    "serverUrl": {
      "type": "string",
      "title": "服务器地址",
      "description": "远端推理服务的 HTTP URL",
      "default": "http://127.0.0.1:8000"
    },
    "maxTokens": {
      "type": "integer",
      "title": "最大 Token 数",
      "default": 4096
    },
    "enableFeature": {
      "type": "boolean",
      "title": "启用实验性功能",
      "default": false
    },
    "apiKey": {
      "type": "string",
      "title": "访问令牌",
      "format": "secret"
    }
  },
  "required": ["serverUrl"]
}
```

- **`format: "secret"`**：声明为敏感字段。该字段值会安全加密保存在操作系统钥匙串（Credential Manager / Keychain）中，前端读取配置时只返回「已设置/未设置」标记，不会在 HTTP/状态流中明文传输。

### 3.6 后台守护进程（`backend`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `command` | `string` | 执行程序名或模板变量（如 `${python}`、`node`）。 |
| `args` | `string[]` | 启动参数列表。支持变量扩展。 |
| `setup` | `object` | 首次启动或版本更新时的依赖准备命令（例如 pip 安装）。包含 `command` 和 `args`。 |
| `env` | `object` | 注入后台进程的环境变量键值对。支持变量扩展。 |
| `port` | `number \| string` | 期望绑定的端口或固定端口。若被占用宿主会自动分配可用端口。 |
| `healthcheck` | `object` | 就绪与保活探针。包含 `path`（如 `/healthz`）和 `timeoutMs`（超时毫秒）。 |
| `restart` | `string` | 重启策略：`no`、`always`、`on-failure`。 |

### 3.7 声明式贡献（`contributes`）

- `quickMessages`：向快捷消息列表注入提示词模板。每个条目包含 `title` 和 `content`。
- `modelProviders`：声明式注入模型供应商通道，包含 `key`、`name`、`apiUrl`、`apiKey`、`agentTypes` 等字段。

---

## 四、变量模板扩展

在 `backend` 的 `command`、`args`、`env` 以及 `contributes` 中，支持以下占位变量动态注入：

| 变量 | 含义 | 示例解析值 |
|---|---|---|
| `${pluginDir}` | 当前插件在宿主系统中的绝对根目录 | `/path/to/plugins/<id>` |
| `${dataDir}` | 宿主全局数据目录 | `/path/to/data` |
| `${port}` | 后台实际分配并成功监听的本地端口号 | `18080` |
| `${token}` | 宿主为当前插件签发的安全通讯令牌 | `sec_xxxx...` |
| `${backend.url}` | 后台完整的本地基准地址 | `http://127.0.0.1:18080` |
| `${config.<key>}` | 读取当前插件配置项中的值 | `${config.authFile}` |
| `${python}` | 宿主当前使用的 Python 解释器绝对路径 | `/usr/bin/python3` |
| `${node}` | 宿主当前使用的 Node.js 解释器绝对路径 | `/usr/bin/node` |

---

## 五、相关文档与资源 (Related Documentation)

- [插件开发实战指南 (Plugin Development Guide)](./plugin-development-guide.md)
- [Plugin SDK 与 API 参考规范 (SDK Reference)](./sdk.md)
- [JSON Schema 校验规范 (codeg-plugin.schema.json)](./codeg-plugin.schema.json)
- [官方示例插件库 (Plugins Repository)](../../plugins/README.md)
- [新手脚手架模板 (Starter Template)](../../plugins/_template/README.md)
