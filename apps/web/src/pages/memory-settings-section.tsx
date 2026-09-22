import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BrainCircuit,
  Database,
  FolderSearch2,
  Loader2,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getApiV1MemorySettings,
  getApiV1MemoryStatus,
  patchApiV1MemorySettings,
  postApiV1MemoryRebuild,
} from "../../lib/api/sdk.gen";

const SETTINGS_QUERY_KEY = ["memory-settings"] as const;
const STATUS_QUERY_KEY = ["memory-status"] as const;

type MemoryPatch = {
  enabled?: boolean;
  sources?: Array<"memory" | "sessions">;
  extraPaths?: string[];
  minScore?: number;
};

function formatLastSync(value: number | undefined, locale: string): string {
  if (value === undefined) return "-";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function MemorySettingsSection() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [extraPathsDraft, setExtraPathsDraft] = useState("");
  const [minScoreDraft, setMinScoreDraft] = useState("0.2");

  const settingsQuery = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: async () => {
      const response = await getApiV1MemorySettings();
      if (response.error || !response.data) {
        throw new Error(t("memory.loadFailed"));
      }
      return response.data.memory;
    },
  });

  const statusQuery = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: async () => {
      const response = await getApiV1MemoryStatus();
      if (response.error || !response.data) {
        throw new Error(t("memory.statusUnavailable"));
      }
      return response.data;
    },
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (!settingsQuery.data) return;
    setExtraPathsDraft((settingsQuery.data.extraPaths ?? []).join("\n"));
    setMinScoreDraft(String(settingsQuery.data.minScore ?? 0.2));
  }, [settingsQuery.data]);

  const updateMutation = useMutation({
    mutationFn: async (body: MemoryPatch) => {
      const response = await patchApiV1MemorySettings({ body });
      if (response.error) throw new Error(t("memory.updateFailed"));
      return response.data?.memory;
    },
    onSuccess: (memory) => {
      if (memory) queryClient.setQueryData(SETTINGS_QUERY_KEY, memory);
      toast.success(t("memory.updated"));
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
  });

  const rebuildMutation = useMutation({
    mutationFn: async () => {
      const response = await postApiV1MemoryRebuild({ body: {} });
      if (response.error) throw new Error(t("memory.rebuildFailed"));
    },
    onSuccess: async () => {
      toast.success(t("memory.rebuilt"));
      await queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const saveScope = () => {
    const minScore = Number.parseFloat(minScoreDraft);
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
      toast.error(t("memory.minScoreInvalid"));
      return;
    }
    void updateMutation.mutateAsync({
      extraPaths: extraPathsDraft
        .split("\n")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
      minScore,
    });
  };

  if (settingsQuery.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-[13px] text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("memory.loading")}
        </CardContent>
      </Card>
    );
  }

  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <Card>
        <CardContent
          className="flex items-center justify-between gap-3 py-5"
          role="alert"
        >
          <span className="text-[13px] text-text-secondary">
            {t("memory.loadFailed")}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void settingsQuery.refetch()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("memory.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const memory = settingsQuery.data;
  const crossSessionEnabled = (memory.sources ?? ["memory"]).includes(
    "sessions",
  );
  const status = statusQuery.data;
  const statusLabel = statusQuery.isError
    ? t("memory.statusUnavailable")
    : status?.status === "ready"
      ? status.mode === "fts-only"
        ? t("memory.statusFtsReady")
        : t("memory.statusSemanticReady")
      : status?.status === "sync-needed"
        ? t("memory.statusSyncNeeded")
        : status?.status === "disabled"
          ? t("memory.statusDisabled")
          : status?.status === "unavailable"
            ? status.reasonCode === "embedding-auth-missing"
              ? t("memory.reasonEmbeddingAuthMissing")
              : status.reasonCode === "embedding-provider-unavailable"
                ? t("memory.reasonEmbeddingProviderUnavailable")
                : status.reasonCode === "fts-unavailable"
                  ? t("memory.reasonFtsUnavailable")
                  : status.reasonCode === "probe-timeout"
                    ? t("memory.reasonProbeTimeout")
                    : status.reasonCode === "invalid-status"
                      ? t("memory.reasonInvalidStatus")
                      : t("memory.statusUnavailable")
            : t("memory.statusWaiting");

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          <BrainCircuit className="h-4 w-4 text-text-secondary" />
          <CardTitle>{t("memory.title")}</CardTitle>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!memory.enabled || rebuildMutation.isPending}
          onClick={() => void rebuildMutation.mutateAsync()}
        >
          {rebuildMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCw className="h-3.5 w-3.5" />
          )}
          {t("memory.rebuild")}
        </Button>
      </CardHeader>
      <CardContent className="divide-y divide-border p-0">
        <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
          <div className="bg-surface-1 px-4 py-3">
            <div className="text-[10px] uppercase text-text-tertiary">
              {t("memory.status")}
            </div>
            <div className="mt-1 text-[12px] font-medium text-text-primary">
              {statusLabel}
            </div>
          </div>
          <div className="bg-surface-1 px-4 py-3">
            <div className="text-[10px] uppercase text-text-tertiary">
              {t("memory.indexedItems")}
            </div>
            <div className="mt-1 text-[12px] font-medium text-text-primary">
              {status?.indexedItems ?? "-"}
            </div>
          </div>
          <div className="col-span-2 bg-surface-1 px-4 py-3">
            <div className="text-[10px] uppercase text-text-tertiary">
              {t("memory.lastSync")}
            </div>
            <div className="mt-1 truncate text-[12px] font-medium text-text-primary">
              {formatLastSync(status?.lastSyncAtMs, i18n.language)}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Database className="h-4 w-4 shrink-0 text-text-secondary" />
            <div>
              <div className="text-[12px] font-medium text-text-primary">
                {t("memory.enabled")}
              </div>
              <div className="mt-0.5 text-[11px] text-text-tertiary">
                {t("memory.enabledHint")}
              </div>
            </div>
          </div>
          <Switch
            checked={memory.enabled}
            disabled={updateMutation.isPending}
            onCheckedChange={(enabled) =>
              void updateMutation.mutateAsync({ enabled })
            }
          />
        </div>

        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-text-primary">
              {t("memory.crossSession")}
            </div>
            <div className="mt-0.5 text-[11px] text-text-tertiary">
              {t("memory.crossSessionHint")}
            </div>
          </div>
          <Switch
            checked={crossSessionEnabled}
            disabled={!memory.enabled || updateMutation.isPending}
            onCheckedChange={(enabled) =>
              void updateMutation.mutateAsync({
                sources: enabled ? ["memory", "sessions"] : ["memory"],
              })
            }
          />
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="flex items-center gap-2 text-[12px] font-medium text-text-primary">
            <FolderSearch2 className="h-4 w-4 text-text-secondary" />
            {t("memory.scope")}
          </div>
          <Textarea
            value={extraPathsDraft}
            disabled={!memory.enabled}
            rows={3}
            placeholder={t("memory.scopePlaceholder")}
            aria-label={t("memory.scope")}
            onChange={(event) => setExtraPathsDraft(event.target.value)}
          />
          <p className="text-[11px] text-text-tertiary">
            {t("memory.autoSyncHint")}
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <label
              htmlFor="memory-min-score"
              className="block w-full max-w-48 text-[11px] text-text-secondary"
            >
              {t("memory.minScore")}
              <Input
                id="memory-min-score"
                className="mt-1"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={minScoreDraft}
                disabled={!memory.enabled}
                onChange={(event) => setMinScoreDraft(event.target.value)}
              />
            </label>
            <Button
              type="button"
              size="sm"
              disabled={!memory.enabled || updateMutation.isPending}
              onClick={saveScope}
            >
              {updateMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t("memory.saveScope")}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
