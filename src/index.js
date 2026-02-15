import { normalizePluginHttpPath } from "clawdbot/plugin-sdk";
import { writeFile, unlink, mkdir, appendFile } from "node:fs/promises";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Agent as UndiciAgent } from "undici";

// --- TLS: skip cert verification for self-signed NAS certs on ZeroTier LAN ---
const insecureDispatcher = new UndiciAgent({
  connect: { rejectUnauthorized: false },
});

function synoFetch(url, opts = {}) {
  return fetch(url, { ...opts, dispatcher: insecureDispatcher });
}

// --- Constants ---
const MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1MB
const SYNOCHAT_TEXT_LIMIT = 4000; // Synology Chat has generous text limits

// --- Utilities ---

function readRequestBody(req, maxSize = MAX_REQUEST_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    req.on("data", (c) => {
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        reject(new Error(`Request body too large (limit: ${maxSize} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function requireEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return v;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Markdown to plain text for Synology Chat
function markdownToPlainText(markdown) {
  if (!markdown) return markdown;
  let text = markdown;

  // Code blocks → indented
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const lines = code.trim().split("\n").map((line) => "  " + line).join("\n");
    return lang ? `[${lang}]\n${lines}` : lines;
  });

  // Inline code
  text = text.replace(/`([^`]+)`/g, "$1");

  // Headers
  text = text.replace(/^### (.+)$/gm, "▸ $1");
  text = text.replace(/^## (.+)$/gm, "■ $1");
  text = text.replace(/^# (.+)$/gm, "◆ $1");

  // Bold/italic
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/___([^_]+)___/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/_([^_]+)_/g, "$1");

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // Unordered lists
  text = text.replace(/^[\*\-] /gm, "• ");

  // Horizontal rules
  text = text.replace(/^[-*_]{3,}$/gm, "────────────");

  // Images
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[图片: $1]");

  // Clean up extra blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// Split long text into chunks
function splitText(text, limit = SYNOCHAT_TEXT_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = limit;

    // Try to split at natural break points
    const searchStart = Math.max(0, splitIndex - 200);
    const searchText = remaining.slice(searchStart, splitIndex);

    let naturalBreak = searchText.lastIndexOf("\n\n");
    if (naturalBreak === -1) naturalBreak = searchText.lastIndexOf("\n");
    if (naturalBreak === -1) {
      naturalBreak = searchText.lastIndexOf("。");
      if (naturalBreak !== -1) naturalBreak += 1;
    }
    if (naturalBreak !== -1 && naturalBreak > 0) {
      splitIndex = searchStart + naturalBreak;
    }

    if (splitIndex <= 0) splitIndex = limit;

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  return chunks.filter((c) => c.length > 0);
}

// --- Synology Chat API ---

async function sendSynoChatText({ nasUrl, botToken, userId, text, logger }) {
  // Synology Chat Bot Incoming API:
  // POST {nasUrl}/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token="{botToken}"
  // Body: payload={"text": "...", "user_ids": [userId]}
  //
  // Note: For "chatbot" type bots, use method=chatbot and user_ids to target specific users
  // For "incoming" webhooks, text goes to the channel

  const chunks = splitText(text);
  logger?.info?.(`synochat: sending ${chunks.length} chunk(s) to user ${userId}`);

  for (let i = 0; i < chunks.length; i++) {
    const apiUrl = `${nasUrl}/chat/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22${encodeURIComponent(botToken)}%22`;

    const payload = JSON.stringify({
      text: chunks[i],
      user_ids: [parseInt(userId, 10)],
    });

    logger?.info?.(`synochat: sending chunk ${i + 1}/${chunks.length}, length=${chunks[i].length}`);

    const res = await synoFetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `payload=${encodeURIComponent(payload)}`,
    });

    const json = await res.json();
    if (!json.success) {
      throw new Error(`SynoChat API failed: ${JSON.stringify(json)}`);
    }

    if (i < chunks.length - 1) {
      await sleep(300);
    }
  }
}

// --- Config ---

let cachedConfig = null;

function getSynoChatConfig(api) {
  if (cachedConfig) return cachedConfig;

  const cfg = api?.config ?? gatewayRuntime?.config;

  // 1. From channels.synochat in openclaw.json
  const channelConfig = cfg?.channels?.synochat;
  if (channelConfig) {
    const nasUrl = channelConfig.nasUrl;
    const botToken = channelConfig.botToken;
    const outgoingToken = channelConfig.outgoingToken;
    const webhookPath = channelConfig.webhookPath || "/synochat/callback";

    if (nasUrl && botToken) {
      cachedConfig = { nasUrl, botToken, outgoingToken, webhookPath };
      return cachedConfig;
    }
  }

  // 2. From env.vars in openclaw.json
  const envVars = cfg?.env?.vars ?? {};
  const nasUrl = envVars.SYNOCHAT_NAS_URL || requireEnv("SYNOCHAT_NAS_URL");
  const botToken = envVars.SYNOCHAT_BOT_TOKEN || requireEnv("SYNOCHAT_BOT_TOKEN");
  const outgoingToken = envVars.SYNOCHAT_OUTGOING_TOKEN || requireEnv("SYNOCHAT_OUTGOING_TOKEN");
  const webhookPath = envVars.SYNOCHAT_WEBHOOK_PATH || requireEnv("SYNOCHAT_WEBHOOK_PATH") || "/synochat/callback";

  if (nasUrl && botToken) {
    cachedConfig = { nasUrl, botToken, outgoingToken, webhookPath };
    return cachedConfig;
  }

  return null;
}

// --- Channel Plugin ---

const SynoChatChannelPlugin = {
  id: "synochat",
  meta: {
    id: "synochat",
    label: "Synology Chat",
    selectionLabel: "Synology Chat (群晖聊天)",
    docsPath: "/channels/synochat",
    blurb: "Synology Chat bot via outgoing/incoming webhooks on ZeroTier LAN.",
    aliases: ["synology", "syno"],
  },
  capabilities: {
    chatTypes: ["direct"],
    media: { inbound: false, outbound: false },
    markdown: false,
  },
  config: {
    listAccountIds: (cfg) => {
      const synoConfig = cfg?.channels?.synochat;
      return synoConfig ? ["default"] : [];
    },
    resolveAccount: (cfg, accountId) => {
      return cfg?.channels?.synochat ?? { accountId: accountId || "default" };
    },
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) return { ok: false, error: new Error("SynoChat requires --to <userId>") };
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text }) => {
      const config = getSynoChatConfig();
      if (!config?.nasUrl || !config?.botToken) {
        return { ok: false, error: new Error("SynoChat not configured (check channels.synochat)") };
      }
      await sendSynoChatText({
        nasUrl: config.nasUrl,
        botToken: config.botToken,
        userId: to,
        text,
      });
      return { ok: true, provider: "synochat" };
    },
  },
  inbound: {
    deliverReply: async ({ to, text, accountId }) => {
      const config = getSynoChatConfig();
      if (!config?.nasUrl || !config?.botToken) {
        throw new Error("SynoChat not configured (check channels.synochat)");
      }
      // to format: "synochat:userId"
      const userId = to.startsWith("synochat:") ? to.slice(9) : to;
      if (text) {
        await sendSynoChatText({
          nasUrl: config.nasUrl,
          botToken: config.botToken,
          userId,
          text,
        });
      }
      return { ok: true };
    },
  },
};

// --- Runtime references ---
let gatewayRuntime = null;
let gatewayBroadcastCtx = null;

// Write to session transcript for Chat UI
async function writeToTranscript({ sessionKey, role, text, logger }) {
  try {
    const stateDir = process.env.CLAWDBOT_STATE_DIR || join(homedir(), ".clawdbot");
    const sessionsDir = join(stateDir, "agents", "main", "sessions");
    const sessionsJsonPath = join(sessionsDir, "sessions.json");

    if (!existsSync(sessionsJsonPath)) {
      logger?.warn?.("synochat: sessions.json not found");
      return;
    }

    const sessionsData = JSON.parse(readFileSync(sessionsJsonPath, "utf8"));
    const sessionEntry = sessionsData[sessionKey] || sessionsData[sessionKey.toLowerCase()];

    if (!sessionEntry?.sessionId) {
      logger?.warn?.(`synochat: session entry not found for ${sessionKey}`);
      return;
    }

    const transcriptPath =
      sessionEntry.sessionFile || join(sessionsDir, `${sessionEntry.sessionId}.jsonl`);

    const transcriptEntry = {
      type: "message",
      id: randomUUID().slice(0, 8),
      timestamp: new Date().toISOString(),
      message: {
        role,
        content: [{ type: "text", text }],
        timestamp: Date.now(),
        stopReason: role === "assistant" ? "end_turn" : undefined,
        usage: role === "assistant" ? { input: 0, output: 0, totalTokens: 0 } : undefined,
      },
    };

    appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
    logger?.info?.(`synochat: wrote ${role} message to transcript`);
  } catch (err) {
    logger?.warn?.(`synochat: failed to write transcript: ${err.message}`);
  }
}

// Broadcast to Chat UI
function broadcastToChatUI({ sessionKey, role, text, runId, state }) {
  if (!gatewayBroadcastCtx) return;
  try {
    const chatPayload = {
      runId: runId || `synochat-${Date.now()}`,
      sessionKey,
      seq: 0,
      state: state || "final",
      message: {
        role: role || "user",
        content: [{ type: "text", text: text || "" }],
        timestamp: Date.now(),
      },
    };
    gatewayBroadcastCtx.broadcast("chat", chatPayload);
    gatewayBroadcastCtx.bridgeSendToSession(sessionKey, "chat", chatPayload);
  } catch (err) {
    // Ignore broadcast errors
  }
}

// --- Commands ---

async function handleHelpCommand({ config, userId, logger }) {
  const helpText = `AI 助手使用帮助

可用命令：
/help - 显示此帮助信息
/clear - 清除会话历史，开始新对话
/status - 查看系统状态

直接发送消息即可与 AI 对话。`;

  await sendSynoChatText({
    nasUrl: config.nasUrl,
    botToken: config.botToken,
    userId,
    text: helpText,
    logger,
  });
  return true;
}

async function handleStatusCommand({ config, userId, logger }) {
  const statusText = `系统状态

渠道：Synology Chat
会话ID：synochat:${userId}
插件版本：0.1.0

功能状态：
- 文本消息 OK
- Markdown 转换 OK
- 命令系统 OK`;

  await sendSynoChatText({
    nasUrl: config.nasUrl,
    botToken: config.botToken,
    userId,
    text: statusText,
    logger,
  });
  return true;
}

const COMMANDS = {
  "/help": handleHelpCommand,
  "/clear": null, // handled inline
  "/status": handleStatusCommand,
};

// --- Inbound message processing ---

async function processInboundMessage({ api, userId, username, content, postId, timestamp: msgTimestamp }) {
  const config = getSynoChatConfig(api);
  const cfg = api.config;
  const runtime = api.runtime;

  if (!config?.nasUrl || !config?.botToken) {
    api.logger.warn?.("synochat: not configured");
    return;
  }

  try {
    const sessionId = `synochat:${userId}`.toLowerCase();
    api.logger.info?.(`synochat: processing message for session ${sessionId}, from=${username}(${userId})`);

    // Command detection
    if (content?.startsWith("/")) {
      const commandKey = content.split(/\s+/)[0].toLowerCase();

      if (commandKey === "/clear") {
        // Clear session inline
        try {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);
          await execFileAsync("clawdbot", ["session", "clear", "--session-id", sessionId], {
            timeout: 10000,
          });
          await sendSynoChatText({
            nasUrl: config.nasUrl,
            botToken: config.botToken,
            userId,
            text: "会话已清除，可以开始新的对话了。",
            logger: api.logger,
          });
        } catch (err) {
          api.logger.warn?.(`synochat: failed to clear session: ${err.message}`);
          await sendSynoChatText({
            nasUrl: config.nasUrl,
            botToken: config.botToken,
            userId,
            text: "会话已重置，请开始新的对话。",
            logger: api.logger,
          });
        }
        return;
      }

      const handler = COMMANDS[commandKey];
      if (handler) {
        api.logger.info?.(`synochat: handling command ${commandKey}`);
        await handler({ api, config, userId, logger: api.logger });
        return;
      }
    }

    if (!content) {
      api.logger.warn?.("synochat: empty message content");
      return;
    }

    // Route resolution
    const route = runtime.channel.routing.resolveAgentRoute({
      cfg,
      sessionKey: sessionId,
      channel: "synochat",
      accountId: "default",
    });

    const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });

    // Format envelope
    const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const body = runtime.channel.reply.formatInboundEnvelope({
      channel: "SynoChat",
      from: username || userId,
      timestamp: msgTimestamp || Date.now(),
      body: content,
      chatType: "direct",
      sender: {
        name: username || String(userId),
        id: String(userId),
      },
      ...envelopeOptions,
    });

    // Context payload
    const ctxPayload = {
      Body: body,
      RawBody: content,
      From: `synochat:${userId}`,
      To: `synochat:${userId}`,
      SessionKey: sessionId,
      AccountId: "default",
      ChatType: "direct",
      ConversationLabel: username || String(userId),
      SenderName: username || String(userId),
      SenderId: String(userId),
      Provider: "synochat",
      Surface: "synochat",
      MessageSid: `synochat-${postId || Date.now()}`,
      Timestamp: msgTimestamp || Date.now(),
      OriginatingChannel: "synochat",
      OriginatingTo: `synochat:${userId}`,
    };

    // Record session
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: sessionId,
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey: sessionId,
        channel: "synochat",
        to: String(userId),
        accountId: "default",
      },
      onRecordError: (err) => {
        api.logger.warn?.(`synochat: failed to record session: ${err}`);
      },
    });
    api.logger.info?.(`synochat: session registered for ${sessionId}`);

    // Record activity
    runtime.channel.activity.record({
      channel: "synochat",
      accountId: "default",
      direction: "inbound",
    });

    // Write user message to transcript
    await writeToTranscript({
      sessionKey: sessionId,
      role: "user",
      text: content,
      logger: api.logger,
    });

    // Broadcast user message to Chat UI
    const inboundRunId = `synochat-inbound-${Date.now()}`;
    broadcastToChatUI({
      sessionKey: sessionId,
      role: "user",
      text: content,
      runId: inboundRunId,
      state: "final",
    });

    api.logger.info?.(`synochat: dispatching to agent runtime for session ${sessionId}`);

    // Dispatch to AI agent
    const outboundRunId = `synochat-outbound-${Date.now()}`;
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload, info) => {
          if (payload.text) {
            api.logger.info?.(`synochat: delivering ${info.kind} reply, length=${payload.text.length}`);
            const formattedReply = markdownToPlainText(payload.text);
            await sendSynoChatText({
              nasUrl: config.nasUrl,
              botToken: config.botToken,
              userId,
              text: formattedReply,
              logger: api.logger,
            });
            api.logger.info?.(`synochat: sent reply to ${userId}: ${formattedReply.slice(0, 50)}...`);

            // Write AI reply to transcript
            await writeToTranscript({
              sessionKey: sessionId,
              role: "assistant",
              text: payload.text,
              logger: api.logger,
            });

            // Broadcast AI reply to Chat UI
            broadcastToChatUI({
              sessionKey: sessionId,
              role: "assistant",
              text: payload.text,
              runId: outboundRunId,
              state: info.kind === "final" ? "final" : "streaming",
            });
          }
        },
        onError: (err, info) => {
          api.logger.error?.(`synochat: ${info.kind} reply failed: ${String(err)}`);
        },
      },
      replyOptions: {
        disableBlockStreaming: true,
      },
    });
  } catch (err) {
    api.logger.error?.(`synochat: failed to process message: ${err.message}`);
    api.logger.error?.(`synochat: stack: ${err.stack}`);

    // Send error to user
    try {
      await sendSynoChatText({
        nasUrl: config.nasUrl,
        botToken: config.botToken,
        userId,
        text: `抱歉，处理消息时出现错误，请稍后重试。\n错误: ${err.message?.slice(0, 100) || "未知错误"}`,
        logger: api.logger,
      });
    } catch (sendErr) {
      api.logger.error?.(`synochat: failed to send error message: ${sendErr.message}`);
    }
  }
}

