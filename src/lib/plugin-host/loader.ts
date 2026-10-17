import type { PluginContext } from "./types"

export interface PluginModule {
  activate?: (ctx: PluginContext) => void | Promise<void>
  deactivate?: () => void | Promise<void>
  [key: string]: unknown
}

export type ImportFn = (url: string) => Promise<unknown>

/**
 * Default ESM import function that bypasses bundler static analysis
 * (Webpack / Turbopack) by using `new Function`.
 * When bundlers analyze `import(/* webpackIgnore: true *\/ ...)`, Turbopack
 * may reject or fail to resolve dynamic expressions. `new Function` ensures
 * native browser ESM dynamic import execution on Blob / data URLs.
 */
export const defaultImportFn: ImportFn = async (url: string) => {
  try {
    const dynamicImport = new Function("u", "return import(u)") as (
      u: string
    ) => Promise<unknown>
    return await dynamicImport(url)
  } catch {
    return await import(/* webpackIgnore: true */ url)
  }
}

/**
 * Loads a plugin ESM entry from raw JavaScript source code.
 * Creates an ephemeral Blob URL, imports the module, and revokes the URL.
 *
 * @param code The ESM JavaScript source code
 * @param importFn Optional custom dynamic import function (useful for tests)
 * @returns The imported PluginModule
 */
export async function loadPluginModule(
  code: string,
  importFn: ImportFn = defaultImportFn
): Promise<PluginModule> {
  const blob = new Blob([code], { type: "text/javascript" })
  const blobUrl = URL.createObjectURL(blob)

  try {
    const mod = await importFn(blobUrl)
    if (typeof mod !== "object" || mod === null) {
      throw new Error("Plugin module must export an object")
    }
    return mod as PluginModule
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}
