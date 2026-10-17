import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PluginInstallDialog } from "./plugin-install-dialog"
import * as api from "@/lib/plugin-host/api"
import * as platform from "@/lib/platform"
import type { StageResult, PluginInfo } from "@/lib/plugin-host/types"

vi.mock("@/lib/plugin-host/api", () => ({
  pluginHostParseRepoUrl: vi.fn(),
  pluginHostStage: vi.fn(),
  pluginHostCommitInstall: vi.fn(),
  pluginHostDiscardStaging: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  isDesktop: vi.fn(),
  openFileDialog: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  getCodegToken: vi.fn().mockReturnValue("mock-token"),
  notifyWebUnauthorized: vi.fn(),
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      title: "Install Plugin",
      tabGit: "Git Repository",
      tabUpload: "Upload",
      repoUrlLabel: "Repository URL",
      repoUrlPlaceholder: "https://github.com/owner/repo or tree link",
      refLabel: "Branch / Tag / Commit",
      refPlaceholder: "Optional",
      subdirLabel: "Subdirectory",
      subdirPlaceholder: "Optional",
      stageBtn: "Preview & Verify",
      staging: "Verifying...",
      uploadZipDesktop: "Choose ZIP File",
      uploadFolderDesktop: "Choose Folder",
      uploadWeb: "Upload ZIP Archive",
      dragDrop: "Click or drag a ZIP file here to upload",
      previewTitle: "Plugin Preview",
      permissions: "Permissions requested:",
      permUi: "UI Modification",
      permProcess: "Background Process",
      permModelProviders: "Model Providers",
      permMcp: "MCP Servers",
      permQuickMessages: "Quick Messages",
      permNetwork: "Network Access",
      hasBackend: "Includes background process",
      hasMain: "Includes UI script",
      contributions: "Contributions:",
      contribProviders: `${params?.count || 0} Model Provider(s)`,
      contribMcp: `${params?.count || 0} MCP Server(s)`,
      contribQuickMessages: `${params?.count || 0} Quick Message(s)`,
      isUpgrade: `Upgrade existing version ${params?.current} to ${params?.version}`,
      installBtn: "Install",
      upgradeBtn: "Upgrade",
      installing: "Installing...",
      installSuccess: "Plugin installed successfully",
      close: "Close",
      cancel: "Cancel",
      discard: "Discard",
    }
    return translations[key] || key
  },
}))

