# 用户自用系统的一键托管：Cloudflare 统一托管方案

## 背景

nexu 当前已经能做到「agent 在 workspace 里写网页 → 内置浏览器预览」。但这条链的产物是**临时进程**：dev server 一停就没了，没有持久数据、没有身份、关掉 app 就消失。

用户真正想要的下一步是：让 agent 帮自己开发一个**带数据库、后端、鉴权的自用系统**，然后一键上线，拿到一个随时能访问的地址。

本文记录这个能力的方案设计、已核实的基础事实、安全边界，以及分阶段路线。

## 结论先行

**可行，且 Cloudflare 有一个专门为「平台托管自己用户的代码」造的产品：Workers for Platforms（WFP）。** 它把这件事最贵的三个问题——不可信代码隔离、scale-to-zero、无数量上限——在基础设施层直接解决了。

但有两个判断必须写死：

1. **数据库不能 per-app 开 Supabase 项目**，那条路的成本是正确方案的 40 倍。默认走 D1，Supabase 降级为用户自带账号的可选升级。
2. **统一托管强制引入云端 broker**。我们的 CF API Token 绝不能下发到用户机器。

## 已核实的基础事实

截至 2026-07-30 核实：

| 事实 | 数字 | 对方案的意义 |
|---|---|---|
| Workers for Platforms 定价 | **$25/月 Paid 计划**（已非 Enterprise-only），**前置要求 Workers Paid $5/月** → 合计 **$30/月起** | 账号级固定成本，小团队即可上手，不随应用数线性增长 |
| dispatch namespace 容量 | **Worker 数量无限**，无 per-account script 上限 | 托管数千用户应用无硬顶 |
| user Worker 隔离 | **默认 untrusted 模式** | 不可信代码隔离由 Cloudflare 承担 |
| WFP 计费口径 | 按入站请求计费，**subrequest 不计费** | 零流量应用≈零成本，scale-to-zero 与生俱来 |
| D1 数量上限 | Paid **50,000 个 database**/账户（Free 仅 10，本方案一 app 一库会很快撞到这个免费上限） | per-app 一个独立库完全可行，但需要已经买了的 Workers Paid |
| Supabase Pro | $25/月，**每多一个项目 +$10/月** | per-app 开项目的成本陷阱来源 |
| Cloudflare Access | **免费 50 座席**，无需 Zero Trust 付费层 | 鉴权可零代码实现 |
| 自定义域名 + Worker Route | **Free zone plan 即可**，域名托管在 Cloudflare 上就满足条件 | zone 本身不需要升级到 Pro/Business |

### 成本对照（100 个自用应用，单人使用、99% 时间空闲）

| 方案 | 月成本 |
|---|---|
| WFP（$30 账号固定成本）+ D1 per app | **$30**，且不随应用数增长 |
| per-app 一个 Supabase 项目 | $25 + 99×$10 = **$1,015** |

差逾 30 倍。这些应用的画像是**数量多、单应用 QPS 趋近 0、绝大部分时间完全空闲**——为空转付全价是这个方案里最容易犯、也最贵的错。

