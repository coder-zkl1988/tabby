import "./a2ui.css";

export { A2UIRenderer, A2UIErrorBoundary } from "./a2ui-renderer";
export type { A2UIRendererProps } from "./a2ui-renderer";
export type {
  A2UIMessage,
  A2UIComponent,
  SurfaceState,
  ComponentId,
  CreateSurfaceMessage,
  UpdateComponentsMessage,
  UpdateDataModelMessage,
  DeleteSurfaceMessage,
} from "./a2ui-types";
export { createSurfaceManager } from "./a2ui-surface";
export {
  isPinnedType,
  isSurfaceTypePinned,
  setTypePinned,
  subscribePinnedTypes,
  surfaceComponentTypes,
  surfacePinKey,
} from "./a2ui-pin-store";
export type { SurfaceManager } from "./a2ui-surface";
export {
  registerCustomComponent,
  resolveCustomComponent,
} from "./custom-components/registry";
export type { CustomComponentProps } from "./custom-components/registry";

import { ExpertInstallCard } from "./custom-components/ExpertInstallCard";
import { MarkdownEditor } from "./custom-components/MarkdownEditor";
import { PhonePreview } from "./custom-components/PhonePreview";
import { TeamRunCard } from "./custom-components/TeamRunCard";
import { TeamRunPanel } from "./custom-components/TeamRunPanel";
import { XHSBatchTable } from "./custom-components/XHSBatchTable";
import { XHSEditor } from "./custom-components/XHSEditor";
// ── Register Nexu custom components ───────────────────────────
import { registerCustomComponent } from "./custom-components/registry";
import { XhsOpsAccountPlanner } from "./custom-components/xhs-ops/XhsOpsAccountPlanner";
import { XhsOpsCommentReview } from "./custom-components/xhs-ops/XhsOpsCommentReview";
import { XhsOpsDashboard } from "./custom-components/xhs-ops/XhsOpsDashboard";
import { XhsOpsProfileCard } from "./custom-components/xhs-ops/XhsOpsProfileCard";
import { XhsOpsProfileMaterial } from "./custom-components/xhs-ops/XhsOpsProfileMaterial";
import { XhsOpsProjectForm } from "./custom-components/xhs-ops/XhsOpsProjectForm";
import { XhsOpsRunPlanner } from "./custom-components/xhs-ops/XhsOpsRunPlanner";

const NEXU_CATALOG = "https://nexu.app/a2ui/custom-catalog.json";

registerCustomComponent(NEXU_CATALOG, "ExpertInstallCard", ExpertInstallCard);
registerCustomComponent(NEXU_CATALOG, "MarkdownEditor", MarkdownEditor);
registerCustomComponent(NEXU_CATALOG, "PhonePreview", PhonePreview);
registerCustomComponent(NEXU_CATALOG, "TeamRunCard", TeamRunCard);
registerCustomComponent(NEXU_CATALOG, "TeamRunPanel", TeamRunPanel);
registerCustomComponent(NEXU_CATALOG, "XHSEditor", XHSEditor);
registerCustomComponent(NEXU_CATALOG, "XHSBatchTable", XHSBatchTable);
registerCustomComponent(NEXU_CATALOG, "XhsOpsProjectForm", XhsOpsProjectForm);
registerCustomComponent(NEXU_CATALOG, "XhsOpsProfileCard", XhsOpsProfileCard);
registerCustomComponent(
  NEXU_CATALOG,
  "XhsOpsAccountPlanner",
  XhsOpsAccountPlanner,
);
registerCustomComponent(NEXU_CATALOG, "XhsOpsRunPlanner", XhsOpsRunPlanner);
registerCustomComponent(
  NEXU_CATALOG,
  "XhsOpsProfileMaterial",
  XhsOpsProfileMaterial,
);
registerCustomComponent(NEXU_CATALOG, "XhsOpsDashboard", XhsOpsDashboard);
registerCustomComponent(
  NEXU_CATALOG,
  "XhsOpsCommentReview",
  XhsOpsCommentReview,
);
