# Codeg Plugin Template (`_template`)

This template serves as a starting point for authoring plugins for Codeg Extended (Plugin System v2).

## Directory Structure

```text
my-plugin/
├── codeg-plugin.json   # Plugin manifest (required)
├── dist/
│   └── index.js        # ESM entrypoint (required if main is specified)
├── styles/
│   └── style.css       # CSS stylesheet (optional)
└── README.md           # Plugin documentation
```

## Quick Start

1. Copy this `_template` folder into your workspace or target repository.
2. Rename the directory to match your plugin `id` (must match `^[a-z0-9][a-z0-9-]{1,63}$`).
3. Update `codeg-plugin.json` with your plugin information, permissions, and configuration schema.
4. Implement your plugin lifecycle hooks (`activate`, `deactivate`) in `dist/index.js`.
5. Package as a zip file or publish to a Git repository, then install via the Plugin Center in Codeg Extended.
