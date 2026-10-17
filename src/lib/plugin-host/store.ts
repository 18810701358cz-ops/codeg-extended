import { create } from "zustand"
import {
  PLUGIN_HOST_API_VERSION,
  PLUGIN_HOST_VERSION,
  type BackendStatus,
  type PluginInfo,
  type PluginListResult,
} from "./types"

export interface PluginRuntimeState {
  active: boolean
  error?: string
  loading?: boolean
}

export interface PluginHostStoreState {
  hostVersion: string
  apiVersion: number
  pluginsDir: string
  safeMode: boolean
  devMode: boolean
  plugins: PluginInfo[]
  booted: boolean
  loading: boolean
  runtimeStates: Record<string, PluginRuntimeState>

  setListResult: (res: PluginListResult) => void
  updatePlugin: (plugin: PluginInfo) => void
  setPluginRuntimeState: (
    id: string,
    state: Partial<PluginRuntimeState>
  ) => void
  updateBackendStatus: (id: string, status: BackendStatus) => void
  setBooted: (booted: boolean) => void
  setLoading: (loading: boolean) => void
  reset: () => void
}

const initialState = {
  hostVersion: PLUGIN_HOST_VERSION,
  apiVersion: PLUGIN_HOST_API_VERSION,
  pluginsDir: "",
  safeMode: false,
  devMode: false,
  plugins: [] as PluginInfo[],
  booted: false,
  loading: false,
  runtimeStates: {} as Record<string, PluginRuntimeState>,
}

export const usePluginHostStore = create<PluginHostStoreState>((set) => ({
  ...initialState,

  setListResult: (res) =>
    set((state) => {
      // Sync runtime states for plugins in the list
      const nextRuntime = { ...state.runtimeStates }
      for (const p of res.plugins) {
        if (!nextRuntime[p.id]) {
          nextRuntime[p.id] = { active: false }
        }
      }
      return {
        hostVersion: res.hostVersion,
        apiVersion: res.apiVersion,
        pluginsDir: res.pluginsDir,
        safeMode: res.safeMode,
        devMode: res.devMode,
        plugins: res.plugins,
        runtimeStates: nextRuntime,
      }
    }),

  updatePlugin: (plugin) =>
    set((state) => ({
      plugins: state.plugins.some((p) => p.id === plugin.id)
        ? state.plugins.map((p) => (p.id === plugin.id ? plugin : p))
        : [...state.plugins, plugin],
    })),

  setPluginRuntimeState: (id, patch) =>
    set((state) => {
      const prev = state.runtimeStates[id] ?? { active: false }
      return {
        runtimeStates: {
          ...state.runtimeStates,
          [id]: { ...prev, ...patch },
        },
      }
    }),

  updateBackendStatus: (id, status) =>
    set((state) => ({
      plugins: state.plugins.map((p) =>
        p.id === id ? { ...p, backend: status } : p
      ),
    })),

  setBooted: (booted) => set({ booted }),
  setLoading: (loading) => set({ loading }),
  reset: () => set(initialState),
}))
