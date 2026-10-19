"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Bot, ScrollText } from "lucide-react"
import { AgentSelector } from "@/components/chat/agent-selector"
import { AgentConfigSection } from "@/components/automations/agent-config-section"
import { useAgentOptions } from "@/components/automations/use-agent-options"
import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { getCommitMessageSettings, setCommitMessageSettings } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { AgentType, CommitMessageSettings } from "@/lib/types"

interface CommitMessageSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Where the agent picker starts when no agent is saved yet: the one the
   *  generator follows today. */
  defaultAgentType?: AgentType | null
}

/**
 * How the commit message generator runs: which agent writes (or "follow the
 * session"), with which model and options, and the user's standing
 * instructions. Opened from where the generator is used, not from Settings.
 */
export function CommitMessageSettingsDialog({
  open,
  onOpenChange,
  defaultAgentType = null,
}: CommitMessageSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[32rem]">
        {/* Mounted per open, so every open loads what is saved now. */}
        {open ? (
          <CommitMessageSettingsBody
            defaultAgentType={defaultAgentType}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function CommitMessageSettingsBody({
  defaultAgentType,
  onClose,
}: {
  defaultAgentType: AgentType | null
  onClose: () => void
}) {
  const t = useTranslations("CommitMessageGeneration.dialog")
  const [loaded, setLoaded] = useState<CommitMessageSettings | null>(null)
  // Whether a specific agent writes the messages; off follows the session.
  const [pinned, setPinned] = useState(false)
  const [agentType, setAgentType] = useState<AgentType>(
    defaultAgentType ?? "claude_code"
  )
  const [modeId, setModeId] = useState<string | null>(null)
  const [configValues, setConfigValues] = useState<Record<string, string>>({})
  const [instructions, setInstructions] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    getCommitMessageSettings()
      .then((settings) => {
        if (cancelled) return
        setLoaded(settings)
        setPinned(settings.agent_type != null)
        if (settings.agent_type) setAgentType(settings.agent_type)
        setModeId(settings.mode_id ?? null)
        setConfigValues(settings.config_values ?? {})
        setInstructions(settings.instructions ?? "")
      })
      .catch((error) => {
        if (cancelled) return
        toast.error(t("loadFailed"), { description: toErrorMessage(error) })
      })
    return () => {
      cancelled = true
    }
  }, [t])

  // Probed only while a specific agent is on: following the session needs no
  // options, and every probe starts the agent's CLI.
  const agentOptions = useAgentOptions(
    agentType,
    null,
    loaded != null && pinned,
    configValues
  )

  const save = async () => {
    setSaving(true)
    try {
      // Only what was picked is saved: an option left on "agent default"
      // keeps following the agent's own default.
      await setCommitMessageSettings({
        agent_type: pinned ? agentType : null,
        mode_id: pinned ? modeId : null,
        config_values: pinned ? configValues : {},
        instructions: instructions.trim(),
      })
      toast.success(t("saved"))
      onClose()
    } catch (error) {
      toast.error(t("saveFailed"), { description: toErrorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        <SettingCard>
          <SettingRow
            icon={Bot}
            title={t("pinAgent")}
            description={pinned ? t("pinAgentHint") : t("followSessionHint")}
            htmlFor="commit-message-pin-agent"
            control={
              <Switch
                id="commit-message-pin-agent"
                checked={pinned}
                disabled={loaded == null}
                onCheckedChange={setPinned}
              />
            }
          >
            {pinned ? (
              <div className="flex flex-col gap-2.5">
                <div className="flex">
                  <AgentSelector
                    defaultAgentType={agentType}
                    onSelect={(agent) => {
                      setAgentType(agent)
                      setModeId(null)
                      setConfigValues({})
                    }}
                    onFallback={setAgentType}
                  />
                </div>
                <AgentConfigSection
                  agentType={agentOptions.snapshotAgentType}
                  snapshot={agentOptions.snapshot}
                  loading={agentOptions.loading}
                  stale={!agentOptions.current}
                  error={agentOptions.error}
                  onReload={agentOptions.reload}
                  modeId={modeId}
                  configValues={configValues}
                  onModeChange={setModeId}
                  onConfigChange={(optionId, valueId) =>
                    setConfigValues((prev) => {
                      const next = { ...prev }
                      if (valueId === null) delete next[optionId]
                      else next[optionId] = valueId
                      return next
                    })
                  }
                />
              </div>
            ) : null}
          </SettingRow>
        </SettingCard>

        <SettingCard>
          <SettingRow
            icon={ScrollText}
            title={t("instructions")}
            description={t("instructionsHint")}
            htmlFor="commit-message-instructions"
          >
            <Textarea
              id="commit-message-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder={t("instructionsPlaceholder")}
              disabled={loaded == null}
              className="min-h-20 bg-background text-sm"
            />
          </SettingRow>
        </SettingCard>
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          disabled={saving}
        >
          {t("cancel")}
        </Button>
        <Button
          type="button"
          onClick={() => void save()}
          disabled={saving || loaded == null}
        >
          {t("save")}
        </Button>
      </DialogFooter>
    </>
  )
}
