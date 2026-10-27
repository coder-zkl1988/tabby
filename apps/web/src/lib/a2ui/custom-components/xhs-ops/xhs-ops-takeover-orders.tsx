/**
 * Takeover card ⑥ 变更单 and ⑦ 观察 (T8–T9, §5.2): public profile changes go
 * through one change order at a time — precheck, a confirmation that lists
 * every value verbatim, the apply, a verification of the order's own fields,
 * the human checks, and the observation review.
 */
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  XHS_PROFILE_FIELD_LABEL,
  XHS_TAKEOVER_CHANGE_BUDGET,
  XHS_TAKEOVER_CHANGE_ORDER_STATUS_LABEL,
  XHS_TAKEOVER_OBSERVATION_HOURS,
  type XhsOpsChangeOrder,
  type XhsOpsChangeOrderAckKey,
  type XhsOpsChangeOrderActionResponse,
  type XhsOpsChangeOrderField,
  type XhsOpsHeaderCounts,
  type XhsOpsTakeoverProfileField,
  compareXhsOpsAudits,
  xhsOpsChangeOrderPreviousReviewWarned,
  xhsOpsChangeOrderRequiredAcks,
  xhsOpsChangeOrderRollbackFields,
  xhsOpsIsTakeoverImageField,
  xhsOpsProfileFieldLabels,
} from "@nexu/shared";
import { useEffect, useState } from "react";
import { ZoomableImage } from "../../components/zoomable-image";
import { xhsOpsApi } from "./xhs-ops-api";
import {
  AUDIT_PARTS,
  AUDIT_PART_STATUS_LABEL,
  CHANGE_ORDER_FLAG_LABEL,
  FIELD_CODE_LABEL,
  FIELD_OUTCOME_LABEL,
  OBSERVATION_VERDICT_LABEL,
  TAKEOVER_BUDGET_HISTORY_NOTE,
  TAKEOVER_FIELDS,
  TAKEOVER_ORDER_MANUAL_CHECK_NOTICE,
  auditPartTone,
  changeOrderAckText,
  changeOrderTone,
  countDisplay,
  formatDateTime,
  formatRemaining,
  orderTakeoverFields,
  rollbackCostText,
  takeoverBudgetRows,
  takeoverImageProblem,
  takeoverImageUrl,
  takeoverPinChangesText,
  verdictTone,
} from "./xhs-ops-takeover-model";
import {
  CheckLine,
  Notice,
  TakeoverFieldValueInput,
  TakeoverSection,
  type TakeoverSectionProps,
  ValueRow,
  useTakeoverAction,
} from "./xhs-ops-takeover-ui";
import {
  ConfirmDialog,
  EmptyState,
  ErrorLine,
  Field,
  HintLine,
  PrimaryButton,
  SecondaryButton,
  Spinner,
  StatusPill,
  selectClass,
} from "./xhs-ops-ui";

function orderTitle(order: XhsOpsChangeOrder): string {
  const fields = xhsOpsProfileFieldLabels(
    order.fields.map((entry) => entry.field),
  );
  return order.rollbackOfId
    ? `回滚单 · ${fields}`
    : `第 ${order.batchIndex} 批 · ${fields}`;
}

