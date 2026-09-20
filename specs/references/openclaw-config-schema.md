# OpenClaw config.json Schema 参考

Config 生成器必须输出符合此格式的 JSON。OpenClaw gateway 通过 chokidar 监听文件变更自动热加载。

---

## 顶层结构

```jsonc
{
  "gateway":  { /* 必填：服务器配置 */ },
  "models":   { /* 可选：LLM provider（LiteLLM 等） */ },
  "agents":   { /* 必填：Agent 列表 */ },
  "channels": { /* 必填：Channel 账号 */ },
  "bindings": [ /* 必填：路由规则 */ ],
  "skills":   { /* 可选：技能热加载 */ },
  "commands": { /* 可选：命令控制 */ },
  "plugins":  { /* 可选：插件启用 */ },
  "update":   { /* 可选：自更新策略。打包版置 checkOnStart:false，禁用开机查 npm 新版（registry.npmjs.org/openclaw/latest），避免受限网络下卡启动 */ }
}
```

---

## gateway

```json
{
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "loopback",
    "auth": { "mode": "token", "token": "gw-secret-token" },
    "reload": { "mode": "hybrid" }
  }
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `port` | number | 18789 | 监听端口 |
| `mode` | `"local"` \| `"remote"` | - | 必须设为 `"local"` |
| `bind` | `"loopback"` \| `"lan"` \| `"auto"` | `"loopback"` | 网络绑定 |
| `auth.mode` | `"none"` \| `"token"` | `"token"` | 认证模式 |
| `auth.token` | string | - | 共享 token（`mode: "token"` 时必填） |
| `reload.mode` | `"off"` \| `"hot"` \| `"hybrid"` | `"hybrid"` | 热加载策略 |

---

## models

自定义 LLM 提供商配置。**当使用 LiteLLM 代理时必填。**

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "litellm": {
        "baseUrl": "https://litellm.example.com",
        "apiKey": "sk-your-key",
        "api": "openai-completions",
        "models": [
          {
            "id": "anthropic/claude-sonnet-4",
            "name": "Claude Sonnet 4",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 8192,
            "compat": { "supportsStore": false }
          }
        ]
      }
    }
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | `"merge"` \| `"replace"` | `merge` = 追加到内置 provider；`replace` = 覆盖 |
| `providers.<name>.baseUrl` | string | Provider API 地址 |
| `providers.<name>.apiKey` | string | API key |
| `providers.<name>.api` | string | API 协议，LiteLLM 用 `"openai-completions"` |
| `providers.<name>.models[].id` | string | 模型 ID（需与 provider 实际 ID 匹配） |
| `providers.<name>.models[].compat.supportsStore` | boolean | **LiteLLM/Bedrock 必须设为 `false`**，否则发送 `store` 参数导致 400 |

### 模型 ID 前缀规则

在 `agents.defaults.model` 和 `agents.list[].model` 中引用自定义 provider 的模型时，必须加 provider 名称前缀：

```
原始 model ID:  anthropic/claude-sonnet-4
引用时写:       litellm/anthropic/claude-sonnet-4
              ^^^^^^^^ provider 名称作前缀
```

Config 生成器在检测到 `LITELLM_BASE_URL` 环境变量时会自动添加此前缀。

### Amazon Bedrock (`aws-sdk`)

Bedrock 使用 OpenClaw 的 AWS SDK 认证链，不在 Nexu 配置中保存 Access Key 或 Secret Key：

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "amazon-bedrock": {
        "baseUrl": "https://bedrock-runtime.us-east-1.amazonaws.com",
        "auth": "aws-sdk",
        "api": "bedrock-converse-stream",
        "models": [
          {
            "id": "us.anthropic.claude-sonnet-4-20250514-v1:0",
            "name": "Claude Sonnet 4",
            "compat": { "supportsStore": false }
          }
        ]
      }
    }
  }
}
```

