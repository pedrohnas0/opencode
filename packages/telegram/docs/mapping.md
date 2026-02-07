# OpenCode Telegram Bot - Feature Mapping Report

Comparative analysis between the OpenCode SDK (as consumed by the `app` web UI) and the OpenClaw Telegram integration, to plan a comprehensive Telegram bot for OpenCode.

---

## 1. OpenCode SDK - Complete API Surface

The SDK (`@opencode-ai/sdk`) exposes the `OpencodeClient` class with these namespaces:

| Namespace | Key Methods | Used by App |
|-----------|------------|-------------|
| `global` | `get`, `update`, `health`, `event` (SSE stream), `dispose` | Yes - bootstrap, config, SSE |
| `auth` | `remove`, `set` | Yes - provider auth |
| `project` | `list`, `current`, `update` | Yes - multi-project |
| `pty` | `list`, `create`, `remove`, `get`, `update`, `connect` | No |
| `config` | `get`, `update`, `providers` | Yes - settings |
| `tool` | `ids`, `list` | No |
| `worktree` | `list`, `remove`, `create`, `reset` | Yes - git worktrees |
| `experimental` | `resource.list` | No |
| `session` | `list`, `create`, `status`, `delete`, `get`, `update`, `children`, `todo`, `init`, `fork`, `abort`, `share`, `unshare`, `diff`, `summarize`, `messages`, `prompt`, `message`, `promptAsync`, `command`, `shell`, `revert`, `unrevert` | Yes - all core |
| `part` | `delete`, `update` | No |
| `permission` | `respond`, `reply`, `list` | Yes - permission dialogs |
| `question` | `list`, `reply`, `reject` | Yes - question dialogs |
| `provider` | `list`, `auth` | Yes - provider mgmt |
| `find` | `text`, `files`, `symbols` | No |
| `file` | `list`, `read`, `status` | Yes - file tree |
| `mcp` | `remove`, `start`, `callback`, `authenticate`, `status`, `add`, `connect`, `disconnect` | No |
| `tui` | `next`, `response`, `appendPrompt`, `openHelp/Sessions/Themes/Models`, `submitPrompt`, `clearPrompt`, `executeCommand`, `showToast`, `publish`, `selectSession` | No (TUI-specific) |
| `instance` | `dispose` | No |
| `path` | `get` | Yes - directory paths |
| `vcs` | `get` | Yes - git status |
| `command` | `list` | Yes - slash commands |
| `app` | `log`, `agents`, `skills` | Yes - agent list |
| `lsp` | `status` | Yes - LSP indicators |
| `formatter` | `status` | No |
| `event` | `subscribe` (per-instance SSE) | Yes - realtime updates |

---

## 2. OpenCode App (Web UI) - SDK Usage Breakdown

### 2.1 Session Lifecycle
- `session.create()` - new conversation
- `session.list()` - sidebar session list
- `session.get()` - load specific session
- `session.update()` - rename, archive
- `session.delete()` - delete session
- `session.fork()` - fork from message
- `session.share()` / `unshare()` - sharing URLs
- `session.abort()` - cancel running response
- `session.diff()` - view file changes
- `session.todo()` - task list
- `session.children()` - sub-sessions

### 2.2 Messaging
- `session.prompt()` - send user message (text + files + images + agent + model + variant)
- `session.shell()` - execute shell command
- `session.command()` - execute slash command (with agent, model, variant, parts)
- `session.messages()` - load message history (paginated)
- `session.message()` - get single message
- `session.summarize()` - summarize session
- `session.revert()` / `unrevert()` - undo/redo changes

### 2.3 Events (SSE)
- `global.event()` - global SSE stream, events by directory
- Event types handled:
  - `message.updated` - new/updated messages
  - `message.part.updated` - tool calls, text streaming
  - `session.updated` - session metadata changes
  - `session.status` - busy/idle state
  - `session.idle` - turn complete (triggers notifications)
  - `session.error` - error events
  - `permission.asked` - permission request
  - `lsp.updated` - LSP status change

### 2.4 Permissions
- `permission.list()` - pending permissions for directory
- `permission.respond()` - once/always/reject

### 2.5 Questions
- `question.list()` - pending questions
- `question.reply()` - answer question
- `question.reject()` - reject question

### 2.6 Config & Providers
- `global.get()` → config, providers, provider_auth, path, project list
- `global.update()` → update global config
- `config.get()` / `config.update()` - per-project config
- `provider.list()` / `provider.auth()` - provider management
- `auth.set()` / `auth.remove()` - API key management

### 2.7 Files & VCS
- `file.list()` - directory file tree
- `file.read()` - read file content
- `file.status()` - git status
- `vcs.get()` - VCS info
- `worktree.create()` / `list()` / `remove()` / `reset()` - git worktree management

### 2.8 Other
- `app.agents()` - list available agents
- `app.skills()` - list skills
- `command.list()` - list slash commands
- `lsp.status()` - LSP server status

---

## 3. OpenClaw Telegram - Feature Breakdown

~6,500 LOC (excluding tests). Built on Grammy (Telegram Bot Framework).

