# Codeg Extended 插件开发指南 (Plugin Development Guide)

本指南面向希望为 Codeg Extended 编写插件的开发者，介绍从零开始创建、调试、打包以及发布插件的全流程。

---

## 一、架构概览

Codeg Extended 插件系统 v2 采用**双端沙箱与生命周期管理**架构：

- **宿主后端 (Rust)**：负责插件清单校验、安全路径隔离、状态持久化、后台服务进程拉起与保活、秘钥存储。
- **宿主前端 (Next.js / React)**：通过单文件 ESM 动态加载机制（Blob URL 隔离）挂载插件，注入受控的 `PluginContext` 对象；支持向状态栏、覆盖层注入组件；停用时自动清理所有副作用（LIFO 逆序销毁）。
- **后台服务 (Python / Node / 可执行程序)**：独立进程运行，监听本地随机分配的端口，通过 Bearer Token 进行双向鉴权。

---

## 二、插件目录结构规范

每个插件应位于一个以其 `id` 命名的文件夹中。推荐结构如下：

```text
my-plugin/
├── codeg-plugin.json      # [必填] 插件元数据与权限声明
├── dist/
│   └── index.js           # [可选] 前端单文件 ESM 入口
├── styles/
│   └── style.css          # [可选] CSS 样式表
├── backend/               # [可选] 常驻本地后台服务
│   ├── server.py
│   └── requirements.txt
└── README.md              # [推荐] 插件使用说明
```

> 提示：可以直接复制仓库中的 [`plugins/_template`](../../plugins/_template) 作为起步脚手架。

---

## 三、前端入口与 PluginContext API

如果插件声明了 `"main": "dist/index.js"`，入口文件必须导出 `activate(ctx)` 函数：

```javascript
export function activate(ctx) {
  ctx.logger.info("插件启动:", ctx.id)

  // 1. 注册状态栏挂件
  ctx.registerSlot("statusbar.right", {
    id: "my-status-button",
    order: 10,
    mount(el) {
      const btn = document.createElement("button")
      btn.textContent = "My Plugin"
      btn.className = "px-2 py-0.5 text-xs rounded hover:bg-accent"
      btn.onclick = () => ctx.notify("点击成功！", "success")
      el.appendChild(btn)

      return () => btn.remove()
    }
  })

  // 2. 监听配置变更
  ctx.config.onChange((newConfig) => {
    ctx.logger.info("配置发生变动:", newConfig)
  })

  // 3. 注册退出清理逻辑
  ctx.onDispose(() => {
    ctx.logger.info("插件已停用并完成清理")
  })
}

export function deactivate() {
  // 可选：所有由 ctx 注册的插槽、样式和监听器均由宿主自动注销
}
```

### 3.1 `ctx` 属性与方法全览

#### 基础信息
- `ctx.id`: 当前插件 ID（如 `my-plugin`）。
- `ctx.version`: 当前插件版本（如 `1.0.0`）。
- `ctx.hostVersion`: 宿主软件版本（如 `1.0.0`）。
- `ctx.env`: 环境上下文 `{ locale: string, theme: "light" | "dark", mode: "desktop" | "web" }`。

#### UI 注入与插槽
- `ctx.injectCSS(css: string)`: 动态注入一段 CSS 字符串。停用时自动移除。
- `ctx.registerSlot(slotName, contribution)`: 向界面插槽挂载内容。
  - **支持的插槽名 (`SlotName`)**：
    - `"statusbar.left"`：底部状态栏左侧区域。
    - `"statusbar.right"`：底部状态栏右侧区域。
    - `"workspace.overlay"`：工作区中央浮层。
    - `"settings.plugin-detail"`：插件中心详情页扩展区。
  - **Contribution 结构**：
    - `id: string`：挂件唯一标识。
    - `order?: number`：挂载排序权重（数值越小越靠前，默认 0）。
    - `mount(el: HTMLElement): void | (() => void)`：挂载回调，接收宿主容器 DOM 节点；可返回一个卸载清理函数。

#### 通知与提示
- `ctx.notify(message: string, type?: "info" | "success" | "warning" | "error")`: 触发宿主全局 Toast 提示。

#### 配置管理
- `ctx.config.get<T>()`: 异步获取当前插件配置键值对象。
- `ctx.config.onChange<T>(callback)`: 监听配置变动并回调最新配置。

