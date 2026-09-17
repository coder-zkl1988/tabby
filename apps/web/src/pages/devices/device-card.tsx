import { Button } from "@/components/ui/button";
import { isImeComposing } from "@/lib/keyboard";
import { Pencil } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  deleteApiV1DevicesByDeviceIdTasksByTaskId,
  patchApiV1DevicesByDeviceId,
} from "../../../lib/api/sdk.gen";
import type { GetApiV1DevicesResponse } from "../../../lib/api/types.gen";
import { useDeviceSnapshot } from "./use-device-snapshot";

export type DeviceInfo =
  NonNullable<GetApiV1DevicesResponse>["devices"][number];

type StatusColor = "success" | "processing" | "error" | "default";

function statusColor(status: DeviceInfo["status"]): StatusColor {
  if (status === "idle") return "success";
  if (status === "busy") return "processing";
  if (status === "error") return "error";
  return "default";
}

const STATUS_DOT: Record<StatusColor, string> = {
  success: "bg-green-500",
  processing: "bg-blue-500 animate-pulse",
  error: "bg-red-500",
  default: "bg-gray-400",
};

const STATUS_TEXT: Record<StatusColor, string> = {
  success: "text-green-700",
  processing: "text-blue-700",
  error: "text-red-700",
  default: "text-gray-500",
};

const STATUS_I18N_KEY: Record<DeviceInfo["status"], string> = {
  idle: "devices.status.idle",
  busy: "devices.status.busy",
  error: "devices.status.error",
};

