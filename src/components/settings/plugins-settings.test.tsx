import type { ReactNode } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PluginsSettings } from "./plugins-settings"
import * as api from "@/lib/plugin-host/api"
import * as platform from "@/lib/platform"
import type { PluginInfo, PluginListResult } from "@/lib/plugin-host/types"

vi.mock("@/lib/plugin-host/api", () => ({
  pluginHostList: vi.fn(),
  pluginHostSetEnabled: vi.fn(),
  pluginHostDisableAll: vi.fn(),
  pluginHostBackendRestart: vi.fn(),
  pluginHostCheckUpdate: vi.fn(),
  pluginHostCommitInstall: vi.fn(),
  subscribePluginHostChanged: vi.fn().mockResolvedValue(() => {}),
  subscribePluginHostBackendStatus: vi.fn().mockResolvedValue(() => {}),
  pluginHostGetConfig: vi
    .fn()
    .mockResolvedValue({ values: {}, secretsSet: [] }),
  pluginHostReadLog: vi.fn().mockResolvedValue(""),
  pluginHostUninstall: vi.fn().mockResolvedValue(null),
  pluginHostSetDevMode: vi.fn().mockResolvedValue(null),
}))

vi.mock("@/lib/platform", () => ({
  isDesktop: vi.fn().mockReturnValue(true),
  openPath: vi.fn(),
  openFileDialog: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}))

// A plain div, so the test can see where the page puts its scroll container;
// the real OverlayScrollbars component wraps its children in elements of its own.
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    className,
  }: {
    children?: ReactNode
    className?: string
  }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      title: "Plugins",
      description: "Manage extensions and plugin runtime",
      pluginsDir: "Plugins directory",
      openDir: "Open directory",
      hostVersion: `Host v${params?.version || ""}`,
      safeModeBadge: "Safe Mode",
      safeModeNotice: "Plugins are disabled because safe mode is active.",
      devMode: "Developer mode",
      refresh: "Refresh",
      disableAll: "Disable All",
      disableAllConfirm: "Are you sure you want to disable all plugins?",
      disableAllSuccess: "All plugins disabled",
      installPlugin: "Install Plugin",
      cssNotice:
        "Plugin styles do not apply to this page. To customize global styles, visit {link}.",
      cssNoticeLink: "Appearance → Custom CSS",
      searchPlaceholder: "Search plugins by name, ID or author...",
      categoryAll: "All",
      categoryAppearance: "Appearance",
      categoryModelProvider: "Model Provider",
      categoryTools: "Tools",
      categoryWorkflow: "Workflow",
      categoryUtility: "Utility",
      emptyPlugins: "No plugins installed",
      noFilteredPlugins: "No plugins match the filter",
      "card.builtin": "Built-in",
      "card.git": "Git",
      "card.upload": "Upload",
      "card.manual": "Manual",
      "card.statusOk": "Running",
      "card.statusInvalid": "Invalid",
      "card.statusIncompatible": "Incompatible",
      "card.statusError": "Error",
      "card.restartBackend": "Restart Backend",
      "card.restartSuccess": "Backend restarted",
      "card.checkUpdate": "Check for Updates",
      "card.upToDate": "Plugin is up to date",
      "card.settings": "Settings",
      "card.issuesTitle": "Issues:",
    }
    return translations[key] || key
  },
}))

