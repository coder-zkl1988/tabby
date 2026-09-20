import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { Coins, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getApiV1RuntimeCost } from "../../lib/api/sdk.gen";

/**
 * Gateway-wide spend from OpenClaw's `usage.cost` ledger.
 *
 * Distinct from the per-session figures in the session operations panel, which
 * come from `sessions.usage`: this is the whole Gateway over a date range, so
 * it answers "what has this cost me lately" rather than "what did this run
 * cost".
 */

const COST_QUERY_KEY = ["runtime-cost"] as const;
const RANGE_OPTIONS = [7, 30] as const;

function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  // Sub-cent totals are common on cheap models; showing $0.00 there reads as
  // broken, so keep enough precision to stay non-zero.
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function CostUsageSection() {
  const { t } = useTranslation();
  const [days, setDays] = useState<number>(30);

  const costQuery = useQuery({
    queryKey: [...COST_QUERY_KEY, days],
    queryFn: async () => {
      const { data, error } = await getApiV1RuntimeCost({ query: { days } });
      if (error || !data) throw new Error("Runtime cost unavailable");
      return data;
    },
  });

  const data = costQuery.data;
  const totals = data?.totals;
  // Only the days that actually spent something are worth a row.
  const activeDays = (data?.daily ?? [])
    .filter((entry) => entry.totalTokens > 0)
    .slice(-7)
    .reverse();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="size-4" />
          {t("settings.cost.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-1.5">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setDays(option)}
              className={`h-7 rounded-md border px-2.5 text-xs transition-colors ${
                days === option
                  ? "border-accent bg-accent/10 text-text-primary"
                  : "border-border text-text-muted hover:bg-surface-2"
              }`}
            >
              {t("settings.cost.lastDays", { count: option })}
            </button>
          ))}
        </div>

        {costQuery.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <Loader2 className="size-3 animate-spin" />
            {t("settings.cost.loading")}
          </div>
        ) : !data?.available ? (
          <div className="text-xs text-text-muted">
            {t("settings.cost.unavailable")}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md bg-surface-1 px-3 py-2">
                <div className="text-[10px] text-text-muted">
                  {t("settings.cost.totalCost")}
                </div>
                <div className="mt-0.5 text-sm font-semibold text-text-primary">
                  {formatUsd(totals?.totalCost ?? 0)}
                </div>
              </div>
              <div className="rounded-md bg-surface-1 px-3 py-2">
                <div className="text-[10px] text-text-muted">
                  {t("settings.cost.totalTokens")}
                </div>
                <div className="mt-0.5 text-sm font-semibold text-text-primary">
                  {formatCount(totals?.totalTokens ?? 0)}
                </div>
              </div>
            </div>

            {totals !== undefined && totals.missingCostEntries > 0 && (
              <div className="text-[10px] text-text-muted">
                {t("settings.cost.missingEntries", {
                  count: totals.missingCostEntries,
                })}
              </div>
            )}

            {activeDays.length === 0 ? (
              <div className="text-xs text-text-muted">
                {t("settings.cost.noActivity")}
              </div>
            ) : (
              <div className="space-y-1">
                {activeDays.map((entry) => (
                  <div
                    key={entry.date}
                    className="flex items-center justify-between gap-3 rounded-md px-2 py-1 text-[11px] hover:bg-surface-2"
                  >
                    <span className="text-text-muted tabular-nums">
                      {entry.date}
                    </span>
                    <span className="text-text-muted tabular-nums">
                      {formatCount(entry.totalTokens)}
                    </span>
                    <span className="font-medium text-text-primary tabular-nums">
                      {formatUsd(entry.totalCost)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
