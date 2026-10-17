import { act } from "react"
import { renderToString } from "react-dom/server"
import { hydrateRoot } from "react-dom/client"
import { fireEvent, render, screen } from "@testing-library/react"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { pluginManager } from "@/lib/plugins/manager"
import { PluginsSettings } from "./plugins-settings"

describe("PluginsSettings Hydration and State Sync", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
    const customStyle = document.getElementById("custom-user-theme")
    if (customStyle) customStyle.remove()
    vi.restoreAllMocks()
  })

  it("hydrates without hydration errors when a plugin was previously enabled", async () => {
    // 1. Simulate SSR render: server-side environment where isPluginEnabled returns false
    vi.spyOn(pluginManager, "isPluginEnabled").mockReturnValue(false)
    const ssrHtml = renderToString(<PluginsSettings />)
    vi.restoreAllMocks()

    // 2. Client environment: plugin is enabled in localStorage
    localStorage.setItem(
      "codeg_plugins_enabled_v1",
      JSON.stringify({ "dsh-cyber-glow": true })
    )

    const container = document.createElement("div")
    document.body.appendChild(container)
    container.innerHTML = ssrHtml

    const recoverableErrors: Error[] = []
    let root: ReturnType<typeof hydrateRoot> | null = null

    await act(async () => {
      root = hydrateRoot(container, <PluginsSettings />, {
        onRecoverableError(error) {
          recoverableErrors.push(error as Error)
        },
      })
      // Flush microtasks and mount effects
      await Promise.resolve()
    })

    // Expect NO hydration mismatch errors
    const hydrationErrors = recoverableErrors.filter((e) =>
      /hydration/i.test(e.message)
    )
    expect(hydrationErrors).toHaveLength(0)

    // And after mount, the enabled plugin status is correctly reflected
    const glowCard = container.textContent || ""
    expect(glowCard).toContain("DSH Cyber Glow")
    const switchEl = container.querySelector(
      'button[role="switch"]'
    ) as HTMLButtonElement | null
    expect(switchEl).not.toBeNull()
    expect(switchEl?.getAttribute("data-state")).toBe("checked")

    act(() => {
      root?.unmount()
    })
    container.remove()
  })

  it("renders with accurate enabled/running state after mount", async () => {
    localStorage.setItem(
      "codeg_plugins_enabled_v1",
      JSON.stringify({ "dsh-cyber-glow": true })
    )

    render(<PluginsSettings />)

    const switches = screen.getAllByRole("switch")
    // First switch is dsh-cyber-glow
    expect(switches[0].getAttribute("data-state")).toBe("checked")
  })

  it("removes custom-user-theme style and closes dialog when applying empty CSS", () => {
    const existingStyle = document.createElement("style")
    existingStyle.id = "custom-user-theme"
    existingStyle.textContent = "body { background: red; }"
    document.head.appendChild(existingStyle)
    expect(document.getElementById("custom-user-theme")).not.toBeNull()

    const toastInfoSpy = vi.spyOn(toast, "info")

    render(<PluginsSettings />)

    // Open quick CSS dialog
    const openBtn = screen.getByRole("button", { name: /快速写 CSS 修饰 UI/i })
    fireEvent.click(openBtn)

    expect(screen.getByText(/快速界面修饰器/i)).toBeDefined()

    // Clear textarea input
    const textarea =
      screen.getByPlaceholderText(/例如：修改侧边栏背景为磨砂黑/i)
    fireEvent.change(textarea, { target: { value: "" } })

    // Click apply
    const applyBtn = screen.getByRole("button", { name: "应用并即时生效" })
    fireEvent.click(applyBtn)

    // Assert style is deleted
    expect(document.getElementById("custom-user-theme")).toBeNull()

    // Assert dialog closed normally
    expect(screen.queryByText(/快速界面修饰器/i)).toBeNull()
    expect(toastInfoSpy).toHaveBeenCalledWith("已清空自定义样式")
  })
})
