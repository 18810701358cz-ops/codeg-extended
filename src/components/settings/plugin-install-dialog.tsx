"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  GitBranch,
  Upload,
  Folder,
  FileArchive,
  AlertTriangle,
  Loader2,
  CheckCircle2,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { isDesktop, openFileDialog } from "@/lib/platform"
import { getCodegToken } from "@/lib/transport/web-auth"
import { notifyWebUnauthorized } from "@/lib/transport/web-connection-store"
import {
  pluginHostCommitInstall,
  pluginHostDiscardStaging,
  pluginHostParseRepoUrl,
  pluginHostStage,
} from "@/lib/plugin-host/api"
import type {
  PluginInfo,
  PluginPermission,
  StageResult,
} from "@/lib/plugin-host/types"

export interface PluginInstallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInstalled?: (plugin: PluginInfo) => void
}

export async function uploadPluginWeb(
  file: File,
  onProgress?: (loaded: number, total: number) => void
): Promise<StageResult> {
  return new Promise<StageResult>((resolve, reject) => {
    const token = getCodegToken()
    const xhr = new XMLHttpRequest()
    xhr.open("POST", `${window.location.origin}/api/plugin_host_stage_upload`)
    if (token) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`)
    }
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total)
      }
    }
    xhr.onload = () => {
      if (xhr.status === 401) {
        notifyWebUnauthorized()
        reject(new Error("Unauthorized"))
        return
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        let err: unknown
        try {
          err = JSON.parse(xhr.responseText)
        } catch {
          err = new Error(`HTTP ${xhr.status}`)
        }
        reject(err)
        return
      }
      try {
        const res = JSON.parse(xhr.responseText) as StageResult
        resolve(res)
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    xhr.onerror = () => reject(new Error("Network error during upload"))
    const form = new FormData()
    form.append("file", file, file.name)
    xhr.send(form)
  })
}

export function PluginInstallDialog({
  open,
  onOpenChange,
  onInstalled,
}: PluginInstallDialogProps) {
  const t = useTranslations("PluginsSettings.installDialog")

  const [activeTab, setActiveTab] = useState<"git" | "upload">("git")
  const [repoUrl, setRepoUrl] = useState("")
  const [ref, setRef] = useState("")
  const [subdir, setSubdir] = useState("")

  const [isParsing, setIsParsing] = useState(false)
  const [isStaging, setIsStaging] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
  const [stageResult, setStageResult] = useState<StageResult | null>(null)
  const [uploadPercent, setUploadPercent] = useState<number | null>(null)

  const desktop = isDesktop()

  // Clean up staging if dialog closes without installing
  useEffect(() => {
    if (!open && stageResult) {
      pluginHostDiscardStaging(stageResult.stagingId).catch(() => {})
      setStageResult(null)
      setUploadPercent(null)
    }
  }, [open, stageResult])

  const handleUrlBlur = async () => {
    const trimmed = repoUrl.trim()
    if (
      !trimmed ||
      trimmed.startsWith("ext::") ||
      trimmed.startsWith("file://")
    )
      return

    if (!ref && !subdir) {
      try {
        setIsParsing(true)
        const parts = await pluginHostParseRepoUrl(trimmed)
        if (parts.url && parts.url !== trimmed) {
          setRepoUrl(parts.url)
        }
        if (parts.ref) setRef(parts.ref)
        if (parts.subdir) setSubdir(parts.subdir)
      } catch {
        // Ignore parse failure on blur
      } finally {
        setIsParsing(false)
      }
    }
  }

  const handleStageGit = async () => {
    const trimmed = repoUrl.trim()
    if (!trimmed) return

    setIsStaging(true)
    try {
      const res = await pluginHostStage({
        kind: "git",
        url: trimmed,
        ...(ref.trim() ? { ref: ref.trim() } : {}),
        ...(subdir.trim() ? { subdir: subdir.trim() } : {}),
      })
      setStageResult(res)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setIsStaging(false)
    }
  }

  const handlePickDesktopFile = async () => {
    try {
      const path = await openFileDialog({
        directory: false,
        title: t("uploadZipDesktop"),
      })
      if (!path || typeof path !== "string") return

      setIsStaging(true)
      const res = await pluginHostStage({
        kind: "path",
        path,
      })
      setStageResult(res)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setIsStaging(false)
    }
  }

  const handlePickDesktopFolder = async () => {
    try {
      const path = await openFileDialog({
        directory: true,
        title: t("uploadFolderDesktop"),
      })
      if (!path || typeof path !== "string") return

      setIsStaging(true)
      const res = await pluginHostStage({
        kind: "path",
        path,
      })
      setStageResult(res)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setIsStaging(false)
    }
  }

  const handleUploadFile = async (file: File) => {
    setIsStaging(true)
    setUploadPercent(0)
    try {
      const res = await uploadPluginWeb(file, (loaded, total) => {
        setUploadPercent(Math.round((loaded / total) * 100))
      })
      setStageResult(res)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setIsStaging(false)
      setUploadPercent(null)
    }
  }

  const handleDiscard = async () => {
    if (stageResult) {
      try {
        await pluginHostDiscardStaging(stageResult.stagingId)
      } catch {
        // Ignore
      }
      setStageResult(null)
    }
  }

  const handleCommit = async () => {
    if (!stageResult) return

    setIsCommitting(true)
    try {
      const plugin = await pluginHostCommitInstall(stageResult.stagingId)
      toast.success(t("installSuccess"))
      setStageResult(null)
      onInstalled?.(plugin)
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setIsCommitting(false)
    }
  }

  const renderPermissionBadge = (perm: PluginPermission) => {
    const labels: Record<PluginPermission, string> = {
      ui: t("permUi"),
      process: t("permProcess"),
      modelProviders: t("permModelProviders"),
      mcp: t("permMcp"),
      quickMessages: t("permQuickMessages"),
      network: t("permNetwork"),
    }
    return (
      <Badge
        key={perm}
        variant="secondary"
        className="text-[10px] px-1.5 py-0.5"
      >
        {labels[perm] || perm}
      </Badge>
    )
  }

  const preview = stageResult?.preview
  const hasProblems = preview && preview.problems && preview.problems.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t("title")}</DialogTitle>
          <DialogDescription className="text-xs">
            {stageResult ? t("previewTitle") : ""}
          </DialogDescription>
        </DialogHeader>

        {stageResult && preview ? (
          <div className="space-y-3 py-2 text-xs">
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-sm flex items-center gap-1.5">
                    {preview.name}
                    <Badge variant="outline" className="text-[10px] font-mono">
                      v{preview.version}
                    </Badge>
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono">
                    {preview.id}
                  </div>
                </div>
                {preview.isUpgrade && (
                  <Badge className="bg-sky-500/10 text-sky-500 border-sky-500/20 text-[10px]">
                    {t("isUpgrade", {
                      current: preview.installedVersion || "",
                      version: preview.version,
                    })}
                  </Badge>
                )}
              </div>

              {preview.description && (
                <p className="text-muted-foreground">{preview.description}</p>
              )}

              {preview.author && (
                <p className="text-[11px] text-muted-foreground">
                  By {preview.author}
                </p>
              )}
            </div>

            {/* Permissions */}
            {preview.permissions.length > 0 && (
              <div className="space-y-1">
                <span className="font-medium text-muted-foreground text-[11px]">
                  {t("permissions")}
                </span>
                <div className="flex flex-wrap gap-1">
                  {preview.permissions.map(renderPermissionBadge)}
                </div>
              </div>
            )}

            {/* Backend & UI Indicators */}
            <div className="flex flex-wrap gap-2 text-[11px]">
              {preview.hasBackend && (
                <div className="flex items-center gap-1 text-amber-500">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>{t("hasBackend")}</span>
                </div>
              )}
              {preview.hasMain && (
                <div className="flex items-center gap-1 text-sky-500">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>{t("hasMain")}</span>
                </div>
              )}
            </div>

            {/* Contributions */}
            {(preview.contributes.modelProviders > 0 ||
              preview.contributes.mcpServers > 0 ||
              preview.contributes.quickMessages > 0) && (
              <div className="space-y-1 rounded border p-2 bg-background/50">
                <span className="font-medium text-muted-foreground text-[11px]">
                  {t("contributions")}
                </span>
                <div className="space-y-0.5 text-[11px]">
                  {preview.contributes.modelProviders > 0 && (
                    <p>
                      {t("contribProviders", {
                        count: preview.contributes.modelProviders,
                      })}
                    </p>
                  )}
                  {preview.contributes.mcpServers > 0 && (
                    <p>
                      {t("contribMcp", {
                        count: preview.contributes.mcpServers,
                      })}
                    </p>
                  )}
                  {preview.contributes.quickMessages > 0 && (
                    <p>
                      {t("contribQuickMessages", {
                        count: preview.contributes.quickMessages,
                      })}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Problems check */}
            {hasProblems && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-destructive space-y-1">
                <div className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>Problems detected</span>
                </div>
                <ul className="list-disc list-inside space-y-0.5 text-[11px]">
                  {preview.problems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as "git" | "upload")}
            className="w-full"
          >
            <TabsList className="grid w-full grid-cols-2 h-8">
              <TabsTrigger
                value="git"
                className="text-xs gap-1.5"
                onClick={() => setActiveTab("git")}
              >
                <GitBranch className="h-3.5 w-3.5" />
                {t("tabGit")}
              </TabsTrigger>
              <TabsTrigger
                value="upload"
                className="text-xs gap-1.5"
                onClick={() => setActiveTab("upload")}
              >
                <Upload className="h-3.5 w-3.5" />
                {t("tabUpload")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="git" className="space-y-3 pt-2">
              <div className="space-y-1">
                <Label htmlFor="repo-url" className="text-xs font-medium">
                  {t("repoUrlLabel")}
                </Label>
                <div className="relative">
                  <Input
                    id="repo-url"
                    placeholder={t("repoUrlPlaceholder")}
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    onBlur={handleUrlBlur}
                    className="h-8 text-xs font-mono pr-8"
                  />
                  {isParsing && (
                    <Loader2 className="absolute right-2.5 top-2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="repo-ref" className="text-xs font-medium">
                    {t("refLabel")}
                  </Label>
                  <Input
                    id="repo-ref"
                    placeholder={t("refPlaceholder")}
                    value={ref}
                    onChange={(e) => setRef(e.target.value)}
                    className="h-8 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="repo-subdir" className="text-xs font-medium">
                    {t("subdirLabel")}
                  </Label>
                  <Input
                    id="repo-subdir"
                    placeholder={t("subdirPlaceholder")}
                    value={subdir}
                    onChange={(e) => setSubdir(e.target.value)}
                    className="h-8 text-xs font-mono"
                  />
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <Button
                  size="sm"
                  disabled={!repoUrl.trim() || isStaging}
                  onClick={handleStageGit}
                  className="h-8 text-xs gap-1.5"
                >
                  {isStaging && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  {isStaging ? t("staging") : t("stageBtn")}
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="upload" className="space-y-3 pt-2">
              {desktop ? (
                <div className="grid grid-cols-2 gap-3 py-2">
                  <Button
                    variant="outline"
                    className="h-24 flex-col gap-2 border-dashed text-xs"
                    onClick={handlePickDesktopFile}
                    disabled={isStaging}
                  >
                    <FileArchive className="h-6 w-6 text-muted-foreground" />
                    <span>{t("uploadZipDesktop")}</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-24 flex-col gap-2 border-dashed text-xs"
                    onClick={handlePickDesktopFolder}
                    disabled={isStaging}
                  >
                    <Folder className="h-6 w-6 text-muted-foreground" />
                    <span>{t("uploadFolderDesktop")}</span>
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <label
                    htmlFor="zip-upload"
                    className="flex flex-col items-center justify-center h-28 border-2 border-dashed rounded-lg cursor-pointer bg-muted/10 hover:bg-muted/30 transition-colors p-4"
                  >
                    <FileArchive className="h-6 w-6 text-muted-foreground mb-1.5" />
                    <span className="text-xs text-center text-muted-foreground">
                      {uploadPercent !== null
                        ? `${uploadPercent}%`
                        : t("dragDrop")}
                    </span>
                    <input
                      id="zip-upload"
                      type="file"
                      accept=".zip"
                      className="hidden"
                      disabled={isStaging}
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) handleUploadFile(file)
                      }}
                    />
                  </label>
                </div>
              )}
              {isStaging && (
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>{t("staging")}</span>
                </div>
              )}
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {stageResult ? (
            <div className="flex w-full items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDiscard}
                disabled={isCommitting}
                className="h-8 text-xs"
              >
                {t("discard")}
              </Button>
              <Button
                size="sm"
                onClick={handleCommit}
                disabled={Boolean(hasProblems || isCommitting)}
                className="h-8 text-xs gap-1.5"
              >
                {isCommitting && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                {isCommitting
                  ? t("installing")
                  : preview?.isUpgrade
                    ? t("upgradeBtn")
                    : t("installBtn")}
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="h-8 text-xs"
            >
              {t("cancel")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
