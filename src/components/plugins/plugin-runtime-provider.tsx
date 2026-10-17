"use client"

import { useEffect } from "react"
import { pluginManager } from "@/lib/plugins/manager"

export function PluginRuntimeProvider() {
  useEffect(() => {
    // 页面挂载时初始化并启动所有启用的 DSH 插件
    pluginManager.boot()
  }, [])

  return null
}
