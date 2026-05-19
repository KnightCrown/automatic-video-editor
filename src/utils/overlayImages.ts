import type { GeneratedOverlayImage, OverlayImageVersion } from "../types/pipeline";

export function overlayImageVersions(img: GeneratedOverlayImage): OverlayImageVersion[] {
  if (img.versions?.length) {
    return img.versions;
  }
  if (img.relativePath) {
    return [{ relativePath: img.relativePath, generatedAt: img.generatedAt }];
  }
  return [];
}

export type OverlayImageVersionTile = {
  suggestionId: string;
  title: string;
  transcriptExcerpt: string;
  relativePath: string;
  versionLabel: string;
  isLatest: boolean;
};

export function overlayImageVersionTiles(
  img: GeneratedOverlayImage | undefined,
): OverlayImageVersionTile[] {
  if (!img) return [];
  const versions = overlayImageVersions(img);
  return versions.map((version, index) => {
    const versionNumber = index + 1;
    let versionLabel = `v${versionNumber}`;
    if (versions.length > 1 && index === versions.length - 1) {
      versionLabel = `v${versionNumber} (latest)`;
    }
    return {
      suggestionId: img.suggestionId,
      title: img.title,
      transcriptExcerpt: img.transcriptExcerpt,
      relativePath: version.relativePath,
      versionLabel,
      isLatest: index === versions.length - 1,
    };
  });
}
