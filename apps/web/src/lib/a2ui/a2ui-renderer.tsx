import { Component, type ReactNode, useMemo } from "react";
import {
  createSurfaceManager,
  getByJsonPointer,
  setByJsonPointer,
} from "./a2ui-surface";
import type { SurfaceManager } from "./a2ui-surface";
import type {
  A2UIMessage,
  ChildList,
  ComponentId,
  SurfaceState,
} from "./a2ui-types";
import { AudioPlayerComponent } from "./components/AudioPlayer";
import { ButtonComponent } from "./components/Button";
import { CardComponent } from "./components/Card";
import { CheckBoxComponent } from "./components/CheckBox";
import { ChoicePickerComponent } from "./components/ChoicePicker";
import { ColumnComponent } from "./components/Column";
import { DateTimeInputComponent } from "./components/DateTimeInput";
import { DividerComponent } from "./components/Divider";
import { IconComponent } from "./components/Icon";
import { ImageComponent } from "./components/Image";
import { ListComponent } from "./components/List";
import { ModalComponent } from "./components/Modal";
import { RowComponent } from "./components/Row";
import { SliderComponent } from "./components/Slider";
import { TabsComponent } from "./components/Tabs";
import { TextComponent } from "./components/Text";
import { TextFieldComponent } from "./components/TextField";
import { VideoComponent } from "./components/Video";
import { resolveCustomComponent } from "./custom-components/registry";

export interface A2UIRendererProps {
  messages: A2UIMessage[];
  onAction?: (actionName: string, context: Record<string, unknown>) => void;
}

export function A2UIRenderer({ messages, onAction }: A2UIRendererProps) {
  // Stabilize memo key: parent creates a fresh array each render, so
  // reference equality never holds. Use a content hash instead.
  const messagesKey = messages.map((m) => JSON.stringify(m)).join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: messagesKey is a content hash of messages
  const manager = useMemo(() => {
    const m = createSurfaceManager();
    m.processMessages(messages);
    // Expand dynamic child lists before rendering so derived components exist
    for (const surface of m.getAllSurfaces().values()) {
      for (const comp of surface.components.values()) {
        const childList =
          "children" in comp
            ? (comp as { children?: ChildList }).children
            : undefined;
        if (!childList || Array.isArray(childList)) continue;
        const { componentId: templateId, path } = childList;
        const items = getByJsonPointer(surface.dataModel, path);
        if (!Array.isArray(items)) continue;
        for (let i = 0; i < items.length; i++) {
          const derivedId = `${templateId}_${i}`;
          if (!surface.components.has(derivedId)) {
            const template = surface.components.get(templateId);
            if (template) {
              surface.components.set(derivedId, { ...template, id: derivedId });
            }
          }
        }
      }
    }
    return m;
  }, [messagesKey]);

  const surfaces = Array.from(manager.getAllSurfaces().values());

  if (surfaces.length === 0) return null;

  return (
    <div className="a2ui-surfaces">
      {surfaces.map((surface) => (
        <SurfaceView
          key={surface.surfaceId}
          surface={surface}
          manager={manager}
          onAction={onAction}
        />
      ))}
    </div>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: unknown;
}

class A2UIErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <div className="a2ui-error">Failed to render interactive UI</div>;
    }
    return this.props.children;
  }
}

export { A2UIErrorBoundary };

interface SurfaceViewProps {
  surface: SurfaceState;
  manager: SurfaceManager;
  onAction?: (actionName: string, context: Record<string, unknown>) => void;
}

function SurfaceView({ surface, manager, onAction }: SurfaceViewProps) {
  return (
    <div className="a2ui-surface" data-surface-id={surface.surfaceId}>
      {surface.rootComponentIds.map((id) => (
        <ComponentNode
          key={id}
          componentId={id}
          surface={surface}
          manager={manager}
          onAction={onAction}
        />
      ))}
    </div>
  );
}

interface ComponentNodeProps {
  componentId: ComponentId;
  surface: SurfaceState;
  manager: SurfaceManager;
  onAction?: (actionName: string, context: Record<string, unknown>) => void;
}

