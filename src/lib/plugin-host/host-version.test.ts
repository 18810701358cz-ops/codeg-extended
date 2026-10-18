import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { PLUGIN_HOST_VERSION } from "./types"

describe("PLUGIN_HOST_VERSION", () => {
  it("matches the Rust constant the manifest validator compares against", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src-tauri/src/plugin_host/mod.rs"),
      "utf8"
    )
    const match = /pub const PLUGIN_HOST_VERSION: &str = "([^"]+)"/.exec(source)

    expect(match?.[1]).toBe(PLUGIN_HOST_VERSION)
  })
})