**来源（本节新增）：**
[WFP 前置 Workers Paid 要求](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/) ·
[Workers 自定义域名对 zone 计划的要求](https://developers.cloudflare.com/workers/configuration/routing/routes/)

**来源：**
[WFP 定价](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/) ·
[WFP 工作原理](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/) ·
[D1 限制](https://developers.cloudflare.com/d1/platform/limits) ·
[D1 定价](https://developers.cloudflare.com/d1/platform/pricing/) ·
[Supabase Management API](https://supabase.com/docs/reference/api/introduction) ·
[Supabase 定价](https://uibakery.io/blog/supabase-pricing) ·
[Cloudflare Zero Trust 定价](https://zerotrustcost.com/cloudflare-zero-trust-pricing)

## 架构

```
┌─────────────────────────────┐
│ nexu desktop                │
│  · agent 在 workspace 开发   │
│  · 本地 esbuild 打包         │  ← 构建在用户机器上完成
└──────────┬──────────────────┘
           │ HTTPS（用户身份鉴权），只传构建产物
           ▼
┌─────────────────────────────┐
│ nexu deploy broker（云端）    │  ← 新组件，持有 CF API Token
│  · 配额校验                  │
│  · 滥用检测                  │
│  · 控制面状态                │
│  自身跑在 Workers + D1 上     │
└──────────┬──────────────────┘
           │ Cloudflare API
           ▼
┌─────────────────────────────┐
│ Cloudflare                  │
│  [Access]  邮箱白名单鉴权     │
│      ▼                      │
│  [Dispatch Worker]  子域路由  │
│      ▼                      │
│  [dispatch namespace]        │
│    user worker × N（untrusted）│
│      ▼                      │
│  [D1 × N]  一应用一库         │
└─────────────────────────────┘
```

请求路径：`app-<id>.happywork.today` → Access 校验邮箱 → Dispatch Worker 按子域查表 → 取对应 user worker → user worker 读自己的 D1。

`happywork.today` 是专用于承载用户应用的独立域名，与品牌域名 `picaso.studio` 隔离；子域必须是一级——原因见「大陆可达性」章节。

## 关键设计决策

### 1. 鉴权不写在应用里，放在边缘

**决策：用 Cloudflare Access 做鉴权，agent 生成的应用中零行 auth 代码。**

理由：「给自己用的系统」的鉴权需求就是「只有我能进」。让 agent 去实现 login 会引入一整类漏洞——密码哈希、会话固定、JWT 校验错误、忘记加中间件的路由。Access 挡在子域前面，只放行用户本人邮箱，OTP 邮件验证，这些漏洞在设计上不存在。

应用若需知道「当前是谁」，从 Access 注入的 header 读取身份即可。

职责划分（避免歧义）：

| 层 | 负责 |
|---|---|
| Cloudflare Access（边缘，请求到达 Worker 之前） | **认证**：判定来访者是否为白名单邮箱，未通过者直接被拦在门外 |
| Dispatch Worker | **校验 Access JWT 签名**，再按子域路由到对应 user worker，并把已验明的身份注入 header |
| user worker | 只读取上游注入的身份 header，**自身不做任何鉴权** |

**安全前提：user worker 必须不可直达。** WFP 中 dispatch namespace 里的 worker 默认没有自己的公网路由，只能被 dispatch worker 调用——这正好保证了「绕过 Access 直连应用」这条路不存在，因此 JWT 校验只需在 dispatch worker 做一次，不必信任每个 user worker 自己校验。

### 2. 数据库：默认 D1 per app

**决策：每个应用一个独立 D1 database。Supabase 仅作为用户自带账号的升级路径。**

理由：
- 物理隔离，跨租户数据泄漏在结构上不可能（对比共享 Postgres + RLS，一个策略写错就漏）
- 成本趋近于零，50,000 个库的上限远超可预见规模
- 单用户系统的数据量距离 D1 单库 10GB 上限极远

Supabase 的位置：用户明确需要 pgvector、复杂 SQL、realtime 时，**接他自己的 Supabase 账号**。我们不代持、不代付、不承担那部分数据责任。

### 3. 构建在用户机器上完成

**决策：nexu desktop 本地 esbuild 打包，只把产物上传给 broker。**

理由：省掉云端构建集群这整个子系统，同时避免在自己云上执行不可信的构建脚本（`npm install` 里的 postinstall 是真实攻击面）。

### 4. agent 生成代码必须被约束在白名单栈

**决策：提供官方 scaffold skill，agent 只能在给定模板与依赖白名单内生成代码。**

理由：**Workers 运行时不是 Node.js。** 即使有 `nodejs_compat`，仍有大量 npm 包跑不起来。放开让 agent 自由发挥，结果是部署成功率无法预期。

默认栈：**Hono + D1 + Drizzle**。选 Hono 的额外好处是与 `apps/controller` 同构，模板和约定可复用。

拒绝清单：依赖 `node:fs`、原生模块、需要长时间 CPU 的库。

### 5. DeployTarget 抽象——为「国内底座」留缝

**决策：控制面不直接调 Cloudflare API，面向抽象编程。**

```ts
interface DeployTarget {
  provision(appId: string): Promise<{ hostname: string }>;
  uploadBundle(appId: string, bundle: Uint8Array): Promise<void>;
  provisionDatabase(appId: string): Promise<DbBinding>;
  configureAccess(appId: string, allowedEmails: readonly string[]): Promise<void>;
  destroy(appId: string): Promise<void>;
}
```

第一个实现 `CloudflareTarget`；国内实现（阿里云 FC / 腾讯云 SCF + RDS + 自建鉴权）后补。broker、skill、前端均不感知底座身份。

这让「国内 + 海外都要」从**现在做两套**降级为**现在留缝、以后补第二块**：目标不变，代价推后。

**定位修正（备案豁免成立后）**：既然不需要国内合规底座，这个抽象已从「必需品」降级为**便宜的保险**——一个 interface 的成本极低，而它对冲的是真实风险：Cloudflare 域名在大陆被封时需要有退路。保留，但不再是路线图上的关键路径。

## 安全边界

### CF API Token 绝不下发到客户端

统一托管模式下，这个 token 能操作我们整个 CF 账号。一旦出现在用户机器上，任何用户都可以删掉所有其他人的应用。**这是 broker 组件存在的根本原因**，不是架构洁癖。

### 单用户滥用是账号级存在性风险

所有用户应用共享我们同一个 CF 账号的同一个 dispatch namespace。某个用户搭钓鱼站或挖矿，Cloudflare 的处置对象是**我们的账号**，不是那个用户——后果是所有人的应用同时下线。

这是托管平台的标准失效模式。因此滥用检测与秒级下线**属于第一天的功能，不是 v2**。

可用的检测位点：
- **Outbound Worker**（WFP 特有）可拦截 user worker 的全部出站请求——检测挖矿回传、凭证外发的天然位置
- bundle 上传时的静态可疑模式扫描
- 请求量与 CPU 时间异常告警

### 配额必须服务端强制

桌面端的任何限制都可被绕过。请求数、CPU 时间、D1 存储、应用数量的配额判定全部在 broker 侧执行。

### 删除必须完整

`destroy` 需清理 user worker、D1 database、Access 策略、子域映射与控制面记录。任何一处遗漏都会变成静默账单或悬空数据。

## 控制面数据模型（broker 侧）

```
app
  id            应用公开 ID（cuid2）
  ownerId       nexu 用户
  name          显示名
  hostname      分配的子域
  d1DatabaseId  绑定的 D1 库
  allowedEmails Access 白名单
  status        active | suspended | deleting
  quota         请求数 / 存储 / CPU 上限
  lastDeployAt
  createdAt
```

## 大陆可达性（取代原「国内合规」章节）

### 备案不适用

现有域名 `picaso.studio` 已托管在 Cloudflare。境外服务器 + 境外域名**不触发 ICP 备案要求**，因此原方案中「国内底座 + 备案 + 增值电信业务许可证 + 内容审核」这一整块工作不需要了。

这是方案的一次重大简化：从「两套底座」缩回「一套底座 + 可达性风险管理」。

### 但备案豁免不等于可达性保证

GFW 的封锁是独立于备案的机制。Cloudflare 社区中「站点在大陆突然无法访问」是高频问题，包含「上周开始被封」这类突发案例——可达性是**不稳定状态**，不是一次性结论。

单点测速（一个运营商、一个时段、一个地点、且很可能是静态资源 CDN 命中）不足以推断动态应用的体验。本方案托管的是 Worker + D1 动态请求，每次访问都要回源执行与查库，没有边缘缓存兜底，延迟画像与静态页显著不同。

**结论：不做大陆可达性承诺，只做可达性监测与降级预案。**

### 用独立域名承载用户应用（已落定）

> **2026-10-26 更新：** `happywork.today` 已改作产品主域名——门户 `tabby.happywork.today`、下载 `downloads.happywork.today`、API `ai.happywork.today`。用户应用托管不再使用它，上线前需另选一个独立域名；下文的隔离理由仍然成立，只是被隔离的域名换了。

**决策：用户应用使用 `happywork.today`，与品牌域名 `picaso.studio` 完全隔离。**

于 2026-07-30 通过 Cloudflare Registrar 注册，NS 为 `marty.ns.cloudflare.com` / `dee.ns.cloudflare.com`，与 `picaso.studio` 同属一个 Cloudflare 账号——这是必要条件，broker 需用单一 API Token 管理该 zone。

理由：GFW 封锁按域名发生。若所有用户应用共享品牌域名的子域，任一用户的应用内容触发封锁，被封的是**整个品牌域名**。这与「单用户滥用导致 CF 账号被封」属于同一类风险的第二个副本，且代价更高——品牌域名的可达性不该押在用户生成内容上。

域名成本远低于品牌域名不可达的代价。

### 子域命名必须是一级子域

**决策：应用地址格式为 `app-<id>.happywork.today`，不使用多级子域。**

理由：Cloudflare Universal SSL 免费覆盖 zone apex 与**一级**子域（`*.happywork.today`），但不覆盖 `*.apps.happywork.today` 这类多级通配符。后者需要 Advanced Certificate Manager（$10/月，首次 provision 最长 24 小时）。

改用一级子域即可免费获得证书覆盖，无需 ACM。

### HSTS 必须手动配置（`.today` 无 TLD 级强制）

**决策：在 Cloudflare zone 上手动启用 Always Use HTTPS 与 HSTS，且必须开启 `includeSubDomains`。**

背景：HSTS preload 名单中的 TLD 为 `.app`、`.dev`、`.page`、`.new`、`.rsvp`、`.day`、`.bank`、`.insurance`。**`.today` 与 `.day` 是不同的 TLD，前者不在名单内**——因此不存在 TLD 级的 HTTPS 强制，浏览器首次访问仍可能走 HTTP 并被降级攻击。

必做配置（Cloudflare → SSL/TLS → Edge Certificates）：

1. **Always Use HTTPS** 启用
2. **HSTS** 启用，其中 `includeSubDomains` **必须勾选**——所有用户应用位于 `app-xxx.happywork.today` 子域，不勾选则子域毫无保护，配置等于无效
3. 可选：满足 `max-age ≥ 1 年 + includeSubDomains + preload` 后向 [hstspreload.org](https://hstspreload.org/) 提交该域名，取得域名级 preload

第 3 项需注意：**preload 准不可逆**，退出名单需数月并依赖浏览器版本更新周期。对长期运营的托管域名有利，但应在确认长期使用后再提交。

**来源：** [HSTS preload 提交与 TLD 名单](https://hstspreload.org/) · [Google Registry 的 HSTS preload TLD 说明](https://kb.porkbun.com/article/96-hsts-preload-and-google-registry)

**来源：**
[Universal SSL 文档](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/) ·
[多级子域限制说明](https://davehogan.co.uk/posts/development/cloudflare-ssl-mutlilevel-subdomains/) ·
[大陆访问受阻案例](https://community.cloudflare.com/t/site-started-getting-blocked-in-mainland-china-last-weeek/738851)

## 分阶段路线

| 阶段 | 内容 | 估算 |
|---|---|---|
| **0** | 底座跑通：WFP + D1 + Access，独立应用域名，邀请制，硬编码配额，`DeployTarget` 接口就位 | 2-3 周 |
| **1** | 滥用检测 + 配额强制 + 用量计费 + 秒级下线 | +3-4 周 |
| **2** | 大陆可达性监测 + 封锁应急预案 | +1 周 |

原阶段 2「国内底座 + 备案 + 内容审核」（+2~3 个月）因备案豁免成立而**取消**，替换为轻量的可达性监测。这是本方案迄今最大的一次简化。

阶段 0 的核心价值是拿真实阻力校准后续判断——尤其是「agent 生成的代码在 Workers 运行时上究竟有多少跑不起来」，这个数字目前无人能准确预估。

## 阶段 0 必须先验证的事实

以下几点尚未核实，会影响实现细节，应在写代码前用最小实验确认：

1. **Workers Assets 在 dispatch namespace 内是否可用**——决定静态资源是随 worker 上传，还是必须走 R2 加一层。
2. **Access 能否对通配符子域配置单一应用策略**，还是每个子域都要建一条策略（后者影响 provision 流程与 API 调用量）。
3. **Outbound Worker 的实际拦截粒度与性能开销**——决定它能否作为主要滥用检测手段。
4. **D1 迁移执行路径**：通过 broker 调 D1 HTTP API 按序执行迁移，与已执行版本的记录方式。
5. **Access 登录页在大陆的可达性**——登录流程会跳转至 `<team>.cloudflareaccess.com`。若该域名在大陆不可达，则鉴权链断裂、应用完全不可用，**即使应用自身域名畅通**。这是一个未验证的单点故障，必须实测，不能假设。
6. **动态请求的大陆真实延迟**——用 Worker + D1 查询实测，不能用静态页 CDN 命中的测速结果推断。建议覆盖多运营商与晚高峰时段。

## 开放问题

- 免费额度与计费的具体数字（每用户几个应用、多少请求）
- 是否允许用户绑定自有域名（会显著改变 Access 与证书流程）
- 应用之间是否需要互相调用（当前假设：不需要）
- 用户在 nexu 中触发部署的入口形态：聊天里说「部署」，还是 web 端「我的应用」页面提供显式按钮（当前倾向两者都要，前者为主）

## 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 单用户滥用导致 CF 账号被封，全平台下线 | 高 | Outbound Worker 监控 + 上传扫描 + 秒级下线能力，第一天就位 |
| CF API Token 泄漏 | 高 | 仅存于 broker，永不下发客户端 |
| 账单被刷 | 中 | 服务端强制配额 + 用量异常告警 |
| agent 生成代码在 Workers 上跑不起来 | 中 | 白名单栈 + 官方 scaffold + 部署前本地冒烟 |
| 用户应用内容触发 GFW 封锁，波及整个域名 | 高 | ✅ 已缓解：用户应用走独立域名 `happywork.today`，与 `picaso.studio` 隔离 |
| `.today` 无 TLD 级 HSTS，首访可被降级 | 中 | zone 上启用 Always Use HTTPS + HSTS（含 `includeSubDomains`）；可选提交域名级 preload |
| Access 登录页在大陆不可达致鉴权链断裂 | 中 | 阶段 0 实测；若不可达则需自建轻量鉴权作为备选 |
| 大陆可达性突然劣化 | 中 | 可达性监测 + 封锁应急预案（阶段 2）；`DeployTarget` 作为底座切换退路 |
| 删除不彻底造成静默账单 | 低 | destroy 全链路清理 + 定期对账巡检 |
