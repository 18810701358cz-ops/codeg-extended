import { createTranslator } from "next-intl"
import { describe, expect, it } from "vitest"

import ar from "./messages-ext/ar.json"
import de from "./messages-ext/de.json"
import en from "./messages-ext/en.json"
import es from "./messages-ext/es.json"
import fr from "./messages-ext/fr.json"
import ja from "./messages-ext/ja.json"
import ko from "./messages-ext/ko.json"
import pt from "./messages-ext/pt.json"
import zhCN from "./messages-ext/zh-CN.json"
import zhTW from "./messages-ext/zh-TW.json"

type MessageNode = string | { [key: string]: MessageNode }

function collectKeys(node: MessageNode, prefix = ""): string[] {
  if (typeof node === "string") {
    return [prefix]
  }
  const out: string[] = []
  for (const [key, value] of Object.entries(node)) {
    const next = prefix ? `${prefix}.${key}` : key
    out.push(...collectKeys(value, next))
  }
  return out
}

const reference = new Set(collectKeys(en as MessageNode))

describe("messages-ext key parity vs en.json", () => {
  it.each([
    ["ar", ar],
    ["de", de],
    ["es", es],
    ["fr", fr],
    ["ja", ja],
    ["ko", ko],
    ["pt", pt],
    ["zh-CN", zhCN],
    ["zh-TW", zhTW],
  ] as const)("%s has the same key set as en", (_locale, messages) => {
    const localeKeys = new Set(collectKeys(messages as MessageNode))
    const missing = [...reference].filter((k) => !localeKeys.has(k))
    const extra = [...localeKeys].filter((k) => !reference.has(k))
    expect({ missing, extra }).toEqual({ missing: [], extra: [] })
  })
})

const ALL_LOCALES = [
  ["en", en],
  ["ar", ar],
  ["de", de],
  ["es", es],
  ["fr", fr],
  ["ja", ja],
  ["ko", ko],
  ["pt", pt],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
] as const

describe("messages-ext messages are valid ICU", () => {
  it.each(ALL_LOCALES)("%s renders every message", (locale, messages) => {
    const broken: string[] = []
    const t = createTranslator({
      locale,
      messages: messages as Record<string, MessageNode>,
      onError: () => {},
      getMessageFallback: ({ key, error }) => {
        if (error?.code === "INVALID_MESSAGE") broken.push(key)
        return key
      },
    })
    for (const key of collectKeys(messages as MessageNode)) {
      t(
        key as never,
        {
          version: "1.0.0",
          current: "1.0.0",
          count: 1,
          path: "/path",
          source: "git",
          author: "author",
          name: "test",
          percent: 50,
          link: "link",
        } as never
      )
    }
    expect(broken).toEqual([])
  })
})