#### 后台进程通讯
- `ctx.backend.status()`: 异步获取后台进程运行状态（`stopped`、`starting`、`running`、`unhealthy` 等）。
- `ctx.backend.onStatus(callback)`: 监听后台状态流。
- `ctx.backend.fetch(path, init)`: 经由宿主底层安全代理向后台发起 HTTP 请求，免去 CORS 与端口直连问题。

#### 静态资源
- `ctx.assets.url(relPath)`: 将插件目录内的相对资源路径（如 `assets/logo.png`）转换为安全的 Blob URL。宿主在插件停用时会自动 `revokeObjectURL`。

#### React 与工具类
- `ctx.react.React`: 宿主共享的 React 命名空间。
- `ctx.react.createRoot`: 宿主共享的 `react-dom/client` `createRoot` 方法。
- `ctx.logger`: 包含 `info`、`warn`、`error`，自动在控制台添加 `[plugin:<id>]` 前缀。
- `ctx.onDispose(fn)`: 注册清理函数。插件停用时以 **LIFO (后进先出)** 顺序调用。

---

## 四、后台服务开发规范

若插件需要常驻后台（如本地模型推理、代理服务），可在 `codeg-plugin.json` 中声明 `backend` 字段。

### 4.1 安全与通讯协议
1. **只能监听回环地址**：必须监听 `127.0.0.1`，严禁绑定 `0.0.0.0`。
2. **Token 双向验证**：宿主启动进程时会注入环境变量 `CODEG_PLUGIN_TOKEN`。后台接收到的每个非 `/healthz` 请求必须在 `Authorization` 头中校验该 Bearer Token。
3. **健康检查探针**：必须提供轻量、快速、不依赖外部联网的探针端点（通常为 `GET /healthz`），返回 200 即代表服务就绪。
4. **端口协商**：从环境变量 `PORT` 中读取宿主分配的端口（或清单中声明的 `port` 占位）。

### 4.2 Python 服务参考示例 (`backend/server.py`)

```python
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = int(os.environ.get("PORT", "18080"))
TOKEN = os.environ.get("CODEG_PLUGIN_TOKEN", "")

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
            return

        # 校验访问令牌
        auth = self.headers.get("Authorization", "")
        if auth != f"Bearer {TOKEN}":
            self.send_response(401)
            self.end_headers()
            return

        if self.path == "/v1/data":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"data":"hello from backend"}')
            return

        self.send_response(404)
        self.end_headers()

if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Server running on 127.0.0.1:{PORT}", file=sys.stderr)
    server.serve_forever()
```

---

## 五、安装与分发方式

用户在 Codeg Extended 中有三种方式安装你的插件：

### 5.1 方式一：Git 仓库地址安装
在插件中心输入 Git 仓库 URL，支持指向子目录：
- `https://github.com/<owner>/<repo>/tree/main/plugins/<plugin-id>`
- `https://github.com/<owner>/<repo>.git`

宿主会自动克隆或提取对应子目录，校验清单并完成安装。当你在仓库发布新版本时，用户在设置页点击「检查更新」即可自动拉取更新。

### 5.2 方式二：Zip 压缩包上传
将插件根目录（包含 `codeg-plugin.json`）压缩为 `.zip` 文件，在「设置」->「插件」中点击「上传安装」，拖入压缩包即可。

### 5.3 方式三：本地开发模式
在插件中心开启「开发者模式」后：
- 将插件目录直接放入宿主的插件数据目录下。
- 文件修改时前端支持快速热重载，无需重启整个应用。

---

## 六、安全模式与故障排查

若遇到第三方插件导致应用崩溃或白屏：
1. 宿主内置**连续失败熔断机制**：连续崩溃或报错达到 3 次的插件会被自动标记并停用。
2. 启动时注入环境变量 `CODEG_PLUGINS_SAFE_MODE=1`：宿主将进入安全模式，所有插件被强制禁用，用户可在干净状态下卸载故障插件。

---

## 七、相关文档与资源 (Related Documentation)

- [插件架构与清单规范 (Manifest Specification)](./manifest-spec.md)
- [Plugin SDK 与 API 参考规范 (SDK Reference)](./sdk.md)
- [JSON Schema 校验规范 (codeg-plugin.schema.json)](./codeg-plugin.schema.json)
- [官方示例插件库 (Plugins Repository)](../../plugins/README.md)
- [新手脚手架模板 (Starter Template)](../../plugins/_template/README.md)
