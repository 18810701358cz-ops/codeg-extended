# Codeg Extended 插件生态 (Plugins Ecosystem)

欢迎来到 Codeg Extended 插件中心！Codeg Extended 正在推进**插件系统 v2 架构**。

## 架构与开发规划

插件系统 v2 正在按工作包分阶段开发中：

- **Phase 0（当前版本 WP0）**：内置 3 个轻量界面修饰示例（霓虹微光主题、紧凑极客模式、浮动快捷挂件）。
- **Phase 1-3（后续版本）**：Rust 核心宿主、清单校验、安全沙箱、进程生命周期管理、本地目录与仓库安装器、声明式贡献系统等能力将陆续交付。

---

## 插件规划分类

1. **模型通道插件 (Model Providers)**:
   - 自动探测并代理外部大模型服务（如本地 Ollama、WorkBuddy、LM Studio 等）。
   - 提供 OpenAI 兼容的 `/v1/models` 和 `/v1/chat/completions` 格式。
2. **MCP 服务插件 (MCP Tools)**:
   - 快捷注册与监控 Model Context Protocol 服务器。
3. **指令与模板插件 (Prompt Snippets)**:
   - 注入常用的 Prompt 模板与快速斜杠指令。
4. **自定义自动化插件 (Custom Automations)**:
   - 定时任务、代码检查、自动文档生成器。

---

## 插件目录结构规范（v2 设计）

在插件系统 v2 规范中，每个独立插件为一个文件夹，包含：

```text
my-plugin/
├── manifest.json       # 插件元数据（ID、名称、版本、类别、入口等）
├── server.py (可选)    # 后台代理或守护进程
└── README.md           # 插件说明文档
```

### manifest.json 规划示例

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "Community",
  "description": "A customized plugin for Codeg Extended",
  "category": "utility",
  "enabled": true,
  "endpoint": "http://127.0.0.1:18080/v1"
}
```
