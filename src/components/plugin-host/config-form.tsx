"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { pluginHostSetConfig } from "@/lib/plugin-host/api"
import type { ConfigSchema, PluginConfig } from "@/lib/plugin-host/types"
import { cn } from "@/lib/utils"

export interface ConfigFormProps {
  pluginId: string
  schema: ConfigSchema
  initialConfig?: PluginConfig
  onSave?: (newConfig: PluginConfig) => void
  className?: string
}

export function ConfigForm({
  pluginId,
  schema,
  initialConfig,
  onSave,
  className,
}: ConfigFormProps) {
  const t = useTranslations("PluginsSettings.configForm")

  const [values, setValues] = useState<
    Record<string, string | number | boolean>
  >(() => {
    const init: Record<string, string | number | boolean> = {}
    for (const [key, prop] of Object.entries(schema.properties || {})) {
      if (initialConfig?.values && key in initialConfig.values) {
        init[key] = initialConfig.values[key]
      } else if (prop.default !== undefined) {
        init[key] = prop.default
      } else if (prop.type === "boolean") {
        init[key] = false
      } else if (prop.type === "number" || prop.type === "integer") {
        init[key] = 0
      } else {
        init[key] = ""
      }
    }
    return init
  })

  const [secretsSet, setSecretsSet] = useState<Set<string>>(
    () => new Set(initialConfig?.secretsSet || [])
  )
  const [secretsDraft, setSecretsDraft] = useState<Record<string, string>>({})
  const [secretsToClear, setSecretsToClear] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const handleTextChange = (key: string, val: string) => {
    setValues((prev) => ({ ...prev, [key]: val }))
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }

  const handleNumberChange = (key: string, val: string) => {
    setValues((prev) => ({ ...prev, [key]: val }))
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }

  const handleBooleanChange = (key: string, checked: boolean) => {
    setValues((prev) => ({ ...prev, [key]: checked }))
  }

  const handleSecretChange = (key: string, val: string) => {
    setSecretsDraft((prev) => ({ ...prev, [key]: val }))
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }

  const handleToggleClearSecret = (key: string) => {
    setSecretsToClear((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
        setSecretsDraft((d) => {
          const nd = { ...d }
          delete nd[key]
          return nd
        })
      }
      return next
    })
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}
    const required = new Set(schema.required || [])

    for (const [key, prop] of Object.entries(schema.properties || {})) {
      const isRequired = required.has(key)
      if (prop.format === "secret") {
        const isCurrentlySet = secretsSet.has(key) && !secretsToClear.has(key)
        const hasDraft = Boolean(secretsDraft[key]?.trim())
        if (isRequired && !isCurrentlySet && !hasDraft) {
          newErrors[key] = t("required")
        }
      } else if (prop.type === "number" || prop.type === "integer") {
        const raw = values[key]
        if (isRequired && (raw === "" || raw === undefined || raw === null)) {
          newErrors[key] = t("required")
        } else if (raw !== "" && raw !== undefined && raw !== null) {
          const num = Number(raw)
          if (isNaN(num)) {
            newErrors[key] = t("invalidNumber")
          } else if (prop.type === "integer" && !Number.isInteger(num)) {
            newErrors[key] = t("invalidInteger")
          }
        }
      } else if (prop.type === "string") {
        const val = values[key]
        if (isRequired && (!val || String(val).trim() === "")) {
          newErrors[key] = t("required")
        }
      }
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return

    setSaving(true)
    try {
      const cleanedValues: Record<string, string | number | boolean> = {}
      for (const [key, prop] of Object.entries(schema.properties || {})) {
        if (prop.format === "secret") continue
        if (prop.type === "number" || prop.type === "integer") {
          const raw = values[key]
          cleanedValues[key] = raw === "" ? 0 : Number(raw)
        } else if (prop.type === "boolean") {
          cleanedValues[key] = Boolean(values[key])
        } else {
          cleanedValues[key] =
            values[key] !== undefined ? String(values[key]) : ""
        }
      }

      const secretsPayload: Record<string, string | null> = {}
      for (const key of secretsToClear) {
        secretsPayload[key] = null
      }
      for (const [key, draft] of Object.entries(secretsDraft)) {
        if (draft.trim() !== "") {
          secretsPayload[key] = draft.trim()
        }
      }

      const res = await pluginHostSetConfig(
        pluginId,
        cleanedValues,
        Object.keys(secretsPayload).length > 0 ? secretsPayload : undefined
      )

      setSecretsSet(new Set(res.secretsSet || []))
      setSecretsDraft({})
      setSecretsToClear(new Set())
      toast.success(t("saveSuccess"))
      onSave?.(res)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const properties = Object.entries(schema.properties || {})
  if (properties.length === 0) {
    return null
  }

  return (
    <form onSubmit={handleSubmit} className={cn("space-y-4", className)}>
      <div className="space-y-4">
        {properties.map(([key, prop]) => {
          const isRequired = schema.required?.includes(key)
          const error = errors[key]

          if (prop.format === "secret") {
            const isCurrentlySet =
              secretsSet.has(key) && !secretsToClear.has(key)
            const isMarkedForClear = secretsToClear.has(key)

            return (
              <div key={key} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label
                    htmlFor={`config-${key}`}
                    className="text-xs font-medium"
                  >
                    {prop.title || key}
                    {isRequired && (
                      <span className="ml-1 text-destructive">*</span>
                    )}
                  </Label>
                  {isCurrentlySet && (
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className="h-4 px-1 text-[10px] text-emerald-500 border-emerald-500/30"
                      >
                        {t("secretConfigured")}
                      </Badge>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-destructive"
                        onClick={() => handleToggleClearSecret(key)}
                      >
                        {t("secretClear")}
                      </Button>
                    </div>
                  )}
                  {isMarkedForClear && (
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className="h-4 px-1 text-[10px] text-amber-500 border-amber-500/30"
                      >
                        {t("secretWillClear")}
                      </Badge>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-5 px-1.5 text-[10px] text-muted-foreground"
                        onClick={() => handleToggleClearSecret(key)}
                      >
                        {t("secretClear")}
                      </Button>
                    </div>
                  )}
                </div>
                {prop.description && (
                  <p className="text-[11px] text-muted-foreground">
                    {prop.description}
                  </p>
                )}
                <Input
                  id={`config-${key}`}
                  type="password"
                  placeholder={
                    isCurrentlySet ? t("secretUpdatePlaceholder") : ""
                  }
                  value={secretsDraft[key] || ""}
                  onChange={(e) => handleSecretChange(key, e.target.value)}
                  className={cn(
                    "h-8 text-xs font-mono",
                    error && "border-destructive"
                  )}
                />
                {error && (
                  <p className="text-[10px] text-destructive">{error}</p>
                )}
              </div>
            )
          }

          if (prop.type === "boolean") {
            return (
              <div
                key={key}
                className="flex items-center justify-between rounded-lg border p-3 bg-muted/20"
              >
                <div className="space-y-0.5 pr-4">
                  <Label
                    htmlFor={`config-${key}`}
                    className="text-xs font-medium cursor-pointer"
                  >
                    {prop.title || key}
                    {isRequired && (
                      <span className="ml-1 text-destructive">*</span>
                    )}
                  </Label>
                  {prop.description && (
                    <p className="text-[11px] text-muted-foreground">
                      {prop.description}
                    </p>
                  )}
                </div>
                <Switch
                  id={`config-${key}`}
                  checked={Boolean(values[key])}
                  onCheckedChange={(checked) =>
                    handleBooleanChange(key, checked)
                  }
                />
              </div>
            )
          }

          if (prop.enum && prop.enum.length > 0) {
            return (
              <div key={key} className="space-y-1.5">
                <Label
                  htmlFor={`config-${key}`}
                  className="text-xs font-medium"
                >
                  {prop.title || key}
                  {isRequired && (
                    <span className="ml-1 text-destructive">*</span>
                  )}
                </Label>
                {prop.description && (
                  <p className="text-[11px] text-muted-foreground">
                    {prop.description}
                  </p>
                )}
                <Select
                  value={values[key] !== undefined ? String(values[key]) : ""}
                  onValueChange={(val) => handleTextChange(key, val)}
                >
                  <SelectTrigger
                    id={`config-${key}`}
                    className="h-8 text-xs w-full"
                  >
                    <SelectValue
                      placeholder={
                        prop.default ? String(prop.default) : "Select..."
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {prop.enum.map((opt) => (
                      <SelectItem key={opt} value={opt} className="text-xs">
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {error && (
                  <p className="text-[10px] text-destructive">{error}</p>
                )}
              </div>
            )
          }

          if (prop.type === "number" || prop.type === "integer") {
            return (
              <div key={key} className="space-y-1.5">
                <Label
                  htmlFor={`config-${key}`}
                  className="text-xs font-medium"
                >
                  {prop.title || key}
                  {isRequired && (
                    <span className="ml-1 text-destructive">*</span>
                  )}
                </Label>
                {prop.description && (
                  <p className="text-[11px] text-muted-foreground">
                    {prop.description}
                  </p>
                )}
                <Input
                  id={`config-${key}`}
                  type="number"
                  step={prop.type === "integer" ? "1" : "any"}
                  value={typeof values[key] === "number" || typeof values[key] === "string" ? values[key] : ""}
                  onChange={(e) => handleNumberChange(key, e.target.value)}
                  className={cn("h-8 text-xs", error && "border-destructive")}
                />
                {error && (
                  <p className="text-[10px] text-destructive">{error}</p>
                )}
              </div>
            )
          }

          return (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`config-${key}`} className="text-xs font-medium">
                {prop.title || key}
                {isRequired && <span className="ml-1 text-destructive">*</span>}
              </Label>
              {prop.description && (
                <p className="text-[11px] text-muted-foreground">
                  {prop.description}
                </p>
              )}
              <Input
                id={`config-${key}`}
                type="text"
                value={values[key] !== undefined ? String(values[key]) : ""}
                onChange={(e) => handleTextChange(key, e.target.value)}
                className={cn("h-8 text-xs", error && "border-destructive")}
              />
              {error && <p className="text-[10px] text-destructive">{error}</p>}
            </div>
          )
        })}
      </div>

      <div className="flex justify-end pt-2">
        <Button
          type="submit"
          size="sm"
          disabled={saving}
          className="h-8 text-xs"
        >
          {saving ? t("saving") : t("save")}
        </Button>
      </div>
    </form>
  )
}
