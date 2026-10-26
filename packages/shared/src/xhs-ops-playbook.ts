import type { XhsOpsPlaybookRule } from "./schemas/xhs-ops.js";

// ─── xhs-ops 经验库（老号接管诊断的可追溯依据）──────────────────────────────
// Design: docs/plans/2026-10-14-xhs-account-takeover-design.md §4.5.
//
// Every finding and proposal a diagnosis makes cites rule ids from here; the
// card shows the rule text and source next to it, grouped as 技能文档 (doc,
// device-verified), 本方案规则 (design) and 参考 (community-unverified).
//
// Sources: `xhs/references/…` is tabby-control/phone-skills/apps/xhs/…, and
// the excerpt of each such rule was checked against phone-skills bundle
// `bundleVersion`; the phone-skills release chain re-checks it on every
// bundle bump (`pnpm check:xhs-playbook`, scripts/check-xhs-playbook-excerpts.mjs).
// `apps/…` is a path in this repository, `本方案` the design doc.
// Line numbers in nexu paths drift, so those cite the symbol instead.
//
// signedOffAt stays null until ops or product sign each rule off (D8); an
// unsigned design rule cannot carry a high-severity finding on its own.
//
// XHS_OPS_PLAYBOOK_VERSION (date.sequence) names the rule records as served
// and stored on each diagnosis (playbookVersion). Bump it on any change to a
// record, a PHONE_SKILLS_BUNDLE move included: a diagnosis' citedRules
// snapshot does not carry bundleVersion, so only the version tells which
// bundle its doc citations were verified against.

export const XHS_OPS_PLAYBOOK_VERSION = "2026-10-21.1";

/**
 * The phone-skills bundleVersion (tabby-control phone-skills/manifest.json)
 * the doc excerpts below were checked against — the P0 release that gives
 * profile.md and media-picker their takeover branches (§3.5). A phone whose
 * DeviceInfo.skillBundleVersion is lower, or whose skillSyncStatus is not
 * "current", runs skill docs older than the ones this playbook cites.
 */
export const PHONE_SKILLS_BUNDLE = 66;
const EXPERT =
  "apps/desktop/static/bundled-experts/marketing-xiaohongshu-operator/expert.json";
const TASK_BUILDER = "apps/controller/src/services/xhs-ops-task-builder.ts";
const PROFILE_SERVICE =
  "apps/controller/src/services/xhs-ops-profile-service.ts";

