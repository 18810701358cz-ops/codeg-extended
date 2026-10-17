# WorkBuddy Connect Plugin for Codeg Extended

WorkBuddy Connect is a model provider bridge plugin that connects locally authenticated WorkBuddy / CodeBuddy AI models to Codeg Extended via OpenAI-compatible endpoints (`/v1/models`, `/v1/chat/completions`).

## Prerequisites

- **Python**: Version 3.10 or higher.
- **WorkBuddy Desktop**: Installed and signed in on your local machine.

## Installation

You can install this plugin through Codeg Extended Settings:

1. **Via Git Repository**:
   Navigate to **Settings -> Plugins (插件中心)**, choose **Install from Git**, and enter:
   ```
   https://github.com/18810701358cz-ops/codeg-extended/tree/main/plugins/workbuddy-connect
   ```

2. **Via Zip Upload**:
   Download or package the `workbuddy-connect` directory as a ZIP file, then select **Upload Plugin Archive** in the Plugin Center.

## Configuration

Configurable via Plugin Settings (`configSchema`):

| Key | Type | Default | Description |
|---|---|---|---|
| `authFile` | `string` | `""` | Custom path to WorkBuddy credential file (`workbuddy-desktop.info`). Leave empty to auto-detect. |
| `probeConsent` | `boolean` | `false` | Allow reasoning effort probing (note: probing consumes model quota / credits). |

## Environment Variables

When managed by Codeg Extended Plugin Host, the following environment variables are supplied:

- `HOST`: Bind address (default: `127.0.0.1`). Binding to non-loopback addresses requires `WORKBUDDY_ALLOW_REMOTE=1`.
- `PORT`: Listen port (preferred: `18080`).
- `CODEG_PLUGIN_TOKEN`: Shared secret token for authentication. All endpoints except `/healthz` and `/health` require `Authorization: Bearer <token>`.
- `WORKBUDDY_ALLOW_NO_TOKEN`: Set to `1` only for debugging to bypass token requirement.
- `WORKBUDDY_AUTH_FILE`: Override path to WorkBuddy credentials file.
- `WORKBUDDY_PROBE_CONSENT`: Set to `true` to allow probing reasoning effort.

## Endpoints

- `GET /healthz` & `GET /health`: Health check endpoints returning `{"ok": true}` without token authentication and without network calls.
- `GET /`: Status and model dashboard (requires Bearer token).
- `GET /v1/models`: OpenAI-compatible model listing with credits and promotional badges (requires Bearer token).
- `POST /v1/chat/completions`: OpenAI-compatible streaming and non-streaming chat completions (requires Bearer token).
- `GET /v1/probe` & `POST /v1/probe`: Reasoning effort probe endpoint (requires Bearer token and `WORKBUDDY_PROBE_CONSENT=true`).