### 3.1 Core Architecture
- **bot.ts** (494 LOC) - Bot creation, Grammy setup, sequentialization, throttling
- **bot-handlers.ts** (928 LOC) - Message/callback routing, media groups, text fragment assembly, debouncing
- **bot-message.ts** (93 LOC) - Message processor factory
- **bot-message-context.ts** (700 LOC) - Rich context building (sender info, group config, history, media, permissions)
- **bot-message-dispatch.ts** (357 LOC) - Dispatches to AI agent, handles reply delivery

### 3.2 Message Handling
- Text messages (DM + group)
- Media: photos, videos, documents, audio, voice, stickers
- Media groups (multiple photos/videos in one message)
- Text fragment assembly (long messages split across multiple Telegram messages)
- Inbound debouncing (batches rapid messages)
- Forward/reply context extraction
- Sticker image analysis via vision model
- Inline button callbacks (callback_query)

### 3.3 Sending / Response Delivery
- **send.ts** (754 LOC) - Full send pipeline:
  - Markdown → Telegram HTML conversion
  - Message chunking (4096 char limit)
  - Media attachments (photo, video, audio, document, voice, GIF)
  - Caption splitting for media
  - Inline keyboard buttons
  - Reply threading (reply_to_message_id)
  - Forum topic support (message_thread_id)
  - Silent messages (disable_notification)
  - Voice messages (via ElevenLabs TTS)
  - Reactions (emoji reactions on messages)
  - Proxy support (SOCKS5/HTTP)
  - Retry with exponential backoff

### 3.4 Draft Streaming
- **draft-stream.ts** (139 LOC) - Live streaming of AI response as editable message draft
- Throttled updates (300ms)
- Max 4096 chars per draft
- Falls back gracefully on failure

### 3.5 Native Commands (/command)
- **bot-native-commands.ts** (699 LOC) - Telegram /commands:
  - `/status` - bot status
  - `/models` - model selection with inline keyboard pagination
  - `/help` - command list
  - `/commands` - list available commands
  - Custom commands from config
  - Skill-based commands
  - Plugin commands
  - Per-group/topic command gating

### 3.6 Model Selection UI
- **model-buttons.ts** (217 LOC) - Inline keyboard for model selection:
  - Provider grouping
  - Paginated model list
  - Per-session model override storage

### 3.7 Group Chat Support
- Group policy (allow/deny/mentionOnly)
- Per-group configuration
- Forum/topic support (supergroups with topics)
- Topic-specific skill filters and system prompts
- Mention detection (@botname)
- Sender allowlists
- Group migration handling (when group ID changes)
- Group history tracking

### 3.8 Multi-Account
- **accounts.ts** (139 LOC) - Multiple Telegram bot accounts
- Account binding per DM chat
- Account-specific config

### 3.9 Security & Access Control
- **bot-access.ts** (94 LOC) - Allowlist checking
- **audit.ts** (162 LOC) - Audit logging for messages
- Sender verification (phone number, username, Telegram ID)
- Per-group allowlists

### 3.10 Infrastructure
- **webhook.ts** (127 LOC) - Webhook mode (alternative to polling)
- **monitor.ts** (215 LOC) - Health monitoring, connection status
- **network-errors.ts** (150 LOC) - Recoverable error detection
- **proxy.ts** - SOCKS5/HTTP proxy support
- **token.ts** (102 LOC) - Token validation
- **format.ts** (98 LOC) - Markdown → Telegram HTML
- **download.ts** - Media file downloads
- **sent-message-cache.ts** - Deduplication of sent messages
- **update-offset-store.ts** - Persistent update offset tracking

---

## 4. Feature Mapping: OpenClaw Telegram → OpenCode SDK

| OpenClaw Telegram Feature | OpenCode SDK Equivalent | Implementation Notes |
|--------------------------|------------------------|---------------------|
| **Session/Thread Management** | `session.create/get/list/delete` | Map Telegram chat/thread → OpenCode session |
| **Send Message to AI** | `session.prompt()` | Main interaction point |
| **Shell Commands** | `session.shell()` | Could support `!command` syntax |
| **Slash Commands** | `session.command()` | Map Telegram /commands → OpenCode commands |
| **Abort Response** | `session.abort()` | /cancel command or inline button |
| **Stream Response** | `global.event()` SSE | Listen for `message.part.updated` events |
| **Tool Call Updates** | `message.part.updated` events | Show tool progress in chat |
| **Permission Requests** | `permission.list/respond` | Inline buttons: Allow/Deny/Always |
| **Question Dialogs** | `question.list/reply/reject` | Inline buttons or reply-based |
| **Model Selection** | `app.agents()` + config | Inline keyboard like OpenClaw |
| **Agent Selection** | `app.agents()` | /agent command with inline keyboard |
| **Session Rename** | `session.update()` | /rename command |
| **Session Fork** | `session.fork()` | /fork command |
| **Session Share** | `session.share()` | /share → returns URL |
| **View Diff** | `session.diff()` | /diff → formatted file changes |
| **View Todo** | `session.todo()` | /todo → task list |
| **Revert Changes** | `session.revert/unrevert` | /undo /redo commands |
| **File Attachment** | `session.prompt()` with FileParts | Photo/document → file part |
| **Media Download** | Direct from Telegram API | Download → base64 → file part |
| **Voice Messages** | Download → transcription/attach | Could use whisper or send as audio |
| **Message History** | `session.messages()` | /history or context loading |
| **Multi-Project** | `project.list()` + directory header | /project command to switch |
| **Config** | `config.get/update` | /config command |
| **Provider Auth** | `auth.set/remove` | /auth command |
| **Notifications** | `session.idle/error` events | Proactive messages on completion |
| **Draft Streaming** | `message.part.updated` + edit_message | Edit message as response streams in |
| **Markdown Formatting** | n/a (SDK returns markdown) | Convert markdown → Telegram HTML |
| **Message Chunking** | n/a | Split >4096 char messages |
| **Inline Buttons** | n/a | Permissions, questions, model selection |
| **Reactions** | n/a | Ack reaction on message receipt |
| **Group Support** | Works with directory header | Group chat → shared project session |
| **Forum Topics** | Works with directory header | Topic → separate session |
| **Error Handling** | `session.error` events | Show errors in chat |