/** Batches in order; a rollback sits right after what it rolls back. */
function sortedOrders(orders: readonly XhsOpsChangeOrder[]) {
  return [...orders].sort(
    (left, right) =>
      left.batchIndex - right.batchIndex ||
      left.createdAt.localeCompare(right.createdAt),
  );
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("读取图片失败"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

/** D2: L1 72 hours, L2 7 days. */
function observationWindowLabel(risk: XhsOpsChangeOrder["risk"]): string {
  const hours = XHS_TAKEOVER_OBSERVATION_HOURS[risk];
  return hours % 24 === 0 && hours > 72 ? `${hours / 24} 天` : `${hours} 小时`;
}

/**
 * Every album a picture of the order was pushed into (§5.2 step 4 清理):
 * pushedAlbums, kept across attempts and through a failed dispatch, plus the
 * fields' mediaAlbum of an order written before that list existed.
 */
function albumsOf(order: XhsOpsChangeOrder): string[] {
  return [
    ...new Set([
      ...order.pushedAlbums,
      ...order.fields.flatMap((entry) =>
        entry.mediaAlbum ? [entry.mediaAlbum] : [],
      ),
    ]),
  ];
}

/** ⑥ 变更单. */
export function ChangeOrdersSection({ data, ops }: TakeoverSectionProps) {
  const { account, orders, now } = data;
  const takeover = account.takeover;
  const active = takeover?.activeChangeOrderId
    ? orders.find((order) => order.id === takeover.activeChangeOrderId)
    : undefined;
  const budget = takeoverBudgetRows({
    account,
    platformAccountId: account.platformAccountId,
    orders,
    now,
  });
  const notices = takeover?.platformLimitNotices ?? [];
  const observationUntil = takeover?.observationUntil
    ? Date.parse(takeover.observationUntil)
    : Number.NaN;

  return (
    <TakeoverSection
      index="⑥"
      title="变更单"
      testId="change-orders"
      hint="公开资料只通过变更单修改：逐张预检、逐字确认后才执行"
    >
      <HintLine>
        第 1 批是简介和职业（观察 72
        小时），之后昵称和地区一批、头像和背景图一批（各观察 7
        天）。每张单先「预检」只读回读本批字段并核对小红书号，再在弹窗里核对现值和新值后「确认执行」；执行后只核验本单字段。
      </HintLine>
      {active &&
      (active.status === "awaiting_confirm" ||
        active.status === "awaiting_visual_check" ||
        active.status === "awaiting_manual_check" ||
        active.status === "interrupted") ? (
        <Notice tone="warning" testId="change-order-todo">
          待办：「{orderTitle(active)}」
          {XHS_TAKEOVER_CHANGE_ORDER_STATUS_LABEL[active.status]}
          ，这张单走完之前养号暂停。
        </Notice>
      ) : null}
      {Number.isFinite(observationUntil) && observationUntil > now ? (
        <Notice tone="info">
          观察期到 {formatDateTime(takeover?.observationUntil)}{" "}
          结束：期间不能开下一张公开变更单；资料变更当天不跑养号。
        </Notice>
      ) : null}
      {orders.length === 0 ? (
        <EmptyState>
          {takeover?.keepAllPublic
            ? "方案选择了「全部保留，只做维护」，没有公开资料变更单。"
            : "没有公开资料变更单。"}
        </EmptyState>
      ) : null}
      {sortedOrders(orders).map((order) => (
        <ChangeOrderCard key={order.id} order={order} data={data} ops={ops} />
      ))}
      {takeover?.planConfirmedAt ? (
        <ManualChangeOrder data={data} ops={ops} />
      ) : null}
      <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-1 px-2.5 py-2">
        <span className="text-[12px] font-medium text-text-heading">
          修改预算（接管自限，比平台更严）
        </span>
        <div className="overflow-x-auto">
          <table
            data-testid="takeover-budget"
            className="w-full min-w-[28rem] border-collapse text-[12px]"
          >
            <thead className="text-text-secondary">
              <tr>
                <th className="py-1 text-left font-normal">字段</th>
                <th className="py-1 text-left font-normal">级别</th>
                <th className="py-1 text-left font-normal">接管自限</th>
                <th className="py-1 text-left font-normal">已用</th>
                <th className="py-1 text-left font-normal">下次可改</th>
              </tr>
            </thead>
            <tbody>
              {budget.map((row) => (
                <tr key={row.field} className="border-t border-border">
                  <td className="py-1">{XHS_PROFILE_FIELD_LABEL[row.field]}</td>
                  <td className="py-1 text-text-secondary">{row.risk}</td>
                  <td className="py-1 text-text-secondary">
                    每 {row.windowDays} 天最多 {row.maxChanges} 次
                  </td>
                  <td className="py-1 text-text-secondary">
                    {row.used}/{row.maxChanges}
                  </td>
                  <td className="py-1 text-text-secondary">
                    {row.blockedUntil
                      ? `${formatDateTime(row.blockedUntil)} 之后`
                      : "现在可改"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {notices.length > 0 ? (
          <div className="flex flex-col gap-0.5 text-[12px] text-[var(--color-warning-ink)]">
            {notices.map((notice) => (
              <span key={`${notice.field}-${notice.observedAt}`}>
                {XHS_PROFILE_FIELD_LABEL[notice.field]}：手机提示「{notice.text}
                」，
                {formatDateTime(notice.blockedUntil)} 之前锁定
              </span>
            ))}
          </div>
        ) : null}
        <HintLine>{TAKEOVER_BUDGET_HISTORY_NOTE}。</HintLine>
      </div>
    </TakeoverSection>
  );
}

/** MT-02's three batches in order; one order only ever holds fields of one. */
const ORDER_BATCHES = [1, 2, 3].map((batch) => ({
  batch,
  fields: TAKEOVER_FIELDS.filter(
    (field) => XHS_TAKEOVER_CHANGE_BUDGET[field].batch === batch,
  ),
}));

const FINISHED_ORDER_STATUSES: ReadonlySet<XhsOpsChangeOrder["status"]> =
  new Set(["completed", "failed", "cancelled"]);

/**
 * The value the plan adopted for `field` (§5.2 step 1), so an order the plan
 * confirmation could not draft — the phone was unreachable for an image, say
 * — starts from it. "" when the plan adopted nothing for the field.
 */
function adoptedTarget(
  diagnosis: TakeoverSectionProps["data"]["diagnosis"],
  field: XhsOpsTakeoverProfileField,
): string {
  for (const proposal of diagnosis?.proposals ?? []) {
    if (proposal.kind !== "profileField" || proposal.field !== field) continue;
    const decision = diagnosis?.decisions[proposal.id];
    if (decision?.decision === "adopt") return proposal.to;
    if (decision?.decision === "edit") {
      const edited = decision.edited;
      return typeof edited === "object" &&
        edited !== null &&
        "to" in edited &&
        typeof edited.to === "string"
        ? edited.to
        : proposal.to;
    }
  }
  return "";
}

/**
 * 「手动新建变更单」 (§5.2 step 1): POST /accounts/{id}/change-orders serves
 * rollbacks and manual orders. A manual order is a draft like any other —
 * precheck and the verbatim confirmation still come before anything runs.
 */
function ManualChangeOrder({ data, ops }: TakeoverSectionProps) {
  const { account, orders, diagnosis } = data;
  const { busy, error, run } = useTakeoverAction(ops.refresh);
  const [open, setOpen] = useState(false);
  const [batch, setBatch] = useState(1);
  const [values, setValues] = useState<
    Partial<Record<XhsOpsTakeoverProfileField, string>>
  >({});
  const fields =
    ORDER_BATCHES.find((entry) => entry.batch === batch)?.fields ?? [];
  // The controller refuses a second unfinished order for the same field.
  const pending = new Set(
    orders
      .filter((order) => !FINISHED_ORDER_STATUSES.has(order.status))
      .flatMap((order) => order.fields.map((entry) => entry.field)),
  );
  const chosen = fields.filter((field) => values[field] !== undefined);
  const ready =
    chosen.length > 0 &&
    chosen.every((field) => (values[field] ?? "").trim() !== "");

  const close = () => {
    setOpen(false);
    setValues({});
  };
  const create = () =>
    void run("create", "新建变更单失败", async () => {
      const result = await xhsOpsApi.createChangeOrder(account.id, {
        fields: chosen.map((field) => ({
          field,
          after: (values[field] ?? "").trim(),
        })),
      });
      ops.track(result.order.id);
      ops.upsertOrder(result.order);
      ops.setAccount(result.account);
      close();
    });

  if (!open)
    return (
      <div className="flex justify-end">
        <SecondaryButton onClick={() => setOpen(true)}>
          手动新建变更单
        </SecondaryButton>
      </div>
    );
  return (
    <div
      data-testid="manual-change-order"
      className="flex flex-col gap-2 rounded-md border border-border bg-surface-1 px-2.5 py-2"
    >
      <span className="text-[12px] font-medium text-text-heading">
        手动新建变更单
      </span>
      <HintLine>
        新建的只是草案：照样要先预检，再在弹窗里逐字确认后才会执行。一张单只能改同一批的字段。
      </HintLine>
      <Field label="批次">
        <select
          className={selectClass}
          value={batch}
          disabled={busy !== null}
          onChange={(event) => {
            setBatch(Number(event.target.value));
            setValues({});
          }}
        >
          {ORDER_BATCHES.map((entry) => (
            <option key={entry.batch} value={entry.batch}>
              第 {entry.batch} 批：{xhsOpsProfileFieldLabels(entry.fields)}
            </option>
          ))}
        </select>
      </Field>
      {fields.map((field) => {
        const value = values[field];
        const blocked = pending.has(field);
        return (
          <div key={field} className="flex flex-col gap-1">
            <CheckLine
              checked={value !== undefined}
              disabled={blocked || busy !== null}
              onChange={(checked) =>
                setValues((current) => {
                  const next = { ...current };
                  if (checked) next[field] = adoptedTarget(diagnosis, field);
                  else delete next[field];
                  return next;
                })
              }
            >
              改{XHS_PROFILE_FIELD_LABEL[field]}
              {blocked ? "（已有未结束的变更单）" : ""}
            </CheckLine>
            {value !== undefined ? (
              <TakeoverFieldValueInput
                field={field}
                value={value}
                disabled={busy !== null}
                onChange={(next) =>
                  setValues((current) => ({ ...current, [field]: next }))
                }
              />
            ) : null}
          </div>
        );
      })}
      <div className="flex items-center justify-end gap-2">
        <SecondaryButton onClick={close} disabled={busy !== null}>
          取消
        </SecondaryButton>
        <PrimaryButton onClick={create} disabled={!ready || busy !== null}>
          {busy === "create" ? <Spinner /> : null}
          新建草案
        </PrimaryButton>
      </div>
      <ErrorLine message={error} />
    </div>
  );
}

function ChangeOrderCard({
  order,
  data,
  ops,
}: TakeoverSectionProps & { order: XhsOpsChangeOrder }) {
  const { busy, error, setError, run } = useTakeoverAction(ops.refresh);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const disabled = busy !== null;
  const expectedUpdatedAt = order.updatedAt;

  const apply = (result: XhsOpsChangeOrderActionResponse) => {
    ops.upsertOrder(result.order);
    ops.setAccount(result.account);
    ops.forward(result.event);
  };

  const precheck = () =>
    void run("precheck", "预检失败", async () => {
      ops.track(order.id);
      apply(
        await xhsOpsApi.precheckChangeOrder(order.id, { expectedUpdatedAt }),
      );
    });

  const confirm = (acks: Partial<Record<XhsOpsChangeOrderAckKey, boolean>>) =>
    void run("confirm", "确认执行失败", async () => {
      if (!order.precheck) throw new Error("请先预检");
      ops.track(order.id);
      apply(
        await xhsOpsApi.confirmChangeOrder(order.id, {
          confirmDigest: order.precheck.confirmDigest,
          expectedUpdatedAt,
          acks,
        }),
      );
    });

  const cancel = () =>
    void run("cancel", "取消变更单失败", async () =>
      apply(await xhsOpsApi.cancelChangeOrder(order.id, { expectedUpdatedAt })),
    );

  const verify = () =>
    void run("verify", "补跑核验失败", async () => {
      ops.track(order.id);
      apply(await xhsOpsApi.verifyChangeOrder(order.id, { expectedUpdatedAt }));
    });

  const manualCheck = () =>
    void run("manual", "提交人工检查失败", async () => {
      ops.track(order.id);
      apply(
        await xhsOpsApi.manualCheckChangeOrder(order.id, { expectedUpdatedAt }),
      );
    });

  const visualCheck = (
    field: "avatar" | "cover",
    result: "match" | "mismatch",
  ) =>
    void run(`visual:${field}`, "提交图片对照结果失败", async () => {
      ops.track(order.id);
      apply(
        await xhsOpsApi.visualCheckChangeOrder(order.id, {
          field,
          result,
          expectedUpdatedAt,
        }),
      );
    });

  const upload = async (field: "avatar" | "cover", file: File) => {
    const problem = takeoverImageProblem(file);
    if (problem) {
      setError(`${XHS_PROFILE_FIELD_LABEL[field]}：${problem}`);
      return;
    }
    await run(`upload:${field}`, "上传图片失败", async () => {
      const dataUrl = await readAsDataUrl(file);
      apply(
        await xhsOpsApi.uploadChangeOrderImage(order.id, field, {
          dataUrl,
          expectedUpdatedAt,
        }),
      );
    });
  };

  const rollbackable = xhsOpsChangeOrderRollbackFields(order);
  const rollbackOpenAlready = data.orders.some(
    (entry) =>
      entry.rollbackOfId === order.id &&
      entry.status !== "completed" &&
      entry.status !== "failed" &&
      entry.status !== "cancelled",
  );
  const createRollback = () =>
    void run("rollback", "新建回滚单失败", async () => {
      const result = await xhsOpsApi.createChangeOrder(order.accountId, {
        rollbackOfId: order.id,
        fields: rollbackable.map((field) => ({ field })),
      });
      ops.track(result.order.id);
      ops.upsertOrder(result.order);
      ops.setAccount(result.account);
    });

  const hasImage = order.fields.some((entry) =>
    xhsOpsIsTakeoverImageField(entry.field),
  );
  const missingImages = order.fields.filter(
    (entry) => xhsOpsIsTakeoverImageField(entry.field) && !entry.imageSha256,
  );
  const albums = albumsOf(order);
  // A draft that already went to the phone once (a failed dispatch) left its
  // own album there too.
  const previousAlbums = [
    ...new Set([
      ...data.orders.filter((entry) => entry.id !== order.id).flatMap(albumsOf),
      ...albums,
    ]),
  ];
  const precheckExpiresAt = order.precheck
    ? Date.parse(order.precheck.expiresAt)
    : Number.NaN;
  const precheckExpired =
    order.status === "awaiting_confirm" &&
    Number.isFinite(precheckExpiresAt) &&
    precheckExpiresAt <= data.now;
  const editableImages =
    order.status === "draft" || order.status === "awaiting_confirm";

  return (
    <div
      data-change-order={order.id}
      className={`flex flex-col gap-2 rounded-md border border-border px-2.5 py-2 ${
        order.status === "cancelled"
          ? "bg-surface-0 opacity-70"
          : "bg-surface-1"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-medium text-text-primary">
          {orderTitle(order)}
        </span>
        <span className="text-text-secondary">{order.risk}</span>
        <StatusPill tone={changeOrderTone(order.status)}>
          {XHS_TAKEOVER_CHANGE_ORDER_STATUS_LABEL[order.status]}
        </StatusPill>
        {order.confirmedAt ? (
          <span className="text-text-secondary">
            确认于 {formatDateTime(order.confirmedAt)}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        {order.fields.map((entry) => (
          <OrderFieldRow
            key={entry.field}
            order={order}
            entry={entry}
            disabled={disabled || !editableImages}
            uploading={busy === `upload:${entry.field}`}
            onUpload={(file) =>
              xhsOpsIsTakeoverImageField(entry.field)
                ? void upload(entry.field, file)
                : undefined
            }
          />
        ))}
      </div>

      {order.flags.map((flag) => (
        <Notice key={flag} tone="warning">
          {CHANGE_ORDER_FLAG_LABEL[flag]}
        </Notice>
      ))}
      {order.error && order.status !== "cancelled" ? (
        <Notice tone={order.status === "failed" ? "error" : "warning"}>
          {order.error}
        </Notice>
      ) : null}
      {order.status === "cancelled" && order.error ? (
        <HintLine>{order.error}</HintLine>
      ) : null}

      {order.status === "draft" ? (
        <>
          {missingImages.length > 0 ? (
            <Notice tone="info">
              先为
              {xhsOpsProfileFieldLabels(
                missingImages.map((entry) => entry.field),
              )}
              提供一张图：图片由你提供，不为接管号生成虚构的真人头像；没有图片之前这张单不能预检。
            </Notice>
          ) : null}
          {hasImage &&
          (order.rollbackOfId !== null || previousAlbums.length > 0) ? (
            <Notice tone="warning" testId="old-album-warning">
              预检前请先在手机相册里删掉之前推进的 Tabby- 相册
              {previousAlbums.length > 0
                ? `（${previousAlbums.join("、")}）`
                : ""}
              ：重试或回滚之后手机上会有多个 Tabby-
              开头的相册，任务只认名字逐字一致的那个。
            </Notice>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <SecondaryButton
              danger
              onClick={() => setCancelOpen(true)}
              disabled={disabled}
            >
              取消这张单
            </SecondaryButton>
            <PrimaryButton
              onClick={precheck}
              disabled={disabled || missingImages.length > 0}
            >
              {busy === "precheck" ? <Spinner /> : null}
              预检
            </PrimaryButton>
          </div>
          <HintLine>
            预检只读回读本批字段并核对小红书号，不改资料、不计预算；约 1–3
            分钟，期间手机被占用。
          </HintLine>
        </>
      ) : null}

      {order.status === "prechecking" ? (
        <Notice tone="info">
          <span className="flex items-center gap-2">
            <Spinner />
            预检中：手机正在只读回读本批字段并核对小红书号…
          </span>
        </Notice>
      ) : null}

      {order.status === "awaiting_confirm" && order.precheck ? (
        <>
          <HintLine>
            预检通过 {formatDateTime(order.precheck.readAt)}；
            {precheckExpired
              ? "已超过 30 分钟，请重新预检。"
              : `${formatDateTime(order.precheck.expiresAt)} 之前有效（还剩 ${formatRemaining(precheckExpiresAt - data.now)}）。`}
          </HintLine>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <SecondaryButton
              danger
              onClick={() => setCancelOpen(true)}
              disabled={disabled}
            >
              取消这张单
            </SecondaryButton>
            <SecondaryButton onClick={precheck} disabled={disabled}>
              重新预检
            </SecondaryButton>
            <PrimaryButton
              onClick={() => setConfirmOpen(true)}
              disabled={disabled || precheckExpired || missingImages.length > 0}
            >
              {busy === "confirm" ? <Spinner /> : null}
              确认执行
            </PrimaryButton>
          </div>
        </>
      ) : null}

      {order.status === "applying" || order.status === "verifying" ? (
        <Notice tone="info">
          <span className="flex items-center gap-2">
            <Spinner />
            {order.status === "applying"
              ? `手机正在修改本单字段（${hasImage ? "含图片约 5–10 分钟" : "约 2–5 分钟"}）…`
              : "手机正在只读核验本单字段…"}
          </span>
        </Notice>
      ) : null}

      {order.status === "interrupted" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <HintLine>
            本单字段可能已经改了，需要补跑核验后才能进入观察期。
          </HintLine>
          <PrimaryButton onClick={verify} disabled={disabled}>
            {busy === "verify" ? <Spinner /> : null}
            补跑核验
          </PrimaryButton>
        </div>
      ) : null}

      {order.status === "awaiting_visual_check"
        ? order.fields
            .filter(
              (entry) =>
                xhsOpsIsTakeoverImageField(entry.field) &&
                entry.outcome === "done",
            )
            .map((entry) => (
              <ImageComparison
                key={entry.field}
                entry={entry}
                screenshotUrl={order.verificationScreenshotUrl}
                busy={busy === `visual:${entry.field}`}
                disabled={disabled}
                onResult={(result) =>
                  xhsOpsIsTakeoverImageField(entry.field)
                    ? visualCheck(entry.field, result)
                    : undefined
                }
              />
            ))
        : null}

      {order.status === "awaiting_manual_check" ? (
        <Notice tone="warning" testId="order-manual-check">
          <span>{TAKEOVER_ORDER_MANUAL_CHECK_NOTICE}。</span>
          <CountsDiff before={order.countsBefore} after={order.countsAfter} />
          <div className="flex justify-end">
            <PrimaryButton onClick={manualCheck} disabled={disabled}>
              已人工检查
            </PrimaryButton>
          </div>
        </Notice>
      ) : null}

      {order.status === "observing" ? (
        <HintLine>
          观察期到 {formatDateTime(order.observation?.until)}，复查见 ⑦。
        </HintLine>
      ) : null}

      {albums.length > 0 &&
      (order.status === "observing" ||
        order.status === "completed" ||
        order.status === "failed") ? (
        <Notice tone="info" testId="album-cleanup">
          推进到手机相册的图片不会自动删除：请在手机相册里删除相册{" "}
          {albums.join("、")}（Tabby-…-* 相册）。
        </Notice>
      ) : null}

      {rollbackable.length > 0 ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {rollbackOpenAlready ? (
            <HintLine>已有一张未结束的回滚单。</HintLine>
          ) : (
            <SecondaryButton
              onClick={() => setRollbackOpen(true)}
              disabled={disabled}
            >
              新建回滚单
            </SecondaryButton>
          )}
        </div>
      ) : null}
      <ErrorLine message={error} />

      <ChangeOrderConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        order={order}
        data={data}
        onConfirm={confirm}
      />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="取消这张变更单？"
        confirmLabel="取消变更单"
        cancelLabel="不取消"
        danger
        description={
          <p>这张单还没在手机上改过任何东西，取消后不会改动资料。</p>
        }
        onConfirm={cancel}
      />
      <ConfirmDialog
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        title="新建回滚单？"
        confirmLabel="新建回滚单"
        description={
          <>
            <p>
              回滚单把{xhsOpsProfileFieldLabels(rollbackable)}
              改回这张单改前的值，照常走预检和确认，绝不自动执行。
            </p>
            {rollbackable.map((field) => (
              <p key={field} className="mt-1">
                {rollbackCostText(field)}
              </p>
            ))}
          </>
        }
        onConfirm={createRollback}
      />
    </div>
  );
}

function OrderFieldRow({
  order,
  entry,
  disabled,
  uploading,
  onUpload,
}: {
  order: XhsOpsChangeOrder;
  entry: XhsOpsChangeOrderField;
  disabled: boolean;
  uploading: boolean;
  onUpload: (file: File) => void;
}) {
  const label = XHS_PROFILE_FIELD_LABEL[entry.field];
  const prechecked = order.precheck !== null || order.confirmedAt !== null;
  const imageUrl = takeoverImageUrl(entry);
  return (
    <div className="flex flex-col gap-1 rounded border border-border-subtle px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-medium text-text-primary">{label}</span>
        {entry.outcome !== "pending" ? (
          <span className="text-text-secondary">
            {FIELD_OUTCOME_LABEL[entry.outcome]}
          </span>
        ) : null}
        {entry.code ? (
          <span className="text-[var(--color-warning-ink)]">
            {FIELD_CODE_LABEL[entry.code] ?? entry.code}
          </span>
        ) : null}
      </div>
      {xhsOpsIsTakeoverImageField(entry.field) ? (
        <>
          <ValueRow label="图片方向">{entry.after}</ValueRow>
          <div className="flex flex-wrap items-start gap-3">
            {imageUrl ? (
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-text-secondary">
                  你提供的图片
                </span>
                <ZoomableImage
                  src={imageUrl}
                  alt={`${label}原图`}
                  imgClassName="h-20 w-20 rounded-md border border-border object-cover"
                />
              </div>
            ) : (
              <span className="text-[12px] text-text-secondary">
                还没提供图片
              </span>
            )}
            {entry.beforeScreenshotUrl ? (
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-text-secondary">
                  改前截图
                </span>
                <ZoomableImage
                  src={entry.beforeScreenshotUrl}
                  alt={`${label}改前截图`}
                  imgClassName="h-20 w-auto rounded-md border border-border"
                />
              </div>
            ) : null}
            {!disabled ? (
              <label className="flex cursor-pointer flex-col gap-1 text-[12px] text-text-secondary">
                <span>
                  {imageUrl ? "换一张图" : "上传图片"}（png / jpeg /
                  webp，≤10MB）
                </span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  aria-label={`上传${label}图片`}
                  disabled={uploading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) onUpload(file);
                  }}
                />
              </label>
            ) : null}
            {uploading ? <Spinner /> : null}
          </div>
          {entry.mediaAlbum ? (
            <HintLine>专用相册：{entry.mediaAlbum}</HintLine>
          ) : null}
        </>
      ) : (
        <>
          <ValueRow label={prechecked ? "预检时手机现值" : "基线值"}>
            {(prechecked ? entry.before : entry.baselineValue) || "（空）"}
          </ValueRow>
          <ValueRow label="新值">{entry.after || "（空）"}</ValueRow>
        </>
      )}
      {entry.note ? <HintLine>{entry.note}</HintLine> : null}
    </div>
  );
}

function CountsDiff({
  before,
  after,
}: {
  before: XhsOpsHeaderCounts | null;
  after: XhsOpsHeaderCounts | null;
}) {
  const rows: Array<[keyof XhsOpsHeaderCounts, string]> = [
    ["following", "关注"],
    ["followers", "粉丝"],
    ["likesCollects", "获赞与收藏"],
  ];
  return (
    <div className="flex flex-col gap-0.5 text-text-primary">
      {rows.map(([key, label]) => (
        <span key={key}>
          {label}：预检 {countDisplay(before?.[key])} → 核验{" "}
          {countDisplay(after?.[key])}
        </span>
      ))}
    </div>
  );
}

/** The phone's final screenshot beside the user's picture, judged per field. */
function ImageComparison({
  entry,
  screenshotUrl,
  busy,
  disabled,
  onResult,
}: {
  entry: XhsOpsChangeOrderField;
  screenshotUrl: string | null;
  busy: boolean;
  disabled: boolean;
  onResult: (result: "match" | "mismatch") => void;
}) {
  const label = XHS_PROFILE_FIELD_LABEL[entry.field];
  const imageUrl = takeoverImageUrl(entry);
  return (
    <div
      data-visual-check={entry.field}
      className="flex flex-col gap-2 rounded-md border border-[var(--color-warning-ink)]/[25%] bg-surface-1 px-2.5 py-2"
    >
      <span className="text-[12px] font-medium text-text-primary">
        对照{label}：手机上的图和你提供的原图一致吗？
      </span>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-text-secondary">
            手机最后一张截图
          </span>
          {screenshotUrl ? (
            <ZoomableImage
              src={screenshotUrl}
              alt={`${label}核验截图`}
              imgClassName="max-h-48 w-auto rounded-md border border-border"
            />
          ) : (
            <span className="text-[12px] text-text-secondary">
              没有截图，请直接看手机
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-text-secondary">你提供的原图</span>
          {imageUrl ? (
            <ZoomableImage
              src={imageUrl}
              alt={`${label}原图`}
              imgClassName="max-h-48 w-auto rounded-md border border-border"
            />
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <SecondaryButton
          danger
          onClick={() => onResult("mismatch")}
          disabled={disabled}
        >
          不一致
        </SecondaryButton>
        <PrimaryButton onClick={() => onResult("match")} disabled={disabled}>
          {busy ? <Spinner /> : null}
          一致
        </PrimaryButton>
      </div>
      <HintLine>
        不一致会让这张单失败并暂停接管，请立即在手机上手动换回，之后可以开回滚单。
      </HintLine>
    </div>
  );
}

/**
 * The confirmation of §5.2 step 3: current → new value verbatim, 「公开、不可
 * 撤销」, the budget left, what a rollback costs, and every box the server
 * demands — the confirm stays disabled until each one is ticked.
 */
function ChangeOrderConfirmDialog({
  open,
  onOpenChange,
  order,
  data,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: XhsOpsChangeOrder;
  data: TakeoverSectionProps["data"];
  onConfirm: (acks: Partial<Record<XhsOpsChangeOrderAckKey, boolean>>) => void;
}) {
  const fields = order.fields.map((entry) => entry.field);
  const required = xhsOpsChangeOrderRequiredAcks(fields, {
    previousWarn: xhsOpsChangeOrderPreviousReviewWarned(data.orders, order),
  });
  const [acks, setAcks] = useState<
    Partial<Record<XhsOpsChangeOrderAckKey, boolean>>
  >({});
  useEffect(() => {
    if (open) setAcks({});
  }, [open]);
  const complete = required.every((key) => acks[key] === true);
  const budget = takeoverBudgetRows({
    account: data.account,
    platformAccountId: order.platformAccountId,
    orders: data.orders,
    now: data.now,
    fields: orderTakeoverFields(order),
    excludeOrderId: order.id,
    rollback: order.rollbackOfId !== null,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>确认执行这张变更单？</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto text-[13px] leading-[1.6] text-text-secondary">
            <DialogDescription asChild>
              <p className="font-medium text-[var(--color-error-ink)]">
                公开、不可撤销：确认后手机会直接修改这个号的公开资料（
                {orderTitle(order)}）。
              </p>
            </DialogDescription>
            <div className="flex flex-col gap-1">
              {order.fields.map((entry) => (
                <div
                  key={entry.field}
                  className="rounded border border-border px-2 py-1.5"
                >
                  <div className="text-[12px] font-medium text-text-primary">
                    {XHS_PROFILE_FIELD_LABEL[entry.field]}
                  </div>
                  {xhsOpsIsTakeoverImageField(entry.field) ? (
                    <>
                      <ValueRow label="现值">（图片，见改前截图）</ValueRow>
                      <ValueRow label="新值">
                        你提供的图片（方向：{entry.after}）
                      </ValueRow>
                    </>
                  ) : (
                    <>
                      <ValueRow label="现值">
                        {entry.before || "（空）"}
                      </ValueRow>
                      <ValueRow label="新值">
                        {entry.after || "（空）"}
                      </ValueRow>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-0.5 text-[12px]">
              <span className="font-medium text-text-primary">剩余预算</span>
              {budget.map((row) => (
                <span key={row.field}>
                  {XHS_PROFILE_FIELD_LABEL[row.field]}：近 {row.windowDays}{" "}
                  天已改 {row.used}/{row.maxChanges} 次
                  {order.rollbackOfId !== null
                    ? "（回滚单不受接管自限额度限制，但计入账本）"
                    : row.blockedUntil
                      ? `，${formatDateTime(row.blockedUntil)} 之前不能再改`
                      : `，这次之后剩 ${Math.max(0, row.maxChanges - row.used - 1)} 次`}
                </span>
              ))}
              <span>{TAKEOVER_BUDGET_HISTORY_NOTE}。</span>
            </div>
            <div className="flex flex-col gap-0.5 text-[12px]">
              <span className="font-medium text-text-primary">回滚代价</span>
              {order.rollbackOfId !== null ? (
                <span>这是回滚单：同样会消耗平台修改次数。</span>
              ) : null}
              {fields.map((field) => (
                <span key={field}>{rollbackCostText(field)}</span>
              ))}
            </div>
            {required.length > 0 ? (
              <div className="flex flex-col gap-1.5" data-testid="order-acks">
                <span className="text-[12px] font-medium text-text-primary">
                  请逐条确认
                </span>
                {required.map((key) => (
                  <CheckLine
                    key={key}
                    checked={acks[key] === true}
                    onChange={(checked) =>
                      setAcks((current) => ({ ...current, [key]: checked }))
                    }
                  >
                    {changeOrderAckText(key, fields)}
                  </CheckLine>
                ))}
              </div>
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <SecondaryButton onClick={() => onOpenChange(false)}>
            取消
          </SecondaryButton>
          <PrimaryButton
            disabled={!complete}
            onClick={() => {
              onOpenChange(false);
              onConfirm(Object.fromEntries(required.map((key) => [key, true])));
            }}
          >
            确认执行
          </PrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** ⑦ 观察 (T9, §6.4). */
export function ObservationSection({ data, ops }: TakeoverSectionProps) {
  const observed = sortedOrders(data.orders).filter(
    (order) => order.observation !== null,
  );
  if (observed.length === 0) return null;
  return (
    <TakeoverSection
      index="⑦"
      title="观察"
      testId="observation"
      hint="期满后由你点「复查」：本单字段回读（含号码核对）→ 主页 → 创作者数据"
    >
      {observed.map((order) => (
        <ObservationPanel key={order.id} order={order} data={data} ops={ops} />
      ))}
    </TakeoverSection>
  );
}

function ObservationPanel({
  order,
  data,
  ops,
}: TakeoverSectionProps & { order: XhsOpsChangeOrder }) {
  const { busy, error, run } = useTakeoverAction(ops.refresh);
  const observation = order.observation;
  if (!observation) return null;
  const until = Date.parse(observation.until);
  const due = Number.isFinite(until) && until <= data.now;
  const reviewAudit = observation.auditId
    ? (data.audits.find((audit) => audit.id === observation.auditId) ?? null)
    : null;
  const reviewing =
    order.status === "observing" &&
    observation.auditId !== null &&
    observation.verdict === "pending";
  // §7.1: what the review audit says about 置顶 against the audit before
  // the order (observation.baseAuditId).
  const baseAudit = observation.baseAuditId
    ? (data.audits.find((audit) => audit.id === observation.baseAuditId) ??
      null)
    : null;
  const pinChanges =
    baseAudit && reviewAudit && reviewAudit.status !== "running"
      ? takeoverPinChangesText(compareXhsOpsAudits(baseAudit, reviewAudit).pins)
      : null;
  const imagesToCheck =
    order.status === "observing" &&
    observation.auditId !== null &&
    observation.verdict === "inconclusive"
      ? order.fields.filter(
          (entry) =>
            xhsOpsIsTakeoverImageField(entry.field) &&
            entry.outcome === "verified" &&
            !observation.visualChecks[entry.field],
        )
      : [];

  const review = () =>
    void run("review", "开始复查失败", async () => {
      ops.track(order.id);
      const result = await xhsOpsApi.reviewObservation(order.id, {
        expectedUpdatedAt: order.updatedAt,
      });
      ops.upsertOrder(result.order);
      ops.setAccount(result.account);
      ops.forward(result.event);
      // The review audit runs in the background; pull it into the list.
      await ops.refresh();
    });

  const visualCheck = (
    field: "avatar" | "cover",
    result: "match" | "mismatch",
  ) =>
    void run(`visual:${field}`, "提交图片对照结果失败", async () => {
      ops.track(order.id);
      const response = await xhsOpsApi.visualCheckChangeOrder(order.id, {
        field,
        result,
        expectedUpdatedAt: order.updatedAt,
      });
      ops.upsertOrder(response.order);
      ops.setAccount(response.account);
      ops.forward(response.event);
    });

  return (
    <div
      data-observation={order.id}
      className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 py-2"
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-medium text-text-primary">
          {orderTitle(order)}
        </span>
        <span className="text-text-secondary">
          {order.risk} 观察期 {observationWindowLabel(order.risk)}
        </span>
        <StatusPill tone={verdictTone(observation.verdict)}>
          {OBSERVATION_VERDICT_LABEL[observation.verdict]}
        </StatusPill>
      </div>
      {order.status === "observing" && !observation.auditId ? (
        due ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <HintLine>观察期已满，可以复查了。</HintLine>
            <PrimaryButton onClick={review} disabled={busy !== null}>
              {busy === "review" ? <Spinner /> : null}
              复查
            </PrimaryButton>
          </div>
        ) : (
          <HintLine>
            观察期还剩 {formatRemaining(until - data.now)}（到{" "}
            {formatDateTime(observation.until)}
            ）；期满后在这里点「复查」。观察期内不开下一张公开变更单。
          </HintLine>
        )
      ) : null}
      {reviewing ? (
        <Notice tone="info">
          <span className="flex items-center gap-2">
            <Spinner />
            复查中：本单字段回读（含号码核对）→ 主页 → 创作者数据
          </span>
          {reviewAudit ? (
            <span className="flex flex-wrap gap-1.5">
              {AUDIT_PARTS.map((part) => {
                const status = reviewAudit[part.key]?.status ?? "pending";
                return (
                  <StatusPill key={part.key} tone={auditPartTone(status)}>
                    {part.title} {AUDIT_PART_STATUS_LABEL[status]}
                  </StatusPill>
                );
              })}
            </span>
          ) : null}
        </Notice>
      ) : null}
      {observation.notes.length > 0 || pinChanges ? (
        <div className="flex flex-col gap-0.5 text-[12px] text-text-secondary">
          {observation.notes.map((note) => (
            <span key={note}>{note}</span>
          ))}
          {pinChanges ? (
            <span data-testid="observation-pin-changes">
              {pinChanges}（对比这张单确认前的盘点）
            </span>
          ) : null}
        </div>
      ) : null}
      {observation.verdict === "warn" && order.status === "completed" ? (
        <HintLine>复查有提醒：下一批公开修改确认时需要额外勾选一次。</HintLine>
      ) : null}
      {imagesToCheck.map((entry) => (
        <ImageComparison
          key={entry.field}
          entry={entry}
          screenshotUrl={reviewAudit?.profile?.evidence?.screenshotUrl ?? null}
          busy={busy === `visual:${entry.field}`}
          disabled={busy !== null}
          onResult={(result) =>
            xhsOpsIsTakeoverImageField(entry.field)
              ? visualCheck(entry.field, result)
              : undefined
          }
        />
      ))}
      {(["avatar", "cover"] as const).map((field) => {
        const check = observation.visualChecks[field];
        return check ? (
          <HintLine key={field}>
            复查后对照{XHS_PROFILE_FIELD_LABEL[field]}：
            {check.result === "match" ? "一致" : "不一致"}（
            {formatDateTime(check.at)}）
          </HintLine>
        ) : null;
      })}
      <ErrorLine message={error} />
    </div>
  );
}
