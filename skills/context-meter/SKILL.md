---
name: context-meter
description: >-
  Show the live context-window token usage for the current Antigravity
  conversation. Use when the user asks how full the context is, how many tokens
  are used or left, whether they are close to the context limit, or asks to open
  the context meter panel. Also use for /context-meter.
---

# Context Meter

This plugin ships a UI extension: a sidecar-backed panel that reads
Antigravity's own context-window estimate and model-quota summary for the active
conversation.

## Open the panel

When the user asks for the meter, emit this pill on its own line:

[Context Meter](sidecar://context-meter/context-meter/)

Clicking it toggles the panel in the auxiliary side pane. The panel refreshes
every 4 seconds. It follows the conversation passed by the host; if it is opened
without a conversation, it shows the most recently modified conversation and
offers a conversation picker when more than one exists.

The plugin also injects a compact badge into the chat header, immediately left
of the ⋮ menu. It follows the active `/c/<conversationId>` URL and refreshes
every 4 seconds. It shows the context percentage and the active model group's
weekly remaining percentage (`7d 91.7% left`); the tooltip and panel have the full
breakdown. Clicking the badge toggles the auxiliary pane: it opens the pane and
focuses the Context Meter tab, and clicking it again closes the pane.
If the user asks where the percentage is, mention both the header badge and the
panel. The badge is an unofficial CDP injection; if it is missing after an
Antigravity update, the panel is the reliable fallback.

## What it shows

- Percentage of the model's context window in use.
- Used and remaining tokens (`estimatedTokensUsed` / `maxContextTokens`).
- Current model, latest step, and generation count.
- Last request's input, output, and thinking tokens.
- A history sparkline of context growth.
- Weekly (or other window) usage limits per model group, remaining percentage,
  and reset time.
- A warning at 70% and a stronger warning at 90% for context usage.

## How to interpret

Values are Antigravity's local estimate from the language server, captured at
the start of each model request. They refresh after a response completes; an
in-progress generation may not be reflected until the next request.

Do not guess a percentage from the chat history. Open the panel and let the user
read the live value. If the panel cannot load, tell the user the language server
is unavailable and to retry after Antigravity finishes starting.