- `auth: "aws-sdk"` 强制使用运行 Nexu/OpenClaw 进程可见的 AWS 默认凭据链；`apiKey` 应省略。
- OpenClaw 不接受 `models.bedrockDiscovery`。自动发现属于外置 `@openclaw/amazon-bedrock-provider` 插件，其配置路径是 `plugins.entries.amazon-bedrock.config.discovery`；Nexu 当前不会把旧字段写入运行时配置。
- 外置的不只是自动发现：`bedrock-converse-stream` 这个 api 本身就由该插件注册。2026.9.4 随包分发 60 个 bundled extension（含 `google`、`minimax`），其中没有 bedrock，所以在未安装该插件的运行时里，Bedrock 的 probe 会直接返回 `No API provider registered for api: bedrock-converse-stream`。2026.8.2 同样如此，不是升级引入的。Nexu 未打包该插件，而打包后的桌面端不允许用 npm/npx 安装（见 AGENTS.md 硬规则）。由于保存 Bedrock 配置要求实时 probe 返回 `ok`，该表单在缺插件时根本无法保存成功，用户只会看到误导性的「检查凭据/区域/网络」错误，因此 registry 已将 `amazon-bedrock` 的 `modelsPageVisible` 置为 `false`，把它从「设置 → 模型」中摘除；`controllerConfigurable` 保持 `true`，API enum 与既有配置不受影响。若将来随包提供该插件，把这个开关改回 `true` 即可恢复入口。
- 保存前必须填写当前区域已授权的模型或推理配置 ID。验证通过打包的 OpenClaw 执行最小 token 实时 probe；只有目标 `amazon-bedrock/<modelId>` 明确返回 `ok` 才算成功。
- 临时 probe 只加载正式运行时扩展目录中的 `amazon-bedrock` 插件。插件未安装时返回明确的不可用错误，不会把传输层缺失误报为 AWS 凭据失败。
- 认证、限流、计费权限、格式、超时和无可用模型错误只映射为安全的产品错误，不透传 CLI 输出，避免日志或界面泄露凭据上下文。

---

## agents

```json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-sonnet-4-20250514"
    },
    "list": [
      {
        "id": "tenant-abc",
        "name": "ABC Corp Bot",
        "default": true,
        "workspace": "/data/workspaces/tenant-abc"
      }
    ]
  }
}
```

### agents.list[] 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | **是** | 唯一标识符，用于 `bindings[].agentId` 匹配 |
| `name` | string | 否 | 显示名称 |
| `default` | boolean | 否 | 标记为默认 agent（最多一个） |
| `workspace` | string | 否 | 工作目录路径 |
| `model` | string \| `{ primary, fallbacks }` | 否 | 模型覆盖 |

---

## channels

### 飞书 (feishu)

```json
{
  "channels": {
    "feishu": {
      "accounts": {
        "feishu-tenant-abc": {
          "enabled": true,
          "appId": "cli_a1b2c3d4",
          "appSecret": "secret_value",
          "connectionMode": "websocket",
          "streaming": true,
          "renderMode": "card",
          "replyInThread": "enabled",
          "mediaMaxMb": 30,
          "tts": { "auto": "inbound" }
        }
      }
    }
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 启用/禁用 |
| `appId` | string | 飞书应用 ID |
| `appSecret` | string | 飞书应用密钥 |
| `connectionMode` | `"websocket"` \| `"webhook"` | 连接模式。webhook 模式需额外设 `verificationToken` |
| `verificationToken` | string | webhook 验证 token（webhook 模式必填） |
| `webhookPath` | string | webhook 路径（如 `/feishu/events/tenant-abc`） |
| `domain` | `"feishu"` \| `"lark"` | API 域名（国内用 feishu，国际用 lark） |
| `dmPolicy` | `"open"` \| `"pairing"` \| `"allowlist"` | 私聊策略 |
| `groupPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | 群聊策略 |
| `requireMention` | boolean | 是否需要 @mention 才响应（群消息） |
| `allowFrom` | string[] | 允许的用户 open_id 列表；`dmPolicy`/`groupPolicy` 为 `"allowlist"` 时生效 |
| `streaming` | boolean | 是否使用流式卡片更新回复 |
| `renderMode` | `"auto"` \| `"raw"` \| `"card"` | 回复渲染格式；`raw` 为纯文本，`card` 为交互卡片 |
| `replyInThread` | `"enabled"` \| `"disabled"` | 是否在飞书话题线程中回复 |
| `mediaMaxMb` | number | 单条音频、图片、文件或视频的媒体大小上限（MB） |
| `tts.auto` | `"off"` \| `"always"` \| `"tagged"` \| `"inbound"` | 自动语音回复策略 |

