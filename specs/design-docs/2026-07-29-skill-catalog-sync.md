# Skill Store 服务端目录同步

## 目标

桌面端技能商店以 ClawHub 当前完整目录为准，同时避免每台桌面客户端每天下载数万条全量数据。公开入口统一使用 `tabby.happywork.today`，不再依赖 `hub.nexu.dev`。

## 数据流

```text
ClawHub packages API
  -> GitHub Actions 每周一、周四全量同步
  -> tabby.happywork.today / Cloudflare D1
  -> GET /api/v1/skill-catalog（游标分页）
  -> Nexu Controller
  -> 生成的 Web SDK / Skill Store
```

同步任务只在服务端每周一、周四运行，间隔 3-4 天。桌面端不运行定时全量同步，也不读取 D1 管理 API；它只按页面、搜索条件和分类读取公开目录 API。安装进度来自本地轻量状态接口，因此不会因轮询重复拉取目录。

## 服务端同步

- 上游：`https://clawhub.ai/api/v1/packages?family=skill&sort=updated&limit=100`。
- 同步逐页读取完整目录，限制并重试 `429`/`5xx`，永久性 `4xx` 直接失败。
- 数据和预计算 facet 先写入按 `run_id` 隔离、对外不可见的版本化快照。
- 技能分别按下载量、更新时间和收藏数预排序，每 100 条编码为一个 JSON 页；另写入 256 个 slug 精确查询桶，facet 只保留公开接口返回的 Top 24。
- 发布事务只完成 run 状态和 active pointer 两次短写入。旧快照在至少 26 小时保留期后由下一次同步清理，发布时不会影响在途请求。
- 首次同步默认少于 30,000 条、标准化失败率超过 2%、重复 identity 超过 2%，或相对上次异常缩减超过 10% 时拒绝发布。确认上游确有大规模删除后才可临时设置 `SKILL_CATALOG_ALLOW_LARGE_SHRINK=true`。
- 当前 71,591 条目录生成 2,148 个排序页和 256 个 lookup 桶，一次完整写入约产生 121 次 D1 数据写入请求；有变化的同步预计少于 5,000 rows written。
- 当前单快照逻辑数据约 140 MiB，新旧快照同时保留预计低于 300 MiB，因此先使用 D1 Free，不要求 Workers Paid。上线后需监控免费版 500 MB 容量和每日 rows read；纯搜索与分类仍会扫描 JSON 页，提高同步间隔不能解决查询额度问题。

## 桌面端读取与安装

- 目录接口使用 keyset cursor，cursor 与目录 revision、查询、分类、owner、slug 和排序条件绑定。revision 切换后旧 cursor 返回 `409`，客户端应重新开始分页。
- 首屏远端不可用时可读取旧本地缓存；远端续页失败时不切换到本地 offset，避免版本和排序混杂。
- ClawHub 新版安装使用 `@ownerHandle/slug`，并可固定镜像中记录的版本。
- ledger 持久化 `ownerHandle` 和版本。旧记录没有 owner 时继续兼容。
- owner-scoped 安装先进入同一文件系统内的 staging 目录；依赖安装完成后才删除旧版本备份，任一步失败都会恢复旧目录。
- 技能商店提供下载量、收藏数、最近更新三种服务端排序，并展示目录更新时间、发布者、版本、下载量和收藏数；浏览器不再二次过滤服务端搜索结果，因此发布者搜索可正常显示。
- 一键更新只对同一 `@ownerHandle/slug`、来源为 `managed` 且目录版本更高的安装开放。服务端重复校验来源、发布者和版本，更新期间禁止取消或卸载，完成后详情页按本地队列状态刷新已安装版本。
- 没有 owner 的旧 ledger 记录仅在 `Yours` 中保留兼容，不会映射到 owner-scoped 的目录卡片，也不能走一键更新。

## 接口

`GET /api/v1/skill-catalog` 支持：

- `q`
- `category`
- `slug`
- `ownerHandle`
- `sort=downloads|updated|stars`
- `cursor`
- `limit`（1-100）

返回 `skills`、`nextCursor`、`total`、预计算 `facets` 和目录 `meta.revision`。

## 发布前置条件

Cloudflare binding、GitHub secrets、同步预算和故障处置记录在 `tabby-site/docs/skill-catalog.md`。每次部署后应验证公开目录接口；缺少 D1 binding 或尚未完成首次同步时接口返回 `503`，桌面端会对首屏使用旧本地缓存。
