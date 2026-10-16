import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { createGlobalCommand, listGlobalCommands } from "@/lib/global-commands"
import type { FolderCommand } from "@/lib/types"
import { CommandManageDialog } from "./command-manage-dialog"

const h = vi.hoisted(() => ({
  desktop: true,
  remote: true,
  platform: "macos",
  hostCommands: [] as unknown[],
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(async () => {}),
  reorder: vi.fn(async () => {}),
}))

vi.mock("@/lib/transport", () => ({
  isDesktop: () => h.desktop,
  isRemoteDesktopMode: () => h.remote,
  getServerBaseUrl: () => "https://devbox.example:3080",
}))
vi.mock("@/hooks/use-platform", () => ({ detectPlatform: () => h.platform }))
vi.mock("@/lib/api", () => ({
  listFolderCommands: vi.fn(async () => h.hostCommands),
  createFolderCommand: h.create,
  updateFolderCommand: h.update,
  deleteFolderCommand: h.remove,
  reorderFolderCommands: h.reorder,
}))

const md = enMessages.Folder.commandDropdown.manageDialog

function hostCommand(id: number, name: string, command: string): FolderCommand {
  return {
    id,
    folder_id: 1,
    name,
    command,
    sort_order: 0,
    created_at: "",
    updated_at: "",
  }
}

function renderDialog() {
  const onChanged = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CommandManageDialog
        open
        onOpenChange={() => {}}
        folderId={1}
        onChanged={onChanged}
      />
    </NextIntlClientProvider>
  )
  return { onChanged }
}

async function startNewCommand(name: string, command: string) {
  fireEvent.click(await screen.findByRole("button", { name: md.newCommand }))
  fireEvent.change(screen.getByLabelText(md.nameLabel), {
    target: { value: name },
  })
  fireEvent.change(screen.getByLabelText(md.commandLabel), {
    target: { value: command },
  })
}

describe("CommandManageDialog", () => {
  // The first render pays for the dialog's UI libraries and the messages'
  // first compile, which can take seconds under a loaded full run. Pay it once
  // here, with time to spare, rather than in whichever test comes first.
  beforeAll(async () => {
    const { unmount } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommandManageDialog
          open
          onOpenChange={() => {}}
          folderId={1}
          onChanged={() => {}}
        />
      </NextIntlClientProvider>
    )
    await screen.findByRole(
      "button",
      { name: md.newCommand },
      { timeout: 10_000 }
    )
    unmount()
  }, 30_000)

  beforeEach(() => {
    localStorage.clear()
    h.desktop = true
    h.remote = true
    h.platform = "macos"
    h.hostCommands = []
    h.create.mockReset()
    h.update.mockReset()
    h.remove.mockReset()
    h.remove.mockImplementation(async () => {})
    h.reorder.mockClear()
  })

  it("lists the host's commands and this computer's, but no impostor", async () => {
    // Global commands have negative ids; the host's database never does.
    h.hostCommands = [
      hostCommand(3, "build", "pnpm build"),
      hostCommand(-1, "impostor", "local: echo x"),
    ]
    createGlobalCommand("mine", "local: echo mine")
    renderDialog()
    expect(await screen.findByText("build")).toBeInTheDocument()
    expect(screen.getByText("mine")).toBeInTheDocument()
    expect(screen.queryByText("impostor")).not.toBeInTheDocument()
  })

  it("warns in a remote window that a folder's local: command won't run here", async () => {
    renderDialog()
    await startNewCommand("zed", "local: zed .")
    expect(screen.getByText(md.localNeedsGlobal)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("switch"))
    expect(screen.queryByText(md.localNeedsGlobal)).not.toBeInTheDocument()
  })

  it("doesn't warn in a local window, whose folders are this computer's", async () => {
    h.remote = false
    renderDialog()
    await startNewCommand("zed", "local: zed .")
    expect(screen.queryByText(md.localNeedsGlobal)).not.toBeInTheDocument()
  })

  it("shows the hint's values as code, spelled for this machine's shell", async () => {
    h.platform = "windows"
    renderDialog()
    const example = await screen.findByText(
      'local: zed "ssh://user@%CODEG_REMOTE_HOST%%CODEG_FOLDER_PATH%"'
    )
    expect(example.tagName).toBe("CODE")
    expect(example).toHaveAttribute("dir", "ltr")
    expect(screen.getByText("%CODEG_FOLDER_PATH%").tagName).toBe("CODE")
  })

  it("spells the hint's variables the POSIX way off Windows", async () => {
    renderDialog()
    expect(
      await screen.findByText(
        'local: zed "ssh://user@$CODEG_REMOTE_HOST$CODEG_FOLDER_PATH"'
      )
    ).toBeInTheDocument()
    expect(screen.getByText("$CODEG_REMOTE_HOST").tagName).toBe("CODE")
  })

  it("leaves out the local-command hint outside the desktop app", async () => {
    h.desktop = false
    h.remote = false
    renderDialog()
    await screen.findByRole("button", { name: md.newCommand })
    expect(screen.queryByText("$CODEG_FOLDER_PATH")).not.toBeInTheDocument()
  })

  it("keeps a command shown in every folder on this computer", async () => {
    const { onChanged } = renderDialog()
    await startNewCommand("zed", "local: zed .")
    fireEvent.click(screen.getByRole("switch"))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(listGlobalCommands().map((c) => [c.name, c.command])).toEqual([
        ["zed", "local: zed ."],
      ])
    )
    expect(h.create).not.toHaveBeenCalled()
    expect(onChanged).toHaveBeenCalled()
  })

  it("moves a folder command to every folder: a copy here first, then the host's goes", async () => {
    h.hostCommands = [hostCommand(3, "zed", "local: zed .")]
    h.remove.mockImplementation(async () => {
      // A failed delete must leave the copy, never neither.
      expect(listGlobalCommands()).toHaveLength(1)
    })
    renderDialog()
    await screen.findByText("zed")
    fireEvent.click(screen.getByRole("switch"))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith(3))
    expect(listGlobalCommands().map((c) => [c.name, c.command])).toEqual([
      ["zed", "local: zed ."],
    ])
  })

  it("refuses a host save that comes back with a global command's id", async () => {
    createGlobalCommand("mine", "pnpm mine")
    h.create.mockResolvedValue(hostCommand(-1, "x", "local: echo injected"))
    renderDialog()
    await screen.findByText("mine")
    await startNewCommand("dev", "pnpm dev")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(
      await screen.findByText(new RegExp(`^${md.saveFailed}: `))
    ).toBeInTheDocument()
    // The form doesn't take the host's entry for this computer's command.
    expect(screen.getByRole("switch")).not.toBeChecked()
    expect(screen.getByLabelText(md.commandLabel)).toHaveValue("pnpm dev")
    expect(listGlobalCommands().map((c) => [c.id, c.command])).toEqual([
      [-1, "pnpm mine"],
    ])
  })
})