> **UI control:** `requireMention`, `dmPolicy`, `groupPolicy`, and `allowFrom` can be configured per feishu channel via the Permissions panel in the UI. When not set (channel.feishuPermissions === null), the compiler emits historical defaults (requireMention=true, dmPolicy=open, groupPolicy=open, allowFrom=["*"]).

> **Delivery capabilities:** `streaming`, `renderMode`, `replyInThread`, `mediaMaxMb`, and `tts.auto` are configured per account in the Message capabilities panel. Audio, image, file, and video support is supplied by the bundled Feishu runtime; `tts.auto` controls generated voice replies, not whether inbound media can be received.

### Slack

Slack channel 有**顶层字段**和 **account 字段**两级。顶层控制全局默认策略，account 级别控制单个 workspace。

```json
{
  "channels": {
    "slack": {
      "mode": "http",
      "signingSecret": "abc123",
      "enabled": true,
      "groupPolicy": "open",
      "requireMention": false,
      "dmPolicy": "open",
      "allowFrom": ["*"],
      "accounts": {
        "slack-team-T123": {
          "enabled": true,
          "botToken": "xoxb-...",
          "signingSecret": "abc123",
          "mode": "http",
          "webhookPath": "/slack/events/team-T123",
          "appToken": "xapp-placeholder-not-used-in-http-mode",
          "replyToMode": "all",
          "streaming": {
            "mode": "progress",
            "nativeTransport": true,
            "progress": {
              "nativeTaskCards": true,
              "render": "rich",
              "toolProgress": true,
              "commandText": "status"
            }
          }
        }
      }
    }
  }
}
```

#### 顶层字段（`channels.slack.*`）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mode` | `"socket"` \| `"http"` | **是** | 连接模式，多租户必须 `"http"` |
| `signingSecret` | string | **是** | 顶层需要一个 signingSecret（可用任一 account 的） |
| `enabled` | boolean | 推荐 | 启用/禁用 |
| `groupPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | **推荐** | 频道消息策略。**不设时运行时默认 `"allowlist"`，bot 会忽略所有频道消息** |
| `requireMention` | boolean | **推荐** | 是否需要 @mention 才响应。**默认 `true`** |
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` | **推荐** | 私聊策略 |
| `allowFrom` | string[] | 条件必填 | 允许的用户/频道。**`dmPolicy: "open"` 时必须设为 `["*"]`** |

#### account 字段（`channels.slack.accounts.<id>.*`）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `enabled` | boolean | 是 | 启用/禁用 |
| `botToken` | string | **是** | Bot token (`xoxb-...`) |
| `signingSecret` | string | HTTP 模式 | Signing secret |
| `appToken` | string | **是** | HTTP 模式下也必填（placeholder 即可），用于通过 `isConfigured` 检查 |
| `mode` | `"socket"` \| `"http"` | 是 | 连接模式 |
| `webhookPath` | string | HTTP 模式 | webhook 路径，如 `/slack/events/slack-T123` |
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` | 否 | 覆盖顶层 |
| `groupPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | 否 | 覆盖顶层 |
| `replyToMode` | `"off"` \| `"first"` \| `"all"` \| `"batched"` | 否 | 是否将回复放入 Slack thread |
| `streaming.mode` | `"off"` \| `"partial"` \| `"block"` \| `"progress"` | 否 | 实时响应模式 |
| `streaming.nativeTransport` | boolean | 否 | 使用 Slack 原生流式传输 |
| `streaming.progress.nativeTaskCards` | boolean | 否 | progress 模式下显示 Slack 原生任务卡片 |
| `streaming.progress.render` | `"text"` \| `"rich"` | 否 | 进度卡片渲染方式 |
| `streaming.progress.toolProgress` | boolean | 否 | 是否在进度卡片中显示工具执行进度 |
| `streaming.progress.commandText` | `"raw"` \| `"status"` | 否 | 命令执行文本的显示方式 |

