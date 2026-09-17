const COMPONENT_SCHEMAS = [
  {
    type: "Text",
    required: ["id", "type", "content"],
    properties: {
      id: { type: "string" },
      type: { const: "Text" },
      content: {
        oneOf: [
          { type: "string", description: "Static text content" },
          {
            type: "object",
            properties: { path: { type: "string" } },
            description: "Data binding to a JSON pointer path",
          },
        ],
      },
      variant: {
        type: "string",
        enum: ["h1", "h2", "h3", "h4", "h5", "body", "caption", "code"],
      },
    },
  },
  {
    type: "Button",
    required: ["id", "type", "label"],
    properties: {
      id: { type: "string" },
      type: { const: "Button" },
      label: {
        oneOf: [
          { type: "string" },
          { type: "object", properties: { path: { type: "string" } } },
        ],
      },
      variant: {
        type: "string",
        enum: ["primary", "secondary", "outlined", "text"],
      },
      action: {
        type: "object",
        properties: {
          event: {
            type: "object",
            properties: {
              name: { type: "string" },
              context: { type: "object" },
            },
            required: ["name"],
          },
        },
      },
      disabled: { type: "boolean" },
      children: {
        type: "array",
        items: { type: "string" },
        description: "Child component IDs",
      },
    },
  },
  {
    type: "TextField",
    required: ["id", "type"],
    properties: {
      id: { type: "string" },
      type: { const: "TextField" },
      label: {
        oneOf: [
          { type: "string" },
          { type: "object", properties: { path: { type: "string" } } },
        ],
      },
      value: {
        oneOf: [
          { type: "string" },
          { type: "object", properties: { path: { type: "string" } } },
        ],
      },
      placeholder: {
        oneOf: [
          { type: "string" },
          { type: "object", properties: { path: { type: "string" } } },
        ],
      },
      hint: {
        oneOf: [
          { type: "string" },
          { type: "object", properties: { path: { type: "string" } } },
        ],
      },
      multiline: { type: "boolean" },
      required: { type: "boolean" },
    },
  },
  {
    type: "DateTimeInput",
    required: ["id", "type"],
    properties: {
      id: { type: "string" },
      type: { const: "DateTimeInput" },
      label: {
        oneOf: [
          { type: "string" },
          { type: "object", properties: { path: { type: "string" } } },
        ],
      },
      value: {
        oneOf: [
          { type: "string" },
          { type: "object", properties: { path: { type: "string" } } },
        ],
      },
      mode: { type: "string", enum: ["date", "time", "datetime"] },
    },
  },
  {
    type: "CheckBox",
    required: ["id", "type", "label"],
    properties: {
      id: { type: "string" },
      type: { const: "CheckBox" },
      label: {
        oneOf: [
          { type: "string" },
          { type: "object", properties: { path: { type: "string" } } },
        ],
      },
      checked: { type: "boolean" },
    },
  },
  {
    type: "ChoicePicker",
    required: ["id", "type", "choices"],
    properties: {
      id: { type: "string" },
      type: { const: "ChoicePicker" },
      label: {
        oneOf: [
          { type: "string" },
          { type: "object", properties: { path: { type: "string" } } },
        ],
      },
      choices: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            value: { type: "string" },
          },
          required: ["label", "value"],
        },
      },
      selected: {
        oneOf: [
          { type: "string" },
          { type: "object", properties: { path: { type: "string" } } },
        ],
      },
    },
  },
  {
    type: "Slider",
    required: ["id", "type"],
    properties: {
      id: { type: "string" },
      type: { const: "Slider" },
      label: {
        oneOf: [
          { type: "string" },
          { type: "object", properties: { path: { type: "string" } } },
        ],
      },
      value: { type: "number" },
      min: { type: "number" },
      max: { type: "number" },
      step: { type: "number" },
      steps: {
        type: "integer",
        minimum: 1,
        description:
          "Number of discrete divisions across the range; the slider snaps to (max - min) / steps intervals. Takes precedence over step.",
      },
    },
  },
  {
    type: "Column",
    required: ["id", "type", "children"],
    properties: {
      id: { type: "string" },
      type: { const: "Column" },
      children: {
        type: "array",
        items: { type: "string" },
        description: "Child component IDs",
      },
      gap: { type: "number" },
      alignment: {
        type: "string",
        enum: ["start", "center", "end", "stretch"],
      },
    },
  },
  {
    type: "Row",
    required: ["id", "type", "children"],
    properties: {
      id: { type: "string" },
      type: { const: "Row" },
      children: {
        type: "array",
        items: { type: "string" },
        description: "Child component IDs",
      },
      gap: { type: "number" },
      alignment: {
        type: "string",
        enum: ["start", "center", "end", "stretch"],
      },
    },
  },
  {
    type: "Card",
    required: ["id", "type", "children"],
    properties: {
      id: { type: "string" },
      type: { const: "Card" },
      children: {
        type: "array",
        items: { type: "string" },
        description: "Child component IDs",
      },
      padding: { type: "number" },
      elevation: { type: "number" },
    },
  },
  {
    type: "List",
    required: ["id", "type", "children"],
    properties: {
      id: { type: "string" },
      type: { const: "List" },
      children: {
        type: "array",
        items: { type: "string" },
        description: "Child component IDs",
      },
      orientation: { type: "string", enum: ["vertical", "horizontal"] },
      gap: { type: "number" },
    },
  },
  {
    type: "Tabs",
    required: ["id", "type", "tabs"],
    properties: {
      id: { type: "string" },
      type: { const: "Tabs" },
      tabs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            children: {
              type: "array",
              items: { type: "string" },
              description: "Child component IDs for this tab",
            },
          },
          required: ["label", "children"],
        },
      },
      selectedIndex: { type: "number" },
    },
  },
  {
    type: "Modal",
    required: ["id", "type", "children", "open"],
    properties: {
      id: { type: "string" },
      type: { const: "Modal" },
      children: {
        type: "array",
        items: { type: "string" },
        description: "Child component IDs",
      },
      open: { type: "boolean" },
      title: { type: "string" },
    },
  },
  {
    type: "Image",
    required: ["id", "type", "source"],
    properties: {
      id: { type: "string" },
      type: { const: "Image" },
      source: { type: "string", description: "Image URL" },
      alt: { type: "string" },
      width: { type: "number" },
      height: { type: "number" },
    },
  },
  {
    type: "Icon",
    required: ["id", "type", "name"],
    properties: {
      id: { type: "string" },
      type: { const: "Icon" },
      name: { type: "string", description: "Icon name (lucide icon set, kebab-case, e.g. star, check, arrow-right, alert-circle)" },
      color: { type: "string" },
      size: { type: "number" },
    },
  },
  {
    type: "Divider",
    required: ["id", "type"],
    properties: {
      id: { type: "string" },
      type: { const: "Divider" },
      orientation: { type: "string", enum: ["horizontal", "vertical"] },
    },
  },
  {
    type: "Video",
    required: ["id", "type", "source"],
    properties: {
      id: { type: "string" },
      type: { const: "Video" },
      source: { type: "string", description: "Video URL" },
      autoplay: { type: "boolean" },
      muted: { type: "boolean" },
      posterUrl: {
        type: "string",
        description: "Preview image URL shown before the video plays",
      },
    },
  },
  {
    type: "AudioPlayer",
    required: ["id", "type", "source"],
    properties: {
      id: { type: "string" },
      type: { const: "AudioPlayer" },
      source: { type: "string", description: "Audio URL" },
      title: { type: "string" },
    },
  },
  {
    type: "PhonePreview",
    required: ["id", "type"],
    properties: {
      id: { type: "string" },
      type: { const: "PhonePreview" },
      devices: {
        type: "array",
        description: "Array of connected phone devices to display",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Device name" },
            model: { type: "string", description: "Device model" },
            status: {
              type: "string",
              enum: ["online", "offline", "busy"],
              description: "Connection status",
            },
            screenshot: {
              type: "string",
              description: "Screenshot image URL or data URI",
            },
          },
          required: ["name"],
        },
      },
    },
  },
  {
    type: "MarkdownEditor",
    required: ["id", "type", "content"],
    properties: {
      id: { type: "string" },
      type: { const: "MarkdownEditor" },
      title: { type: "string", description: "Optional editor title" },
      content: { type: "string", description: "Markdown content to display" },
    },
  },
  {
    type: "XHSEditor",
    required: ["id", "type"],
    properties: {
      id: { type: "string", description: "Unique component ID" },
      type: { const: "XHSEditor" },
      title: {
        type: "string",
        description: "Initial title text for the post",
      },
      content: {
        type: "string",
        description:
          "Initial body text for the post. PLAIN TEXT only — Xiaohongshu does not render Markdown. Do NOT use Markdown: no `#` headings, `**bold**`, or `-`/`*` bullets. The title is the separate `title` field, so never restate it as a `# heading` on the first body line. Emojis and line breaks are fine.",
      },
      images: {
        type: "array",
        items: { type: "string" },
        description:
          "Array of image URLs, data URIs, or local media file paths to display as preview",
      },
      hashtags: {
        type: "array",
        items: { type: "string" },
        description: "Array of hashtag strings (without # prefix)",
      },
      maxTitleLength: {
        type: "number",
        description: "Maximum title character count (default 20)",
      },
      visibility: {
        type: "string",
        enum: ["visible", "hidden"],
        description: "Component visibility",
      },
    },
  },
  {
    type: "XHSBatchTable",
    required: ["id", "type", "posts"],
    properties: {
      id: { type: "string", description: "Unique component ID" },
      type: { const: "XHSBatchTable" },
      batchId: {
        type: "string",
        description:
          "Stable id for this batch session; reuse the same value to keep edits/status across re-renders. Defaults to 'default'.",
      },
      posts: {
        type: "array",
        description:
          "The posts to publish in this batch. Each row expands an inline XHSEditor in the chat thread when clicked. Leave deviceId empty to auto-assign phones round-robin.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable post id" },
            title: { type: "string", description: "Post title" },
            content: {
              type: "string",
              description:
                "Post body text. PLAIN TEXT only — Xiaohongshu does not render Markdown; no `#` headings, `**bold**`, or `-`/`*` bullets, and never restate the title as a `# heading` on the first line. Emojis and line breaks are fine.",
            },
            images: {
              type: "array",
              items: { type: "string" },
              description:
                "Image URLs, data URIs, or local media file paths for this post",
            },
            hashtags: {
              type: "array",
              items: { type: "string" },
              description: "Hashtag strings (without # prefix)",
            },
            deviceId: {
              type: "string",
              description:
                "Target phone deviceId; omit to auto-assign round-robin across connected phones",
            },
          },
          required: ["title", "content"],
        },
      },
    },
  },
  {
    type: "XhsOpsProjectForm",
    required: ["id", "type"],
    properties: {
      id: { type: "string", description: "Unique component ID" },
      type: { const: "XhsOpsProjectForm" },
      projectId: {
        type: "string",
        description:
          "Existing project id to edit; omit when creating a new nurturing project.",
      },
      prefill: {
        type: "object",
        description:
          "Initial values for a NEW project: name plus business={industry,product,regions[],sellingPoints[],priceBand,scene}, audience={ageRange,genderRatio,regions[],occupations[],spendingPower,knownInterests[],painPoints[]}, opsNotes={forbiddenTopics[],boostKeywords[],avoidContentTypes[]}. Fill from what the user already told you; leave the rest for them to complete.",
      },
    },
  },
  {
    type: "XhsOpsProfileCard",
    required: ["id", "type", "projectId"],
    properties: {
      id: { type: "string", description: "Unique component ID" },
      type: { const: "XhsOpsProfileCard" },
      projectId: {
        type: "string",
        description: "The nurturing project this profile belongs to.",
      },
      profile: {
        type: "object",
        description:
          "Proposed target-user profile for HUMAN confirmation: summary (one paragraph), base={ageRange,genderRatio,regions[]}, verticalInterests[] (business-related), generalInterests[] (everyday interests). The user can edit fields inline; you receive xhs_ops_profile_confirmed or xhs_ops_profile_regenerate actions.",
      },
    },
  },
  {
    type: "XhsOpsAccountPlanner",
    required: ["id", "type", "projectId"],
    properties: {
      id: { type: "string", description: "Unique component ID" },
      type: { const: "XhsOpsAccountPlanner" },
      projectId: {
        type: "string",
        description: "The nurturing project these personas belong to.",
      },
      suggestions: {
        type: "array",
        description:
          "Optional candidates; prefer the card’s N-count generate/retry and human distribution review. Wait for xhs_ops_personas_confirmed before materials. Differentiated KOC persona suggestions — generate TEN by default unless the user asks for another count (the ops spec's minimal loop generates 10 personas, then binds 2-3 to phones). Each: {label (<=40 chars, unique), positioning (one sentence), persona {age, gender, region, occupation, lifeStatus} (REQUIRED structured demographics), interestPool {core[], extended[], general[]}}. Personas must differ from each other (age band / city district / occupation / life status / interest mix) while their overall distribution matches the CONFIRMED target profile (e.g. ~70% female if the profile says so). The card lists connected phones for binding.",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Short persona name" },
            positioning: {
              type: "string",
              description: "One-sentence account direction",
            },
            persona: {
              type: "object",
              description:
                "Structured demographics, all short strings: age ('32岁'), gender ('女'), region ('北京海淀'), occupation ('互联网产品经理'), lifeStatus ('2岁娃新手妈妈'). Vary them across personas.",
              properties: {
                age: { type: "string" },
                gender: { type: "string" },
                region: { type: "string" },
                occupation: { type: "string" },
                lifeStatus: { type: "string" },
              },
              required: ["age", "gender", "region", "occupation", "lifeStatus"],
            },
            personaTags: {
              type: "object",
              description: "Compact archive tags, separate from the rotating interest pool: vertical 1–2 distinct tags, general 2–3 distinct tags.",
              properties: {
                vertical: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
                general: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3 },
              },
            },
            interestPool: {
              type: "object",
              properties: {
                core: { type: "array", items: { type: "string" } },
                extended: { type: "array", items: { type: "string" } },
                general: { type: "array", items: { type: "string" } },
              },
            },
          },
          required: ["label", "positioning", "persona"],
        },
      },
    },
  },
  {
    type: "XhsOpsProfileMaterial",
    required: ["id", "type"],
    properties: {
      id: { type: "string", description: "Unique component ID" },
      type: { const: "XhsOpsProfileMaterial" },
      projectId: {
        type: "string",
        description:
          "The nurturing project whose bound accounts get profile material. Pass it when this session has it; otherwise omit (optionally pass projectName) and the component lets the user pick.",
      },
      projectName: {
        type: "string",
        description: "Optional: the project name the user mentioned, auto-selected when it matches.",
      },
      accountId: {
        type: "string",
        description: "Optional: show only this account.",
      },
    },
  },
  {
    type: "XhsOpsRunPlanner",
    required: ["id", "type"],
    properties: {
      id: { type: "string", description: "Unique component ID" },
      type: { const: "XhsOpsRunPlanner" },
      projectId: {
        type: "string",
        description:
          "The nurturing project to run today. Pass it when this session has it (xhs_ops_project_saved); otherwise omit (optionally pass projectName) and the component lets the user pick.",
      },
      projectName: {
        type: "string",
        description: "Optional: the project name the user mentioned, auto-selected when it matches.",
      },
      plans: {
        type: "array",
        description:
          "OPTIONAL. Omit it in the normal flow: the desktop generates today's plan per bound account deterministically from its interest pool (core keywords rotate by round, extended/general add variety, the previous run's exact set is avoided, home-feed count derives from searchRatioPercent) and shows the rationale. Pass plans ONLY when the user dictated specific keywords/counts: one per account {accountId (must already exist), keywords: [{keyword, count 1-8}] up to 8, homeFeedCount 0-12}. The user adjusts before starting; you receive xhs_ops_run_started and exactly one xhs_ops_run_finished with the summary. NEVER re-dispatch after finished — help the user review instead.",
        items: {
          type: "object",
          properties: {
            accountId: { type: "string", description: "Existing account id" },
            keywords: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  keyword: { type: "string" },
                  count: { type: "number", description: "Posts to browse, 1-8" },
                },
                required: ["keyword"],
              },
            },
            homeFeedCount: {
              type: "number",
              description: "Home-feed posts, 0-12",
            },
          },
          required: ["accountId", "keywords"],
        },
      },
    },
  },
  {
    type: "XhsOpsDashboard",
    required: ["id", "type"],
    properties: {
      id: { type: "string", description: "Unique component ID" },
      type: { const: "XhsOpsDashboard" },
      projectId: {
        type: "string",
        description:
          "The nurturing project to review, when you know its id (e.g. from xhs_ops_project_saved in this session). Omit it otherwise — the component lists the projects and lets the user pick.",
      },
      projectName: {
        type: "string",
        description:
          "Optional: the project name the user mentioned; the component auto-selects it when it matches, else shows the picker.",
      },
      accountId: {
        type: "string",
        description: "Optional: limit the board to one account.",
      },
      days: {
        type: "number",
        description:
          "Optional: how many recent days to show (default 7; 7/14/30 are the user-switchable presets).",
      },
    },
  },
  {
    type: "XhsOpsCommentReview",
    required: ["id", "type"],
    properties: {
      id: { type: "string", description: "Unique component ID" },
      type: { const: "XhsOpsCommentReview" },
      projectId: {
        type: "string",
        description:
          "The nurturing project whose comment queue to review. Omit when unknown (optionally pass projectName) — the component lets the user pick.",
      },
      projectName: {
        type: "string",
        description: "Optional: the project name the user mentioned.",
      },
      accountId: {
        type: "string",
        description: "Optional: limit the queue to one account.",
      },
    },
  },
];

