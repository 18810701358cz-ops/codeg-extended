# Codeg Extended Plugins

Welcome to the Codeg Extended plugin repository. This directory contains official and community example plugins for the **Codeg Plugin Host v2** architecture.

## Repository Plugins

| Directory | Plugin ID | Category | Description |
|---|---|---|---|
| [`workbuddy-connect/`](./workbuddy-connect) | `workbuddy-connect` | `model-provider` | Integrates authenticated WorkBuddy local/remote AI models into Codeg as a model provider. |
| [`prompt-pack/`](./prompt-pack) | `prompt-pack` | `workflow` | Contributes a curated set of developer prompts to Codeg's Quick Messages. |
| [`_template/`](./_template) | `sample-plugin` | `utility` | Starter template containing manifest, ESM entrypoint, CSS styling, and documentation. |

## Built-in Plugins

In addition to repository plugins, Codeg Extended bundles three built-in UI and widget plugins into the application binary (located in `src-tauri/builtin-plugins/`):

1. **`dsh-cyber-glow`**: DeepSeek Harness-inspired translucent dark neon glow theme.
2. **`dsh-compact-layout`**: High information density layout tuning conversation transcript and card dimensions.
3. **`dsh-quick-actions`**: Status bar right-slot action widget.

All built-in plugins are disabled by default and can be enabled individually in Settings -> Plugins.

## Plugin Structure (v2)

Each plugin resides in a dedicated directory named after its plugin `id`:

```text
<plugin-id>/
├── codeg-plugin.json   # Plugin manifest (required)
├── dist/               # Bundled frontend ESM artifacts
│   └── index.js        # Entrypoint (required if main is specified)
├── styles/             # Stylesheets (optional)
│   └── style.css
├── backend/            # Backend service scripts/binaries (optional)
│   └── server.py
└── README.md           # Plugin documentation
```

## Installing Plugins

Plugins can be installed in Codeg Extended via:
1. **Git Repository**: Enter a GitHub repository URL or deep-link (e.g. `https://github.com/<owner>/<repo>/tree/main/plugins/<id>`).
2. **Zip Upload**: Upload a zipped plugin directory.
3. **Local Directory**: Place the plugin directory in the host's plugins data directory.
