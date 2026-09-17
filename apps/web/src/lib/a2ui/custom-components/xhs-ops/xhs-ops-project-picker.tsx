import { useEffect, useState } from "react";
import { describeXhsOpsError, xhsOpsApi } from "./xhs-ops-api";
import type { XhsOpsProject } from "./xhs-ops-types";
import {
  EmptyState,
  SecondaryButton,
  SectionTitle,
  Skeleton,
} from "./xhs-ops-ui";

/**
 * Agent 在新会话里通常拿不到 projectId（没有列项目的工具，只有本会话的
 * `xhs_ops_project_saved` 会带 id），所以 xhs-ops 各阶段组件都允许省略
 * projectId：按 `projectName` 匹配，匹配不到就在卡片里让用户点选。
 */

/** Exact name first, then unique substring match (either direction). */
export function pickProjectByName(
  projects: XhsOpsProject[],
  wanted: string,
): XhsOpsProject | null {
  const name = wanted.trim();
  if (!name) return projects.length === 1 ? (projects[0] ?? null) : null;
  const exact = projects.find((p) => p.name.trim() === name);
  if (exact) return exact;
  const loose = projects.filter(
    (p) => p.name.includes(name) || name.includes(p.name.trim()),
  );
  return loose.length === 1 ? (loose[0] ?? null) : null;
}

export interface ProjectResolution {
  /** Resolved id, or "" while unresolved. */
  projectId: string;
  /** null = still loading the list; [] = none / load failed. */
  choices: XhsOpsProject[] | null;
  error: string | null;
  pick: (projectId: string) => void;
}

export function useProjectResolution(
  propProjectId: string,
  projectName: string,
): ProjectResolution {
  const [projectId, setProjectId] = useState(propProjectId);
  const [choices, setChoices] = useState<XhsOpsProject[] | null>(
    propProjectId ? [] : null,
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (propProjectId) {
      setProjectId(propProjectId);
      return;
    }
    let cancelled = false;
    xhsOpsApi
      .listProjects()
      .then((list) => {
        if (cancelled) return;
        const match = pickProjectByName(list, projectName);
        if (match) setProjectId(match.id);
        setChoices(list);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setChoices([]);
        setError(describeXhsOpsError(err, "项目列表加载失败"));
      });
    return () => {
      cancelled = true;
    };
  }, [propProjectId, projectName]);
  return { projectId, choices, error, pick: setProjectId };
}

export function ProjectPicker({
  resolution,
  wanted,
  purpose,
}: {
  resolution: ProjectResolution;
  wanted: string;
  /** e.g. "复盘" / "执行" / "生成资料" — used in the hint copy. */
  purpose: string;
}) {
  const { choices, pick } = resolution;
  if (choices === null) return <Skeleton rows={2} label="正在加载项目列表" />;
  if (choices.length === 0) {
    return (
      <EmptyState>
        还没有养号项目；先用「养号项目」表单创建一个再{purpose}。
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <SectionTitle
        hint={
          wanted
            ? `没有找到名为「${wanted}」的项目，请选择要${purpose}的项目`
            : `请选择要${purpose}的项目`
        }
      >
        选择项目
      </SectionTitle>
      <div className="flex flex-wrap gap-1.5">
        {choices.map((p) => (
          <SecondaryButton key={p.id} onClick={() => pick(p.id)}>
            {p.name}
          </SecondaryButton>
        ))}
      </div>
    </div>
  );
}