/**
 * Convert simplified component definitions to A2UI v0.9 JSONL.
 *
 * IMPORTANT: This is NOT OpenClaw Canvas format. Do NOT use literalString,
 * explicitList, function, or beginRendering. Use plain strings, plain arrays,
 * and event-based actions ONLY.
 */
function generateA2UIJSONL(surfaceId, components, initialData, catalogId) {
  // Single-message form adopted from A2UI v1.0: createSurface carries the
  // whole component tree and initial data model, so the renderer never sees
  // a half-built surface.
  const createSurface = { surfaceId, components };
  if (catalogId) createSurface.catalogId = catalogId;
  if (initialData && typeof initialData === "object") {
    createSurface.dataModel = initialData;
  }

  return JSON.stringify({ version: "v0.9", createSurface });
}

export const RENDER_A2UI_DESCRIPTION = `Render interactive UI components (forms, buttons, date pickers, sliders, etc.) directly in the chat.

WHEN TO USE:
- Displaying connected phone/device status — use PhonePreview component
- Showing generic copywriting / markdown / plain generated text that is NOT a Xiaohongshu post — use MarkdownEditor component
- Writing Xiaohongshu/RedNote post(s) — ALWAYS render with XHS components, NEVER MarkdownEditor or a plain-text list:
    • exactly ONE post → XHSEditor
    • TWO OR MORE posts → a SINGLE XHSBatchTable holding all of them (one row per post). MANDATORY: never place multiple XHSEditor components in one surface, never emit several XHSEditor surfaces, and never a plain-text list. The XHSBatchTable and each expanded post editor stay inline in the chat thread; do not route them to the canvas.
    • CONTENT FORMAT: title and body are SEPARATE fields. Write the body as PLAIN TEXT — Xiaohongshu does not render Markdown. No \`#\` headings, no \`**bold**\`, no \`-\`/\`*\` bullets, and NEVER repeat the title as a \`# heading\` on the first body line. Emojis and line breaks are encouraged.
    • Images are OPTIONAL and are NOT a prerequisite for publishing: render the post(s) immediately with images:[] and let the user add images afterwards. NEVER stall, loop, or refuse to render just because there are no images yet.
- Updating an existing XHSEditor or XHSBatchTable in the chat, including putting a generated image into it. Reuse the exact prior surfaceId and preserve all existing post fields. For a requested generated image, first call image_generate and wait for its real media path, then call render_a2ui with that path appended to the XHS images. NEVER use canvas_read or canvas_op for a chat XHS component.
- Running the Xiaohongshu KOC account-nurturing (小红书养号) workflow — render the stage component IN ORDER, one stage at a time, in the same conversation:
    • collect / edit customer business + target-audience info → XhsOpsProjectForm (it fires xhs_ops_project_saved; then generate the target-user profile from the saved business/audience/opsNotes)
    • present the generated profile for HUMAN confirmation → XhsOpsProfileCard (wait for xhs_ops_profile_confirmed or xhs_ops_profile_regenerate; NEVER proceed to personas before confirmed — this gate is a product requirement)
    • batch persona suggestions + phone binding → XhsOpsAccountPlanner (TEN personas by default, each with structured persona demographics {age, gender, region, occupation, lifeStatus}; differentiated from each other but jointly matching the confirmed profile; the card supports N-count generation and distribution review, and only xhs_ops_personas_confirmed advances to materials)
    • required new-account profile material after personas are confirmed → XhsOpsProfileMaterial (render with projectId; desktop generates nickname/bio and avatar/cover candidates; the user supplies target platform ID, gender, exact birthday, region and interest tags. xhs_ops_profile_material_confirmed means only the eight draft fields were reviewed. Do not proceed to nurturing until xhs_ops_profile_applied reports independent target-account and eight-field verification. The user's separate setup action prepares installation/login, applies the profile and reads it back; failed/partial/unverified results remain locked. Never infer a birthday from an age range or trigger public-profile changes yourself)
    • today's per-account plan + execution + progress → XhsOpsRunPlanner (render it with projectId after verified phone account setup — the desktop generates each account's plan from its interest pool and shows the rationale; if an account is not ready, the planner embeds the material step and keeps execution disabled; pass plans only when the user dictated keywords; the user adjusts and starts; xhs_ops_run_finished carries the summary — do NOT re-dispatch afterwards, help review instead. Accounts whose browse defaults set dailySegments>1 get one card per segment; the desktop runs them serially and auto-chains them, so you receive one xhs_ops_run_finished per segment (payload.segment = {index, count}) — do not re-render the planner between segments. Daily auto-run (每日自动执行/定时/每天早上自动跑) is a switch + time on this planner card, stored on the project and fired by the desktop's own scheduler — do NOT create OpenClaw cron jobs or schedules for xhs-ops; just render the planner and tell the user to flip the switch)
    • reviewing results across days (复盘/看板/效果如何/推荐流有没有变/哪些关键词不行/异常多不多) → XhsOpsDashboard, IMMEDIATELY and as the FIRST tool call. Pass projectId if this session already has it, otherwise pass projectName (what the user called it) or nothing — the component lets the user pick. The run data lives ONLY in the desktop's xhs-ops store, which this board reads; it is NOT in sessions_history, memory_search, files or exec output — do not search for it there. READ-ONLY: never re-dispatch phone tasks to "refresh" results. The user may save a 运营备注 there; you receive xhs_ops_dashboard_note_saved.
    • Never render these stages as plain text or Markdown lists — the components own the form, confirmation and progress UX.
    • comment review (评论审核/评论队列/给帖子评论/批准评论) → XhsOpsCommentReview. The DESKTOP generates candidate comments from browsed posts and the HUMAN approves each one there; comments are only ever sent by a later desktop comment task. You NEVER write, approve or send a comment yourself, never dispatch a phone task to comment, and never call device tools for it — render the queue and stop. You receive xhs_ops_comments_reviewed per decision; acknowledge briefly, do not restate the comment. Approved comments are dispatched to the phone by the USER from the same queue (「派发已批准的评论」, a desktop comment task whose phone policy only allows the verbatim approved text) — you receive xhs_ops_comment_run_started; never dispatch, retry or "help" by sending anything.
    • projectId is only known inside the session that saved the project. In any other session (今天跑一下养号 / 给账号生成资料 / 复盘) render XhsOpsRunPlanner / XhsOpsProfileMaterial / XhsOpsDashboard WITHOUT projectId (pass projectName if the user named it) — the component shows a project picker. Never search memory/sessions/files for a projectId.
- Showing a generated/edited image to the user in webchat — use an Image component (pass the local file path produced by image_generate)
- Collecting structured input from the user (forms, date/time, choices)
- Offering selectable actions (confirm/cancel, option selection)
- Any situation where plain text alone is insufficient

HOW TO USE:
1. Call this tool with a surfaceId and an array of component definitions.
   surfaceId is the surface's IDENTITY, not a per-call serial number:
   - Creating a genuinely NEW surface (a different artifact) -> pick a new descriptive id.
   - Updating / revising / iterating on content you already rendered (same editor, same post, new wording or images) -> REUSE the exact same surfaceId as before. Re-rendering with the same id updates the existing surface in place. Inline XHS surfaces remain in their original chat card; they are not canvas nodes.
2. The tool result is automatically rendered as interactive UI. Do NOT copy, repeat, or echo the JSONL in your text response. Just reply naturally — the UI appears alongside your message.
3. CRITICAL: NEVER include raw JSONL or \`\`\`a2ui code blocks in your text output. The system renders UI automatically. Your text and A2UI are separate.
4. Do not claim an image was generated or inserted until image_generate returned a real media path and this render_a2ui call completed with that path in the XHS images field.

SURFACE PLACEMENT (automatic — you normally don't control it):
- MarkdownEditor surfaces automatically open in the right side panel, with an "open panel" button shown in the chat thread. XHSEditor and XHSBatchTable stay inline in the conversation.
- Everything else (forms, images, video/audio, confirmations, pickers, status cards) renders inline in the chat thread.
- Only when the user explicitly asks for the side panel (侧边栏), prefix the surfaceId with "sidebar:" to force panel placement.

IMAGE / MEDIA SOURCES:
- Image.source, PhonePreview screenshot, and XHS images accept http(s) URLs, data URIs, or absolute local file paths UNDER THE OPENCLAW MEDIA DIRECTORY. Only paths under that media directory are auto-converted to servable URLs in webchat.
- To create post/cover images, use the image_generate tool — its output lands in the media directory and previews correctly. Pass the returned local path straight into images.
- Do NOT scrape image sites (pexels / freepik / Baidu Images etc. — they block scraping and will fail) and do NOT download/save images to /tmp or any path outside the media directory: webchat cannot serve those, so the preview will 404. If you cannot generate an image, just render the post with images:[] rather than fetching from the web.

BUTTON ACTIONS:
- Use \`"action": {"event": {"name": "actionName", "context": {}}}\` for buttons.
- When the user clicks, you receive the action name and context in your next message.

DATA BINDING:
- Use \`{"path": "/json/pointer"}\` instead of a literal value to bind to the data model.
- Use \`updateDataModel\` messages to change data values.

COMPONENT TREE:
- Each component has a unique "id". Container components (Column, Row, Card, List, Tabs, Modal) reference child components by their IDs in the "children" array.
- The root-level components become the top-level UI elements.

NOTE: This is standard A2UI v0.9 format. It is NOT OpenClaw Canvas format — do not use "literalString", "explicitList", "function", or "beginRendering".

CUSTOM COMPONENTS:
- PhonePreview: Show connected phone devices with name, model, status, and screenshot.
- MarkdownEditor: Display markdown/copywriting content with a copy button.
- XHSEditor: Inline Xiaohongshu/RedNote content editor card with title, body, image upload or AI image generation, hashtags, and a device picker + publish button.
- XHSBatchTable: Inline chat table for multiple XHS posts (fixed height, max ~5 rows). Each row shows thumbnail/title/preview/target-phone/status; clicking a row expands that post's XHSEditor directly below the table; a "全部发布" button publishes all posts to their assigned phones. Pass each post's title/content/images/hashtags; omit deviceId to auto-assign phones round-robin.
- XhsOpsProjectForm: KOC nurturing project form — customer business, target audience, ops notes; saves via the controller API and reports back xhs_ops_project_saved.
- XhsOpsProfileCard: Target-user profile proposal with inline editing and human confirm/regenerate (xhs_ops_profile_confirmed / xhs_ops_profile_regenerate).
- XhsOpsAccountPlanner: Persona suggestion table with phone binding and three-layer interest pool editing.
- XhsOpsProfileMaterial: Per-account profile material — AI-generated nickname/bio, 3 avatar + 3 cover candidates to pick from, and a user-triggered 「应用到手机」 that edits the public profile via the phone.
- XhsOpsRunPlanner: Today's per-account nurture plan (keywords × counts + home feed), launch button, live chunk progress, and post-run review notes.
- XhsOpsCommentReview: Human review queue for comment drafts — per-account quota, AI candidates per browsed post, edit/approve/reject; nothing is sent from here and the agent never comments on its own.
- XhsOpsDashboard: Read-only review board for a nurturing project — account × date matrix (actual/planned browsed, home feed, interactions, anomalies), per-keyword verdicts (正常/观察/建议调整), anomaly summary, phone + ops observation timeline, and inline 运营备注 editing.
Use catalogId: "https://nexu.app/a2ui/custom-catalog.json" when using PhonePreview, MarkdownEditor, XHSEditor, XHSBatchTable, XhsOpsProjectForm, XhsOpsProfileCard, XhsOpsAccountPlanner, XhsOpsProfileMaterial, XhsOpsRunPlanner, XhsOpsDashboard, or XhsOpsCommentReview.`;