// --- Plugin Registration ---

export default function register(api) {
  gatewayRuntime = api.runtime;

  const cfg = getSynoChatConfig(api);
  if (cfg) {
    api.logger.info?.(`synochat: config loaded (nasUrl=${cfg.nasUrl})`);
  } else {
    api.logger.warn?.("synochat: no configuration found (check channels.synochat in openclaw.json)");
  }

  api.registerChannel({ plugin: SynoChatChannelPlugin });

  // Gateway method for capturing broadcast context
  api.registerGatewayMethod("synochat.init", async (ctx, nodeId, params) => {
    gatewayBroadcastCtx = ctx;
    api.logger.info?.("synochat: gateway broadcast context captured");
    return { ok: true };
  });

  // Gateway method for broadcasting
  api.registerGatewayMethod("synochat.broadcast", async (ctx, nodeId, params) => {
    const { sessionKey, runId, message, state } = params || {};
    if (!sessionKey || !message) {
      return { ok: false, error: { message: "missing sessionKey or message" } };
    }

    const chatPayload = {
      runId: runId || `synochat-${Date.now()}`,
      sessionKey,
      seq: 0,
      state: state || "final",
      message: {
        role: message.role || "user",
        content: [{ type: "text", text: message.text || "" }],
        timestamp: Date.now(),
      },
    };

    ctx.broadcast("chat", chatPayload);
    ctx.bridgeSendToSession(sessionKey, "chat", chatPayload);
    gatewayBroadcastCtx = ctx;

    return { ok: true };
  });

  const webhookPath = cfg?.webhookPath || "/synochat/callback";
  const normalizedPath = normalizePluginHttpPath(webhookPath, "/synochat/callback") ?? "/synochat/callback";

  api.registerHttpRoute({
    path: normalizedPath,
    handler: async (req, res) => {
      const config = getSynoChatConfig(api);

      // Health check
      if (req.method === "GET") {
        res.statusCode = config?.nasUrl && config?.botToken ? 200 : 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(
          config?.nasUrl && config?.botToken
            ? "synochat webhook ok"
            : "synochat webhook not configured"
        );
        return;
      }

      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, POST");
        res.end();
        return;
      }

      if (!config?.nasUrl || !config?.botToken) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("SynoChat plugin not configured");
        return;
      }

      // Parse POST body - Synology Chat sends application/x-www-form-urlencoded
      const rawBody = await readRequestBody(req);
      api.logger.info?.(`synochat: received webhook POST, body length=${rawBody.length}`);

      // Parse form data
      const params = new URLSearchParams(rawBody);
      const token = params.get("token") || "";
      const userId = params.get("user_id") || "";
      const username = params.get("username") || "";
      const text = params.get("text") || "";
      const postId = params.get("post_id") || "";
      const timestamp = params.get("timestamp") || "";

      api.logger.info?.(
        `synochat inbound: userId=${userId} username=${username} text=${text.slice(0, 80)}`
      );

      // Verify outgoing token
      if (config.outgoingToken && token !== config.outgoingToken) {
        api.logger.warn?.(`synochat: token mismatch (got=${token.slice(0, 8)}...)`);
        res.statusCode = 401;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Invalid token");
        return;
      }

      // ACK immediately
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("ok");

      // Skip empty messages
      if (!text.trim()) {
        api.logger.info?.("synochat: ignoring empty message");
        return;
      }

      // Process async
      processInboundMessage({
        api,
        userId,
        username,
        content: text.trim(),
        postId,
        timestamp: timestamp ? parseInt(timestamp, 10) * 1000 : Date.now(),
      }).catch((err) => {
        api.logger.error?.(`synochat: async message processing failed: ${err.message}`);
      });
    },
  });

  api.logger.info?.(`synochat: registered webhook at ${normalizedPath}`);
}
