import { Suspense } from "react"
import { SettingsShell } from "@/components/settings/settings-shell"
import { RemoteConnectionGate } from "@/contexts/remote-connection-context"
import { UpdateProvider } from "@/components/providers/update-provider"
// [codeg-extended] plugin host declarative styles for settings
import { PluginStyles } from "@/components/plugin-host/plugin-styles"

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <Suspense>
      <RemoteConnectionGate>
        <UpdateProvider>
          {/* [codeg-extended] plugin host declarative styles */}
          <PluginStyles />
          <SettingsShell>{children}</SettingsShell>
        </UpdateProvider>
      </RemoteConnectionGate>
    </Suspense>
  )
}
