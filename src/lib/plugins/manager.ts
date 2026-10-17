"use client"

import { PluginMetadata, PluginUIHook, CodegPluginAPI } from "./types"

const STORAGE_KEY_ENABLED = "codeg_plugins_enabled_v1"
const STORAGE_KEY_CUSTOM_CSS = "codeg_plugins_custom_css_v1"

// 默认内置的 UI 增强/魔改插件（DSH 风格）
export const BUILTIN_DSH_PLUGINS: PluginMetadata[] = [
  {
    id: "dsh-cyber-glow",
    name: "DSH Cyber Glow (霓虹微光主题)",
    version: "1.1.0",
    description:
      "类似 DeepSeek Harness 的深色半透明毛玻璃与赛博霓虹微光边缘特效，优化气泡与侧边栏质感",
    author: "codeg-community",
    category: "appearance",
    icon: "sparkles",
    defaultEnabled: false,
    css: `
      /* DSH 赛博毛玻璃效果 */
      .bg-background, .bg-card {
        background-color: rgba(13, 17, 23, 0.85) !important;
        backdrop-filter: blur(12px) !important;
      }
      /* 增强卡片与消息微光 */
      [data-slot="card"], .border-border {
        border-color: rgba(56, 189, 248, 0.18) !important;
        box-shadow: 0 0 15px -3px rgba(56, 189, 248, 0.05);
      }
      /* 激活按钮微光态 */
      button[data-state="active"], .bg-primary {
        box-shadow: 0 0 12px rgba(14, 165, 233, 0.45) !important;
      }
    `,
  },
  {
    id: "dsh-compact-layout",
    name: "DSH Compact Mode (紧凑极客模式)",
    version: "1.0.0",
    description: "缩减侧栏与聊天边距，最大化会话视野，还原 DSH 高信息密度交互",
    author: "codeg-community",
    category: "appearance",
    icon: "layout",
    defaultEnabled: false,
    css: `
      /* 紧凑边距与高视野优化 */
      main, .conversation-viewport {
        padding-left: 0.75rem !important;
        padding-right: 0.75rem !important;
      }
      .message-bubble {
        margin-top: 0.5rem !important;
        margin-bottom: 0.5rem !important;
      }
    `,
  },
  {
    id: "dsh-quick-actions",
    name: "DSH Quick Tools (浮动快捷挂件)",
    version: "1.0.0",
    description:
      "在右下角挂载示例快捷悬浮胶囊，点击展示通知提示（前端挂件与交互示例）",
    author: "codeg-community",
    category: "utility",
    icon: "terminal",
    defaultEnabled: false,
    script: `
      // 动态注册右下角快捷胶囊
      if (!document.getElementById("dsh-floating-pill")) {
        const pill = document.createElement("div");
        pill.id = "dsh-floating-pill";
        pill.style.cssText = "position:fixed;bottom:20px;right:24px;z-index:9999;display:flex;align-items:center;gap:8px;padding:6px 14px;background:rgba(15,23,42,0.85);backdrop-filter:blur(8px);border:1px solid rgba(56,189,248,0.3);border-radius:9999px;box-shadow:0 8px 32px rgba(0,0,0,0.4);font-size:12px;color:#38bdf8;cursor:pointer;user-select:none;transition:all 0.2s ease;";
        pill.innerHTML = "<span style='display:inline-block;width:8px;height:8px;background:#10b981;border-radius:50%;box-shadow:0 0 8px #10b981;'></span><span>DSH 增强已就绪</span>";
        pill.onmouseover = () => { pill.style.borderColor = "#38bdf8"; pill.style.transform = "translateY(-2px)"; };
        pill.onmouseout = () => { pill.style.borderColor = "rgba(56,189,248,0.3)"; pill.style.transform = "none"; };
        pill.onclick = () => {
          if (window.codegPlugins) {
            window.codegPlugins.notify("DSH 插件系统运行中 - UI 动态修饰已生效", "info");
          }
        };
        document.body.appendChild(pill);
      }
    `,
  },
]

class PluginRuntimeManager {
  private hooks: Map<string, PluginUIHook> = new Map()
  private cleanupMap: Map<string, () => void> = new Map()
  private booted = false
  private listeners: Set<() => void> = new Set()

