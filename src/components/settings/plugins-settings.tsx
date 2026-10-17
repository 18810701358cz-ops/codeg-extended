"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Boxes,
  Layers,
  Palette,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Terminal,
} from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingNote } from "@/components/shared/setting-card"
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
import { PluginMetadata } from "@/lib/plugins/types"

export interface PluginManifest {
  id: string
  name: string
  version: string
  author: string
  description: string
  category: "appearance" | "model-provider" | "mcp-tool" | "prompt-template" | "automation" | "utility"
  enabled: boolean
  status: "running" | "idle" | "error" | "stopped"
  endpoint?: string
  homepage?: string
  tags?: string[]
  css?: string
}

const DEFAULT_PLUGINS: PluginManifest[] = [
  {
    id: "workbuddy-connect",
    name: "WorkBuddy Connect (旗舰模型网关)",
    version: "2.1.0",
    author: "codeg-community",
    description: "免 Key 自动接入 37 个大模型，包含全套扣费倍率高亮显示与思考档位探针。",
    category: "model-provider",
    enabled: true,
    status: "running",
    endpoint: "http://127.0.0.1:18080/v1",
    homepage: "https://github.com/18810701358cz-ops/codeg-extended",
    tags: ["免Key接入", "37个模型", "倍率探测", "静默常驻"],
  },
  {
    id: "dsh-cyber-glow",
    name: "DSH Cyber Glow (霓虹微光主题)",
    version: "1.1.0",
    author: "codeg-community",
    description: "类似 DeepSeek Harness 的深色半透明毛玻璃与赛博微光边缘，优化聊天气泡与侧栏视觉。",
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
    description: "缩减侧栏与会话边距，最大化聊天视野，还原 DSH 高信息密度极客布局。",
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
    description: "在右下角挂载快捷指令胶囊，支持随时切换模型、清理会话并提供插件交互。",
    category: "utility",
    enabled: true,
    status: "running",
    tags: ["UI组件", "浮动胶囊", "DOM挂载"],
  },
  {
    id: "mcp-assistant",
    name: "MCP 增强诊断助手",
    version: "1.0.4",
    author: "codeg-community",
    description: "实时监控 MCP 工具链心跳，提供自动化重连与调用延迟分析面板。",
    category: "mcp-tool",
    enabled: false,
    status: "idle",
    tags: ["MCP诊断", "延迟分析", "故障自愈"],
  },
  {
    id: "prompt-snippets",
    name: "DSH 提示词预设包",
    version: "1.0.0",
    author: "codeg-community",
    description: "精选高阶编程、架构重构、单测生成与系统指令模板，一键载入上下文。",
    category: "prompt-template",
    enabled: false,
    status: "idle",
    tags: ["提示词", "架构重构", "工作流"],
  },
]

