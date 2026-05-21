import { useEffect, useState } from "react";
import { getOverlayImageDisplayUrl } from "../services/pipelineService";

const displayUrlCache = new Map<string, string>();

function cacheKey(rootPath: string, relativePath: string): string {
  return `${rootPath}\0${relativePath}`;
}

export function peekOverlayDisplayUrl(
  rootPath: string,
  relativePath: string,
): string | undefined {
  return displayUrlCache.get(cacheKey(rootPath, relativePath));
}

export function useOverlayDisplayUrl(
  rootPath: string | undefined,
  relativePath: string | undefined,
): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() =>
    rootPath && relativePath
      ? peekOverlayDisplayUrl(rootPath, relativePath)
      : undefined,
  );

  useEffect(() => {
    if (!rootPath || !relativePath) {
      setUrl(undefined);
      return;
    }
    const key = cacheKey(rootPath, relativePath);
    const cached = displayUrlCache.get(key);
    if (cached) {
      setUrl(cached);
      return;
    }
    let cancelled = false;
    void getOverlayImageDisplayUrl(rootPath, relativePath)
      .then((resolved) => {
        displayUrlCache.set(key, resolved);
        if (!cancelled) setUrl(resolved);
      })
      .catch(() => {
        if (!cancelled) setUrl(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, relativePath]);

  return url;
}
