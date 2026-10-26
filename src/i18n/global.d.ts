import type enMessages from "@/i18n/messages/en.json"
import type enExtMessages from "@/i18n/messages-ext/en.json"

type DeepMerge<T, U> = {
  [K in keyof T | keyof U]: K extends keyof T
    ? K extends keyof U
      ? T[K] extends object
        ? U[K] extends object
          ? DeepMerge<T[K], U[K]>
          : U[K]
        : U[K]
      : T[K]
    : K extends keyof U
      ? U[K]
      : never
}

type ExtendedMessages = DeepMerge<typeof enMessages, typeof enExtMessages>

declare module "next-intl" {
  interface AppConfig {
    Locale:
      | "en"
      | "zh-CN"
      | "zh-TW"
      | "ja"
      | "ko"
      | "es"
      | "de"
      | "fr"
      | "pt"
      | "ar"
    Messages: ExtendedMessages
  }
}
