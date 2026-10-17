# Codeg Extended 插件 SDK 规范 (Plugin Host v2 SDK Specification)

本文档面向 Codeg Extended 插件开发者与扩展包作者，全面阐述 Codeg 插件系统的运行时架构、生命周期模型、`PluginContext` SDK API 规范、插槽扩展机制、声明式贡献体系以及开发调试与热重载最佳实践。

---

## 1. 架构与运行模型

Codeg Extended 采用**双端沙箱与协同进程模型**：

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          Codeg Extended 宿主                            │
├──────────────────────────────────┬─────────────────────────────────────┤
│      宿主前端 (Next.js / React)   │          宿主后端 (Rust / Tauri)     │
│  - 沙箱执行环境 (Blob URL ESM)   │  - 插件清单校验 & 安全路径沙箱       │
│  - PluginContext 动态注入        │  - 状态管理 & state.json 持久化      │
│  - 插槽挂载系统 (Slot System)    │  - 后台进程守护 (Supervisor & Backoff)│
│  - LIFO 逆序销毁机制             │  - 凭据安全存储 & Token 派发         │
│  - 实时事件网桥 (Event Bridge)   │  - 开发模式文件监听 (Notify 300ms)   │
└──────────────────────────────────┴─────────────────────────────────────┘
                                      │
                                      ▼ (标准双向进程通信 / HTTP Bearer)
┌────────────────────────────────────────────────────────────────────────┐
│                   插件后台服务 (Python / Node / Binary)                │
│  - 本地随机空闲端口绑定 (127.0.0.1:<port>)                             │
│  - Bearer Token 强身份校验 (CODEG_PLUGIN_TOKEN 环境变量)               │
│  - 声明式贡献提供 (ModelProvider / MCP Server)                         │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.1 安全模式 (Safe Mode)
当环境变量 `CODEG_PLUGINS_SAFE_MODE=1` 时，宿主进入安全急救模式：
- 禁用所有已安装插件的启动与后台进程执行。
- 仅提供清单浏览与卸载功能，防止崩溃级插件阻碍主程序恢复。

### 1.2 权限控制模型 (Permissions)
插件必须在 `codeg-plugin.json` 的 `permissions` 数组中预先声明权限方可调用对应 API 或声明贡献：
- `"ui"`：允许注入 CSS、挂载状态栏/覆盖层/设置页插槽。
- `"process"`：允许拉起后台常驻进程及调用 `ctx.backend.*`。
- `"modelProviders"`：允许向全局注册模型提供商（如 WorkBuddy 或本地推理服务）。
- `"mcpServers"`：允许向智能体提供 MCP (Model Context Protocol) 工具集。
- `"quickMessages"`：允许注入快捷指令与 Prompt 模板。

---

## 2. 插件生命周期 (Lifecycle)

每个声明了 `"main": "dist/index.js"` 的插件均遵循标准的加载与清理生命周期。

### 2.1 钩子函数导出

```typescript
/**
 * 插件激活入口：在插件启用、宿主启动或热重载时调用
 * @param ctx 宿主注入的受控 PluginContext 对象
 */
export function activate(ctx: PluginContext): void | Promise<void>;

/**
 * 插件停用清理：在插件禁用、卸载或重载前调用
 */
export function deactivate(): void | Promise<void>;
```

### 2.2 资源销毁与 LIFO 保证 (Cleanups & onDispose)
1. 插件在 `activate(ctx)` 内部通过 `ctx.registerSlot`、`ctx.injectCSS`、`ctx.config.onChange`、`ctx.backend.onStatus` 注册的资源，均会自动绑定到该插件的作用域下。
2. 开发者可通过 `ctx.onDispose(() => { ... })` 注册自定义销毁逻辑。
3. 当插件被停用或重载时，宿主严格按照**LIFO (后入先出)**顺序执行清理回调，保证：
   - 0 遗留 DOM 节点：插槽元素调用 `mount()` 返回的 cleanup 函数。
   - 0 遗留全局样式：动态注入的 `<style>` 标签自动移除。
   - 0 遗留事件监听器：后台状态变化与配置变化订阅自动注销。

---

## 3. PluginContext API 参考

`PluginContext` 是插件与宿主交互的核心抽象对象。

### 3.1 基础属性
```typescript
interface PluginContext {
  /** 插件唯一标识符 (例如 "workbuddy-connect") */
  readonly id: string;
  /** 插件配置清单元数据 */
  readonly manifest: PluginManifest;
  /** 宿主环境信息 */
  readonly env: PluginEnv;
  /** 统一日志记录器 */
  readonly logger: PluginLogger;
}
```

### 3.2 宿主环境 `ctx.env`
```typescript
interface PluginEnv {
  hostVersion: string;         // 宿主版本 (如 "1.0.0")
  apiVersion: number;          // 插件 API 版本 (当前为 1)
  platform: "desktop" | "web"; // 运行平台
  theme: "light" | "dark" | "system"; // 当前激活主题
}
```

