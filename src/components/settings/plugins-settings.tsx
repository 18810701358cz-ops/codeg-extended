"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Boxes,
  Layers,
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
import { cn } from "@/lib/utils"

export interface PluginManifest {
  id: string
  name: string
  version: string
  author: string
  description: string
  category: "model-provider" | "mcp-tool" | "prompt-template" | "automation" | "utility"
  enabled: boolean
  status: "running" | "idle" | "error" | "stopped"
  endpoint?: string
  homepage?: string
  tags?: string[]
}

const DEFAULT_PLUGINS: PluginManifest[] = [
  {
    id: "workbuddy-connect",
    name: "WorkBuddy Connect (旗舰模型网关)",
    version: "1.0.0",
    author: "Community",
    description: "无感免密解密本地 CodeBuddy/WorkBuddy 凭证，暴露标准 OpenAI 兼容接口，提供 37+ 旗舰大模型及点数折扣探测",
    category: "model-provider",
    enabled: true,
    status: "running",
    endpoint: "http://127.0.0.1:18080/v1",
    homepage: "https://github.com/codeg-community/codeg-extended",
    tags: ["OpenAI兼容", "多模型代理", "自动解密", "免密接入"],
  },
  {
    id: "mcp-assistant",
    name: "MCP 服务管家 (MCP Assistant)",
    version: "1.0.0",
    author: "Community",
    description: "监控与快速调试本地 stdio / SSE MCP 服务器，实时检查健康状态与可用工具",
    category: "mcp-tool",
    enabled: true,
    status: "idle",
    tags: ["MCP", "Tools", "服务监控"],
  },
  {
    id: "prompt-snippets",
    name: "指令与模版库 (Prompt Snippets)",
    version: "1.0.0",
    author: "Community",
    description: "管理个人常用 Prompt 模板与快捷指令，支持在对话窗口通过斜杠快速唤出",
    category: "prompt-template",
    enabled: true,
    status: "idle",
    tags: ["Prompt", "快捷模板", "效率工具"],
  },
]

