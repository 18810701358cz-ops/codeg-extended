/**
 * Codeg Extended Plugin v2 Entrypoint
 * Single-file ESM module (no relative imports).
 */

export function activate(ctx) {
  ctx.logger.info("Sample plugin activated:", ctx.id)

  // Example: register a slot contribution in the right status bar
  ctx.registerSlot("statusbar.right", {
    id: "sample-status-widget",
    order: 100,
    mount(el) {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className =
        "sample-plugin-badge px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground rounded transition-colors"
      btn.textContent = "Sample"
      btn.title = "Sample Plugin Widget"

      const onClick = async () => {
        const config = await ctx.config.get()
        const greeting = (config && config.greeting) || "Hello from Plugin!"
        ctx.notify(greeting, "info")
      }

      btn.addEventListener("click", onClick)
      el.appendChild(btn)

      return () => {
        btn.removeEventListener("click", onClick)
      }
    },
  })

  // Register cleanup when disposed
  ctx.onDispose(() => {
    ctx.logger.info("Sample plugin disposed:", ctx.id)
  })
}

export function deactivate() {
  // Optional: all registered resources are automatically cleaned up by host
}
