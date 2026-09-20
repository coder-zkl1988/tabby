import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { formatChannelConnectErrorMessage } from "@/lib/channel-connect-errors";
import { openExternalUrl } from "@/lib/desktop-links";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Globe2,
  Loader2,
  Monitor,
  RefreshCw,
  ShieldAlert,
  Smartphone,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getApiV1RuntimeConfig,
  patchApiV1RuntimeConfigDeviceControl,
  patchApiV1RuntimeConfigLocalAutomation,
  postApiV1RuntimeConfigLocalAutomationComputerUsePermissions,
} from "../../lib/api/sdk.gen";

const QUERY_KEY = ["runtime-config"] as const;

export function LocalAutomationSettingsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isError, isFetching, isLoading, refetch } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const response = await getApiV1RuntimeConfig();
      if (response.error) throw new Error(t("automation.loadFailed"));
      return response.data;
    },
  });

  const patchMutation = useMutation({
    mutationFn: async (body: {
      browser?: { enabled: boolean };
      computerUse?: { enabled: boolean };
    }) => {
      const response = await patchApiV1RuntimeConfigLocalAutomation({ body });
      if (response.error) {
        throw new Error(
          formatChannelConnectErrorMessage(
            response.error,
            t("automation.updateFailed"),
          ),
        );
      }
    },
    onSuccess: () => toast.success(t("automation.updated")),
    onError: (error: Error) => toast.error(error.message),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const deviceControlMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const response = await patchApiV1RuntimeConfigDeviceControl({
        body: { enabled },
      });
      if (response.error) {
        throw new Error(
          formatChannelConnectErrorMessage(
            response.error,
            t("devices.settings.updateFailed"),
          ),
        );
      }
    },
    onSuccess: () => toast.success(t("devices.settings.updated")),
    onError: (error: Error) => toast.error(error.message),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  // cua-driver grants Accessibility, Screen Recording and (on Tahoe) direct
  // capture in one pass, attributing the prompts to CuaDriver.app. There is no
  // per-permission entry point, and none of them is useful alone.
  const permissionsMutation = useMutation({
    mutationFn: async () => {
      const response =
        await postApiV1RuntimeConfigLocalAutomationComputerUsePermissions({
          body: {},
        });
      if (response.error) {
        throw new Error(t("automation.computer.permissionRequestFailed"));
      }
    },
    onSuccess: async () => {
      await openExternalUrl(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-[13px] text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("automation.loading")}
        </CardContent>
      </Card>
    );
  }

  if (isError || !data?.deviceControl || !data?.localAutomation) {
    return (
      <Card>
        <CardContent
          className="flex flex-col items-start gap-3 py-6 text-[13px]"
          role="alert"
        >
          <div className="flex items-center gap-2 text-text-secondary">
            <ShieldAlert className="h-4 w-4 shrink-0 text-warning" />
            {t("automation.loadFailed")}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            {isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t(isFetching ? "automation.retrying" : "automation.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { deviceControl, localAutomation, localAutomationStatus } = data;
  const previewEnabled = localAutomationStatus.previewEnabled;
  const browserConfig = localAutomation.browser ?? { enabled: false };
  const computerUseConfig = localAutomation.computerUse ?? { enabled: false };
  const computerUseReady =
    localAutomationStatus.computerUsePermissionState === "ready";
  const computerUseNeedsPermission =
    localAutomationStatus.computerUsePermissionState === "permission-required";
  const computerUseProbeFailed = ["unavailable", "unknown"].includes(
    localAutomationStatus.computerUsePermissionState,
  );
  const computerUseStatusKey = !localAutomationStatus.computerUseAvailable
    ? localAutomationStatus.computerUseUnavailableReason === "unsupported-os"
      ? "automation.computer.requiresMacOS13"
      : "automation.computer.unavailable"
    : computerUseNeedsPermission
      ? "automation.computer.permissionRequired"
      : computerUseReady
        ? "automation.computer.ready"
        : localAutomationStatus.computerUsePermissionState === "unavailable"
          ? "automation.computer.backendUnavailable"
          : localAutomationStatus.computerUsePermissionState === "unknown"
            ? "automation.computer.statusUnknown"
            : "automation.computer.installed";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("automation.title")}</CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-border p-0">
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Smartphone className="h-4 w-4 shrink-0 text-text-secondary" />
            <div className="text-[13px] font-medium text-text-primary">
              {t("devices.settings.title")}
            </div>
          </div>
          <Switch
            aria-label={t("devices.settings.title")}
            checked={deviceControl.enabled}
            disabled={deviceControlMutation.isPending}
            onCheckedChange={(enabled) => deviceControlMutation.mutate(enabled)}
          />
        </div>

        <div className="flex items-start justify-between gap-4 px-5 py-4">
          <div className="flex min-w-0 gap-3">
            <Globe2 className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-text-primary">
                {t("automation.browser.title")}
              </div>
              <div className="mt-1 text-[11px] leading-relaxed text-text-tertiary">
                {t("automation.browser.description")}
              </div>
            </div>
          </div>
          <Switch
            aria-label={t("automation.browser.title")}
            checked={browserConfig.enabled}
            disabled={
              patchMutation.isPending ||
              (!previewEnabled && !browserConfig.enabled)
            }
            onCheckedChange={(enabled) => {
              if (!previewEnabled && enabled) return;
              patchMutation.mutate({ browser: { enabled } });
            }}
          />
        </div>

        <div className="flex items-start justify-between gap-4 px-5 py-4">
          <div className="flex min-w-0 gap-3">
            <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-text-primary">
                {t("automation.computer.title")}
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-text-tertiary">
                {computerUseReady ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                ) : computerUseNeedsPermission ||
                  computerUseProbeFailed ||
                  !localAutomationStatus.computerUseAvailable ? (
                  <ShieldAlert className="h-3.5 w-3.5 text-warning" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 text-text-tertiary" />
                )}
                {t(computerUseStatusKey)}
              </div>
              {previewEnabled && computerUseNeedsPermission ? (
                <div className="mt-3">
                  {/* The driver grants all of these in one pass, but the user
                      still needs to see which one is missing. */}
                  {localAutomationStatus.computerUsePermissions.length > 0 ? (
                    <ul className="mb-2 space-y-1">
                      {localAutomationStatus.computerUsePermissions.map(
                        (permission) => (
                          <li
                            key={permission.name}
                            className="flex items-center gap-1.5 text-[11px] text-text-tertiary"
                          >
                            {permission.granted ? (
                              <CheckCircle2 className="h-3 w-3 text-success" />
                            ) : (
                              <ShieldAlert className="h-3 w-3 text-warning" />
                            )}
                            {t(
                              permission.name === "Accessibility"
                                ? "automation.computer.permissionAccessibility"
                                : "automation.computer.permissionScreenRecording",
                            )}
                          </li>
                        ),
                      )}
                    </ul>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={permissionsMutation.isPending}
                      onClick={() => permissionsMutation.mutate()}
                    >
                      {permissionsMutation.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ShieldAlert className="h-3.5 w-3.5" />
                      )}
                      {t("automation.computer.requestPermissions")}
                    </Button>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-text-tertiary">
                    {t("automation.computer.permissionHint")}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
          <Switch
            aria-label={t("automation.computer.title")}
            checked={computerUseConfig.enabled}
            disabled={
              patchMutation.isPending ||
              (!previewEnabled && !computerUseConfig.enabled) ||
              (!localAutomationStatus.computerUseAvailable &&
                !computerUseConfig.enabled)
            }
            onCheckedChange={(enabled) => {
              if (!previewEnabled && enabled) return;
              patchMutation.mutate({ computerUse: { enabled } });
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
