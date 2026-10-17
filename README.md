# Codeg Extended

<p align="center">
  <img src="./public/icon.svg" alt="Codeg Extended logo" width="80" align="absmiddle" />
</p>

<p align="center">
  <strong>基于 Codeg 官方客户端的现代化增强版本，原生内置 Plugin Host v2 插件系统与「🧩 插件中心」</strong>
</p>

<p align="center">
  <a href="https://github.com/18810701358cz-ops/codeg-extended/releases/latest"><img src="https://img.shields.io/github/v/release/18810701358cz-ops/codeg-extended?style=flat&color=3b82f6" alt="Latest release" /></a>
  <a href="https://github.com/18810701358cz-ops/codeg-extended/releases"><img src="https://img.shields.io/github/downloads/18810701358cz-ops/codeg-extended/total?style=flat&color=3b82f6" alt="Total downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/18810701358cz-ops/codeg-extended?style=flat&color=3b82f6" alt="License" /></a>
  <img src="https://img.shields.io/badge/Plugin%20Host-v2%20Ready-emerald?style=flat" alt="Plugin Host v2 Ready" />
</p>

---

## 📌 项目说明 (Overview)

**Codeg Extended** 是基于上游优秀开源项目 [spacering-net/codeg](https://github.com/spacering-net/codeg) 进行二次深度扩展的专业级 AI 智能体开发工作台。

在完整继承官方客户端卓越的多智能体协作、会话管理、智能画布 (Canvas)、无头浏览器自动化以及 MCP (Model Context Protocol) 工具生态的基础上，Codeg Extended 倾力打造了**完全自主研发、安全可靠、可深度定制的 Plugin Host v2 插件宿主系统**与原生交互的**「🧩 插件中心」**，使开发者能够随心所欲地扩展界面插槽、集成专属模型通道、注入后台常驻守护服务，并实现秒级无刷新的插件开发体验。

---

## 🌟 Plugin Host v2 核心扩展特性

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          Codeg Extended 宿主                            │
├──────────────────────────────────┬─────────────────────────────────────┤
│      宿主前端 (Next.js / React)   │          宿主后端 (Rust / Tauri)     │
│  - 沙箱执行环境 (Blob URL ESM)   │  - 清单强类型校验 (JSON Schema)     │
│  - PluginContext 动态注入        │  - 状态原子化存储 (state.json)       │
│  - 插槽挂载系统 (Slot System)    │  - 伴生进程守护 (Supervisor/Backoff) │
│  - LIFO 逆序自动销毁保证         │  - 系统安全凭据保管 (OS Keyring)     │
│  - 实时事件网桥 (Event Bridge)   │  - 目录监视热重载 (Notify 300ms)     │
└──────────────────────────────────┴─────────────────────────────────────┘
                                      │
                                      ▼ (本地回环 / HTTP Bearer 双向鉴权)
┌────────────────────────────────────────────────────────────────────────┐
│                   插件伴生服务 (Python / Node / Binary)                │
│  - 127.0.0.1 随机端口监听与 Zero-CORS 代理                             │
│  - CODEG_PLUGIN_TOKEN 随机安全凭证双向校验                             │
│  - 声明式贡献注入 (contributes.modelProviders / mcpServers)            │
└────────────────────────────────────────────────────────────────────────┘
```

### 1. 双端隔离的安全沙箱架构
- **宿主后端 (Rust Core)**：严格校验 `codeg-plugin.json` 清单规范，杜绝路径穿越与越权访问；内置连续 3 次崩溃熔断保护与安全急救模式（`CODEG_PLUGINS_SAFE_MODE=1`）；配置项中的敏感密钥（`format: "secret"`）由系统凭据管理器（Credential Manager / Keychain）直接托管，不以明文落盘。
- **宿主前端 (Web Sandbox)**：采用独立 Blob URL ES Module 动态加载机制，彻底隔离全局作用域；向插件注入受控的 `PluginContext` API；插件停用时执行严格的 **LIFO (后进先出)** 逆序清理，确保 **0 遗留 DOM 挂件、0 遗留全局样式、0 内存泄漏**。
- **伴生进程生命周期守护 (Supervisor & Backoff)**：支持 Python、Node 及可执行文件以后台进程常驻；动态绑定随机空闲端口；限制仅监听本地回环地址（`127.0.0.1`）；宿主自动签发高熵随机 Bearer Token 并注入环境变量 `CODEG_PLUGIN_TOKEN`；内置 `/healthz` 轻量探针与崩溃自愈重启策略。

### 2. 全场景插件安装与分发机制
- **Git 仓库一键安装**：支持输入 GitHub 完整仓库地址或深层子目录链接（例如 `https://github.com/18810701358cz-ops/codeg-extended/tree/main/plugins/workbuddy-connect`）。利用 Git Sparse-Checkout 精准提取插件，支持一键检查版本更新与失败自动回滚。
- **Multipart Zip 压缩包上传**：桌面端与 Web 端统一支持多部件 ZIP 文件上传安装，内置 Zip-Slip 路径穿越防御与单文件体积限制。
- **本地路径暂存安装**：支持直接从本地临时目录或开发路径暂存安装，便于脱网环境与内部测试。
- **安全卸载与回收隔离**：卸载插件时采用安全隔离暂存机制，杜绝文件残留。

### 3. 官方原生模型连接器：WorkBuddy Connect
- **零配置凭据探测**：自动检索并解密本机已认证登录的 WorkBuddy (`workbuddy-desktop.info`) 客户端凭证。
- **伴生 Python 服务托管**：宿主自动拉起 `backend/server.py`，自动装载隔离依赖目录（`.deps`），并通过 `/healthz` 执行毫秒级存活检查。
- **零 CORS 代理与 Bearer Token 强隔离**：全通信链路经过宿主底层安全桥接，阻断非授权外部调用。
- **声明式模型供应商注册**：自动向 Codeg 全局注入 `contributes.modelProviders`，让 Codeg 内置的各类 AI 智能体（如 `codex`、`open_code` 等）直接调用本机 WorkBuddy 的高性能模型能力，免除额外 API Key 开销。

### 4. 3 款内置开箱即用界面与交互插件
- **`dsh-cyber-glow` (DSH 霓虹微光)**：汲取 DeepSeek Harness 灵感的高级半透明赛博暗色霓虹微光主题。
- **`dsh-compact-layout` (DSH 紧凑极客模式)**：优化会话视口高度与卡片外边距，显著提升代码阅读与排版信息密度。
- **`dsh-quick-actions` (DSH 快捷动作挂件)**：在状态栏右侧注入交互式快捷按钮与全局通知触发面板。
- *所有内置插件直接打包进二进制程序中，默认关闭，用户可在设置中按需一键启用。*

### 5. 开发者模式与极速热重载 (Developer Mode)
- **毫秒级文件监视**：在插件中心开启「开发者模式」后，Rust 后端监视器实时监听插件目录变更，经过 ~300ms 智能防抖合并受影响的插件 ID 列表。
- **差异化热替换**：仅重载修改过的插件前端模块，无需重启整个应用。
- **自动规避无关扰动**：监视器自动忽略虚拟依赖环境（`.deps`）、暂存区（`.staging`）、回收站（`.trash`）、版本库（`.git`）及状态文件（`state.json`），彻底避免循环触发。
- **配合 esbuild 单文件极速工作流**：支持 TypeScript 源码实时编译打包为纯单文件零依赖 ESM。

### 6. 数据备份系统深度整合
- 深度整合 Codeg 原生备份恢复系统，自动将已安装插件目录纳管至 `plugins` 备份分区。
- 自动剔除 `.deps`（临时虚拟依赖包）、`.staging`（暂存文件）、`.trash`（回收站缓存），确保导出的备份归档包体积精巧纯净。

### 7. 独立更新源与数字签名
- 客户端内置的自动更新模块定向至本项目独立专属的 GitHub Release 通道，并由独立的 Ed25519 数字签名校验保护，避免被官方原版安装包覆盖。

---

## 🧩 插件中心使用指南 (User Guide)

### 1. 打开插件管理中心
启动 Codeg Extended 客户端，点击左下角 **偏好设置 (Settings)** -> 选择左侧导航栏的 **「🧩 插件中心」 (Plugins)**。

### 2. 通过 Git 仓库安装插件
1. 在插件中心顶部点击 **「从 Git 安装」 (Install from Git)**。
2. 输入插件的 Git 仓库 URL 或官方子目录 URL：
   - 官方 WorkBuddy 连接器：`https://github.com/18810701358cz-ops/codeg-extended/tree/main/plugins/workbuddy-connect`
   - 官方快捷提示词包：`https://github.com/18810701358cz-ops/codeg-extended/tree/main/plugins/prompt-pack`
3. 点击 **「克隆并安装」**，宿主将自动拉取、校验清单并在几秒内完成部署。

### 3. 通过 Zip 压缩包上传安装
1. 下载或打包插件目录为标准 `.zip` 格式（根目录必须包含 `codeg-plugin.json`）。
2. 在插件中心点击 **「上传插件包」 (Upload Archive)**，选择或拖入 `.zip` 文件。
3. 宿主自动解压、校验并载入插件。

### 4. 插件日常管理与维护
- **启停控制**：每个插件卡片右上角配有独立 Switch，随时一键启用或禁用。
- **配置与密钥**：点击插件卡片上的 **「设置」** 齿轮图标，即可呼出配置抽屉，填写参数或密文 API Token。
- **检查更新**：对通过 Git 安装的插件，点击 **「检查更新」** 即可比对远端版本并无缝热更新。
- **一键卸载**：点击 **「卸载」** 按钮，宿主将安全终止伴生进程并清理插件文件。

---

## ⚡ WorkBuddy Connect 官方插件使用教程

**WorkBuddy Connect** 是 Codeg Extended 官方推出的模型桥接插件，能够无缝调用本机已登录的 WorkBuddy 高性能推理模型。

### 1. 前置条件
- 本机已安装并运行 **Python 3.10 或更高版本**（可通过终端运行 `python --version` 确认）。
- 本机已安装并登录 **WorkBuddy Desktop** 客户端。

### 2. 安装步骤
1. 打开 Codeg Extended 的 **「偏好设置」 -> 「🧩 插件中心」**。
2. 点击 **「从 Git 安装」**，填入官方插件仓库地址：
   ```text
   https://github.com/18810701358cz-ops/codeg-extended/tree/main/plugins/workbuddy-connect
   ```
3. 点击确认安装。安装完成后，点击插件卡片上的开关切换为 **「启用」**。

### 3. 运行验证与模型调用
- **服务就绪**：插件启动时会自动通过 `pip` 安装必要的轻量依赖至插件私有目录 `.deps`，拉起后台守护进程并完成 `/healthz` 就绪探针校验。
- **自动注册模型供应商**：启用成功后，插件会自动将 `WorkBuddy` 注册为系统的模型供应商（Model Provider）。
- **智能体无缝对话**：在 Codeg 聊天对话区或智能体设置中，模型选择列表即可直接选取 WorkBuddy 提供的模型（如 `codex`、`open_code` 等）展开丝滑对话与代码编写！

---

## 🛠️ 插件开发者指南 (Developer Guide)

### 1. 开启开发者模式
在 **「偏好设置」 -> 「🧩 插件中心」** 顶部工具栏中开启 **「开发者模式」 (Developer Mode)**。宿主后端将实时监视 `~/.codeg/plugins/` 目录。

### 2. 从官方脚手架起步
复制仓库中的 [`plugins/_template`](./plugins/_template) 目录至你的插件工作区：
```bash
cp -r plugins/_template my-awesome-plugin
```

### 3. 目录结构规范
```text
my-awesome-plugin/
├── codeg-plugin.json       # [必填] 插件元数据、权限声明与配置 Schema
├── src/                    # [可选] 源码目录 (TypeScript / React)
│   └── index.ts            # 前端源码入口
├── dist/                   # [必填] 打包产物目录
│   └── index.js            # 前端自包含 ESM 单文件入口
├── styles/                 # [可选] CSS 样式目录
│   └── style.css           # 插件样式表
├── backend/                # [可选] 伴生本地后台服务
│   ├── server.py           # 伴生服务入口脚本
│   └── requirements.txt    # 依赖包列表
└── README.md               # [推荐] 插件说明文档
```

### 4. 配合 esbuild 享受秒级热重载
Codeg 前端采用原生 Blob URL 加载 ESM 模块，要求产物为**自包含零外部裸导入的单文件**。

在插件源码根目录运行 esbuild 监视命令：
```bash
npx esbuild src/index.ts --bundle --format=esm --outfile=dist/index.js --watch
```

**极速开发循环**：
1. 编辑 `src/index.ts` 并保存；
2. esbuild 在数十毫秒内编译输出 `dist/index.js`；
3. Codeg 开发模式监视器在 300ms 内触发 `plugin-host://changed`；
4. 前端应用界面实时热更新，无需重启客户端！

---

## 📚 插件开发文档索引 (Documentation Index)

| 文档名称 | 路径 | 核心内容说明 |
|---|---|---|
| **架构与清单规范** | [`docs/plugin-host/manifest-spec.md`](./docs/plugin-host/manifest-spec.md) | `codeg-plugin.json` 规范、字段约束、权限清单、变量插值机制 |
| **插件开发实战指南** | [`docs/plugin-host/plugin-development-guide.md`](./docs/plugin-host/plugin-development-guide.md) | 从零创建、UI 插槽挂载、后台服务编写、打包分发与调试排错 |
| **Plugin SDK 与 API 参考** | [`docs/plugin-host/sdk.md`](./docs/plugin-host/sdk.md) | `PluginContext` 完整 API、插槽规范、声明式贡献、LIFO 销毁机制 |
| **JSON Schema 校验规范** | [`docs/plugin-host/codeg-plugin.schema.json`](./docs/plugin-host/codeg-plugin.schema.json) | 插件清单合法性的标准 JSON Schema 定义文件 |
| **官方示例插件库** | [`plugins/README.md`](./plugins/README.md) | 包含 WorkBuddy Connect、Prompt Pack 等完整插件源码 |
| **新手脚手架模板** | [`plugins/_template/README.md`](./plugins/_template/README.md) | 开箱即用的插件模板，附带 esbuild 极速打包构建脚本 |

---

## 📦 下载与安装 (Downloads)

前往 [Releases 页面](https://github.com/18810701358cz-ops/codeg-extended/releases/latest) 获取最新的发行版：

- **Windows 客户端**：`codeg_x.x.x_x64-setup.exe`（直接双击安装体验完整扩展特性）

---

## 🙏 致谢与开源协议 (License)

- 上游开源项目：感谢 [spacering-net/codeg](https://github.com/spacering-net/codeg) 社区团队提供的卓越工作台基石。
- 本项目遵循与上游一致的开源许可协议：[Apache-2.0 License](./LICENSE)。
