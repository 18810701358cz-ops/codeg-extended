"use client"

import { useCallback, useState, useSyncExternalStore } from "react"
import { Palette, Puzzle, RefreshCw, Search, Settings } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { pluginManager } from "@/lib/plugins/manager"

export interface PluginManifest {
  id: string
  name: string
  version: string
  author: string
  description: string
  category: "appearance" | "utility"
  enabled: boolean
  status: "running" | "idle" | "error" | "stopped"
  endpoint?: string
  homepage?: string
  tags?: string[]
}

const DEFAULT_PLUGINS: PluginManifest[] = [
  {
    id: "dsh-cyber-glow",
    name: "DSH Cyber Glow (霓虹微光主题)",
    version: "1.1.0",
    author: "codeg-community",
    description:
      "类似 DeepSeek Harness 的深色半透明毛玻璃与赛博微光边缘，优化聊天气泡与侧栏视觉。",
    category: "appearance",
    enabled: false,
    status: "idle",
    tags: ["UI美化", "毛玻璃", "赛博微光", "动态注入"],
  },
  {
    id: "dsh-compact-layout",
    name: "DSH Compact Mode (紧凑极客模式)",
    version: "1.0.0",
    author: "codeg-community",
    description:
      "缩减侧栏与会话边距，最大化聊天视野，还原 DSH 高信息密度极客布局。",
    category: "appearance",
    enabled: false,
    status: "idle",
    tags: ["布局修饰", "高信息密度", "全屏沉浸"],
  },
  {
    id: "dsh-quick-actions",
    name: "DSH Quick Tools (浮动快捷挂件)",
    version: "1.0.0",
    author: "codeg-community",
    description:
      "在右下角挂载示例快捷悬浮胶囊，点击展示通知提示（前端挂件与交互示例）。",
    category: "utility",
    enabled: false,
    status: "idle",
    tags: ["UI组件", "浮动胶囊", "DOM挂载"],
  },
]

let cachedManifests: PluginManifest[] | null = null
let lastEnabledMapKey = ""

function getClientManifests(): PluginManifest[] {
  if (typeof window === "undefined") return DEFAULT_PLUGINS
  const raw = localStorage.getItem("codeg_plugins_enabled_v1") || ""
  if (cachedManifests && lastEnabledMapKey === raw) {
    return cachedManifests
  }
  lastEnabledMapKey = raw
  cachedManifests = DEFAULT_PLUGINS.map((p) => {
    const isEn = pluginManager.isPluginEnabled(p.id)
    return {
      ...p,
      enabled: isEn,
      status: isEn ? "running" : "idle",
    }
  })
  return cachedManifests
}

function getServerManifests(): PluginManifest[] {
  return DEFAULT_PLUGINS
}