describe("PluginsSettings", () => {
  const mockPlugins: PluginInfo[] = [
    {
      id: "builtin-glow",
      name: "Cyber Glow",
      version: "1.0.0",
      description: "A dark glowing appearance plugin",
      author: "Codeg Team",
      category: "appearance",
      permissions: ["ui"],
      enabled: true,
      status: "ok",
      problems: [],
      source: { kind: "builtin" },
      builtin: true,
      hasMain: true,
      styles: [],
      hasBackend: false,
      applied: { modelProviders: {}, mcpServers: {}, quickMessages: {} },
    },
    {
      id: "git-workbuddy",
      name: "WorkBuddy Connect",
      version: "0.9.0",
      description: "Connect to workbuddy backend",
      author: "Community",
      category: "model-provider",
      permissions: ["process", "modelProviders"],
      enabled: false,
      status: "ok",
      problems: [],
      source: {
        kind: "git",
        url: "https://github.com/test/workbuddy",
      },
      builtin: false,
      hasMain: false,
      styles: [],
      hasBackend: true,
      backend: { state: "stopped", restarts: 0 },
      applied: { modelProviders: {}, mcpServers: {}, quickMessages: {} },
    },
  ]

  const mockListResult: PluginListResult = {
    hostVersion: "1.0.0",
    apiVersion: 1,
    pluginsDir: "C:\\Codeg\\plugins",
    safeMode: false,
    devMode: false,
    plugins: mockPlugins,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.pluginHostList).mockResolvedValue(mockListResult)
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ""
  })

  it("fetches and renders plugin list and header information", async () => {
    render(<PluginsSettings />)

    await waitFor(() => {
      expect(api.pluginHostList).toHaveBeenCalled()
      expect(screen.getByText("Cyber Glow")).toBeDefined()
      expect(screen.getByText("WorkBuddy Connect")).toBeDefined()
      expect(screen.getByText("Host v1.0.0")).toBeDefined()
      expect(screen.getByText("C:\\Codeg\\plugins")).toBeDefined()
    })
  })

  it("keeps the whole page inside a full-height scroll area", async () => {
    const { container } = render(<PluginsSettings />)

    await waitFor(() => {
      expect(screen.getByText("Cyber Glow")).toBeDefined()
    })

    // SettingsShell clips what it hosts (`overflow-hidden`), so a page that
    // does not bring its own scroll container cannot be scrolled past the fold.
    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveAttribute("data-testid", "scroll-area")
    expect(root).toHaveClass("h-full")
    expect(root).toContainElement(
      screen.getByRole("heading", { name: "Plugins" })
    )
    expect(root).toContainElement(screen.getByText("WorkBuddy Connect"))
  })

  it("opens plugin directory when Open Directory button is clicked", async () => {
    render(<PluginsSettings />)

    await waitFor(() => {
      expect(screen.getByText("Open directory")).toBeDefined()
    })

    const openDirBtn = screen.getByRole("button", { name: /Open directory/i })
    fireEvent.click(openDirBtn)

    expect(platform.openPath).toHaveBeenCalledWith("C:\\Codeg\\plugins")
  })

  it("filters plugins by search text", async () => {
    render(<PluginsSettings />)

    await waitFor(() => {
      expect(screen.getByText("Cyber Glow")).toBeDefined()
    })

    const searchInput = screen.getByPlaceholderText(
      "Search plugins by name, ID or author..."
    )
    fireEvent.change(searchInput, { target: { value: "workbuddy" } })

    expect(screen.queryByText("Cyber Glow")).toBeNull()
    expect(screen.getByText("WorkBuddy Connect")).toBeDefined()
  })

  it("filters plugins by category tab", async () => {
    render(<PluginsSettings />)

    await waitFor(() => {
      expect(screen.getByText("Cyber Glow")).toBeDefined()
    })

    const modelProviderTab = screen.getByRole("tab", {
      name: "Model Provider",
    })
    fireEvent.click(modelProviderTab)

    expect(screen.queryByText("Cyber Glow")).toBeNull()
    expect(screen.getByText("WorkBuddy Connect")).toBeDefined()
  })

  it("toggles plugin enabled status via switch", async () => {
    const updated = { ...mockPlugins[0], enabled: false }
    vi.mocked(api.pluginHostSetEnabled).mockResolvedValueOnce(updated)

    render(<PluginsSettings />)

    await waitFor(() => {
      expect(screen.getByText("Cyber Glow")).toBeDefined()
    })

    const switchBtn = screen.getByRole("switch", {
      name: "Toggle Cyber Glow",
    })
    fireEvent.click(switchBtn)

    await waitFor(() => {
      expect(api.pluginHostSetEnabled).toHaveBeenCalledWith(
        "builtin-glow",
        false
      )
    })
  })

  it("restarts backend for plugins with hasBackend", async () => {
    vi.mocked(api.pluginHostBackendRestart).mockResolvedValueOnce({
      state: "running",
      restarts: 1,
    })

    render(<PluginsSettings />)

    await waitFor(() => {
      expect(screen.getByText("WorkBuddy Connect")).toBeDefined()
    })

    const restartBtn = screen.getByTitle("Restart Backend")
    fireEvent.click(restartBtn)

    await waitFor(() => {
      expect(api.pluginHostBackendRestart).toHaveBeenCalledWith("git-workbuddy")
    })
  })

  it("checks updates for git plugins", async () => {
    vi.mocked(api.pluginHostCheckUpdate).mockResolvedValueOnce({
      current: "0.9.0",
      latest: "0.9.0",
      updatable: false,
    })

    render(<PluginsSettings />)

    await waitFor(() => {
      expect(screen.getByText("WorkBuddy Connect")).toBeDefined()
    })

    const checkUpdateBtn = screen.getByTitle("Check for Updates")
    fireEvent.click(checkUpdateBtn)

    await waitFor(() => {
      expect(api.pluginHostCheckUpdate).toHaveBeenCalledWith("git-workbuddy")
    })
  })

  it("disables all plugins via Disable All button", async () => {
    vi.mocked(api.pluginHostDisableAll).mockResolvedValueOnce({
      ...mockListResult,
      plugins: mockPlugins.map((p) => ({ ...p, enabled: false })),
    })

    render(<PluginsSettings />)

    await waitFor(() => {
      expect(screen.getByText("Disable All")).toBeDefined()
    })

    const disableAllBtn = screen.getByRole("button", {
      name: "Disable All",
    })
    fireEvent.click(disableAllBtn)

    // Confirm dialog appears
    await waitFor(() => {
      expect(
        screen.getByText("Are you sure you want to disable all plugins?")
      ).toBeDefined()
    })

    const confirmBtn = document.querySelector(
      '[data-slot="alert-dialog-action"]'
    ) as HTMLElement
    expect(confirmBtn).not.toBeNull()
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(api.pluginHostDisableAll).toHaveBeenCalled()
    })
  })

  it("displays safe mode badge and alert when safeMode is true", async () => {
    vi.mocked(api.pluginHostList).mockResolvedValueOnce({
      ...mockListResult,
      safeMode: true,
    })

    render(<PluginsSettings />)

    await waitFor(() => {
      expect(screen.getByText("Safe Mode")).toBeDefined()
      expect(
        screen.getByText("Plugins are disabled because safe mode is active.")
      ).toBeDefined()
    })
  })

  it("toggles developer mode switch and calls pluginHostSetDevMode", async () => {
    vi.mocked(api.pluginHostSetDevMode).mockResolvedValue(null)

    render(<PluginsSettings />)

    await waitFor(() => {
      expect(screen.getByText("Developer mode")).toBeDefined()
    })

    const devModeSwitch = screen.getByRole("switch", {
      name: "Toggle Developer Mode",
    })
    expect(devModeSwitch).toBeDefined()
    expect(devModeSwitch.getAttribute("data-state")).toBe("unchecked")

    fireEvent.click(devModeSwitch)

    await waitFor(() => {
      expect(api.pluginHostSetDevMode).toHaveBeenCalledWith(true)
    })
  })
})
