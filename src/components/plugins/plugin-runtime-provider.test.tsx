import React from "react"
import { render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const nav = vi.hoisted(() => ({ pathname: "/" }))

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
}))

import { pluginManager } from "@/lib/plugins/manager"
import { PluginRuntimeProvider } from "./plugin-runtime-provider"

describe("PluginRuntimeProvider", () => {
  beforeEach(() => {
    nav.pathname = "/"
    window.history.replaceState(null, "", "/")
    localStorage.clear()
    localStorage.setItem(
      "codeg_plugins_enabled_v1",
      JSON.stringify({ "dsh-cyber-glow": true, "dsh-quick-actions": true })
    )
    // Clean up any injected styles or elements
    const style = document.getElementById("plugin-dsh-cyber-glow")
    if (style) style.remove()
    const pill = document.getElementById("dsh-floating-pill")
    if (pill) pill.remove()
    // Reset manager booted state if possible
    if (
      "teardown" in pluginManager &&
      typeof pluginManager.teardown === "function"
    ) {
      ;(pluginManager as unknown as { teardown: () => void }).teardown()
    } else {
      ;(pluginManager as unknown as { booted: boolean }).booted = false
    }
  })

  afterEach(() => {
    const style = document.getElementById("plugin-dsh-cyber-glow")
    if (style) style.remove()
    const pill = document.getElementById("dsh-floating-pill")
    if (pill) pill.remove()
    if (
      "teardown" in pluginManager &&
      typeof pluginManager.teardown === "function"
    ) {
      ;(pluginManager as unknown as { teardown: () => void }).teardown()
    } else {
      ;(pluginManager as unknown as { booted: boolean }).booted = false
    }
  })

  it("does not boot on / or /login and boots when navigating to /workspace", () => {
    nav.pathname = "/"
    window.history.replaceState(null, "", "/")
    const { rerender } = render(<PluginRuntimeProvider />)

    // On /, plugins must not be booted
    expect(document.getElementById("plugin-dsh-cyber-glow")).toBeNull()

    // Navigate to /workspace
    nav.pathname = "/workspace"
    window.history.replaceState(null, "", "/workspace")
    rerender(<PluginRuntimeProvider />)

    // On /workspace, enabled plugin styles and elements should be present
    expect(document.getElementById("plugin-dsh-cyber-glow")).not.toBeNull()
    expect(document.getElementById("dsh-floating-pill")).not.toBeNull()
  })

  it("does not activate plugins on pet or computer marker floating windows", () => {
    nav.pathname = "/pet"
    window.history.replaceState(null, "", "/pet")
    render(<PluginRuntimeProvider />)

    expect(document.getElementById("plugin-dsh-cyber-glow")).toBeNull()
    expect(document.getElementById("dsh-floating-pill")).toBeNull()

    nav.pathname = "/computer-marker"
    window.history.replaceState(null, "", "/computer-marker")
    render(<PluginRuntimeProvider />)

    expect(document.getElementById("plugin-dsh-cyber-glow")).toBeNull()
    expect(document.getElementById("dsh-floating-pill")).toBeNull()
  })

  it("cleans up active plugins when navigating away from allowed routes", () => {
    nav.pathname = "/workspace"
    window.history.replaceState(null, "", "/workspace")
    const { rerender } = render(<PluginRuntimeProvider />)

    expect(document.getElementById("plugin-dsh-cyber-glow")).not.toBeNull()
    expect(document.getElementById("dsh-floating-pill")).not.toBeNull()

    // Navigate to /login or /pet
    nav.pathname = "/login"
    window.history.replaceState(null, "", "/login")
    rerender(<PluginRuntimeProvider />)

    expect(document.getElementById("plugin-dsh-cyber-glow")).toBeNull()
    expect(document.getElementById("dsh-floating-pill")).toBeNull()

    // Persistent storage must not be modified by route cleanup!
    const saved = JSON.parse(
      localStorage.getItem("codeg_plugins_enabled_v1") || "{}"
    )
    expect(saved["dsh-cyber-glow"]).toBe(true)
  })

  it("does not duplicate execution on same route repeated render or StrictMode", () => {
    nav.pathname = "/workspace"
    window.history.replaceState(null, "", "/workspace")
    const { rerender } = render(
      <React.StrictMode>
        <PluginRuntimeProvider />
      </React.StrictMode>
    )

    rerender(
      <React.StrictMode>
        <PluginRuntimeProvider />
      </React.StrictMode>
    )

    const styles = document.querySelectorAll("#plugin-dsh-cyber-glow")
    expect(styles.length).toBe(1)
    const pills = document.querySelectorAll("#dsh-floating-pill")
    expect(pills.length).toBe(1)
  })
})
