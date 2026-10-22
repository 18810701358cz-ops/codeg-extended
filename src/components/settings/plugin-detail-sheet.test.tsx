import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PluginDetailSheet } from "./plugin-detail-sheet"
import * as api from "@/lib/plugin-host/api"
import type { PluginInfo } from "@/lib/plugin-host/types"

vi.mock("@/lib/plugin-host/api", () => ({
  pluginHostGetConfig: vi.fn(),
  pluginHostReadLog: vi.fn(),
  pluginHostUninstall: vi.fn(),
  pluginHostSetConfig: vi.fn(),
}))

vi.mock("@/components/plugin-host/plugin-slot", () => ({
  PluginSlot: () => <div data-testid="mock-plugin-slot">Mock Plugin Slot</div>,
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      title: "Plugin Details",
      tabConfig: "Configuration",
      tabContributions: "Contributions",
      tabLogs: "Logs",
      noConfig: "This plugin does not provide configuration options.",
      noContributions: "No contributions registered by this plugin.",
      modelProviders: "Model Providers",
      mcpServers: "MCP Servers",
      quickMessages: "Quick Messages",
      refreshLogs: "Refresh Logs",
      loadingLogs: "Loading logs...",
      noLogs: "No logs recorded yet.",
      uninstall: "Uninstall",
      uninstallConfirmTitle: "Uninstall Plugin",
      uninstallConfirmDesc: `Are you sure you want to uninstall ${params?.name}?`,
      removeContributionsLabel: "Also remove contributions",
      uninstalling: "Uninstalling...",
      uninstallSuccess: "Plugin uninstalled successfully",
      save: "Save Configuration",
      saving: "Saving...",
      saveSuccess: "Configuration saved",
      secretConfigured: "Configured",
      secretUpdatePlaceholder: "Enter new secret",
      secretClear: "Clear",
      secretWillClear: "Will be cleared",
      required: "Required",
    }
    return translations[key] || key
  },
}))

describe("PluginDetailSheet", () => {
  const mockPlugin: PluginInfo = {
    id: "test-plugin",
    name: "Test Plugin",
    version: "2.1.0",
    description: "Detailed test plugin",
    author: "Jane Doe",
    permissions: ["ui", "process"],
    enabled: true,
    status: "ok",
    problems: [],
    source: { kind: "git", url: "https://github.com/test/plugin" },
    builtin: false,
    hasMain: true,
    styles: [],
    hasBackend: true,
    applied: {
      modelProviders: { "test-provider": [1, 2] },
      mcpServers: { "test-mcp": ["tool_a", "tool_b"] },
      quickMessages: {},
    },
    configSchema: {
      type: "object",
      properties: {
        serverPort: {
          type: "integer",
          title: "Server Port",
          default: 8080,
        },
      },
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.pluginHostGetConfig).mockResolvedValue({
      values: { serverPort: 9000 },
      secretsSet: [],
    })
    vi.mocked(api.pluginHostReadLog).mockResolvedValue("Log line 1\nLog line 2")
    vi.mocked(api.pluginHostUninstall).mockResolvedValue(null)
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ""
  })

  it("renders plugin header and configuration form", async () => {
    render(
      <PluginDetailSheet
        plugin={mockPlugin}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getByText("Test Plugin")).toBeDefined()
    expect(screen.getByText("v2.1.0")).toBeDefined()
    expect(screen.getByText(/By Jane Doe/i)).toBeDefined()
    expect(screen.getByTestId("mock-plugin-slot")).toBeDefined()

    await waitFor(() => {
      expect(api.pluginHostGetConfig).toHaveBeenCalledWith("test-plugin")
      expect(screen.getByLabelText(/Server Port/i)).toBeDefined()
    })
  })

  it("scrolls the plugin widget region instead of letting it crowd out the tabs", () => {
    render(
      <PluginDetailSheet
        plugin={mockPlugin}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    // A plugin decides how tall what it mounts here is (WorkBuddy lists every
    // model it serves), and the drawer body does not scroll: left unbounded, the
    // region pushes the tabs down to no height and the drawer clips both.
    const region = screen.getByTestId("mock-plugin-slot").parentElement
    expect(region).toHaveClass("max-h-[40dvh]", "overflow-y-auto", "shrink-0")
  })

  it("renders applied contributions tab", async () => {
    render(
      <PluginDetailSheet
        plugin={mockPlugin}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    const contribTab = screen.getByRole("tab", { name: /Contributions/i })
    fireEvent.click(contribTab)

    expect(screen.getByText("Model Providers")).toBeDefined()
    expect(screen.getByText("test-provider")).toBeDefined()
    expect(screen.getByText("MCP Servers")).toBeDefined()
    expect(screen.getByText("test-mcp")).toBeDefined()
  })

  it("renders logs tab and calls readLog", async () => {
    render(
      <PluginDetailSheet
        plugin={mockPlugin}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    const logsTab = screen.getByRole("tab", { name: /Logs/i })
    fireEvent.click(logsTab)

    await waitFor(() => {
      expect(api.pluginHostReadLog).toHaveBeenCalledWith("test-plugin", 50000)
      expect(screen.getByText(/Log line 1/)).toBeDefined()
    })
  })

  it("opens uninstall dialog and confirms uninstallation with contributions checkbox", async () => {
    const onUninstalled = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <PluginDetailSheet
        plugin={mockPlugin}
        open={true}
        onOpenChange={onOpenChange}
        onUninstalled={onUninstalled}
      />
    )

    const uninstallBtn = screen.getByRole("button", { name: "Uninstall" })
    fireEvent.click(uninstallBtn)

    await waitFor(() => {
      expect(screen.getByText("Uninstall Plugin")).toBeDefined()
      expect(
        screen.getByText("Are you sure you want to uninstall Test Plugin?")
      ).toBeDefined()
      expect(screen.getByText("Also remove contributions")).toBeDefined()
    })

    // Find the action button with data-slot="alert-dialog-action"
    const actionBtn = document.querySelector(
      '[data-slot="alert-dialog-action"]'
    ) as HTMLElement
    expect(actionBtn).not.toBeNull()
    fireEvent.click(actionBtn)

    await waitFor(() => {
      expect(api.pluginHostUninstall).toHaveBeenCalledWith("test-plugin", true)
      expect(onUninstalled).toHaveBeenCalledWith("test-plugin")
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })
})
