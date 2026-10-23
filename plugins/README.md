# Codeg Extended Plugins

Welcome to the Codeg Extended plugin repository. This directory contains official and community plugins for the **Codeg Plugin Host v2** architecture.

---

## 📦 Repository Plugins

| Directory | Plugin ID | Category | Description | Documentation |
|---|---|---|---|---|
| [`workbuddy-connect/`](./workbuddy-connect) | `workbuddy-connect` | `model-provider` | Integrates authenticated WorkBuddy local/remote AI models into Codeg as a model provider. | [README](./workbuddy-connect/README.md) |
| [`prompt-pack/`](./prompt-pack) | `prompt-pack` | `workflow` | Contributes a curated set of developer prompts to Codeg's Quick Messages. | [README](./prompt-pack/README.md) |
| [`token-meter/`](./token-meter) | `token-meter` | `utility` | Shows the live output speed and the conversation's total tokens in the status bar. | [README](./token-meter/README.md) |
| [`_template/`](./_template) | `sample-plugin` | `utility` | Starter template containing manifest, ESM entrypoint, CSS styling, and documentation. | [README](./_template/README.md) |

---

## 🎨 Built-in Plugins

In addition to repository plugins, Codeg Extended bundles three built-in UI and widget plugins directly into the application binary (located in `src-tauri/builtin-plugins/`):

1. **`dsh-cyber-glow`**: DeepSeek Harness-inspired translucent dark neon glow theme.
2. **`dsh-compact-layout`**: High information density layout tuning conversation transcript and card dimensions.
3. **`dsh-quick-actions`**: Status bar right-slot action widget.

All built-in plugins are disabled by default and can be enabled individually in **Settings -> Plugins (偏好设置 -> 插件中心)**.

---

## 📂 Plugin Structure (v2)

Each plugin resides in a dedicated directory named after its plugin `id` (matching `^[a-z0-9][a-z0-9-]{1,63}$`):

```text
<plugin-id>/
├── codeg-plugin.json   # Plugin manifest (required)
├── src/                # Multi-file source code (TypeScript / React)
│   └── index.ts
├── dist/               # Bundled frontend ESM artifacts
│   └── index.js        # Entrypoint (required if main is specified)
├── styles/             # Stylesheets (optional)
│   └── style.css
├── backend/            # Backend service scripts/binaries (optional)
│   ├── server.py
│   └── requirements.txt
└── README.md           # Plugin documentation
```

---

## 🚀 Installing Plugins

Plugins can be installed in Codeg Extended via:
1. **Git Repository**: Enter a GitHub repository URL or deep-link (e.g. `https://github.com/18810701358cz-ops/codeg-extended/tree/main/plugins/workbuddy-connect`).
2. **Zip Upload**: Upload a zipped plugin directory containing `codeg-plugin.json` at root.
3. **Local Directory**: Place the plugin directory in the host's plugins data directory (`~/.codeg/plugins/`).

---

## 🛠️ Developer Mode & Hot Reload

When Developer Mode is enabled in Settings -> Plugins:
- The host backend automatically monitors `~/.codeg/plugins/` using Rust `notify` with ~300ms trailing debounce.
- Non-plugin directories (`.deps`, `.trash`, `.staging`, `node_modules`, `.git`) are automatically excluded.
- Saving changes to `dist/index.js` triggers instant hot reload without restarting Codeg.

Bundling with `esbuild`:
```bash
npx esbuild src/index.ts --bundle --format=esm --outfile=dist/index.js --watch
```

---

## 📚 Documentation & Specifications

- [Architecture & Manifest Specification](../docs/plugin-host/manifest-spec.md)
- [Plugin Development Guide](../docs/plugin-host/plugin-development-guide.md)
- [Plugin SDK & API Reference](../docs/plugin-host/sdk.md)
- [JSON Schema Specification](../docs/plugin-host/codeg-plugin.schema.json)
- [Starter Template Guide](./_template/README.md)