export function ComponentNode({
  componentId,
  surface,
  manager,
  onAction,
}: ComponentNodeProps) {
  const comp = surface.components.get(componentId);
  if (!comp) return null;
  if (comp.visible === false) return null;

  const resolve = <T,>(val: T): unknown =>
    manager.resolveValue(val, surface.dataModel);

  // Two-way binding write half: form components persist user input into the
  // surface data model so button actions submit the live form state.
  const write = (path: string, value: unknown): void => {
    setByJsonPointer(surface.dataModel, path, value);
  };

  function resolveChildren(childList: ChildList | undefined): ComponentId[] {
    if (!childList) return [];
    if (Array.isArray(childList)) return childList;
    // Dynamic child list: compute derived IDs (expansion done in useMemo above)
    const { componentId: templateId, path } = childList;
    const items = getByJsonPointer(surface.dataModel, path);
    if (!Array.isArray(items)) return [];
    return items.map((_, i) => `${templateId}_${i}`);
  }

  const childIds = resolveChildren(
    "children" in comp
      ? (comp as { children?: ChildList }).children
      : undefined,
  );

  const children = childIds.map((id) => (
    <ComponentNode
      key={id}
      componentId={id}
      surface={surface}
      manager={manager}
      onAction={onAction}
    />
  ));

  switch (comp.type) {
    case "Text":
      return <TextComponent comp={comp} resolve={resolve} />;
    case "Button":
      return (
        <ButtonComponent
          comp={comp}
          resolve={resolve}
          onAction={onAction}
          dataModel={surface.dataModel}
        />
      );
    case "TextField":
      return <TextFieldComponent comp={comp} resolve={resolve} write={write} />;
    case "DateTimeInput":
      return (
        <DateTimeInputComponent comp={comp} resolve={resolve} write={write} />
      );
    case "Card":
      return (
        <CardComponent comp={comp} resolve={resolve}>
          {children}
        </CardComponent>
      );
    case "Column":
      return (
        <ColumnComponent comp={comp} resolve={resolve}>
          {children}
        </ColumnComponent>
      );
    case "Row":
      return (
        <RowComponent comp={comp} resolve={resolve}>
          {children}
        </RowComponent>
      );
    case "List":
      return (
        <ListComponent comp={comp} resolve={resolve}>
          {children}
        </ListComponent>
      );
    case "Image":
      return <ImageComponent comp={comp} resolve={resolve} />;
    case "Icon":
      return <IconComponent comp={comp} resolve={resolve} />;
    case "Divider":
      return <DividerComponent comp={comp} resolve={resolve} />;
    case "Tabs":
      return (
        <TabsComponent
          comp={comp}
          resolve={resolve}
          surface={surface}
          manager={manager}
          onAction={onAction}
        >
          {children}
        </TabsComponent>
      );
    case "Modal":
      return (
        <ModalComponent comp={comp} resolve={resolve}>
          {children}
        </ModalComponent>
      );
    case "CheckBox":
      return <CheckBoxComponent comp={comp} resolve={resolve} write={write} />;
    case "ChoicePicker":
      return (
        <ChoicePickerComponent comp={comp} resolve={resolve} write={write} />
      );
    case "Slider":
      return <SliderComponent comp={comp} resolve={resolve} write={write} />;
    case "Video":
      return <VideoComponent comp={comp} resolve={resolve} />;
    case "AudioPlayer":
      return <AudioPlayerComponent comp={comp} resolve={resolve} />;
    default: {
      // Look up custom component from registered catalogs
      const catalogId = surface.catalogId;
      if (catalogId) {
        const compType = (comp as { type: string }).type;
        const CustomComp = resolveCustomComponent(catalogId, compType);
        if (CustomComp) {
          return (
            <CustomComp
              comp={comp}
              resolve={resolve}
              surface={surface}
              manager={manager}
              onAction={onAction}
            >
              {children}
            </CustomComp>
          );
        }
      }

      return <div className="a2ui-unknown">{JSON.stringify(comp)}</div>;
    }
  }
}
