export function activate(ctx) {
  ctx.registerSlot("statusbar.right", {
    id: "quick-actions-trigger",
    order: 100,
    mount(el) {
      const button = document.createElement("button")
      button.type = "button"
      button.className =
        "flex items-center gap-1.5 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded transition-colors"
      button.title = "DSH Quick Actions"
      button.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg><span>DSH</span>'

      const handleClick = () => {
        ctx.notify("DSH Quick Actions: system ready", "info")
      }

      button.addEventListener("click", handleClick)
      el.appendChild(button)

      return () => {
        button.removeEventListener("click", handleClick)
      }
    },
  })
}

export function deactivate() {
  // Disposed automatically via PluginContext
}
