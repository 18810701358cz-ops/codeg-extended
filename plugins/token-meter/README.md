# Token Meter

Shows two numbers in the status bar, for the conversation you are looking at.

| Item | Meaning |
|---|---|
| `⚡ 42.3 tok/s` | Output speed of the reply that is streaming right now. Shows `—` while nothing is streaming. |
| `Σ 128.4K` | Tokens the agent has reported for the whole conversation (input + output + cache). It is the same figure as the "Total" row of the usage popover under the composer, and it settles after each turn. |
| `+1.2K` | Only while a reply streams: tokens generated so far in this turn (an estimate). It is not added into the total, which the agent reports once the turn is over. |

Hover the meter for the details. It is dimmed while nothing is streaming.

## Requirements

Codeg Extended with plugin host **1.1.0** or later (the `ctx.tokens` API). Older hosts list the plugin as incompatible instead of loading it.

## Install

- **Git repository**: in Settings → Plugins, install from `https://github.com/18810701358cz-ops/codeg-extended/tree/main/plugins/token-meter`.
- **Upload**: zip the `token-meter` folder (with `codeg-plugin.json` at its root) and upload it, or pick the folder on desktop.
- **Local directory**: copy the folder into the plugins directory shown at the top of the Plugins page, then press Refresh.

Then make sure it is switched on in the Plugins page (a plugin copied in by hand starts out enabled).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Status bar side | `left` | Which side of the status bar shows the meter (`left` sits next to the conversation count). Takes effect the next time the plugin is enabled. |

## How the numbers are produced

- The speed and the `+N` count are estimates made from the text as it streams: roughly 4 characters per token for Latin text and 1.8 for Chinese, Japanese and Korean. Speed uses the same algorithm as the "streaming" row in the chat, so the two always agree.
- The total is whatever the agent reports. It is read from the conversation's transcript after each turn, so it can lag a few seconds behind the end of a reply.

## Limits

- Desktop-width layouts only: the compact (mobile) status bar has no plugin slots yet.
- Agents that report no usage at all (some hosted models) leave the total at `—`.
- The tooltip is available in English and Chinese; other languages fall back to English.
