# Codeg Extended

<p align="center">
  <img src="./public/icon.svg" alt="Codeg Extended logo" width="80" align="absmiddle" />
</p>

<p align="center">
  <strong>基于 Codeg 官方客户端的增强版本，原生新增「插件中心」与插件系统 v2 规划。</strong>
</p>

<p align="center">
  <a href="https://github.com/18810701358cz-ops/codeg-extended/releases/latest"><img src="https://img.shields.io/github/v/release/18810701358cz-ops/codeg-extended?style=flat&color=3b82f6" alt="Latest release" /></a>
  <a href="https://github.com/18810701358cz-ops/codeg-extended/releases"><img src="https://img.shields.io/github/downloads/18810701358cz-ops/codeg-extended/total?style=flat&color=3b82f6" alt="Total downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/18810701358cz-ops/codeg-extended?style=flat&color=3b82f6" alt="License" /></a>
</p>

---

## 📌 项目说明

本项目基于上游优秀开源项目 [spacering-net/codeg](https://github.com/spacering-net/codeg) 进行二次扩展。在保持原版全部 AI 智能体开发工作台能力的基础上，**核心新增了原生设置界面的「🧩 插件中心」模块以及插件系统 v2 规划**。

### 🌟 核心扩展特性

1. **设置页内嵌「插件中心」**：
   - 在原生偏好设置左侧导航栏中无缝集成「🧩 插件中心」Tab。
   - 采用现代化 DSH 卡片式交互，提供分类检索、服务状态指示灯、启停开关与详细参数抽屉。

2. **插件系统 v2 开发中**：
   - 全新插件宿主架构正在按分阶段工作包推进中。
   - 包含清单校验、状态存储、安全沙箱、进程管理、Git/本地安装与统一生命周期。
   - 当前版本内置 3 个轻量界面修饰示例（霓虹微光主题、紧凑极客模式、浮动快捷挂件）；外部插件热插拔、目录扫描与仓库安装等能力将在后续工作包推进中陆续推出。

3. **独立更新源保障**：
   - 软件内置的自动更新检测已定向至本项目专属 Release 通道，并由独立生成的数字签名保障，避免被官方原版安装包覆盖。

---

## 📦 下载与安装

进入 [Releases 发布页面](https://github.com/18810701358cz-ops/codeg-extended/releases/latest) 下载最新的 Windows 安装包：

- **`codeg_x.x.x_x64-setup.exe`**：直接双击安装即可体验包含插件中心的完整客户端。

---

## 🧩 插件开发规范（v2 规划）

插件系统 v2 规划的独立插件目录结构规范如下：

```text
my-custom-plugin/
├── manifest.json       # 插件元信息（ID、名称、版本、类别、描述等）
├── server.py (可选)    # 本地后台守护或代理进程
└── README.md           # 插件说明文档
```

详细开发规范与架构设计请参阅 [plugins/README.md](./plugins/README.md)。

---

## 🙏 致谢与许可

- 上游开源项目：[spacering-net/codeg](https://github.com/spacering-net/codeg)
- 遵循与原项目一致的开源协议：[Apache-2.0 License](./LICENSE)
