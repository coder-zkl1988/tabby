import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Smartphone } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getApiV1DevicesPairingRequests,
  postApiV1DevicesPairingRequestsByRequestIdApprove,
  postApiV1DevicesPairingRequestsByRequestIdReject,
} from "../../lib/api/sdk.gen";

export const DEVICE_PAIRING_QUERY_KEY = ["device-pairing-requests"] as const;

/**
 * The phone polls every 1.5s and a request lives 120s, so a 2s poll keeps
 * the prompt (and its disappearance on cancel/expiry) close to real time
 * without a dedicated push channel.
 */
const POLL_INTERVAL_MS = 2000;

/**
 * App-wide approval prompt for iTabby LAN pairing: a phone on the same
 * network found this desktop and asked to pair. Approving hands the phone a
 * device key, so the user confirms the 6-digit code matches the phone first.
 */
export function DevicePairingWatcher() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: DEVICE_PAIRING_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await getApiV1DevicesPairingRequests();
      if (error || !data) throw new Error("Pairing requests unavailable");
      return data;
    },
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });

  // Oldest first; the next one shows once this one is decided or gone.
  const request = data?.requests[0] ?? null;

  const decide = useMutation({
    mutationFn: async (input: {
      requestId: string;
      decision: "approve" | "reject";
    }) => {
      const call =
        input.decision === "approve"
          ? postApiV1DevicesPairingRequestsByRequestIdApprove
          : postApiV1DevicesPairingRequestsByRequestIdReject;
      const { error, response } = await call({
        path: { requestId: input.requestId },
      });
      if (error) {
        throw new Error(
          response?.status === 404
            ? t("devices.pairing.expired")
            : t("devices.pairing.failed"),
        );
      }
      return input.decision;
    },
    onSuccess: (decision) => {
      if (decision === "approve") toast.success(t("devices.pairing.approved"));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: DEVICE_PAIRING_QUERY_KEY,
      });
    },
  });

  // When the window is in the background, a native notification tells the
  // user a phone is waiting (once per request).
  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!request || notifiedRef.current.has(request.requestId)) return;
    notifiedRef.current.add(request.requestId);
    if (
      typeof Notification === "undefined" ||
      Notification.permission !== "granted" ||
      document.hasFocus()
    ) {
      return;
    }
    try {
      new Notification(t("devices.pairing.title"), {
        body: t("devices.pairing.notificationBody", {
          device: deviceLabel(request),
        }),
      });
    } catch {
      // The in-app prompt is still shown.
    }
  }, [request, t]);

  const pendingId = decide.isPending ? decide.variables?.requestId : null;

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        // Closing the dialog (Esc / ×) is a rejection: the phone is waiting
        // for an answer and would otherwise sit there until it expires.
        if (!open && request && !decide.isPending) {
          decide.mutate({ requestId: request.requestId, decision: "reject" });
        }
      }}
    >
      {request && (
        <DialogContent
          onPointerDownOutside={(e) => e.preventDefault()}
          className="max-w-sm"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-accent" />
              {t("devices.pairing.title")}
            </DialogTitle>
            <DialogDescription className="mt-1">
              {t("devices.pairing.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="text-[13px] text-text-secondary">
              <span className="text-text-muted">
                {t("devices.pairing.device")}
              </span>
              <span className="ml-2 font-medium text-text-primary">
                {deviceLabel(request)}
              </span>
            </div>
            <div className="rounded-xl border border-border bg-surface-2 px-4 py-4 text-center">
              <div className="text-[11px] text-text-muted">
                {t("devices.pairing.code")}
              </div>
              <div
                className="mt-1 font-mono text-[32px] font-bold tracking-[0.3em] text-text-primary"
                data-testid="device-pairing-code"
              >
                {request.code}
              </div>
            </div>
            <p className="text-[12px] leading-relaxed text-text-muted">
              {t("devices.pairing.confirmHint")}
            </p>
          </DialogBody>
          <DialogFooter>
            <button
              type="button"
              disabled={pendingId === request.requestId}
              onClick={() =>
                decide.mutate({
                  requestId: request.requestId,
                  decision: "reject",
                })
              }
              className="h-8 px-4 text-[12px] font-medium text-text-secondary rounded-lg border border-border hover:border-border-hover hover:bg-surface-2 transition-all disabled:opacity-60"
            >
              {t("devices.pairing.reject")}
            </button>
            <button
              type="button"
              disabled={pendingId === request.requestId}
              onClick={() =>
                decide.mutate({
                  requestId: request.requestId,
                  decision: "approve",
                })
              }
              className="flex items-center gap-1.5 h-8 px-4 text-[12px] font-medium text-white rounded-lg bg-accent hover:bg-accent/90 transition-all disabled:opacity-60"
            >
              {pendingId === request.requestId &&
                decide.variables?.decision === "approve" && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
              {t("devices.pairing.approve")}
            </button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

export function deviceLabel(request: {
  manufacturer: string;
  model: string;
  deviceId: string;
}): string {
  const label = [request.manufacturer, request.model]
    .filter((part) => part.trim().length > 0)
    .join(" ");
  return label || request.deviceId;
}