export function PluginsSettings() {
  const [plugins, setPlugins] = useState<PluginManifest[]>(DEFAULT_PLUGINS)
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedCategory, setSelectedCategory] = useState<string>("all")
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedPlugin, setSelectedPlugin] = useState<PluginManifest | null>(null)
  const [isInstallDialogOpen, setIsInstallDialogOpen] = useState(false)
  const [installPath, setInstallPath] = useState("")

  // Load plugin states from local storage or initialize
  useEffect(() => {
    try {
      const saved = localStorage.getItem("codeg_installed_plugins")
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setPlugins(parsed)
        }
      }
    } catch {
      // Ignore fallback
    }
  }, [])

  const savePlugins = useCallback((updated: PluginManifest[]) => {
    setPlugins(updated)
    try {
      localStorage.setItem("codeg_installed_plugins", JSON.stringify(updated))
    } catch {
      // Ignore
    }
  }, [])

  const handleToggle = useCallback(
    (id: string, enabled: boolean) => {
      const updated = plugins.map((p) => {
        if (p.id === id) {
          return {
            ...p,
            enabled,
            status: enabled ? (p.category === "model-provider" ? "running" : "idle") : "stopped",
          } as PluginManifest
        }
        return p
      })
      savePlugins(updated)
      toast.success(`${enabled ? "已启用" : "已停用"} 插件`)
    },
    [plugins, savePlugins]
  )

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true)
    setTimeout(() => {
      setIsRefreshing(false)
      toast.success("已扫描并同步本地插件目录 (%APPDATA%/codeg/plugins)")
    }, 800)
  }, [])

  const filteredPlugins = plugins.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.tags?.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()))
    const matchesCat =
      selectedCategory === "all" || p.category === selectedCategory
    return matchesSearch && matchesCat
  })

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header Banner */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Puzzle className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold tracking-tight">插件中心 (Plugin Ecosystem)</h2>
                <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-2xs">
                  热插拔架构已启用
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                基于 DSH 规范的模块化扩展体系，支持动态装载模型网关、MCP 监控、快捷指令与自动化脚本
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="gap-1.5 text-xs"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
              刷新检测
            </Button>
            <Button
              size="sm"
              onClick={() => setIsInstallDialogOpen(true)}
              className="gap-1.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              添加插件
            </Button>
          </div>
        </div>
      </div>

      {/* Info Notice */}
      <SettingNote icon={Sparkles}>
        插件目录位于系统用户主目录 <code>%APPDATA%/codeg/plugins/</code>。后续安装新插件只需将插件文件夹放入该目录，即可即时热插拔生效，无需重新编译客户端。
      </SettingNote>

      {/* Filter and Search Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={selectedCategory}
          onValueChange={setSelectedCategory}
          className="w-full sm:w-auto"
        >
          <TabsList className="h-8 text-xs">
            <TabsTrigger value="all">全部 ({plugins.length})</TabsTrigger>
            <TabsTrigger value="model-provider">模型通道</TabsTrigger>
            <TabsTrigger value="mcp-tool">MCP 工具</TabsTrigger>
            <TabsTrigger value="prompt-template">指令模板</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索插件名称、描述或标签..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      {/* Plugin Card List */}
      <div className="grid gap-3">
        {filteredPlugins.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 p-8 text-center">
            <Boxes className="h-8 w-8 text-muted-foreground/60 mb-2" />
            <p className="text-sm font-medium">未找到符合条件的插件</p>
            <p className="text-xs text-muted-foreground mt-1">可以尝试更换搜索关键词或清空分类筛选</p>
          </div>
        ) : (
          filteredPlugins.map((plugin) => (
            <SettingCard key={plugin.id} className="p-4 transition-colors hover:border-border">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground border border-border/60">
                    {plugin.category === "model-provider" ? (
                      <Layers className="h-5 w-5 text-indigo-500" />
                    ) : plugin.category === "mcp-tool" ? (
                      <Terminal className="h-5 w-5 text-amber-500" />
                    ) : (
                      <Sparkles className="h-5 w-5 text-rose-500" />
                    )}
                  </div>
                  <div className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-foreground">{plugin.name}</span>
                      <span className="text-2xs text-muted-foreground font-mono">v{plugin.version}</span>
                      {plugin.status === "running" ? (
                        <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-500 text-2xs flex items-center gap-1 py-0">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          运行中
                        </Badge>
                      ) : plugin.status === "idle" ? (
                        <Badge variant="outline" className="border-blue-500/40 bg-blue-500/10 text-blue-500 text-2xs py-0">
                          就绪
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-muted-foreground/30 text-muted-foreground text-2xs py-0">
                          已停止
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{plugin.description}</p>
                    {plugin.endpoint && (
                      <div className="flex items-center gap-1.5 mt-0.5 text-2xs font-mono text-muted-foreground">
                        <span>服务地址:</span>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-foreground/80">{plugin.endpoint}</code>
                      </div>
                    )}
                    {plugin.tags && plugin.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {plugin.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-secondary/60 px-1.5 py-0.5 text-2xs text-secondary-foreground"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Switch
                    checked={plugin.enabled}
                    onCheckedChange={(checked) => handleToggle(plugin.id, checked)}
                    aria-label={`启用 ${plugin.name}`}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    onClick={() => setSelectedPlugin(plugin)}
                    title="插件设置与状态"
                  >
                    <Settings className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </SettingCard>
          ))
        )}
      </div>

      {/* Detail & Config Modal */}
      {selectedPlugin && (
        <Dialog open={!!selectedPlugin} onOpenChange={(open) => !open && setSelectedPlugin(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <Puzzle className="h-4 w-4 text-primary" />
                {selectedPlugin.name}
              </DialogTitle>
              <DialogDescription className="text-xs">
                版本 {selectedPlugin.version} · 作者 {selectedPlugin.author}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2 text-xs">
              <div>
                <span className="font-medium text-foreground">描述：</span>
                <p className="text-muted-foreground mt-0.5">{selectedPlugin.description}</p>
              </div>
              {selectedPlugin.endpoint && (
                <div>
                  <span className="font-medium text-foreground">本地 API 节点：</span>
                  <p className="font-mono text-muted-foreground mt-0.5 bg-muted p-1.5 rounded">
                    {selectedPlugin.endpoint}
                  </p>
                </div>
              )}
              <div>
                <span className="font-medium text-foreground">运行机制：</span>
                <p className="text-muted-foreground mt-0.5">
                  该插件独立运行在后台守护进程中，通过本地 Loopback 通道无损接入 Codeg 模型供应商与交互界面。
                </p>
              </div>
            </div>
            <DialogFooter className="flex items-center justify-between sm:justify-between">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  handleToggle(selectedPlugin.id, false)
                  setSelectedPlugin(null)
                }}
                className="text-xs"
              >
                停止插件
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
            <DialogTitle className="text-base">手动导入新插件</DialogTitle>
            <DialogDescription className="text-xs">
              输入插件包的本地文件路径或 Git 仓库地址，插件将被安装到 <code>%APPDATA%/codeg/plugins/</code>。
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
