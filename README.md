# Codeg Extended

<p align="center">
  <img src="./public/icon.svg" alt="Codeg Extended logo" width="80" align="absmiddle" />
</p>

<p align="center">
  <strong>基于 Codeg 官方客户端的增强版本，原生新增模块化插件中心与热插拔扩展能力。</strong>
</p>

<p align="center">
  <a href="https://github.com/18810701358cz-ops/codeg-extended/releases/latest"><img src="https://img.shields.io/github/v/release/18810701358cz-ops/codeg-extended?style=flat&color=3b82f6" alt="Latest release" /></a>
  <a href="https://github.com/18810701358cz-ops/codeg-extended/releases"><img src="https://img.shields.io/github/downloads/18810701358cz-ops/codeg-extended/total?style=flat&color=3b82f6" alt="Total downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/18810701358cz-ops/codeg-extended?style=flat&color=3b82f6" alt="License" /></a>
</p>

---

## 📌 项目说明

本项目基于上游优秀开源项目 [spacering-net/codeg](https://github.com/spacering-net/codeg) 进行二次扩展。在保持原版全部 AI 智能体开发工作台能力的基础上，**核心新增了原生设置界面的「🧩 插件中心」模块以及外部插件热插拔系统**。

### 🌟 核心扩展特性

1. **设置页内嵌「插件中心」**：
   - 在原生偏好设置左侧导航栏中无缝集成「🧩 插件中心」Tab。
   - 采用现代化 DSH 卡片式交互，提供分类检索、服务状态指示灯、启停开关与详细参数抽屉。

2. **支持外部插件动态热插拔**：
   - 客户端启动时自动扫描并装载用户目录下的插件：
     - **Windows**: `%APPDATA%/codeg/plugins/`
     - **macOS / Linux**: `~/.config/codeg/plugins/`
   - **无需重新编译**：编写或下载第三方扩展后，只需放入该目录即可直接生效使用。

3. **内置开箱即用插件样例**：
   - **WorkBuddy Connect**：自动解密并桥接本地大模型，提供 37+ 旗舰大模型及点数折扣探测。
   - **MCP Assistant**：本地 MCP (Model Context Protocol) 服务健康监控管家。
   - **Prompt Snippets**：个人快捷 Prompt 模板库。
   - **_template**：第三方自定义扩展脚手架。

4. **独立更新源保障**：
   - 软件内置的自动更新检测已定向至本项目专属 Release 通道，并由独立生成的数字签名保障，避免被官方原版安装包覆盖。

---

## 📦 下载与安装

进入 [Releases 发布页面](https://github.com/18810701358cz-ops/codeg-extended/releases/latest) 下载最新的 Windows 安装包：
- **`codeg_x.x.x_x64-setup.exe`**：直接双击安装即可体验包含插件中心的完整客户端。

---

## 🧩 插件开发规范

每个插件为一个独立的文件夹，结构规范如下：

```text
my-custom-plugin/
├── manifest.json       # 插件元信息（ID、名称、版本、类别、描述等）
├── server.py (可选)    # 本地后台守护或代理进程
└── README.md           # 插件说明文档
```

详细开发规范与示例请参阅 [plugins/README.md](./plugins/README.md)。

---

## 🙏 致谢与许可

- 上游开源项目：[spacering-net/codeg](https://github.com/spacering-net/codeg)
- 遵循与原项目一致的开源协议：[Apache-2.0 License](./LICENSE)