const plugin = {
  id: "nexu-a2ui",
  name: "Nexu A2UI Renderer",
  description:
    "Registers the render_a2ui tool for rendering interactive UI components directly in chat messages.",
  register(api) {
    api.registerTool({
      name: "render_a2ui",
      label: "Render Interactive UI",
      description: RENDER_A2UI_DESCRIPTION,

      parameters: {
        type: "object",
        properties: {
          surfaceId: {
            type: "string",
            description:
              "Stable identity of this UI surface (e.g. 'registration-form', 'booking-ui'). Reuse the SAME id when updating or revising previously rendered content; only use a new id for a genuinely different surface.",
          },
          catalogId: {
            type: "string",
            description:
              "Catalog ID for custom components. Use 'https://nexu.app/a2ui/custom-catalog.json' when using PhonePreview, MarkdownEditor, or XHSEditor components. Omit for standard components.",
          },
          components: {
            type: "array",
            description:
              "Array of component definitions. Each component must have a unique 'id' and a 'type'. Container components reference children by ID.",
            items: {
              oneOf: COMPONENT_SCHEMAS.map((s) => ({
                type: "object",
                properties: s.properties,
                required: s.required,
                additionalProperties: false,
              })),
            },
          },
          initialData: {
            type: "object",
            description:
              "Optional initial data model values. Each key becomes a top-level path in the data model. Use this to pre-fill form values.",
          },
        },
        required: ["surfaceId", "components"],
      },

      async execute(_toolCallId, params) {
        const jsonl = generateA2UIJSONL(
          params.surfaceId,
          params.components,
          params.initialData,
          params.catalogId,
        );

        return {
          content: [
            {
              type: "text",
              text: ["```a2ui", jsonl, "```"].join("\n"),
            },
          ],
        };
      },
    });

    api.registerTool({
      name: "render_skill_confirmation",
      label: "Render Skill Confirmation Card",
      description: `Render a confirmation card for skill operations that require user approval (posting, commenting, etc.).

WHEN TO USE:
- The device_execute_skill tool returns a result with status "needs_confirmation"
- The user needs to review and approve/cancel a write operation before it executes

HOW TO USE:
- Call this tool with the pending operation details from the needs_confirmation result
- It generates a standardized confirmation card with screenshot preview, operation summary, and confirm/cancel buttons
- When the user clicks a button, you receive the action and can call device_execute_skill with action="resume" to proceed or abort

PARAMETERS:
- surfaceId: Unique surface ID for this confirmation UI
- appName: Display name of the target app (e.g. "小红书")
- operationName: Name of the pending operation (e.g. "发布笔记", "发表评论")
- contentSummary: Key-value pairs of the content to be confirmed (e.g. {"标题": "周末羽毛球", "正文": "..."})
- screenshotUrl: URL or data URI of the current phone screenshot showing the filled content
- taskId: The orchestration taskId (needed for resume)
- subtaskId: The pending subtaskId (needed for resume)`,

      parameters: {
        type: "object",
        properties: {
          surfaceId: {
            type: "string",
            description: "Unique identifier for this confirmation surface (e.g. 'xhs-post-confirm')",
          },
          appName: {
            type: "string",
            description: "Display name of the app (e.g. '小红书')",
          },
          operationName: {
            type: "string",
            description: "Name of the operation pending confirmation (e.g. '发布笔记')",
          },
          contentSummary: {
            type: "object",
            description: "Key-value pairs of content to be reviewed (e.g. {\"标题\": \"周末羽毛球\"})",
            additionalProperties: { type: "string" },
          },
          screenshotUrl: {
            type: "string",
            description: "Data URI or URL of the current phone screenshot",
          },
          taskId: {
            type: "string",
            description: "The orchestration taskId for resume",
          },
          subtaskId: {
            type: "string",
            description: "The pending subtaskId for resume",
          },
        },
        required: ["surfaceId", "appName", "operationName", "contentSummary", "taskId", "subtaskId"],
      },

      async execute(_toolCallId, params) {
        // Build component tree for confirmation card
        const components = [];
        const rootChildren = [];

        // Header section
        components.push({
          id: "confirm-header",
          type: "Text",
          content: `📱 ${params.appName} - ${params.operationName}确认`,
          variant: "h3",
        });
        rootChildren.push("confirm-header");

        // Screenshot section (if provided)
        if (params.screenshotUrl) {
          components.push({
            id: "confirm-screenshot",
            type: "Image",
            source: params.screenshotUrl,
            alt: "当前屏幕截图",
            width: 270,
            height: 480,
          });
          rootChildren.push("confirm-screenshot");
        }

        // Content summary section
        const contentChildren = [];
        components.push({
          id: "content-label",
          type: "Text",
          content: "📋 待确认内容",
          variant: "h4",
        });
        contentChildren.push("content-label");

        const entries = Object.entries(params.contentSummary);
        for (const [key, value] of entries) {
          const keyId = `content-key-${key}`;
          const valueId = `content-value-${key}`;
          const rowId = `content-row-${key}`;

          components.push({ id: keyId, type: "Text", content: `${key}：`, variant: "body" });
          components.push({
            id: valueId,
            type: "Text",
            content: value.length > 100 ? value.slice(0, 100) + "..." : value,
            variant: "body",
          });
          components.push({
            id: rowId,
            type: "Row",
            children: [keyId, valueId],
            gap: 4,
          });
          contentChildren.push(rowId);
        }

        components.push({
          id: "content-section",
          type: "Column",
          children: contentChildren,
          gap: 6,
        });
        rootChildren.push("content-section");

        // Divider
        components.push({ id: "confirm-divider", type: "Divider" });
        rootChildren.push("confirm-divider");

        // Action buttons
        components.push({
          id: "btn-cancel",
          type: "Button",
          label: "❌ 取消",
          variant: "secondary",
          action: {
            event: {
              name: "skill_confirmation",
              context: {
                taskId: params.taskId,
                subtaskId: params.subtaskId,
                confirmed: false,
              },
            },
          },
        });

        components.push({
          id: "btn-confirm",
          type: "Button",
          label: "✅ 确认执行",
          variant: "primary",
          action: {
            event: {
              name: "skill_confirmation",
              context: {
                taskId: params.taskId,
                subtaskId: params.subtaskId,
                confirmed: true,
              },
            },
          },
        });

        components.push({
          id: "action-buttons",
          type: "Row",
          children: ["btn-cancel", "btn-confirm"],
          gap: 12,
          alignment: "center",
        });
        rootChildren.push("action-buttons");

        // Root card
        components.push({
          id: "confirm-card",
          type: "Card",
          children: rootChildren,
          padding: 16,
          elevation: 2,
        });

        const jsonl = generateA2UIJSONL(params.surfaceId, components, undefined, undefined);

        return {
          content: [
            {
              type: "text",
              text: ["```a2ui", jsonl, "```"].join("\n"),
            },
          ],
        };
      },
    });
  },
};

export default plugin;