describe("PluginInstallDialog", () => {
  const mockStageResult: StageResult = {
    stagingId: "stage-123",
    preview: {
      id: "sample-plugin",
      name: "Sample Plugin",
      version: "1.2.0",
      description: "A great sample plugin",
      author: "Test Author",
      permissions: ["ui", "process"],
      hasBackend: true,
      hasMain: true,
      contributes: {
        modelProviders: 1,
        mcpServers: 0,
        quickMessages: 2,
      },
      isUpgrade: false,
      problems: [],
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(platform.isDesktop).mockReturnValue(true)
    vi.mocked(api.pluginHostDiscardStaging).mockResolvedValue(null)
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ""
  })

  it("stages and installs from Git repository", async () => {
    vi.mocked(api.pluginHostParseRepoUrl).mockResolvedValueOnce({
      url: "https://github.com/test/repo",
      ref: "main",
      subdir: "plugins/test",
    })
    vi.mocked(api.pluginHostStage).mockResolvedValueOnce(mockStageResult)
    vi.mocked(api.pluginHostCommitInstall).mockResolvedValueOnce({
      id: "sample-plugin",
      name: "Sample Plugin",
      version: "1.2.0",
    } as PluginInfo)

    const onInstalled = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <PluginInstallDialog
        open={true}
        onOpenChange={onOpenChange}
        onInstalled={onInstalled}
      />
    )

    // Fill Git repo URL and trigger blur for auto-parsing
    const urlInput = screen.getByPlaceholderText(/https:\/\/github.com/i)
    fireEvent.change(urlInput, {
      target: {
        value: "https://github.com/test/repo/tree/main/plugins/test",
      },
    })
    fireEvent.blur(urlInput)

    await waitFor(() => {
      expect(api.pluginHostParseRepoUrl).toHaveBeenCalled()
    })

    // Click Preview & Verify
    const stageBtn = screen.getByRole("button", { name: "Preview & Verify" })
    fireEvent.click(stageBtn)

    await waitFor(() => {
      expect(api.pluginHostStage).toHaveBeenCalledWith({
        kind: "git",
        url: "https://github.com/test/repo",
        ref: "main",
        subdir: "plugins/test",
      })
      // Preview should now be shown
      expect(screen.getByText("Sample Plugin")).toBeDefined()
      expect(screen.getByText("UI Modification")).toBeDefined()
      expect(screen.getByText("Includes background process")).toBeDefined()
    })

    // Click Install
    const installBtn = screen.getByRole("button", { name: "Install" })
    fireEvent.click(installBtn)

    await waitFor(() => {
      expect(api.pluginHostCommitInstall).toHaveBeenCalledWith("stage-123")
      expect(onInstalled).toHaveBeenCalled()
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it("stages and installs from Desktop file picker", async () => {
    vi.mocked(platform.isDesktop).mockReturnValue(true)
    vi.mocked(platform.openFileDialog).mockResolvedValueOnce(
      "C:\\downloads\\plugin.zip"
    )
    vi.mocked(api.pluginHostStage).mockResolvedValueOnce(mockStageResult)
    vi.mocked(api.pluginHostCommitInstall).mockResolvedValueOnce({
      id: "sample-plugin",
    } as PluginInfo)

    render(<PluginInstallDialog open={true} onOpenChange={vi.fn()} />)

    // Switch to Upload tab using pointerDown
    const uploadTab = screen.getByRole("tab", { name: "Upload" })
    fireEvent.pointerDown(uploadTab, { button: 0 })
    fireEvent.click(uploadTab)

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Choose ZIP File" })
      ).toBeDefined()
    })

    // Click Choose ZIP File
    const chooseZipBtn = screen.getByRole("button", {
      name: "Choose ZIP File",
    })
    fireEvent.click(chooseZipBtn)

    await waitFor(() => {
      expect(platform.openFileDialog).toHaveBeenCalledWith({
        directory: false,
        title: "Choose ZIP File",
      })
      expect(api.pluginHostStage).toHaveBeenCalledWith({
        kind: "path",
        path: "C:\\downloads\\plugin.zip",
      })
    })

    // Preview rendered
    expect(screen.getByText("Sample Plugin")).toBeDefined()

    // Can discard staging
    const discardBtn = screen.getByRole("button", { name: "Discard" })
    fireEvent.click(discardBtn)

    await waitFor(() => {
      expect(api.pluginHostDiscardStaging).toHaveBeenCalledWith("stage-123")
    })
  })

  it("disables install button if problems are detected", async () => {
    const problematicStageResult: StageResult = {
      stagingId: "stage-err",
      preview: {
        ...mockStageResult.preview,
        name: "Problematic Plugin",
        problems: ["Manifest engines incompatible: requires host >= 2.0.0"],
      },
    }

    vi.mocked(api.pluginHostStage).mockResolvedValueOnce(problematicStageResult)

    render(<PluginInstallDialog open={true} onOpenChange={vi.fn()} />)

    const urlInput = screen.getByPlaceholderText(/https:\/\/github.com/i)
    fireEvent.change(urlInput, {
      target: { value: "https://github.com/test/repo" },
    })

    const stageBtn = screen.getByRole("button", { name: "Preview & Verify" })
    fireEvent.click(stageBtn)

    await waitFor(() => {
      expect(
        screen.getByText(
          "Manifest engines incompatible: requires host >= 2.0.0"
        )
      ).toBeDefined()
    })

    const installBtn = screen.getByRole("button", { name: "Install" })
    expect(installBtn.hasAttribute("disabled")).toBe(true)
  })
})