  constructor() {
    if (typeof window !== "undefined") {
      this.initGlobalAPI()
      window.addEventListener("storage", (e) => {
        if (e.key === STORAGE_KEY_ENABLED) {
          this.notifyListeners()
        }
      })
    }
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public notifyListeners() {
    this.listeners.forEach((fn) => fn())
  }

  private initGlobalAPI() {
    const api: CodegPluginAPI = {
      version: "1.0.0",
      injectCSS: this.injectCSS.bind(this),
      removeCSS: this.removeCSS.bind(this),
      registerUIHook: this.registerUIHook.bind(this),
      unregisterUIHook: this.unregisterUIHook.bind(this),
      notify: (msg, type = "info") => {
        console.log(`[Plugin Notify][${type}]:`, msg)
      },
      getPlugins: this.getPlugins.bind(this),
      isPluginEnabled: this.isPluginEnabled.bind(this),
      setPluginEnabled: this.setPluginEnabled.bind(this),
    }

    ;(window as unknown as { codegPlugins: CodegPluginAPI }).codegPlugins = api
  }

  public boot(force = false, currentPath?: string) {
    if (this.booted && !force) return
    if (typeof window === "undefined") return
    const pathname = currentPath ?? window.location.pathname
    if (
      !pathname.startsWith("/workspace") &&
      !pathname.startsWith("/settings")
    ) {
      return
    }
    this.booted = true

    const plugins = this.getPlugins()
    plugins.forEach((p) => {
      if (this.isPluginEnabled(p.id)) {
        this.activatePlugin(p)
      }
    })
  }

  public teardown() {
    if (!this.booted) return
    const plugins = this.getPlugins()
    plugins.forEach((p) => {
      this.deactivatePlugin(p)
    })
    this.booted = false
  }

  public isBooted(): boolean {
    return this.booted
  }

  public getPlugins(): PluginMetadata[] {
    if (typeof window === "undefined") return BUILTIN_DSH_PLUGINS
    try {
      const customStr = localStorage.getItem(STORAGE_KEY_CUSTOM_CSS)
      const customList: PluginMetadata[] = customStr
        ? JSON.parse(customStr)
        : []
      return [...BUILTIN_DSH_PLUGINS, ...customList]
    } catch {
      return BUILTIN_DSH_PLUGINS
    }
  }

  public isPluginEnabled(id: string): boolean {
    if (typeof window === "undefined") return false
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ENABLED)
      if (!raw) {
        const found = BUILTIN_DSH_PLUGINS.find((p) => p.id === id)
        return Boolean(found?.defaultEnabled)
      }
      const map: Record<string, boolean> = JSON.parse(raw)
      if (id in map) return map[id]
      const found = BUILTIN_DSH_PLUGINS.find((p) => p.id === id)
      return Boolean(found?.defaultEnabled)
    } catch {
      return false
    }
  }

  public setPluginEnabled(id: string, enabled: boolean) {
    if (typeof window === "undefined") return
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ENABLED)
      const map: Record<string, boolean> = raw ? JSON.parse(raw) : {}
      map[id] = enabled
      localStorage.setItem(STORAGE_KEY_ENABLED, JSON.stringify(map))

      const plugin = this.getPlugins().find((p) => p.id === id)
      if (plugin) {
        if (enabled) {
          this.activatePlugin(plugin)
        } else {
          this.deactivatePlugin(plugin)
        }
      }
      this.notifyListeners()
    } catch (e) {
      console.error("[PluginManager] Failed to toggle plugin:", e)
    }
  }

  public activatePlugin(plugin: PluginMetadata) {
    // 1. 注入 CSS 样式
    if (plugin.css) {
      this.injectCSS(`plugin-${plugin.id}`, plugin.css)
    }
    // 2. 执行脚本注入
    if (plugin.script && typeof window !== "undefined") {
      try {
        const fn = new Function("api", plugin.script)
        fn((window as unknown as { codegPlugins: CodegPluginAPI }).codegPlugins)
      } catch (e) {
        console.error(`[PluginManager] Execution error in ${plugin.id}:`, e)
      }
    }
  }

  public deactivatePlugin(plugin: PluginMetadata) {
    if (plugin.css) {
      this.removeCSS(`plugin-${plugin.id}`)
    }
    // 清除脚本创建的特定元素
    if (plugin.id === "dsh-quick-actions") {
      const el = document.getElementById("dsh-floating-pill")
      if (el) el.remove()
    }
  }

  public injectCSS(styleId: string, cssText: string) {
    if (typeof document === "undefined") return
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = document.createElement("style")
      styleEl.id = styleId
      document.head.appendChild(styleEl)
    }
    styleEl.textContent = cssText
  }

  public removeCSS(styleId: string) {
    if (typeof document === "undefined") return
    const el = document.getElementById(styleId)
    if (el) el.remove()
  }

  public registerUIHook(hook: PluginUIHook) {
    this.hooks.set(hook.id, hook)
  }

  public unregisterUIHook(hookId: string) {
    this.hooks.delete(hookId)
    const cleanup = this.cleanupMap.get(hookId)
    if (cleanup) {
      cleanup()
      this.cleanupMap.delete(hookId)
    }
  }
}

export const pluginManager = new PluginRuntimeManager()
