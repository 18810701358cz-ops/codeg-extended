# Codeg Extended 插件生态 (Plugins Ecosystem)

欢迎来到 Codeg Extended 插件中心！Codeg Extended 引入了基于 DSH（DeepSeek Harness）规范的**热插拔插件架构**。

## 什么是热插拔？
编译后的 Codeg Extended 客户端在启动时会自动扫描用户目录中的插件：
- **Windows**: `%APPDATA%/codeg/plugins/`
- **Linux / macOS**: `~/.config/codeg/plugins/`

你可以直接把写好的插件文件夹丢进该目录，立即生效，**无需重新编译客户端**！

---

## 插件分类

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

## 插件目录结构规范

每个插件应当是一个独立的文件夹，包含：
```text
my-plugin/
├── manifest.json       # 插件元数据（ID、名称、版本、类别、入口等）
├── server.py (可选)    # 后台代理或守护进程
└── README.md           # 插件说明文档
```

### manifest.json 示例
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