---

## 5. Proposed Architecture

```
opencode-telegram/
  src/
    index.ts              # Entry point, bot startup
    bot.ts                # Grammy bot creation, middleware
    session-map.ts        # Telegram chat/thread → OpenCode session mapping
    handlers/
      message.ts          # Text + media message handling
      command.ts          # /start, /new, /model, /agent, /cancel, etc.
      callback.ts         # Inline button callbacks
      media.ts            # Photo, document, voice, sticker handling
    events/
      listener.ts         # SSE event listener (global.event)
      dispatcher.ts       # Route events → Telegram responses
    send/
      format.ts           # Markdown → Telegram HTML
      chunker.ts          # Message splitting (4096 limit)
      media.ts            # Send photos, files, voice
      draft-stream.ts     # Live response streaming via edit_message
    ui/
      permissions.ts      # Inline keyboard for permissions
      questions.ts        # Inline keyboard for questions
      models.ts           # Model selection inline keyboard
      agents.ts           # Agent selection inline keyboard
    config.ts             # Bot configuration
    types.ts              # Shared types
```

### 5.1 Priority Features (MVP)

1. **Session Management** - chat → session mapping, /new, /list
2. **Prompting** - text messages → `session.prompt()`
3. **SSE Events** - stream responses back to Telegram
4. **Response Delivery** - markdown formatting, chunking, streaming edits
5. **Permission Handling** - inline buttons for allow/deny
6. **Question Handling** - inline buttons for question replies
7. **Abort** - /cancel to stop generation
8. **Model/Agent Selection** - /model, /agent commands with inline keyboards
9. **File Attachments** - photos/documents → file parts
10. **Error Handling** - show errors, retry logic

### 5.2 Advanced Features (Post-MVP)

1. **Draft Streaming** - edit message as response arrives
2. **Group Chat Support** - mention detection, allowlists
3. **Forum Topics** - topic → session mapping
4. **Voice Messages** - download + attach as audio
5. **Slash Commands** - /commit, /review, etc. → `session.command()`
6. **Shell Mode** - `!ls` → `session.shell()`
7. **Session Sharing** - /share → public URL
8. **Diff View** - /diff → formatted file changes
9. **Multi-Project** - /project to switch directories
10. **Notifications** - proactive messages on turn completion
11. **Reactions** - ack reaction on message receipt, reactions on completion

### 5.3 Key Differences from OpenClaw

| Aspect | OpenClaw Telegram | OpenCode Telegram (Proposed) |
|--------|------------------|------------------------------|
| Backend | Direct AI agent integration | SDK HTTP client (like web UI) |
| Session Store | Custom session store | OpenCode manages sessions |
| Model Catalog | Internal model catalog | `app.agents()` + provider list |
| Commands | Custom command registry | `command.list()` from OpenCode |
| Streaming | Token-by-token streaming | SSE `message.part.updated` events |
| Config | OpenClaw config system | `config.get/update` from SDK |
| Permissions | Not applicable | Full permission system via SDK |
| Questions | Not applicable | Full question system via SDK |
| Multi-Project | Not applicable | Directory header in SDK client |

---

## 6. SDK Methods NOT Used by Web App (Available for Telegram)

These SDK features are available but the web app doesn't use them:

- `pty.*` - Terminal sessions (could power interactive shell in Telegram)
- `tool.ids/list` - Enumerate available tools
- `find.text/files/symbols` - Code search
- `mcp.*` - MCP server management
- `session.promptAsync()` - Non-blocking prompt (useful for Telegram's async nature)
- `part.delete/update` - Edit/delete message parts
- `instance.dispose` - Cleanup

Of particular interest: **`session.promptAsync()`** could be ideal for Telegram since it doesn't block, allowing the bot to handle other messages while waiting for AI responses.
