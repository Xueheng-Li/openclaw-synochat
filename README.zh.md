# 🤖 OpenClaw SynoChat 插件

Synology Chat 聊天机器人通道插件，为 [OpenClaw](https://github.com/nicholasgriffintn/OpenClaw) 实现 Synology Chat 与 AI 代理之间的双向消息互通（基于 ZeroTier 局域网）。

## ✨ 功能特性

- 📨 **接收消息** — Synology Chat outgoing webhook → OpenClaw 代理处理
- 📤 **发送回复** — AI 生成的回复通过 Bot Incoming API 发送回去
- 🔐 **Token 认证** — outgoing webhook token 验证
- 📝 **Markdown 转换** — 将 Markdown 转换为 Synology Chat 可读的纯文本
- ✂️ **自动拆分** — 长消息拆分为多条发送
- 💬 **聊天界面集成** — 消息在 OpenClaw 聊天界面显示，带对话历史
- 🛠️ **内置命令** — `/help`, `/clear`, `/status`

## 📐 架构图

```
[Synology Chat 用户]
    → [NAS 机器人 Outgoing Webhook]
    → POST https://<gateway>/synochat/callback
    → [OpenClaw SynoChat 插件: 解析表单数据, 验证 token]
    → [AI 代理生成回复]
    → [插件: POST 回复到 NAS 机器人 Incoming API]
    → [Synology Chat 机器人 → 用户]
```

所有流量都在 ZeroTier 局域网内（如 10.0.0.x/24）。无需 SSL/XML 复杂配置 — 简单的 token 认证 + 表单/JSON 数据。

## 📦 安装步骤

1. 在 OpenClaw 网关服务器上克隆本仓库:

```bash
git clone https://github.com/Xueheng-Li/openclaw-synochat.git ~/openclaw-synochat
cd ~/openclaw-synochat
npm install
```

2. 在 `~/.openclaw/openclaw.json` 中添加插件路径:

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

3. 在 `~/.openclaw/openclaw.json` 中添加通道配置:

```json
{
  "channels": {
    "synochat": {
      "nasUrl": "https://你的NAS_IP:端口",
      "botToken": "你的机器人_INCOMING_TOKEN",
      "outgoingToken": "你的机器人_OUTGOING_TOKEN",
      "webhookPath": "/synochat/callback"
    }
  }
}
```

4. 重启网关:

```bash
systemctl --user restart openclaw-gateway.service
```

## 🔧 Synology Chat 机器人配置

### 第一步：打开机器人集成

1. 登录你的 Synology NAS DSM
2. 打开 **Synology Chat**（如未安装请先从套件中心安装）
3. 点击你的 **头像**（左下角）→ **集成**
4. 选择 **机器人** 选项卡

### 第二步：创建新机器人

1. 点击 **➕ 创建**
2. 填写:
   - **机器人名称**: `OpenClaw`（或你喜欢的名字 — 这是用户在聊天中看到的名称）
   - **Outgoing Webhook URL**: `https://<网关IP>/synochat/callback`
     - 示例: `https://你的网关IP/synochat/callback`
   - 勾选 **启用 Outgoing Webhook** ✅
   - 勾选 **启用 Incoming Webhook** ✅
3. 点击 **创建**

### 第三步：获取 Token

创建后，机器人详情页会显示:

- **Incoming Webhook URL** — 类似于:
  ```
  https://你的NAS_IP:端口/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=%22XXXXXX%22
  ```
  提取 `%22` 之间的 token 值（即编码引号之间的部分）。这就是你的 **`botToken`**。

- **Outgoing Token** — 页面显示的另一个 token 字符串。这就是你的 **`outgoingToken`**。

### 第四步：更新 OpenClaw 配置

将两个 token 放入 `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "synochat": {
      "nasUrl": "https://你的NAS_IP:端口",
      "botToken": "你提取的_INCOMING_TOKEN",
      "outgoingToken": "你的_OUTGOING_TOKEN字符串",
      "webhookPath": "/synochat/callback"
    }
  }
}
```

然后重启网关:

```bash
systemctl --user restart openclaw-gateway.service
```

### 第五步：测试

1. 在 DSM 或手机 app 上打开 Synology Chat
2. 在联系人列表中找到该机器人（或发起与其的私信）
3. 发送任意消息（如 "你好"）
4. 机器人应该回复 AI 生成的响应

如果出错，查看日志:

```bash
journalctl --user -u openclaw-gateway.service -n 50 --no-pager | grep synochat
```

### ⚠️ SSL 问题排查

如果 Synology Chat 拒绝网关的自签名证书（outgoing webhook 静默失败），有两个解决方案:

1. **将网关的 CA 证书添加到 NAS 信任存储** — DSM → 控制面板 → 安全 → 证书 → 导入
2. **使用 HTTP 回退** — 在 Caddy 中添加仅 HTTP 监听器，绑定到 ZeroTier IP 的备用端口:

   ```
   # Caddyfile
   http://你的网关IP:18790 {
       reverse_proxy localhost:18789
   }
   ```

   然后将机器人的 Outgoing Webhook URL 更新为 `http://你的网关IP:18790/synochat/callback`。

### 📝 Synology Chat 机器人 API 参考

- **Incoming（发送消息给用户）**: `POST {nasUrl}/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token="{botToken}"` 表单 body `payload={"text":"...","user_ids":[123]}`
- **Outgoing（接收用户消息）**: NAS 向你的 webhook 发送表单数据，包含字段: `token`, `user_id`, `username`, `text`, `post_id`, `timestamp`
- [官方 Synology Chat 机器人 API 文档](https://kb.synology.com/en-us/DSM/help/Chat/chat_integration)

## 📁 项目结构

```
openclaw-synochat/
├── package.json              # 插件包清单
├── openclaw.plugin.json      # OpenClaw 插件描述文件
├── src/
│   ├── index.js              # 插件主代码
│   └── openclaw.plugin.json  # 描述文件副本（从 exports 路径解析）
├── .gitignore
├── README.md                 # 英文说明
└── README.zh.md              # 中文说明
```

## ⚙️ 配置说明

配置从 `openclaw.json` 的 `channels.synochat` 读取（优先），或从环境变量读取:

| 配置键 | 环境变量 | 说明 |
|--------|----------|------|
| `nasUrl` | `SYNOCHAT_NAS_URL` | Synology NAS 基础 URL |
| `botToken` | `SYNOCHAT_BOT_TOKEN` | 机器人 incoming webhook token |
| `outgoingToken` | `SYNOCHAT_OUTGOING_TOKEN` | 用于验证 outgoing webhooks 的 token |
| `webhookPath` | `SYNOCHAT_WEBHOOK_PATH` | Webhook 路径（默认: `/synochat/callback`） |

## 🔍 验证

```bash
# 查看网关日志
journalctl --user -u openclaw-gateway.service -n 50 --no-pager | grep synochat

# 健康检查
curl https://localhost/synochat/callback
# → "synochat webhook ok"
```

## 📜 开源许可

MIT