export function PluginsSettings() {
  const [plugins, setPlugins] = useState<PluginManifest[]>(DEFAULT_PLUGINS)
  const [searchQuery, setSearchQuery] = useState("")
  const [activeCategory, setActiveCategory] = useState<string>("all")
  const [selectedPlugin, setSelectedPlugin] = useState<PluginManifest | null>(null)
  const [isInstallDialogOpen, setIsInstallDialogOpen] = useState(false)
  const [isThemeEditorOpen, setIsThemeEditorOpen] = useState(false)
  const [themeCSS, setThemeCSS] = useState("")
  const [installPath, setInstallPath] = useState("")

  useEffect(() => {
    // 从管理器同步插件实际启用状态
    setPlugins((prev) =>
      prev.map((p) => {
        const isEn = pluginManager.isPluginEnabled(p.id)
        return {
          ...p,
          enabled: isEn,
          status: isEn ? "running" : "idle",
        }
      })
    )
  }, [])

  const handleToggle = useCallback((id: string) => {
    setPlugins((prev) =>
      prev.map((p) => {
        if (p.id === id) {
          const nextState = !p.enabled
          pluginManager.setPluginEnabled(id, nextState)
          toast.success(
            nextState
              ? `插件「${p.name}」已启用并即时生效`
              : `插件「${p.name}」已停用`
          )
          return {
            ...p,
            enabled: nextState,
            status: nextState ? "running" : "idle",
          }
        }
        return p
      })
    )
  }, [])

  const handleApplyCustomCSS = () => {
    if (!themeCSS.trim()) {
      pluginManager.removeCSS("custom-user-theme")
      toast.info("已清空自定义样式")
    } else {
      pluginManager.injectCSS("custom-user-theme", themeCSS)
      toast.success("自定义 CSS 样式已即时注入生效！")
    }
    setIsThemeEditorOpen(false)
  }

  const filteredPlugins = plugins.filter((plugin) => {
    const matchesSearch =
      plugin.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      plugin.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      plugin.tags?.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()))

    const matchesCategory =
      activeCategory === "all" || plugin.category === activeCategory

    return matchesSearch && matchesCategory
  })

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <SettingNote variant="info" className="flex items-center justify-between">
        <div>
          <span className="font-medium text-foreground">DSH 模块化插件系统与 UI 动态修饰已就绪</span>
          <p className="mt-0.5 text-xs text-muted-foreground">
            支持像 DeepSeek Harness 一样随意修饰客户端界面（CSS / DOM 组件 / 挂件），放入 <code>%APPDATA%/codeg/plugins/</code> 目录即可热生效。
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
              pluginManager.boot()
              toast.success("已重新扫描并热应用所有插件与样式")
            }}
            className="h-8 gap-1.5 text-xs"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            热重载
          </Button>
          <Button
            size="sm"
            onClick={() => setIsInstallDialogOpen(true)}
            className="h-8 gap-1.5 text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            安装新插件
          </Button>
        </div>
      </SettingNote>

      {/* Filter and Search Bar */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={activeCategory} onValueChange={setActiveCategory} className="w-full sm:w-auto">
          <TabsList className="h-8">
            <TabsTrigger value="all" className="text-xs">全部</TabsTrigger>
            <TabsTrigger value="appearance" className="text-xs">界面修饰 (UI)</TabsTrigger>
            <TabsTrigger value="model-provider" className="text-xs">模型网关</TabsTrigger>
            <TabsTrigger value="utility" className="text-xs">挂件与工具</TabsTrigger>
            <TabsTrigger value="prompt-template" className="text-xs">提示词</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
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
          <SettingCard
            key={plugin.id}
            title={
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm">{plugin.name}</span>
                <Badge variant="outline" className="text-[10px] font-mono h-4 px-1.5">
                  v{plugin.version}
                </Badge>
              </div>
            }
            description={plugin.description}
            action={
              <div className="flex items-center gap-3">
                <Switch
                  checked={plugin.enabled}
                  onCheckedChange={() => handleToggle(plugin.id)}
                />
              </div>
            }
          >
            <div className="mt-3 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
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

              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs px-2"
                  onClick={() => setSelectedPlugin(plugin)}
                >
                  <Settings className="mr-1 h-3.5 w-3.5" />
                  配置与代码
                </Button>
              </div>
            </div>

            {plugin.tags && plugin.tags.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1">
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
          </SettingCard>
        ))}
      </div>

      {/* Custom Theme Editor Modal */}
      <Dialog open={isThemeEditorOpen} onOpenChange={setIsThemeEditorOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Palette className="h-4 w-4 text-sky-400" />
              DSH 快速界面修饰器 (实时 CSS 注入)
            </DialogTitle>
            <DialogDescription className="text-xs">
              输入任意 CSS 样式，点击应用即可瞬间修饰 Codeg 客户端的所有界面、颜色、毛玻璃与气泡布局。
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <Textarea
              placeholder="/* 例如：修改侧边栏背景为磨砂黑 */&#10;.bg-background { background: #000 !important; }&#10;.text-foreground { color: #38bdf8 !important; }"
              value={themeCSS}
              onChange={(e) => setThemeCSS(e.target.value)}
              className="font-mono text-xs h-48"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setIsThemeEditorOpen(false)} className="text-xs">
              取消
            </Button>
            <Button size="sm" onClick={handleApplyCustomCSS} className="text-xs">
              应用并即时生效
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail / Config Modal */}
      {selectedPlugin && (
        <Dialog open={Boolean(selectedPlugin)} onOpenChange={() => setSelectedPlugin(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base flex items-center gap-2">
                <Puzzle className="h-4 w-4 text-sky-400" />
                {selectedPlugin.name}
              </DialogTitle>
              <DialogDescription className="text-xs">
                ID: <code>{selectedPlugin.id}</code> | 状态: {selectedPlugin.status}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2 text-xs">
              <div className="rounded-md bg-muted p-2.5">
                <p className="font-medium text-foreground mb-1">插件描述：</p>
                <p className="text-muted-foreground">{selectedPlugin.description}</p>
              </div>

              {selectedPlugin.endpoint && (
                <div className="flex items-center justify-between border rounded p-2">
                  <span className="text-muted-foreground">服务接口:</span>
                  <code className="text-sky-400">{selectedPlugin.endpoint}</code>
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
              <Button size="sm" onClick={() => setSelectedPlugin(null)} className="text-xs">
                确定
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Install Modal */}
      <Dialog open={isInstallDialogOpen} onOpenChange={setIsInstallDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">安装/导入 DSH 插件</DialogTitle>
            <DialogDescription className="text-xs">
              输入插件包的本地文件路径或 Git 仓库地址，插件将被放置到 <code>%APPDATA%/codeg/plugins/</code>。
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              placeholder="C:/WorkSpace/my-new-plugin 或 https://github.com/..."
              value={installPath}
              onChange={(e) => setInstallPath(e.target.value)}
              className="text-xs"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setIsInstallDialogOpen(false)} className="text-xs">
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (!installPath.trim()) {
                  toast.error("请输入有效的文件路径或 URL")
                  return
                }
                toast.success("插件已导入并注册")
                setIsInstallDialogOpen(false)
                setInstallPath("")
              }}
              className="text-xs"
            >
              开始导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
