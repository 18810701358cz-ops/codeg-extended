"use client"

import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import { pluginManager } from "@/lib/plugins/manager"

function isAllowedPluginPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return pathname.startsWith("/workspace") || pathname.startsWith("/settings")
}

export function PluginRuntimeProvider() {
  const nextPathname = usePathname()
  const [windowPath, setWindowPath] = useState(() =>
    typeof window !== "undefined" ? window.location.pathname : ""
  )

  useEffect(() => {
    const handlePopState = () => {
      setWindowPath(window.location.pathname)
    }
    window.addEventListener("popstate", handlePopState)
    return () => {
      window.removeEventListener("popstate", handlePopState)
    }
  }, [])

  const currentPath =
    nextPathname ??
    (typeof window !== "undefined" ? window.location.pathname : windowPath)

  useEffect(() => {
    if (isAllowedPluginPath(currentPath)) {
      pluginManager.boot(false, currentPath)
    } else {
      pluginManager.teardown()
    }
  }, [currentPath])

  return null
}
