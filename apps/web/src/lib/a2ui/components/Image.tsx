import type { ImageComponent as ImageComp } from "../a2ui-types";
import { ZoomableImage } from "./zoomable-image";

interface Props {
  comp: ImageComp;
  resolve: <T>(val: T) => unknown;
}

export function ImageComponent({ comp, resolve }: Props) {
  const source = String(resolve(comp.source) ?? "");
  const alt = comp.alt ? String(resolve(comp.alt) ?? "") : "";
  const width = resolve(comp.width) as number | undefined;
  const height = resolve(comp.height) as number | undefined;
  const objectFit =
    (resolve(comp.objectFit) as ImageComp["objectFit"]) ?? "cover";

  return (
    <ZoomableImage
      src={source}
      alt={alt}
      className="a2ui-image-zoom"
      imgClassName="a2ui-image"
      style={{
        width: width != null ? `${width}px` : undefined,
        height: height != null ? `${height}px` : undefined,
        objectFit,
      }}
    />
  );
}
