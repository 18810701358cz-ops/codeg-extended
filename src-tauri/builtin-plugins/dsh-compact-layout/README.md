# DSH Compact Layout

High information density layout for Codeg Extended.
A pure styling plugin that tightens paddings and margins across the chat transcript, message bubbles, conversation list, and cards to maximize working viewport area.

## Real Selectors Verification
Every selector used in this plugin directly targets components in Codeg:
- `.chat-content-w`: Conversation transcript container gutter
- `.is-user`, `.is-assistant`: Message thread rows
- `.is-user .ws-msg-secondary`: User message bubble interior padding
- `[data-conv-key]`: Sidebar conversation item height
- `[data-slot="card"]`: Card containers
- `.ws-surface-sidebar`: Sidebar surface padding
- `[data-slot-name="statusbar.left"]`, `[data-slot-name="statusbar.right"]`: Status bar plugin slots