export function PluginsSettings() {
  const plugins = useSyncExternalStore(
    (cb) => pluginManager.subscribe(cb),
    getClientManifests,
    getServerManifests
  )
  const [searchQuery, setSearchQuery] = useState("")
  const [activeCategory, setActiveCategory] = useState<string>("all")
  const [selectedPlugin, setSelectedPlugin] = useState<PluginManifest | null>(
    null
  )
  const [isThemeEditorOpen, setIsThemeEditorOpen] = useState(false)
  const [themeCSS, setThemeCSS] = useState("")

  const handleToggle = useCallback(
    (id: string) => {
      const plugin = plugins.find((p) => p.id === id)
      if (!plugin) return
      const nextState = !plugin.enabled
      pluginManager.setPluginEnabled(id, nextState)
      toast.success(
        nextState
          ? `插件「${plugin.name}」已启用并即时生效`
          : `插件「${plugin.name}」已停用`
      )
    },
    [plugins]
  )

  const handleApplyCustomCSS = useCallback(() => {
    if (!themeCSS.trim()) {
      toast.error("CSS 内容不能为空")
      return
    }
    try {
      pluginManager.injectCSS("custom-user-theme", themeCSS)
      toast.success("自定义 CSS 样式已临时生效（重启后失效）")
      setIsThemeEditorOpen(false)
    } catch {
      toast.error("注入 CSS 失败")
    }
  }, [themeCSS])

  const filteredPlugins = plugins.filter((plugin) => {
    const matchesSearch =
      plugin.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      plugin.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      plugin.tags?.some((t) =>
        t.toLowerCase().includes(searchQuery.toLowerCase())
      )

    const matchesCategory =
      activeCategory === "all" || plugin.category === activeCategory

    return matchesSearch && matchesCategory
  })

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <div className="flex items-center justify-between gap-2.5 rounded-xl border border-border/70 bg-muted/40 p-3">
        <div>
          <span className="font-medium text-foreground">
            插件系统开发中：目前仅内置 3
            个界面修饰示例，目录安装和仓库安装将在后续版本提供
          </span>
          <p className="mt-0.5 text-xs text-muted-foreground">
            插件系统 v2 正在重构推进中，当前内置轻量 UI
            修饰示例，外部插件热插拔与完整宿主能力将在后续版本陆续推出。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setIsThemeEditorOpen(true)}
            className="h-8 gap-1.5 text-xs"
          >
            <Palette className="h-3.5 w-3.5" />
            快速写 CSS 修饰 UI
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              pluginManager.boot(true)
              toast.success("已重新应用当前启用的插件与样式")
            }}
            className="h-8 gap-1.5 text-xs"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            热重载
          </Button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={activeCategory}
          onValueChange={setActiveCategory}
          className="w-full sm:w-auto"
        >
          <TabsList className="h-8">
            <TabsTrigger value="all" className="text-xs">
              全部
            </TabsTrigger>
            <TabsTrigger value="appearance" className="text-xs">
              界面修饰 (UI)
            </TabsTrigger>
            <TabsTrigger value="utility" className="text-xs">
              挂件与工具
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="relative w-full sm:w-64">
          <Search className="absolute top-2.5 left-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="搜索插件、标签或作者..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      {/* Plugin Cards Grid */}
      <div className="grid gap-4 md:grid-cols-2">
        {filteredPlugins.map((plugin) => (
          <SettingCard key={plugin.id}>
            <SettingRow
              title={plugin.name}
              description={plugin.description}
              control={
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className="h-4 px-1.5 font-mono text-[10px]"
                  >
                    v{plugin.version}
                  </Badge>
                  <Switch
                    checked={plugin.enabled}
                    onCheckedChange={() => handleToggle(plugin.id)}
                  />
                </div>
              }
            >
              <div className="mt-2 flex items-center justify-between border-t border-border/40 pt-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "inline-block h-2 w-2 rounded-full",
                      plugin.status === "running"
                        ? "bg-emerald-500 animate-pulse"
                        : "bg-muted-foreground/40"
                    )}
                  />
                  <span className="capitalize">
                    {plugin.status === "running" ? "运行中 / 已注入" : "未启动"}
                  </span>
                  <span className="mx-1">•</span>
                  <span>{plugin.author}</span>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setSelectedPlugin(plugin)}
                >
                  <Settings className="mr-1 h-3.5 w-3.5" />
                  配置与代码
                </Button>
              </div>

              {plugin.tags && plugin.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {plugin.tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </SettingRow>
          </SettingCard>
        ))}
      </div>

      {/* Custom Theme Editor Modal */}
      <Dialog open={isThemeEditorOpen} onOpenChange={setIsThemeEditorOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Palette className="h-4 w-4 text-sky-400" />
              快速界面修饰器 (实时 CSS 注入)
            </DialogTitle>
            <DialogDescription className="text-xs">
              输入任意 CSS
              样式，点击应用即可实时修饰界面。注意：此处修改仅临时生效，重启后失效；要长期保存请用「外观
              → 自定义 CSS」。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Textarea
              placeholder={`/* 例如：修改侧边栏背景为磨砂黑 */\n.bg-background { background: #000 !important; }\n.text-foreground { color: #38bdf8 !important; }`}
              value={themeCSS}
              onChange={(e) => setThemeCSS(e.target.value)}
              className="h-48 font-mono text-xs"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsThemeEditorOpen(false)}
              className="text-xs"
            >
              取消
            </Button>
            <Button
              size="sm"
              onClick={handleApplyCustomCSS}
              className="text-xs"
            >
              应用并即时生效
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail / Config Modal */}
      {selectedPlugin && (
        <Dialog
          open={Boolean(selectedPlugin)}
          onOpenChange={() => setSelectedPlugin(null)}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <Puzzle className="h-4 w-4 text-sky-400" />
                {selectedPlugin.name}
              </DialogTitle>
              <DialogDescription className="text-xs">
                ID: <code>{selectedPlugin.id}</code> | 状态:{" "}
                {selectedPlugin.status}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2 text-xs">
              <div className="rounded-md bg-muted p-2.5">
                <p className="mb-1 font-medium text-foreground">插件描述：</p>
                <p className="text-muted-foreground">
                  {selectedPlugin.description}
                </p>
              </div>

              {selectedPlugin.endpoint && (
                <div className="flex items-center justify-between rounded border p-2">
                  <span className="text-muted-foreground">服务接口:</span>
                  <code className="text-sky-400">
                    {selectedPlugin.endpoint}
                  </code>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  handleToggle(selectedPlugin.id)
                  setSelectedPlugin(null)
                }}
                className="text-xs"
              >
                {selectedPlugin.enabled ? "停用此插件" : "启用此插件"}
              </Button>
              <Button
                size="sm"
                onClick={() => setSelectedPlugin(null)}
                className="text-xs"
              >
                确定
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
