import { describe, expect, it, vi } from "vitest"
import { defaultImportFn, loadPluginModule } from "./loader"

describe("loader", () => {
  it("loads a valid ESM plugin module using custom importFn", async () => {
    const code = `export function activate(ctx) {}`
    const mockModule = {
      activate: vi.fn(),
      deactivate: vi.fn(),
    }
    const mockImport = vi.fn().mockResolvedValue(mockModule)

    const mod = await loadPluginModule(code, mockImport)

    expect(mockImport).toHaveBeenCalledTimes(1)
    const passedUrl = mockImport.mock.calls[0][0]
    expect(passedUrl).toMatch(/^blob:/)
    expect(mod).toBe(mockModule)
  })

  it("revokes the Blob URL even if importFn throws", async () => {
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL")
    const mockImport = vi.fn().mockRejectedValue(new Error("Import failed"))

    await expect(loadPluginModule("invalid code", mockImport)).rejects.toThrow(
      "Import failed"
    )

    expect(revokeSpy).toHaveBeenCalled()
    revokeSpy.mockRestore()
  })

  it("throws if imported module is not an object", async () => {
    const mockImport = vi.fn().mockResolvedValue(null)

    await expect(
      loadPluginModule("export default 42", mockImport)
    ).rejects.toThrow("Plugin module must export an object")
  })

  it("defaultImportFn uses new Function to invoke dynamic import", async () => {
    // Test data URL with defaultImportFn
    const dataUrl = "data:text/javascript,export const testVal = 123;"
    const mod = (await defaultImportFn(dataUrl)) as { testVal: number }
    expect(mod.testVal).toBe(123)
  })
})
