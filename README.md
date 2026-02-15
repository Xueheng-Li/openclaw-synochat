# 🤖 OpenClaw SynoChat Plugin

> 📖 **中文说明**: 见 [README.zh.md](./README.zh.md)

Synology Chat channel plugin for [OpenClaw](https://github.com/nicholasgriffintn/OpenClaw) — enables bidirectional messaging between Synology Chat bots and OpenClaw AI agents over a ZeroTier LAN.

## ✨ Features

- 📨 **Inbound messages** — Synology Chat outgoing webhook → OpenClaw agent processing
- 📤 **Outbound replies** — AI-generated responses sent back via Bot Incoming API
- 🔐 **Token-based auth** — outgoing webhook token verification
- 📝 **Markdown conversion** — converts Markdown to readable plain text for Synology Chat
- ✂️ **Auto-splitting** — long messages split into multiple chunks
- 💬 **Chat UI integration** — messages appear in OpenClaw Chat UI with transcript history
- 🛠️ **Built-in commands** — `/help`, `/clear`, `/status`

## 📐 Architecture

```
[User in Synology Chat]
    → [NAS Bot Outgoing Webhook]
    → POST https://<gateway>/synochat/callback
    → [OpenClaw SynoChat Plugin: parse form data, verify token]
    → [AI Agent generates reply]
    → [Plugin: POST reply to NAS Bot Incoming API]
    → [Synology Chat Bot → User]
```

All traffic stays on ZeroTier LAN (e.g., 10.0.0.x/24). No encryption/XML complexity — simple token auth with form-encoded/JSON payloads.

## 📦 Installation

1. Clone this repo on the OpenClaw gateway server:

```bash
git clone https://github.com/Xueheng-Li/openclaw-synochat.git ~/openclaw-synochat
cd ~/openclaw-synochat
npm install
```

2. Add the plugin path to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/home/xueheng/openclaw-synochat"
      ]
    }
  }
}
```

3. Add the channel config to `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "synochat": {
      "nasUrl": "https://YOUR_NAS_IP:PORT",
      "botToken": "YOUR_BOT_INCOMING_TOKEN",
      "outgoingToken": "YOUR_BOT_OUTGOING_TOKEN",
      "webhookPath": "/synochat/callback"
    }
  }
}
```

4. Restart the gateway:

```bash
systemctl --user restart openclaw-gateway.service
```

## 🔧 Synology Chat Bot Setup

### Step 1: Open Bot Integration

1. Log in to your Synology NAS DSM
2. Open **Synology Chat** (install from Package Center if not installed)
3. Click your **avatar** (bottom-left) → **Integration**
4. Select the **Bots** tab

### Step 2: Create a New Bot

1. Click **➕ Create**
2. Fill in:
   - **Bot Name**: `OpenClaw` (or any name you prefer — this is what users see in chat)
   - **Outgoing Webhook URL**: `https://<gateway-ip>/synochat/callback`
     - Example: `https://YOUR_GATEWAY_IP/synochat/callback`
   - Check **Enable Outgoing Webhook** ✅
   - Check **Enable Incoming Webhook** ✅
3. Click **Create**

### Step 3: Collect Tokens

After creation, the bot detail page shows:

- **Incoming Webhook URL** — looks like:
  ```
  https://YOUR_NAS_IP:PORT/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=%22XXXXXX%22
  ```
  Extract the token value between `%22` (i.e., between the encoded quotes). This is your **`botToken`**.

- **Outgoing Token** — a separate token string displayed on the page. This is your **`outgoingToken`**.

### Step 4: Update OpenClaw Config

Put both tokens into `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "synochat": {
      "nasUrl": "https://YOUR_NAS_IP:PORT",
      "botToken": "THE_INCOMING_TOKEN_YOU_EXTRACTED",
      "outgoingToken": "THE_OUTGOING_TOKEN_STRING",
      "webhookPath": "/synochat/callback"
    }
  }
}
```

Then restart the gateway:

```bash
systemctl --user restart openclaw-gateway.service
```

### Step 5: Test

1. Open Synology Chat on DSM or mobile app
2. Find the bot in your contact list (or start a direct message with it)
3. Send any message (e.g., "hello")
4. The bot should reply with an AI-generated response

Check logs if something goes wrong:

```bash
journalctl --user -u openclaw-gateway.service -n 50 --no-pager | grep synochat
```

### ⚠️ SSL Troubleshooting

If Synology Chat rejects the self-signed certificate on the gateway (outgoing webhook fails silently), you have two options:

1. **Add the gateway's CA cert to NAS trusted store** — DSM → Control Panel → Security → Certificate → Import
2. **Use HTTP fallback** — add an HTTP-only listener in Caddy bound to ZeroTier IP on an alternate port:

   ```
   # In Caddyfile
   http://YOUR_GATEWAY_IP:18790 {
       reverse_proxy localhost:18789
   }
   ```

   Then update the bot's Outgoing Webhook URL to `http://YOUR_GATEWAY_IP:18790/synochat/callback`.

### 📝 Synology Chat Bot API Reference

- **Incoming (send messages to users)**: `POST {nasUrl}/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token="{botToken}"` with form-encoded body `payload={"text":"...","user_ids":[123]}`
- **Outgoing (receive messages from users)**: NAS POSTs form-encoded data to your webhook with fields: `token`, `user_id`, `username`, `text`, `post_id`, `timestamp`
- [Official Synology Chat Bot API docs](https://kb.synology.com/en-us/DSM/help/Chat/chat_integration)

## 📁 Project Structure

```
openclaw-synochat/
├── package.json              # Plugin package manifest
├── openclaw.plugin.json      # OpenClaw plugin descriptor
├── src/
│   ├── index.js              # Main plugin source
│   └── openclaw.plugin.json  # Copy of descriptor (resolved from exports path)
├── .gitignore
└── README.md
```

## ⚙️ Configuration

Config is read from `channels.synochat` in `openclaw.json` (preferred), or from environment variables:

| Config Key | Env Var | Description |
|-----------|---------|-------------|
| `nasUrl` | `SYNOCHAT_NAS_URL` | Synology NAS base URL |
| `botToken` | `SYNOCHAT_BOT_TOKEN` | Bot incoming webhook token |
| `outgoingToken` | `SYNOCHAT_OUTGOING_TOKEN` | Token for verifying outgoing webhooks |
| `webhookPath` | `SYNOCHAT_WEBHOOK_PATH` | Webhook path (default: `/synochat/callback`) |

## 🔍 Verification

```bash
# Check gateway logs
journalctl --user -u openclaw-gateway.service -n 50 --no-pager | grep synochat

# Health check
curl https://localhost/synochat/callback
# → "synochat webhook ok"
```

## 📜 License

MIT
