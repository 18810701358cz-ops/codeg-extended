"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  AlertTriangle,
  FolderOpen,
  Loader2,
  Palette,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Settings,
  ShieldAlert,
} from "lucide-react"
import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { PluginInstallDialog } from "@/components/settings/plugin-install-dialog"
import { PluginDetailSheet } from "@/components/settings/plugin-detail-sheet"
import { isDesktop, openPath } from "@/lib/platform"
import {
  pluginHostBackendRestart,
  pluginHostCheckUpdate,
  pluginHostCommitInstall,
  pluginHostDisableAll,
  pluginHostList,
  pluginHostSetDevMode,
  pluginHostSetEnabled,
  subscribePluginHostBackendStatus,
  subscribePluginHostChanged,
} from "@/lib/plugin-host/api"
import type { PluginInfo, PluginListResult } from "@/lib/plugin-host/types"
import { cn } from "@/lib/utils"

export function PluginsSettings() {
  const t = useTranslations("PluginsSettings")
  const searchParams = useSearchParams()

  const [loading, setLoading] = useState(true)
  const [listData, setListData] = useState<PluginListResult | null>(null)
  const [plugins, setPlugins] = useState<PluginInfo[]>([])

  const [searchQuery, setSearchQuery] = useState("")
  const [activeCategory, setActiveCategory] = useState<string>("all")

  const [installDialogOpen, setInstallDialogOpen] = useState(false)
  const [selectedPlugin, setSelectedPlugin] = useState<PluginInfo | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const [disableAllConfirmOpen, setDisableAllConfirmOpen] = useState(false)
  const [disablingAll, setDisablingAll] = useState(false)

  const [checkingUpdateId, setCheckingUpdateId] = useState<string | null>(null)
  const [restartingBackendId, setRestartingBackendId] = useState<string | null>(
    null
  )
  const [togglingDevMode, setTogglingDevMode] = useState(false)

  const handleToggleDevMode = async (checked: boolean) => {
    setTogglingDevMode(true)
    try {
      await pluginHostSetDevMode(checked)
      await fetchPlugins()
    } catch (err) {
      console.error("Failed to toggle developer mode:", err)
    } finally {
      setTogglingDevMode(false)
    }
  }

  const desktop = isDesktop()

  const fetchPlugins = useCallback(async () => {
    try {
      const data = await pluginHostList()
      setListData(data)
      setPlugins(data.plugins || [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPlugins()
  }, [fetchPlugins])

  // Sync ?id= parameter with DetailSheet
  useEffect(() => {
    const idParam = searchParams.get("id")
    if (idParam && plugins.length > 0) {
      const target = plugins.find((p) => p.id === idParam)
      if (target) {
        setSelectedPlugin(target)
        setDetailOpen(true)
      }
    }
  }, [searchParams, plugins])

  // Subscribe to changed & backend status events
  useEffect(() => {
    const unsubs: Array<() => void> = []
    let active = true

    subscribePluginHostChanged(() => {
      if (active) fetchPlugins()
    })
      .then((unsub) => {
        if (active) unsubs.push(unsub)
        else unsub()
      })
      .catch(() => {})

    subscribePluginHostBackendStatus((event) => {
      if (active) {
        setPlugins((prev) =>
          prev.map((p) =>
            p.id === event.id ? { ...p, backend: event.status } : p
          )
        )
      }
    })
      .then((unsub) => {
        if (active) unsubs.push(unsub)
        else unsub()
      })
      .catch(() => {})

    return () => {
      active = false
      unsubs.forEach((u) => u())
    }
  }, [fetchPlugins])

  const handleOpenDetail = (plugin: PluginInfo) => {
    setSelectedPlugin(plugin)
    setDetailOpen(true)
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      url.searchParams.set("id", plugin.id)
      window.history.pushState(null, "", url.toString())
    }
  }

  const handleCloseDetail = () => {
    setDetailOpen(false)
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      url.searchParams.delete("id")
      window.history.pushState(null, "", url.toString())
    }
  }

  const handleToggle = async (plugin: PluginInfo) => {
    const nextEnabled = !plugin.enabled
    try {
      const updated = await pluginHostSetEnabled(plugin.id, nextEnabled)
      setPlugins((prev) => prev.map((p) => (p.id === plugin.id ? updated : p)))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDisableAll = async () => {
    setDisablingAll(true)
    try {
      const res = await pluginHostDisableAll()
      setListData(res)
      setPlugins(res.plugins || [])
      toast.success(t("disableAllSuccess"))
      setDisableAllConfirmOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDisablingAll(false)
    }
  }

  const handleRestartBackend = async (plugin: PluginInfo) => {
    setRestartingBackendId(plugin.id)
    try {
      const status = await pluginHostBackendRestart(plugin.id)
      setPlugins((prev) =>
        prev.map((p) => (p.id === plugin.id ? { ...p, backend: status } : p))
      )
      toast.success(t("card.restartSuccess"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRestartingBackendId(null)
    }
  }

  const handleCheckUpdate = async (plugin: PluginInfo) => {
    setCheckingUpdateId(plugin.id)
    try {
      const res = await pluginHostCheckUpdate(plugin.id)
      if (res.updatable && res.stagingId) {
        toast.info(t("card.updateAvailable", { version: res.latest || "new" }))
        await pluginHostCommitInstall(res.stagingId)
        toast.success(t("installDialog.installSuccess"))
        await fetchPlugins()
      } else {
        toast.success(t("card.upToDate"))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCheckingUpdateId(null)
    }
  }

  const handleOpenPluginsDirectory = async () => {
    if (listData?.pluginsDir) {
      try {
        await openPath(listData.pluginsDir)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const filteredPlugins = useMemo(() => {
    return plugins.filter((plugin) => {
      const matchesSearch =
        searchQuery === "" ||
        plugin.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        plugin.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (plugin.description &&
          plugin.description
            .toLowerCase()
            .includes(searchQuery.toLowerCase())) ||
        (plugin.author &&
          plugin.author.toLowerCase().includes(searchQuery.toLowerCase()))

      const matchesCategory =
        activeCategory === "all" || plugin.category === activeCategory

      return matchesSearch && matchesCategory
    })
  }, [plugins, searchQuery, activeCategory])

  const cssNoticeParts = useMemo(() => {
    return t("cssNotice", { link: "__LINK__" }).split("__LINK__")
  }, [t])

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 p-4 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between border-b pb-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-bold tracking-tight">{t("title")}</h1>
              {listData && (
                <Badge variant="outline" className="text-xs font-mono">
                  {t("hostVersion", { version: listData.hostVersion })}
                </Badge>
              )}
              {listData?.safeMode && (
                <Badge variant="destructive" className="text-xs gap-1">
                  <ShieldAlert className="h-3 w-3" />
                  {t("safeModeBadge")}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t("description")}
            </p>
            {listData?.pluginsDir && (
              <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted-foreground">
                <span>{t("pluginsDir")}:</span>
                <code className="font-mono bg-muted/60 px-1 py-0.5 rounded text-[10px]">
                  {listData.pluginsDir}
                </code>
                {desktop && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[10px] gap-1 hover:text-foreground"
                    onClick={handleOpenPluginsDirectory}
                  >
                    <FolderOpen className="h-3 w-3" />
                    {t("openDir")}
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              className="flex items-center gap-2 px-2 py-1 rounded border bg-muted/20"
              title={t("devMode")}
            >
              <span className="text-xs font-medium text-muted-foreground">
                {t("devMode")}
              </span>
              <Switch
                checked={listData?.devMode ?? false}
                onCheckedChange={handleToggleDevMode}
                disabled={loading || togglingDevMode}
                aria-label="Toggle Developer Mode"
              />
            </div>

            <Button
              size="sm"
              variant="outline"
              onClick={fetchPlugins}
              disabled={loading}
              className="h-8 gap-1.5 text-xs"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />
              {t("refresh")}
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={() => setDisableAllConfirmOpen(true)}
              disabled={plugins.length === 0}
              className="h-8 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              {t("disableAll")}
            </Button>

            <Button
              size="sm"
              onClick={() => setInstallDialogOpen(true)}
              className="h-8 gap-1.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("installPlugin")}
            </Button>
          </div>
        </div>

        {/* Safe Mode Alert */}
        {listData?.safeMode && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            <span>{t("safeModeNotice")}</span>
          </div>
        )}

        {/* Notice about plugin styles */}
        <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 px-3.5 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Palette className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>
              {cssNoticeParts[0]}
              <Link
                href="/settings/appearance"
                className="font-medium text-foreground underline underline-offset-4 hover:text-primary transition-colors"
              >
                {t("cssNoticeLink")}
              </Link>
              {cssNoticeParts[1]}
            </span>
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
              <TabsTrigger
                value="all"
                className="text-xs"
                onClick={() => setActiveCategory("all")}
              >
                {t("categoryAll")}
              </TabsTrigger>
              <TabsTrigger
                value="appearance"
                className="text-xs"
                onClick={() => setActiveCategory("appearance")}
              >
                {t("categoryAppearance")}
              </TabsTrigger>
              <TabsTrigger
                value="model-provider"
                className="text-xs"
                onClick={() => setActiveCategory("model-provider")}
              >
                {t("categoryModelProvider")}
              </TabsTrigger>
              <TabsTrigger
                value="tools"
                className="text-xs"
                onClick={() => setActiveCategory("tools")}
              >
                {t("categoryTools")}
              </TabsTrigger>
              <TabsTrigger
                value="workflow"
                className="text-xs"
                onClick={() => setActiveCategory("workflow")}
              >
                {t("categoryWorkflow")}
              </TabsTrigger>
              <TabsTrigger
                value="utility"
                className="text-xs"
                onClick={() => setActiveCategory("utility")}
              >
                {t("categoryUtility")}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="relative w-full sm:w-72">
            <Search className="absolute top-2.5 left-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder={t("searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        {/* Plugin Cards Grid */}
        {filteredPlugins.length === 0 ? (
          <div className="py-16 text-center text-xs text-muted-foreground border rounded-lg bg-muted/10">
            {plugins.length === 0 ? t("emptyPlugins") : t("noFilteredPlugins")}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {filteredPlugins.map((plugin) => {
              const hasProblems = plugin.problems && plugin.problems.length > 0
              const isGit = plugin.source.kind === "git"
              const isChecking = checkingUpdateId === plugin.id
              const isRestarting = restartingBackendId === plugin.id

              return (
                <SettingCard key={plugin.id}>
                  <SettingRow
                    title={
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{plugin.name}</span>
                        <Badge
                          variant="outline"
                          className="h-4 px-1.5 font-mono text-[10px]"
                        >
                          v{plugin.version}
                        </Badge>
                        <Badge
                          variant="secondary"
                          className="h-4 px-1 text-[9px]"
                        >
                          {plugin.source.kind === "builtin"
                            ? t("card.builtin")
                            : plugin.source.kind === "git"
                              ? t("card.git")
                              : plugin.source.kind === "upload"
                                ? t("card.upload")
                                : t("card.manual")}
                        </Badge>
                      </div>
                    }
                    description={plugin.description}
                    control={
                      <Switch
                        checked={plugin.enabled}
                        onCheckedChange={() => handleToggle(plugin)}
                        aria-label={`Toggle ${plugin.name}`}
                      />
                    }
                  >
                    {/* Status & Author row */}
                    <div className="mt-2 flex items-center justify-between border-t border-border/40 pt-2 text-xs text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "inline-block h-2 w-2 rounded-full",
                            plugin.status === "ok" && plugin.enabled
                              ? "bg-emerald-500 animate-pulse"
                              : plugin.status === "error"
                                ? "bg-destructive"
                                : "bg-muted-foreground/40"
                          )}
                        />
                        <span className="capitalize">
                          {plugin.status === "ok"
                            ? plugin.enabled
                              ? t("card.statusOk")
                              : "Disabled"
                            : plugin.status === "invalid"
                              ? t("card.statusInvalid")
                              : plugin.status === "incompatible"
                                ? t("card.statusIncompatible")
                                : t("card.statusError")}
                        </span>

                        {plugin.backend && (
                          <Badge
                            variant="outline"
                            className={cn(
                              "h-4 px-1 text-[9px]",
                              plugin.backend.state === "running"
                                ? "text-emerald-500 border-emerald-500/30"
                                : plugin.backend.state === "crashed" ||
                                    plugin.backend.state === "unhealthy"
                                  ? "text-destructive border-destructive/30"
                                  : "text-muted-foreground"
                            )}
                          >
                            {plugin.backend.state}
                          </Badge>
                        )}

                        {plugin.author && (
                          <>
                            <span className="mx-0.5">·</span>
                            <span className="truncate max-w-[120px]">
                              {plugin.author}
                            </span>
                          </>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        {plugin.hasBackend && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                            title={t("card.restartBackend")}
                            onClick={() => handleRestartBackend(plugin)}
                            disabled={isRestarting}
                          >
                            <RotateCw
                              className={`h-3 w-3 ${
                                isRestarting ? "animate-spin" : ""
                              }`}
                            />
                          </Button>
                        )}

                        {isGit && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                            title={t("card.checkUpdate")}
                            onClick={() => handleCheckUpdate(plugin)}
                            disabled={isChecking}
                          >
                            <RefreshCw
                              className={`h-3 w-3 ${
                                isChecking ? "animate-spin" : ""
                              }`}
                            />
                          </Button>
                        )}

                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => handleOpenDetail(plugin)}
                        >
                          <Settings className="mr-1 h-3.5 w-3.5" />
                          {t("card.settings")}
                        </Button>
                      </div>
                    </div>

                    {/* Problems display */}
                    {hasProblems && (
                      <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/10 p-2 text-[11px] text-destructive space-y-0.5">
                        <div className="font-medium flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3 shrink-0" />
                          <span>{t("card.issuesTitle")}</span>
                        </div>
                        <ul className="list-disc list-inside space-y-0.5">
                          {plugin.problems.map((prob, i) => (
                            <li key={i}>{prob}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </SettingRow>
                </SettingCard>
              )
            })}
          </div>
        )}

        {/* Detail Sheet */}
        <PluginDetailSheet
          plugin={selectedPlugin}
          open={detailOpen}
          onOpenChange={(open) => {
            if (!open) handleCloseDetail()
            else setDetailOpen(true)
          }}
          onPluginUpdated={fetchPlugins}
          onUninstalled={fetchPlugins}
        />

        {/* Install Dialog */}
        <PluginInstallDialog
          open={installDialogOpen}
          onOpenChange={setInstallDialogOpen}
          onInstalled={fetchPlugins}
        />

        {/* Disable All Confirmation */}
        <AlertDialog
          open={disableAllConfirmOpen}
          onOpenChange={setDisableAllConfirmOpen}
        >
          <AlertDialogContent className="sm:max-w-md">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-base text-destructive">
                {t("disableAll")}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-xs text-muted-foreground">
                {t("disableAllConfirm")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={disablingAll}
                className="h-8 text-xs"
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault()
                  handleDisableAll()
                }}
                disabled={disablingAll}
                className="h-8 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90 gap-1.5"
              >
                {disablingAll && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                {t("disableAll")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </ScrollArea>
  )
}