export function DeviceCard({
  device,
  onRefresh,
  onViewScreen,
  wsPort,
}: {
  device: DeviceInfo;
  onRefresh: () => void;
  onViewScreen: (device: DeviceInfo) => void;
  wsPort?: number;
}) {
  const { t } = useTranslation();
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(device.name ?? "");
  const nameInputRef = useRef<HTMLSpanElement>(null);
  const snapshot = useDeviceSnapshot(device.deviceId, wsPort);
  const color = statusColor(device.status);
  const label = STATUS_I18N_KEY[device.status]
    ? t(STATUS_I18N_KEY[device.status])
    : device.status;
  const displayName = device.name || device.deviceId;
  const isBusy = device.status === "busy";

  const startRename = useCallback(() => {
    setNameDraft(device.name ?? "");
    setEditingName(true);
  }, [device.name]);

  const commitRename = useCallback(async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === device.name) {
      setEditingName(false);
      return;
    }
    try {
      await patchApiV1DevicesByDeviceId({
        path: { deviceId: device.deviceId },
        body: { name: trimmed },
      });
    } catch {
      // ignore
    }
    setEditingName(false);
  }, [nameDraft, device.name, device.deviceId]);

  /**
   * Interrupt whatever the phone is running, exactly as its own on-device
   * "紧急停止" button does: the DELETE lands as an `agent.cancel` frame,
   * which the app routes to the same `cancelCurrentTask()` the local button
   * calls. The agent loop dies; the WebSocket and the foreground service stay
   * up, so the phone is idle and still connected afterwards.
   */
  const emergencyStop = useCallback(async () => {
    setStopping(true);
    setStopError(null);
    try {
      const { error: apiError } =
        await deleteApiV1DevicesByDeviceIdTasksByTaskId({
          path: {
            deviceId: device.deviceId,
            // A task whose dispatcher already timed out keeps running but is no
            // longer tracked under its id, and that is exactly the task most
            // likely to need stopping. "current" is the plugin's own name for
            // "whatever this device is running" and resolves that case.
            taskId: device.currentTaskId ?? "current",
          },
        });
      if (apiError) {
        throw new Error(
          typeof apiError === "object" &&
            apiError !== null &&
            "message" in apiError
            ? String((apiError as { message: unknown }).message)
            : t("devices.emergencyStopError"),
        );
      }
      onRefresh();
    } catch (err) {
      setStopError(
        err instanceof Error ? err.message : t("devices.emergencyStopError"),
      );
    } finally {
      setStopping(false);
    }
  }, [device.deviceId, device.currentTaskId, onRefresh, t]);

  return (
    <div className="border border-border bg-surface-1 shadow-sm flex rounded overflow-hidden">
      <div className="shrink-0 w-[120px] bg-surface-2 flex items-center justify-center">
        {snapshot ? (
          <img
            // useDeviceSnapshot always produces JPEG: the STABLE/accessibility
            // path sends raw JPEG bytes as-is, and the H.264 decode path
            // re-encodes decoded frames via canvas.toDataURL("image/jpeg", ...).
            // A "png" label here makes Chromium invoke the PNG decoder on JPEG
            // bytes, which rejects them as malformed — the <img> silently fails
            // to render regardless of which path produced the snapshot.
            src={`data:image/jpeg;base64,${snapshot}`}
            alt=""
            className="w-full h-full object-cover"
          />
        ) : (
          <span className="text-3xl opacity-30">📱</span>
        )}
      </div>

      <div className="flex-1 min-w-0 p-3 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 flex items-center gap-1">
            <span
              ref={nameInputRef}
              contentEditable={editingName}
              suppressContentEditableWarning
              onFocus={() => {
                if (!editingName) return;
                const nameInput = nameInputRef.current;
                if (!nameInput) return;
                // Select all text on focus
                const range = document.createRange();
                range.selectNodeContents(nameInput);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
              }}
              onInput={(e) => setNameDraft(e.currentTarget.textContent ?? "")}
              onBlur={commitRename}
              onKeyDown={(e) => {
                // Device names are Chinese — Enter mid-composition confirms
                // the IME candidate and must not commit the rename.
                if (e.key === "Enter" && !isImeComposing(e)) {
                  e.preventDefault();
                  commitRename();
                }
                if (e.key === "Escape") {
                  setEditingName(false);
                  e.currentTarget.textContent = device.name || device.deviceId;
                }
              }}
              className={
                editingName
                  ? "text-[13px] font-semibold text-text-primary outline-none rounded px-0.5 -mx-0.5 min-w-[60px] inline-block caret-accent"
                  : "text-[13px] font-semibold text-text-primary truncate"
              }
            >
              {displayName}
            </span>
            {!editingName && (
              <button
                type="button"
                onClick={startRename}
                className="shrink-0 p-0.5 rounded text-text-muted hover:text-accent hover:bg-surface-2 transition-colors"
                title="重命名"
              >
                <Pencil size={12} />
              </button>
            )}
          </div>
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0 ${STATUS_TEXT[color]}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[color]}`} />
            {label}
          </span>
        </div>

        {device.model && (
          <div className="text-[11px] text-text-muted truncate mt-0.5">
            {device.model}
          </div>
        )}

        <div className="flex flex-col gap-1 text-[12px] text-text-secondary">
          {device.currentApp && (
            <div className="flex justify-between gap-2">
              <span className="text-text-muted shrink-0">
                {t("devices.currentApp")}
              </span>
              <span className="truncate text-right">{device.currentApp}</span>
            </div>
          )}
          {device.batteryLevel !== undefined && (
            <div className="flex justify-between gap-2">
              <span className="text-text-muted shrink-0">
                {t("devices.battery")}
              </span>
              <span>
                {device.batteryLevel}%
                {device.isCharging && (
                  <span className="ml-1 text-green-600">⚡</span>
                )}
              </span>
            </div>
          )}
        </div>

        <div className="mt-auto flex flex-col gap-1.5">
          <div className="flex justify-center gap-3">
            {/*
              Always rendered, greyed out when there is nothing to stop — the
              same shape the phone's own screen uses, so the control sits in
              one predictable place instead of appearing only mid-task.
            */}
            <Button
              variant={isBusy ? "destructive" : "outline"}
              size="sm"
              disabled={!isBusy || stopping}
              onClick={emergencyStop}
            >
              {stopping
                ? t("devices.emergencyStopping")
                : t("devices.emergencyStop")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onViewScreen(device)}
            >
              {t("devices.viewScreen")}
            </Button>
          </div>
          {stopError && (
            <div className="text-[11px] text-red-600 text-center">
              {stopError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