> **UI control:** `replyToMode`, `streaming.mode`, and `streaming.progress.nativeTaskCards` are configurable per Slack workspace. Native task cards are only emitted when `streaming.mode` is `"progress"`; disabling progress mode clears the card toggle.

---

## bindings

路由规则：将 channel 消息分发到指定 agent。

```json
{
  "bindings": [
    {
      "agentId": "tenant-abc",
      "match": {
        "channel": "feishu",
        "accountId": "feishu-tenant-abc"
      }
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | **是** | 必须匹配 `agents.list[].id` |
| `match.channel` | string | **是** | channel 类型（`"feishu"`, `"slack"` 等） |
| `match.accountId` | string | 推荐 | 必须匹配 `channels.<type>.accounts` 的 key |

### 路由优先级（从高到低）

1. peer 精确匹配（channel + account + peer）
2. guild + roles（Discord）
3. guild（Discord）
4. team（Slack）
5. **account（最常用：channel + accountId）**
6. channel 通配（`accountId: "*"`）
7. 默认 agent

---

## skills

技能热加载配置。Config 生成器自动设置。

```json
{
  "skills": {
    "load": {
      "watch": true,
      "watchDebounceMs": 250,
      "extraDirs": ["/data/openclaw/skills"]
    }
  }
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `load.watch` | boolean | `false` | 启用 chokidar 文件监听，检测 SKILL.md 变化后自动刷新 snapshot |
| `load.watchDebounceMs` | number | `250` | 文件变化去抖时间（毫秒） |
| `load.extraDirs` | string[] | `[]` | 额外技能扫描目录。**必须包含 sidecar 写入目录**（`${OPENCLAW_STATE_DIR}/skills`），否则 managed skills 在生产环境不可见 |

### 常见坑点

17. **`extraDirs` 必须包含 sidecar 写入路径** — OpenClaw 默认只扫描 `CONFIG_DIR/skills`（基于 `os.homedir()`）和 workspace 目录。sidecar 写入的 `${OPENCLAW_STATE_DIR}/skills` 在生产容器中通常与这些路径不同，必须通过 `extraDirs` 显式添加。

---

## commands

控制 Gateway 命令系统行为。Config 生成器自动设置。

```json
{
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "restart": false,
    "ownerDisplay": "raw"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `native` | `"auto"` \| `"off"` | 原生命令（`/help` 等） |
| `nativeSkills` | `"auto"` \| `"off"` | 原生技能 |
| `restart` | boolean | 是否允许通过命令重启 |
| `ownerDisplay` | `"raw"` \| `"friendly"` | 用户名显示模式 |

Nexu 不生成 wildcard `commands.ownerAllowFrom`。随包 OpenClaw 2026.7.1 会把 `ownerAllowFrom: ["*"]` 解析为任意渠道发送者都是 owner，因此该配置会越权开放 `nodes`、`gateway`、`cron` 等本机控制工具。真实 owner 必须使用带渠道前缀的明确身份，并由后续产品化的 owner 配置流程写入。

---

## 完整示例：3 租户（2 飞书 + 1 Slack）

```json
{
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "lan",
    "auth": { "mode": "token", "token": "gw-secret-2026" },
    "reload": { "mode": "hybrid" }
  },
  "agents": {
    "defaults": {
      "model": "anthropic/claude-sonnet-4-20250514"
    },
    "list": [
      {
        "id": "acme-corp",
        "name": "Acme Corp Bot",
        "default": true,
        "workspace": "/data/workspaces/acme-corp"
      },
      {
        "id": "globex-inc",
        "name": "Globex Inc Bot",
        "workspace": "/data/workspaces/globex-inc"
      },
      {
        "id": "initech-llc",
        "name": "Initech LLC Bot",
        "workspace": "/data/workspaces/initech-llc",
        "model": { "primary": "openai/gpt-4o" }
      }
    ]
  },
  "channels": {
    "feishu": {
      "accounts": {
        "feishu-acme": {
          "enabled": true,
          "appId": "cli_a1b2c3d4e5",
          "appSecret": "secret_acme"
        },
        "feishu-globex": {
          "enabled": true,
          "appId": "cli_f6g7h8i9j0",
          "appSecret": "secret_globex",
          "domain": "lark"
        }
      }
    },
    "slack": {
      "accounts": {
        "slack-initech": {
          "enabled": true,
          "botToken": "xoxb-initech-token",
          "signingSecret": "initech-signing-secret",
          "mode": "http",
          "webhookPath": "/slack/events/initech"
        }
      }
    }
  },
  "bindings": [
    { "agentId": "acme-corp",   "match": { "channel": "feishu", "accountId": "feishu-acme" } },
    { "agentId": "globex-inc",  "match": { "channel": "feishu", "accountId": "feishu-globex" } },
    { "agentId": "initech-llc", "match": { "channel": "slack",  "accountId": "slack-initech" } }
  ],
  "plugins": {
    "entries": {
      "feishu": { "enabled": true }
    }
  }
}
```

Nexu 编译器默认省略 `plugins.allow` 与 `plugins.deny`，让 OpenClaw 发现所有已安装插件；需要平台配置或显式开关的插件仍写入 `plugins.entries`。不得用静态插件目录白名单阻断用户后来安装的插件。

---

## 常见坑点

### 基础

1. **`accountId` 是 accounts 对象的 key，不是 appId**
   ```
   正确: "accountId": "feishu-acme"     (匹配 accounts.feishu-acme)
   错误: "accountId": "cli_a1b2c3d4e5"  (这是 appId，不是 key)
   ```

2. **`agentId` 大小写不敏感**，内部会 normalize 为小写

3. **省略 `accountId` 匹配的是 "default" 账号**，不是通配。通配用 `"*"`

4. **一个 config 中只能有一个 `default: true` 的 agent**

5. **`workspace` 目录必须存在**，gateway 不会自动创建

### Slack 专项（极易踩坑）

6. **`groupPolicy` 不设就是 `"allowlist"`** — Gateway 运行时 `resolveOpenProviderRuntimeGroupPolicy` 会在无显式配置时回退到 `"allowlist"`，导致 bot 默默丢弃所有频道消息而不报错。**务必显式设 `"groupPolicy": "open"`**。

7. **`requireMention` 默认 `true`** — `defaultRequireMention` 在代码中 `?? true`。如果希望 bot 回应所有消息而非仅 @mention，需显式设 `false`。

8. **`dmPolicy: "open"` 必须配套 `allowFrom: ["*"]`** — 否则 Gateway 启动时 schema 校验报错 `dmPolicy="open" requires allowFrom to include "*"`。

9. **Slack HTTP 模式必须设 `signingSecret`**，Socket 模式必须设 `appToken`

10. **Slack account 必须设 `appToken`（即使 HTTP 模式不用它）** — OpenClaw Slack 插件的 `isConfigured` 检查会验证该字段。用 `"xapp-placeholder-not-used-in-http-mode"` 占位即可。

11. **顶层 `channels.slack` 需要 `mode` 和 `signingSecret`** — 不只是 account 里需要，顶层也得有，否则 gateway 验证不通过。

### 模型（LiteLLM）

12. **Model ID 必须加 provider 前缀** — agents 里写 `"litellm/anthropic/claude-sonnet-4"`，models.providers 里的 `id` 写 `"anthropic/claude-sonnet-4"`（无前缀）。

13. **LiteLLM/Bedrock 模型必须设 `compat.supportsStore: false`** — OpenClaw 默认发送 `store: false` 参数（OpenAI 协议字段），Bedrock 不识别该字段会返回 400 `"store: Extra inputs are not permitted"`。

14. **Model ID 必须与 provider 实际支持的匹配** — 用 `curl <base_url>/v1/models -H "Authorization: Bearer <key>"` 查看可用列表，不要凭猜测填。

### 飞书

15. **飞书 webhook 模式必须设 `verificationToken`**，否则 schema 校验报错

16. **`plugins.entries.feishu.enabled: true`** 是必需的，否则飞书插件不加载
