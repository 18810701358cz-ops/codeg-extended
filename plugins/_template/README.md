# Codeg Plugin Template (`_template`)

This template serves as an official starting point for authoring plugins for Codeg Extended (Plugin Host v2).

## Directory Structure

```text
my-plugin/
├── codeg-plugin.json   # Plugin manifest (required)
├── src/                # Multi-file source code (optional, recommended for development)
│   ├── index.ts        # TypeScript entry point
│   └── components/     # UI / helper modules
├── dist/
│   └── index.js        # Built single-file ESM entrypoint (required if "main" is specified)
├── styles/
│   └── style.css       # CSS stylesheet (optional)
└── README.md           # Plugin documentation
```

---

## Quick Start

1. Copy this `_template` folder into your workspace or target repository.
2. Rename the directory to match your plugin `id` (must match `^[a-z0-9][a-z0-9-]{1,63}$`).
3. Update `codeg-plugin.json` with your plugin metadata, permissions, contributes declarations, and configuration schema.
4. Implement your plugin lifecycle hooks (`activate`, `deactivate`) in `src/index.ts` or directly in `dist/index.js`.
5. Build and bundle your source code into `dist/index.js`.
6. Package as a zip archive or publish to a Git repository, then install via the Plugin Center in Codeg Extended.

---

## Building with esbuild (Single-File Zero-Dependency ESM)

Codeg Extended executes plugin frontend entries as native Browser ES Modules via Blob URL isolation (`type="module"`).
To ensure compatibility across desktop and web environments:
- **Single-File Bundling**: Multi-file TypeScript, JavaScript, or JSX source code must be compiled into a single self-contained output file at `dist/index.js`.
- **Zero Bare Imports**: Do not leave external bare specifier imports (e.g. `import React from 'react'`) in `dist/index.js`. All dependencies and helpers must be bundled inline, or DOM manipulation should be written using standard native Web APIs (`document.createElement`, `innerHTML`, etc.).

### 1. One-Click Build Command

Using `npx esbuild` (no configuration file needed):

```bash
npx esbuild src/index.ts --bundle --format=esm --outfile=dist/index.js
```

For minified production builds:

```bash
npx esbuild src/index.ts --bundle --format=esm --minify --outfile=dist/index.js
```

### 2. Developer Watch Mode (Hot Reload)

When Developer Mode is enabled in Codeg Extended settings, the plugin host automatically monitors `~/.codeg/plugins/` for file changes with ~300ms debouncing and reloads active plugins instantly.

Run esbuild in watch mode to automatically recompile on save:

```bash
npx esbuild src/index.ts --bundle --format=esm --outfile=dist/index.js --watch
```

Saving any file in `src/` triggers an immediate re-bundle into `dist/index.js`, which the Codeg Developer Mode watcher detects and live-updates in the running application.

---

## Plugin Lifecycle Example (`src/index.ts`)

```typescript
export function activate(ctx: any) {
  ctx.logger.info("Plugin activated:", ctx.id);

  // Injected CSS
  ctx.injectCSS(`
    .my-custom-widget {
      display: inline-flex;
      align-items: center;
      padding: 2px 6px;
      font-size: 11px;
    }
  `);

  // Register a statusbar slot widget
  ctx.registerSlot("statusbar.right", {
    id: "my-status-indicator",
    order: 10,
    mount(container: HTMLElement) {
      const el = document.createElement("span");
      el.className = "my-custom-widget text-muted-foreground";
      el.textContent = "My Plugin Active";
      container.appendChild(el);

      return () => {
        el.remove();
      };
    },
  });
}

export function deactivate() {
  // Global teardown if necessary (slot widgets & injected CSS are automatically cleaned up)
}
```

---

## Documentation & References

- [Manifest Specification (清单规范)](../../docs/plugin-host/manifest-spec.md)
- [Plugin Development Guide (开发实战指南)](../../docs/plugin-host/plugin-development-guide.md)
- [Plugin SDK & API Reference (SDK 参考规范)](../../docs/plugin-host/sdk.md)
- [JSON Schema Specification (清单模式校验)](../../docs/plugin-host/codeg-plugin.schema.json)
- [Plugins Repository (插件库列表)](../README.md)