export const XHS_OPS_PLAYBOOK: readonly XhsOpsPlaybookRule[] = [
  // ── Identity ──
  {
    id: "ID-01",
    topic: "identity",
    text: "只操作当前已登录账号；检测到其他账号不得切换",
    source: "xhs/references/profile.md:17；xhs/references/login.md:24",
    appliesTo: ["new", "existing"],
    confidence: "doc",
    excerpt: "只操作当前已登录账号自己的内容",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "ID-02",
    topic: "identity",
    text: "出现登录页或掉线时不代为登录，由账号本人在手机上登录",
    source: "xhs/references/research.md:44；本方案（D5）",
    appliesTo: ["existing"],
    confidence: "doc",
    excerpt: "记录后立即结束，不要登录",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  // ── Profile ──
  {
    id: "PF-01",
    topic: "profile",
    text: "每次只改一个字段，保存后回读",
    source: "xhs/references/profile.md:30",
    appliesTo: ["new", "existing"],
    confidence: "doc",
    excerpt: "只修改一个字段 → 保存或确认自动保存",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "PF-02",
    topic: "profile",
    text: "名字遇到次数、敏感词限制就停，不自动换名",
    source: `xhs/references/profile.md:35；${TASK_BUILDER}（buildProfileApplyTask 名字步骤）`,
    appliesTo: ["new", "existing"],
    confidence: "doc",
    excerpt: "遇到修改频率、字符、敏感词或审核限制时停止",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "PF-03",
    topic: "profile",
    text: "小红书号不改",
    source: `${TASK_BUILDER}（buildProfileApplyTask 禁止改动小红书号）；xhs/references/profile.md:15,66（平台侧涉及修改次数）`,
    appliesTo: ["new", "existing"],
    confidence: "design",
    signedOffAt: null,
  },
  {
    id: "PF-04",
    topic: "profile",
    text: "头像 7 天内最多 3 次",
    source: `${PROFILE_SERVICE}（资料回执注释记录的手机回执原话）`,
    appliesTo: ["new", "existing"],
    confidence: "device-verified",
    signedOffAt: null,
  },
  {
    id: "PF-05",
    topic: "profile",
    text: "不猜旧值，不擅自回滚",
    source: "xhs/references/profile.md:72",
    appliesTo: ["new", "existing"],
    confidence: "doc",
    excerpt: "不得猜测旧值或擅自回滚",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "PF-06",
    topic: "profile",
    text: "简介不含营销、联系方式、引流、品牌",
    source: `${PROFILE_SERVICE}（buildProfileTextPrompt 简介规则）`,
    appliesTo: ["new", "existing"],
    confidence: "design",
    signedOffAt: null,
  },
  {
    id: "PF-07",
    topic: "profile",
    text: "改前存档旧值（基线和预检各存一次）",
    source: "本方案",
    appliesTo: ["existing"],
    confidence: "design",
    signedOffAt: null,
  },
  {
    id: "PF-08",
    topic: "profile",
    text: "职业必须精确到二级项，不选一级分类或相近项",
    source: "xhs/references/profile.md:58",
    appliesTo: ["new", "existing"],
    confidence: "doc",
    excerpt: "不能只选一级分类，也不能用「产品经理」等相近项替代",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  // ── Takeover ──
  {
    id: "MT-01",
    topic: "takeover",
    text: "已有账号以保留辨识度为先：昵称默认保留；简介只改和目标冲突的部分；不套星座+MBTI 模板（PS:163 的新号模板）",
    source: "本方案",
    appliesTo: ["existing"],
    confidence: "design",
    signedOffAt: null,
  },
  {
    id: "MT-02",
    topic: "takeover",
    text: "每批最多 2 个公开字段；昵称和头像不同批；批与批之间隔一个观察期",
    source: "本方案",
    appliesTo: ["existing"],
    confidence: "design",
    signedOffAt: null,
  },
  {
    id: "MT-03",
    topic: "takeover",
    text: "资料变更当天不跑养号",
    source: "本方案",
    appliesTo: ["existing"],
    confidence: "design",
    signedOffAt: null,
  },
  {
    id: "MT-04",
    topic: "takeover",
    text: "人设迁移时旧主线放扩展层过渡，新方向放核心层",
    source: "本方案",
    appliesTo: ["existing"],
    confidence: "design",
    signedOffAt: null,
  },
  // ── Nurture ──
  {
    id: "NU-01",
    topic: "nurture",
    text: "多数帖子只看不互动；前 1–2 篇预热；互动分散开",
    source: "xhs/references/nurture.md:19,33-35",
    appliesTo: ["new", "existing"],
    confidence: "doc",
    excerpt: "多数帖子只浏览、不互动",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "NU-02",
    topic: "nurture",
    text: "关注默认关闭，方案不提议开启：关注列表公开，老粉看得到",
    source: "本方案（§6.3）",
    appliesTo: ["existing"],
    confidence: "design",
    signedOffAt: null,
  },
  {
    id: "NU-03",
    topic: "nurture",
    text: "已有账号按体量定一个静态档位，养号强度只降不升；调整档位由人确认",
    source: "本方案（D3）",
    appliesTo: ["existing"],
    confidence: "design",
    signedOffAt: null,
  },
  {
    id: "NU-04",
    topic: "nurture",
    text: "已点过赞的不再点也不计数，老号上更常见",
    source: "xhs/references/research.md:36",
    appliesTo: ["new", "existing"],
    confidence: "doc",
    excerpt: "已经是红色不再点、不计数",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "NU-05",
    topic: "nurture",
    text: '出现"操作频繁"立即停止',
    source:
      "xhs/references/nurture.md:74；apps/controller/src/services/xhs-ops-run-service.ts（SAFETY_STOP_TYPES）",
    appliesTo: ["new", "existing"],
    confidence: "device-verified",
    excerpt: "立即停止互动",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "NU-06",
    topic: "nurture",
    text: "评论默认关闭；只发桌面审核队列逐条批准过的原文",
    source: "xhs/references/interact.md:8",
    appliesTo: ["new", "existing"],
    confidence: "doc",
    excerpt: "评论只能通过「小红书评论任务」发",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "NU-08",
    topic: "nurture",
    text: "每轮 3 核心 + 1 扩展 + 1 泛，轮换并避开上一轮",
    source:
      "apps/controller/src/services/xhs-ops-plan-suggest.ts（suggestPlanAt 轮换规则）",
    appliesTo: ["new", "existing"],
    confidence: "design",
    signedOffAt: null,
  },
  // ── Tone ──
  {
    id: "TN-01",
    topic: "tone",
    text: "内容基于真实体验，不搬运不洗稿",
    source: `${EXPERT}（内容真实性）`,
    appliesTo: ["new", "existing"],
    confidence: "community-unverified",
    signedOffAt: null,
  },
  {
    id: "TN-02",
    topic: "tone",
    text: "标题 18–20 字，关键词加情绪词；封面 3:4；正文 300–600 字",
    source: `${EXPERT}（爆款笔记模板）`,
    appliesTo: ["new", "existing"],
    confidence: "community-unverified",
    signedOffAt: null,
  },
  {
    id: "TN-04",
    topic: "tone",
    text: "垂直度看主内容支柱：多数笔记应落在 1–2 个与目标人群相关的支柱上",
    source: "本方案",
    appliesTo: ["existing"],
    confidence: "design",
    signedOffAt: null,
  },
  {
    id: "TN-06",
    topic: "tone",
    text: '说"热门"必须有页面证据；选题优先榜单高位且无争议',
    source: "xhs/references/hotsearch.md:8,15",
    appliesTo: ["new", "existing"],
    confidence: "doc",
    excerpt: "“热门”必须有当前页面证据",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "TN-08",
    topic: "tone",
    text: "评论不用套话开头，不假装亲身经历",
    source: "xhs/references/nurture.md:70,72",
    appliesTo: ["new", "existing"],
    confidence: "doc",
    excerpt: "也不能假装亲身经历",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  // ── Risk ──
  {
    id: "RK-01",
    topic: "risk",
    text: "小红书号、生日、地区等具体值不进日志、对话和提示词",
    source: "xhs/references/profile.md:18；本方案（D6）",
    appliesTo: ["new", "existing"],
    confidence: "doc",
    excerpt: "不在日志、`key_process` 或最终返回中记录小红书号",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "RK-02",
    topic: "risk",
    text: "收藏、赞过、草稿和浏览记录属于隐私，不读取完整列表",
    source: "xhs/references/profile.md:19",
    appliesTo: ["new", "existing"],
    confidence: "doc",
    excerpt: "可能是仅账号本人可见的隐私内容",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "RK-03",
    topic: "risk",
    text: "前任运营的草稿不丢弃、不覆盖",
    source: "xhs/references/post.md:49-52",
    appliesTo: ["existing"],
    confidence: "doc",
    excerpt: "不能自行丢弃、覆盖或进入继续编辑",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "RK-04",
    topic: "risk",
    text: "删除笔记最终确认前必须 CALL_USER（profile-notes.md:15）；本方案进一步规定桌面永不自动删除",
    source: 'xhs/references/profile-notes.md:15（"永不"是本方案的策略）',
    appliesTo: ["new", "existing"],
    confidence: "doc",
    excerpt: "删除笔记是不可逆或高影响操作",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "RK-05",
    topic: "risk",
    text: "不自动发布、不编辑或隐藏已有笔记、不删除笔记、不发私信、不做推广",
    source: "本方案（V0.1 边界）",
    appliesTo: ["new", "existing"],
    confidence: "design",
    signedOffAt: null,
  },
  // ── Metrics ──
  {
    id: "MX-01",
    topic: "metrics",
    text: "互动率参考值 >5%，只作参考，不作结论",
    source: `${EXPERT}（成功指标）`,
    appliesTo: ["new", "existing"],
    confidence: "community-unverified",
    signedOffAt: null,
  },
  {
    id: "MX-02",
    topic: "metrics",
    text: "近 7 日数据按页面原样读取，不推算未显示的数据",
    source: "xhs/references/creator.md:21",
    appliesTo: ["new", "existing"],
    confidence: "doc",
    excerpt: "不能推算未显示数据",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "MX-03",
    topic: "metrics",
    text: "创作者数据不可用（新号或未开通）属正常，活跃度记为未知，不判为差",
    source: "xhs/references/creator.md:34；本方案",
    appliesTo: ["existing"],
    confidence: "design",
    excerpt: "入口、指标或目标项不存在时如实返回",
    bundleVersion: PHONE_SKILLS_BUNDLE,
    signedOffAt: null,
  },
  {
    id: "MX-04",
    topic: "metrics",
    text: "缩写数字（如「1.2万」）按区间比较，变化小于精度时不下结论",
    source: "本方案（§6.4）",
    appliesTo: ["new", "existing"],
    confidence: "design",
    signedOffAt: null,
  },
];