### 3.3 样式注入 `ctx.injectCSS(css: string): () => void`
动态向宿主 DOM 注入作用域 CSS 样式。返回一个手动清理函数（停用时自动清理）。
```typescript
const removeCSS = ctx.injectCSS(`
  .my-widget {
    color: var(--primary);
    background: var(--muted);
  }
`);
```

### 3.4 插槽挂载 `ctx.registerSlot(slotId, definition): () => void`
向宿主预定义的 UI 插槽注入可视化组件或控件。详见下文第 4 节。

### 3.5 消息通知 `ctx.notify`
调用宿主统一的 Toast 通知系统。
```typescript
ctx.notify("操作成功完成", "success", { duration: 3000 });
ctx.notify("网络请求超时", "error");
```

### 3.6 配置管理 `ctx.config`
安全读写插件的持久化配置项（非敏感配置存入 `state.json`，敏感密文存入系统 Keyring）。
```typescript
// 1. 读取当前配置
const config = await ctx.config.get();
const isEnabled = config.values["enableFeature"] ?? true;

// 2. 更新配置
await ctx.config.set(
  { enableFeature: false, maxRetries: 3 },
  { secretApiKey: "sk-xxxxxxxx" } // 密文存储，不写入明文磁盘
);

// 3. 监听配置实时变化
const unwatch = ctx.config.onChange((newValues) => {
  console.log("Config updated:", newValues);
});
```

### 3.7 后台通信 `ctx.backend` (需 `process` 权限)
与插件的伴生本地服务进行安全通信。
```typescript
// 1. 获取当前后台服务状态
const status = ctx.backend.status();
console.log(`Backend PID: ${status.pid}, Port: ${status.port}, State: ${status.state}`);

// 2. 监听后台生命周期与心跳状态
ctx.backend.onStatus((status) => {
  if (status.state === "crashed") {
    ctx.notify("后台进程异常退出，正在尝试自愈...", "warning");
  }
});

// 3. 代理 HTTP 请求（宿主自动注入 Bearer Token 与 127.0.0.1 端口映射）
const res = await ctx.backend.fetch("/v1/models", {
  method: "GET",
  headers: { "Content-Type": "application/json" }
});
const data = await res.json();

// 4. 重启后台服务
await ctx.backend.restart();
```

### 3.8 资源定位 `ctx.assets`
安全解析插件私有目录内的静态资源：
```typescript
// 解析安全资源 URL (通过 Blob 或 asset 代理)
const logoUrl = ctx.assets.resolve("assets/logo.png");

// 直接读取为 Base64 与 MIME
const { mime, base64 } = await ctx.assets.read("assets/icon.svg");
```

---

## 4. 插槽系统规范 (Slot System)

Codeg 提供了声明式的插槽系统，允许插件安全挂载交互组件。

### 4.1 可用插槽点

| 插槽 ID | 位置 | 典型应用场景 |
|---|---|---|
| `statusbar.left` | 底部状态栏左侧 | 任务计数、版本指示、分支指示器 |
| `statusbar.right` | 底部状态栏右侧 | 后台运行状态指示灯、快捷弹出菜单、网络延时 |
| `workspace.overlay` | 工作区浮层 | 全局快速唤出面板、画板覆盖层、悬浮快捷球 |
| `settings.plugin-detail` | 设置中心插件详情卡片 | 插件专有配置面板、模型配额看板、诊断与自检卡片 |

### 4.2 SlotWidget 接口定义

```typescript
interface SlotWidget {
  /** 挂件在插槽内的唯一标识符 */
  id: string;
  /** 排序权重：数值越小越靠前，默认 100 */
  order?: number;
  /**
   * 挂载函数：在宿主容器挂载时调用
   * @param container 宿主提供的容器 HTMLElement
   * @returns 清理函数（必须释放所有绑定的 DOM 节点与事件），或 void
   */
  mount(container: HTMLElement): (() => void) | void;
}
```

### 4.3 插槽挂载示例与零内存泄漏规范
```typescript
ctx.registerSlot("statusbar.right", {
  id: "my-status-dot",
  order: 50,
  mount(container: HTMLElement) {
    const dot = document.createElement("span");
    dot.className = "w-2 h-2 rounded-full bg-emerald-500 cursor-pointer";
    dot.title = "WorkBuddy Service Active";

    const handleClick = () => {
      ctx.notify("WorkBuddy 服务运行正常", "info");
    };
    dot.addEventListener("click", handleClick);
    container.appendChild(dot);

    // 严禁遗留任何未注销的 DOM 节点或监听器
    return () => {
      dot.removeEventListener("click", handleClick);
      dot.remove();
    };
  }
});
```

---

## 5. 声明式贡献机制 (Contributes)

