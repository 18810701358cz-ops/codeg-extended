// [codeg-extended] Merge extension messages for plugin host settings and navigation
import type { AbstractIntlMessages } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import enExtMessages from "@/i18n/messages-ext/en.json"
import type { AppLocale } from "@/lib/types"

function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>
): T {
  const output = { ...target } as Record<string, unknown>
  for (const key of Object.keys(source)) {
    const sVal = source[key]
    const tVal = output[key]
    if (
      sVal &&
      typeof sVal === "object" &&
      !Array.isArray(sVal) &&
      tVal &&
      typeof tVal === "object" &&
      !Array.isArray(tVal)
    ) {
      output[key] = deepMerge(
        tVal as Record<string, unknown>,
        sVal as Record<string, unknown>
      )
    } else {
      output[key] = sVal
    }
  }
  return output as T
}

const mergedEnMessages = deepMerge(
  enMessages as Record<string, unknown>,
  enExtMessages as Record<string, unknown>
) as unknown as AbstractIntlMessages

const MESSAGE_CACHE = new Map<AppLocale, AbstractIntlMessages>([
  ["en", mergedEnMessages],
])

async function loadMessages(locale: AppLocale): Promise<AbstractIntlMessages> {
  let base: Record<string, unknown>
  let ext: Record<string, unknown>

  switch (locale) {
    case "zh_cn":
      base = (await import("@/i18n/messages/zh-CN.json")).default
      ext = (await import("@/i18n/messages-ext/zh-CN.json")).default
      break
    case "zh_tw":
      base = (await import("@/i18n/messages/zh-TW.json")).default
      ext = (await import("@/i18n/messages-ext/zh-TW.json")).default
      break
    case "ja":
      base = (await import("@/i18n/messages/ja.json")).default
      ext = (await import("@/i18n/messages-ext/ja.json")).default
      break
    case "ko":
      base = (await import("@/i18n/messages/ko.json")).default
      ext = (await import("@/i18n/messages-ext/ko.json")).default
      break
    case "es":
      base = (await import("@/i18n/messages/es.json")).default
      ext = (await import("@/i18n/messages-ext/es.json")).default
      break
    case "de":
      base = (await import("@/i18n/messages/de.json")).default
      ext = (await import("@/i18n/messages-ext/de.json")).default
      break
    case "fr":
      base = (await import("@/i18n/messages/fr.json")).default
      ext = (await import("@/i18n/messages-ext/fr.json")).default
      break
    case "pt":
      base = (await import("@/i18n/messages/pt.json")).default
      ext = (await import("@/i18n/messages-ext/pt.json")).default
      break
    case "ar":
      base = (await import("@/i18n/messages/ar.json")).default
      ext = (await import("@/i18n/messages-ext/ar.json")).default
      break
    case "en":
    default:
      return mergedEnMessages
  }

  return deepMerge(base, ext) as unknown as AbstractIntlMessages
}

export function getFallbackMessages(): AbstractIntlMessages {
  return mergedEnMessages
}

export async function getMessagesForLocale(
  locale: AppLocale
): Promise<AbstractIntlMessages> {
  const cached = MESSAGE_CACHE.get(locale)
  if (cached) return cached

  const messages = await loadMessages(locale)
  MESSAGE_CACHE.set(locale, messages)
  return messages
}
