"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  FileText,
  Loader2,
  Puzzle,
  RefreshCw,
  Server,
  Settings,
  Trash2,
} from "lucide-react"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ConfigForm } from "@/components/plugin-host/config-form"
import { PluginSlot } from "@/components/plugin-host/plugin-slot"
import {
  pluginHostGetConfig,
  pluginHostReadLog,
  pluginHostUninstall,
} from "@/lib/plugin-host/api"
import type { PluginConfig, PluginInfo } from "@/lib/plugin-host/types"

export interface PluginDetailSheetProps {
  plugin: PluginInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onPluginUpdated?: () => void
  onUninstalled?: (id: string) => void
}

export function PluginDetailSheet({
  plugin,
  open,
  onOpenChange,
  onPluginUpdated,
  onUninstalled,
}: PluginDetailSheetProps) {
  const t = useTranslations("PluginsSettings.detailSheet")

  const [activeTab, setActiveTab] = useState<
    "config" | "contributions" | "logs"
  >("config")
  const [config, setConfig] = useState<PluginConfig | undefined>(undefined)
  const [loadingConfig, setLoadingConfig] = useState(false)

  const [logs, setLogs] = useState<string>("")
  const [loadingLogs, setLoadingLogs] = useState(false)

  const [uninstallOpen, setUninstallOpen] = useState(false)
  const [removeContributions, setRemoveContributions] = useState(true)
  const [uninstalling, setUninstalling] = useState(false)

  const fetchConfig = useCallback(async (id: string) => {
    setLoadingConfig(true)
    try {
      const cfg = await pluginHostGetConfig(id)
      setConfig(cfg)
    } catch {
      setConfig(undefined)
    } finally {
      setLoadingConfig(false)
    }
  }, [])

  const fetchLogs = useCallback(async (id: string) => {
    setLoadingLogs(true)
    try {
      const content = await pluginHostReadLog(id, 50000)
      setLogs(content || "")
    } catch {
      setLogs("")
    } finally {
      setLoadingLogs(false)
    }
  }, [])

  useEffect(() => {
    if (open && plugin) {
      if (plugin.configSchema) {
        fetchConfig(plugin.id)
      }
      fetchLogs(plugin.id)
    } else {
      setLogs("")
      setConfig(undefined)
      setUninstallOpen(false)
    }
  }, [open, plugin, fetchConfig, fetchLogs])

  const handleUninstall = async () => {
    if (!plugin) return

    setUninstalling(true)
    try {
      await pluginHostUninstall(plugin.id, removeContributions)
      toast.success(t("uninstallSuccess"))
      setUninstallOpen(false)
      onUninstalled?.(plugin.id)
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setUninstalling(false)
    }
  }

  if (!plugin) return null

  const hasConfig = Boolean(
    plugin.configSchema &&
    Object.keys(plugin.configSchema.properties || {}).length > 0
  )

  const modelProviderEntries = Object.entries(
    plugin.applied?.modelProviders || {}
  )
  const mcpServerEntries = Object.entries(plugin.applied?.mcpServers || {})
  const quickMessageEntries = Object.entries(
    plugin.applied?.quickMessages || {}
  )
  const hasContributions =
    modelProviderEntries.length > 0 ||
    mcpServerEntries.length > 0 ||
    quickMessageEntries.length > 0

  return (
    <>
      <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
        <DrawerContent className="w-[min(38rem,92vw)] sm:max-w-xl p-0 flex flex-col h-full bg-background">
          <DrawerHeader className="p-4 border-b shrink-0">
            <div className="flex items-start justify-between gap-3 pr-6">
              <div>
                <div className="flex items-center gap-2">
                  <DrawerTitle className="text-base font-semibold">
                    {plugin.name}
                  </DrawerTitle>
                  <Badge variant="outline" className="text-[10px] font-mono">
                    v{plugin.version}
                  </Badge>
                  {plugin.builtin && (
                    <Badge variant="secondary" className="text-[10px]">
                      Built-in
                    </Badge>
                  )}
                </div>
                <DrawerDescription className="text-xs text-muted-foreground mt-0.5">
                  ID: <code className="font-mono">{plugin.id}</code>
                  {plugin.author ? ` · By ${plugin.author}` : ""}
                </DrawerDescription>
              </div>

              {!plugin.builtin && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1"
                  onClick={() => setUninstallOpen(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("uninstall")}
                </Button>
              )}
            </div>
          </DrawerHeader>

          {/* Plugin Details Slot. A plugin sets the height of what it mounts
              here and the drawer body does not scroll, so the region carries
              its own cap and scrollbar rather than squeezing the tabs. */}
          <div className="max-h-[40dvh] shrink-0 overflow-y-auto px-4 py-2 border-b bg-muted/10 empty:hidden">
            <PluginSlot name="settings.plugin-detail" />
          </div>

          <Tabs
            value={activeTab}
            onValueChange={(v) =>
              setActiveTab(v as "config" | "contributions" | "logs")
            }
            className="flex-1 flex flex-col min-h-0"
          >
            <div className="px-4 pt-2 border-b shrink-0">
              <TabsList className="h-8">
                <TabsTrigger
                  value="config"
                  className="text-xs gap-1.5"
                  onClick={() => setActiveTab("config")}
                >
                  <Settings className="h-3.5 w-3.5" />
                  {t("tabConfig")}
                </TabsTrigger>
                <TabsTrigger
                  value="contributions"
                  className="text-xs gap-1.5"
                  onClick={() => setActiveTab("contributions")}
                >
                  <Puzzle className="h-3.5 w-3.5" />
                  {t("tabContributions")}
                  {hasContributions && (
                    <span className="ml-1 rounded-full bg-primary/20 text-primary px-1.5 py-0.2 text-[10px]">
                      {modelProviderEntries.length +
                        mcpServerEntries.length +
                        quickMessageEntries.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="logs"
                  className="text-xs gap-1.5"
                  onClick={() => setActiveTab("logs")}
                >
                  <FileText className="h-3.5 w-3.5" />
                  {t("tabLogs")}
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="config" className="flex-1 p-4 overflow-y-auto">
              {loadingConfig ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground gap-2 text-xs">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Loading configuration...</span>
                </div>
              ) : hasConfig && plugin.configSchema ? (
                <ConfigForm
                  pluginId={plugin.id}
                  schema={plugin.configSchema}
                  initialConfig={config}
                  onSave={(newCfg) => {
                    setConfig(newCfg)
                    onPluginUpdated?.()
                  }}
                />
              ) : (
                <div className="py-12 text-center text-xs text-muted-foreground">
                  {t("noConfig")}
                </div>
              )}
            </TabsContent>

            <TabsContent
              value="contributions"
              className="flex-1 p-4 overflow-y-auto space-y-4"
            >
              {!hasContributions ? (
                <div className="py-12 text-center text-xs text-muted-foreground">
                  {t("noContributions")}
                </div>
              ) : (
                <div className="space-y-4 text-xs">
                  {modelProviderEntries.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <Server className="h-3.5 w-3.5 text-sky-500" />
                        <span>{t("modelProviders")}</span>
                      </div>
                      <div className="rounded-lg border divide-y bg-muted/20">
                        {modelProviderEntries.map(([providerKey, agentIds]) => (
                          <div
                            key={providerKey}
                            className="p-2.5 flex items-center justify-between"
                          >
                            <span className="font-mono text-xs">
                              {providerKey}
                            </span>
                            <Badge
                              variant="outline"
                              className="text-[10px] text-muted-foreground"
                            >
                              Agents: {agentIds.length}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {mcpServerEntries.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <Puzzle className="h-3.5 w-3.5 text-emerald-500" />
                        <span>{t("mcpServers")}</span>
                      </div>
                      <div className="rounded-lg border divide-y bg-muted/20">
                        {mcpServerEntries.map(([serverName, tools]) => (
                          <div
                            key={serverName}
                            className="p-2.5 flex items-center justify-between"
                          >
                            <span className="font-mono text-xs">
                              {serverName}
                            </span>
                            <Badge
                              variant="outline"
                              className="text-[10px] text-muted-foreground"
                            >
                              Tools: {tools.length}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {quickMessageEntries.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <FileText className="h-3.5 w-3.5 text-indigo-500" />
                        <span>{t("quickMessages")}</span>
                      </div>
                      <div className="rounded-lg border divide-y bg-muted/20">
                        {quickMessageEntries.map(([qmKey, ids]) => (
                          <div
                            key={qmKey}
                            className="p-2.5 flex items-center justify-between"
                          >
                            <span className="font-mono text-xs">{qmKey}</span>
                            <Badge
                              variant="outline"
                              className="text-[10px] text-muted-foreground"
                            >
                              Count: {ids.length}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </TabsContent>

            <TabsContent
              value="logs"
              className="flex-1 flex flex-col min-h-0 p-4"
            >
              <div className="flex items-center justify-between pb-2 shrink-0">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("tabLogs")}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs gap-1"
                  onClick={() => fetchLogs(plugin.id)}
                  disabled={loadingLogs}
                >
                  <RefreshCw
                    className={`h-3 w-3 ${loadingLogs ? "animate-spin" : ""}`}
                  />
                  {t("refreshLogs")}
                </Button>
              </div>

              <ScrollArea className="flex-1 rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                {loadingLogs ? (
                  <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>{t("loadingLogs")}</span>
                  </div>
                ) : logs.trim() ? (
                  <pre className="whitespace-pre-wrap break-all text-muted-foreground">
                    {logs}
                  </pre>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    {t("noLogs")}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </DrawerContent>
      </Drawer>

      {/* Uninstall Confirmation Dialog */}
      <AlertDialog open={uninstallOpen} onOpenChange={setUninstallOpen}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base text-destructive flex items-center gap-1.5">
              <Trash2 className="h-4 w-4" />
              {t("uninstallConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground">
              {t("uninstallConfirmDesc", { name: plugin.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="py-2">
            <div className="flex items-start gap-2 rounded-lg border p-3 bg-muted/20">
              <Checkbox
                id="remove-contrib-check"
                checked={removeContributions}
                onCheckedChange={(checked) =>
                  setRemoveContributions(Boolean(checked))
                }
              />
              <Label
                htmlFor="remove-contrib-check"
                className="text-xs leading-snug cursor-pointer font-normal"
              >
                {t("removeContributionsLabel")}
              </Label>
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={uninstalling} className="h-8 text-xs">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleUninstall()
              }}
              disabled={uninstalling}
              className="h-8 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90 gap-1.5"
            >
              {uninstalling && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {uninstalling ? t("uninstalling") : t("uninstall")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