在 `codeg-plugin.json` 中，可通过 `contributes` 字段向 Codeg 宿主声明核心能力。

### 5.1 变量插值规则
宿主在解析 `contributes` 时支持以下动态变量：
- `${backend.url}`：伴生服务的完整 HTTP 地址（如 `http://127.0.0.1:49210`）
- `${backend.port}`：伴生服务的监听端口号（如 `49210`）
- `${token}`：伴生服务的随机安全 Bearer 鉴权凭证
- `${pluginDir}`：插件在当前操作系统中的绝对目录路径
- `${dataDir}`：Codeg 运行数据目录
- `${config.<key>}`：插件用户配置项的当前值

### 5.2 模型提供商贡献 (`contributes.modelProviders`)
```json
{
  "contributes": {
    "modelProviders": [
      {
        "id": "workbuddy-local",
        "name": "WorkBuddy AI",
        "apiType": "openai-compatible",
        "apiUrl": "${backend.url}/v1",
        "apiKey": "${token}",
        "agentTypes": ["codex", "open_code"],
        "defaultModel": "wb-code-v2"
      }
    ]
  }
}
```

### 5.3 MCP 工具服务贡献 (`contributes.mcpServers`)
```json
{
  "contributes": {
    "mcpServers": [
      {
        "id": "git-tools",
        "name": "Git MCP Server",
        "transport": "stdio",
        "command": "python",
        "args": ["${pluginDir}/mcp_server.py"]
      }
    ]
  }
}
```

### 5.4 快捷指令模板贡献 (`contributes.quickMessages`)
```json
{
  "contributes": {
    "quickMessages": [
      {
        "id": "code-review",
        "title": "审查当前更改",
        "content": "请对当前 git diff 中的更改进行安全性与性能代码审查。"
      }
    ]
  }
}
```

---

## 6. 开发模式与热重载 (Developer Mode)

Codeg Extended 提供了面向插件创作者的**即时热重载开发环境**。

### 6.1 开启开发模式
1. 打开 Codeg 设置 -> 插件管理中心 (Plugins Settings)。
2. 在头部工具栏中打开 **开发者模式 (Developer Mode)** 开关。
3. 宿主后端自动激活文件系统监视器（基于 Rust `notify` crate），实时监听插件安装目录（`~/.codeg/plugins/`）。

### 6.2 300ms 防抖与局部热替换机制
- **监视防抖**：宿主收集 300 毫秒时间窗口内的全部文件变动，合并受影响的插件 ID 列表。
- **差异刷新**：
  - 若特定插件目录（如 `my-plugin/dist/index.js`）发生变动，宿主向前端分发 `plugin-host://changed` 事件，附带受影响的 `ids: ["my-plugin"]`。
  - 前端运行时捕获事件后，先逆序销毁该插件的既有组件与样式，再重新加载其最新 ESM 代码并执行 `activate(ctx)`，无需重启整个应用。
  - 若根目录结构变更或无法推断具体插件，派发 `ids: []` 触发全局自动重建。
- **自动忽略列表**：监视器自动忽略虚拟环境 `.deps`、回收站 `.trash`、暂存区 `.staging`、`.tmp`、`.git` 以及 `state.json`，避免构建与状态写入引发重载循环。

### 6.3 配合 esbuild 实现无缝热重载工作流

推荐在插件源码工程中运行 esbuild 监视命令：

```bash
# 单文件零依赖打包并开启自动监视
npx esbuild src/index.ts --bundle --format=esm --outfile=dist/index.js --watch
```

**开发循环**：
1. 开发者在 `src/index.ts` 中修改 UI 或业务代码并保存。
2. esbuild 在数十毫秒内重新打包至 `dist/index.js`。
3. Codeg 开发模式监视器捕捉到文件变动，300ms 后触发 `plugin-host://changed`。
4. 前端应用界面实时无刷新重绘更新！

---

## 7. 纯单文件零依赖 ESM 打包规范

由于 Codeg 前端运行在严格的 Web 标准 ES Module 环境下：
1. **禁止裸模块导入 (No Bare Specifiers)**：
   打包产物 `dist/index.js` 中严禁出现未解析的第三方包导入语句（例如 `import _ from 'lodash'` 或 `import React from 'react'`），否则浏览器在动态解析 Blob URL 时会直接抛出 `TypeError: Failed to resolve module specifier`。
2. **零运行时外部依赖**：
   必须通过 esbuild 的 `--bundle` 参数将所有依赖内联编译为一个自包含的 ESM 文件。
3. **样式单文件化**：
   小规模样式可通过 `ctx.injectCSS(...)` 随 JS 动态注入，或存入 `styles/style.css` 并在清单中通过 `"styles": ["styles/style.css"]` 声明加载。
4. **日志排查路径**：
   伴生后台服务日志统一保存在 `~/.codeg/logs/plugins/<plugin-id>.log`（单文件上限 2MB，自动滚动轮转）。
