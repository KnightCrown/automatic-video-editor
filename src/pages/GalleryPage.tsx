import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, LayoutGrid, LayoutList, Check, Heart, Download } from "lucide-react";
import { useProject } from "../context/ProjectContext";
import {
  getOverlayImageDisplayUrl,
  getOverlayImagesManifest,
} from "../services/pipelineService";
import type { GeneratedOverlayImage, OverlayImagesManifest } from "../types/pipeline";
import { downloadFromUrl, sanitizeDownloadFilename } from "../utils/download";
import { excerptSnippet } from "../utils/format";

type GalleryItem = {
  videoId: string;
  videoFileName: string;
  img: GeneratedOverlayImage;
  manifest: OverlayImagesManifest;
};

function itemKey(item: GalleryItem): string {
  return `${item.videoId}:${item.img.suggestionId}`;
}

export function GalleryPage() {
  const { project } = useProject();
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [search, setSearch] = useState("");
  const [episodeFilter, setEpisodeFilter] = useState<string>("all");
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [displayUrls, setDisplayUrls] = useState<Record<string, string>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const projectVideos = useMemo(() => project?.videos ?? [], [project?.videos]);

  const loadGallery = useCallback(async () => {
    if (!project) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const all: GalleryItem[] = [];
      for (const video of projectVideos) {
        const manifest = await getOverlayImagesManifest(project.rootPath, video.id);
        if (!manifest?.images.length) continue;
        for (const img of manifest.images) {
          all.push({
            videoId: video.id,
            videoFileName: video.fileName,
            img,
            manifest,
          });
        }
      }
      all.sort(
        (a, b) =>
          new Date(b.img.generatedAt).getTime() - new Date(a.img.generatedAt).getTime(),
      );
      setItems(all);
    } finally {
      setLoading(false);
    }
  }, [project, projectVideos]);

  useEffect(() => {
    void loadGallery();
  }, [loadGallery]);

  useEffect(() => {
    if (!project?.rootPath || items.length === 0) {
      setDisplayUrls({});
      setPreviewErrors({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const urls: Record<string, string> = {};
      const errs: Record<string, string> = {};
      await Promise.all(
        items.map(async (item) => {
          const key = itemKey(item);
          try {
            urls[key] = await getOverlayImageDisplayUrl(
              project.rootPath,
              item.img.relativePath,
            );
          } catch (e) {
            errs[key] = String(e);
          }
        }),
      );
      if (!cancelled) {
        setDisplayUrls(urls);
        setPreviewErrors(errs);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.rootPath, items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (episodeFilter !== "all" && item.videoId !== episodeFilter) return false;
      if (!q) return true;
      const hay =
        `${item.img.title} ${item.img.transcriptExcerpt} ${item.videoFileName}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, search, episodeFilter]);

  const selected = useMemo(() => {
    if (!selectedKey) return filtered[0] ?? null;
    return filtered.find((i) => itemKey(i) === selectedKey) ?? filtered[0] ?? null;
  }, [filtered, selectedKey]);

  if (!project) {
    return (
      <NoProjectMessage />
    );
  }

  return (
    <div className="flex-1 flex flex-col p-6 h-full overflow-hidden">
      <div className="flex justify-between items-center mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-semibold mb-1 text-white">Gallery</h1>
          <p className="text-textMuted text-sm">Browse and manage all generated images.</p>
        </div>
      </div>

      <div className="flex gap-4 mb-6 flex-shrink-0 flex-wrap">
        <div className="relative flex-1 max-w-sm min-w-[200px]">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-textMuted"
            size={16}
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search images..."
            className="w-full bg-surface border border-border rounded-lg pl-9 pr-4 py-2 text-sm text-white focus:outline-none focus:border-primary"
          />
        </div>
        <select
          value={episodeFilter}
          onChange={(e) => setEpisodeFilter(e.target.value)}
          className="bg-surface border border-border px-3 py-2 rounded-lg text-sm text-white focus:outline-none focus:border-primary"
        >
          <option value="all">All episodes</option>
          {projectVideos.map((v) => (
            <option key={v.id} value={v.id}>
              {v.fileName}
            </option>
          ))}
        </select>
        <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
      </div>

      <GalleryCountRow loading={loading} count={filtered.length} />

      {projectVideos.length === 0 ? (
        <p className="text-textMuted text-sm">
          Transcribe videos first. Images appear here after you generate them in Editing.
        </p>
      ) : filtered.length === 0 && !loading ? (
        <p className="text-textMuted text-sm">
          No generated images yet. Open Editing and run Generate images.
        </p>
      ) : (
        <div className="flex-1 flex gap-6 overflow-hidden min-h-0">
          <GalleryGrid
            filtered={filtered}
            viewMode={viewMode}
            displayUrls={displayUrls}
            previewErrors={previewErrors}
            selectedKey={selected ? itemKey(selected) : null}
            onSelect={setSelectedKey}
          />
          {selected && (
            <GalleryDetailPanel
              item={selected}
              displayUrl={displayUrls[itemKey(selected)]}
              previewError={previewErrors[itemKey(selected)]}
            />
          )}
        </div>
      )}
    </div>
  );
}

function NoProjectMessage() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6">
      <p className="text-textMuted text-sm">Open a project from Overview first.</p>
    </div>
  );
}

function GalleryCountRow({ loading, count }: { loading: boolean; count: number }) {
  return (
    <div className="flex justify-between items-center mb-4 flex-shrink-0">
      <span className="text-sm text-textMuted">
        {loading ? "Loading…" : `${count} image${count === 1 ? "" : "s"}`}
      </span>
      <span className="text-sm text-textMuted">Sort by: Newest</span>
    </div>
  );
}

function ViewModeToggle({
  viewMode,
  setViewMode,
}: {
  viewMode: "grid" | "list";
  setViewMode: (m: "grid" | "list") => void;
}) {
  return (
    <div className="ml-auto flex bg-surface border border-border rounded-lg p-1">
      <button
        type="button"
        onClick={() => setViewMode("list")}
        className={`p-1.5 rounded ${viewMode === "list" ? "bg-primary bg-opacity-20 text-primary" : "text-textMuted"}`}
      >
        <LayoutList size={16} />
      </button>
      <button
        type="button"
        onClick={() => setViewMode("grid")}
        className={`p-1.5 rounded ${viewMode === "grid" ? "bg-primary text-white" : "text-textMuted"}`}
      >
        <LayoutGrid size={16} />
      </button>
    </div>
  );
}

function GalleryGrid({
  filtered,
  viewMode,
  displayUrls,
  previewErrors,
  selectedKey,
  onSelect,
}: {
  filtered: GalleryItem[];
  viewMode: "grid" | "list";
  displayUrls: Record<string, string>;
  previewErrors: Record<string, string>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div
      className={`flex-1 min-h-0 min-w-0 overflow-y-auto pr-2 ${
        viewMode === "grid"
          ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 auto-rows-min content-start"
          : "flex flex-col gap-3"
      }`}
    >
      {filtered.map((item) => {
        const key = itemKey(item);
        const url = displayUrls[key];
        const isSelected = selectedKey === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            className={`text-left bg-surface border rounded-xl overflow-hidden transition-colors ${
              isSelected ? "border-primary" : "border-border hover:border-gray-600"
            } ${viewMode === "grid" ? "w-full min-w-0 self-start flex flex-col" : "flex gap-4 p-3 w-full"}`}
          >
            <div
              className={`bg-background relative flex items-center justify-center overflow-hidden ${
                viewMode === "list" ? "w-32 h-20 flex-shrink-0 rounded-lg" : "aspect-square"
              }`}
            >
              {url ? (
                <img src={url} alt={item.img.title} className="w-full h-full object-cover" />
              ) : previewErrors[key] ? (
                <span className="text-xs text-danger p-2">{previewErrors[key]}</span>
              ) : (
                <span className="text-textMuted text-xs">Loading…</span>
              )}
              {isSelected && (
                <div className="absolute top-2 left-2 bg-primary text-white p-1 rounded">
                  <Check size={14} />
                </div>
              )}
            </div>
            <div className={viewMode === "list" ? "flex-1 min-w-0 py-1" : "p-3"}>
              <p className="text-sm text-white font-medium truncate mb-1">{item.img.title}</p>
              <p className="text-xs text-textMuted mb-2 truncate">{item.videoFileName}</p>
              <p className="text-[10px] text-textMuted uppercase">
                {new Date(item.img.generatedAt).toLocaleDateString()}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function GalleryDetailPanel({
  item,
  displayUrl,
  previewError,
}: {
  item: GalleryItem;
  displayUrl?: string;
  previewError?: string;
}) {
  const fileName = `${sanitizeDownloadFilename(item.img.title)}-${item.img.suggestionId.slice(0, 8)}.png`;

  return (
    <div className="w-[340px] flex-shrink-0 flex flex-col bg-surface border border-border rounded-xl overflow-hidden hidden xl:flex">
      <div className="aspect-video bg-background border-b border-border flex items-center justify-center">
        {displayUrl ? (
          <img src={displayUrl} alt={item.img.title} className="w-full h-full object-contain" />
        ) : previewError ? (
          <p className="text-xs text-danger p-4">{previewError}</p>
        ) : (
          <p className="text-textMuted text-sm">Loading…</p>
        )}
      </div>
      <div className="p-5 flex-1 overflow-y-auto flex flex-col">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="text-lg text-white font-semibold">{item.img.title}</h3>
          <Heart size={16} className="text-textMuted flex-shrink-0" aria-hidden />
        </div>
        <p className="text-xs text-textMuted mb-4 pb-4 border-b border-border">
          {item.videoFileName}
        </p>
        <div className="space-y-4 mb-6 text-sm flex-1">
          <DetailBlock label="Prompt" value={item.img.imagePrompt} />
          <DetailRow label="Model" value={item.manifest.model} />
          <DetailRow label="Created" value={new Date(item.img.generatedAt).toLocaleString()} />
          {item.img.transcriptExcerpt ? (
            <DetailBlock
              label="Transcript excerpt"
              value={excerptSnippet(item.img.transcriptExcerpt, 400)}
            />
          ) : null}
        </div>
        {displayUrl && (
          <button
            type="button"
            onClick={() => void downloadFromUrl(displayUrl, `${item.videoId}-${fileName}`)}
            className="w-full py-3 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2"
          >
            <Download size={16} /> Download
          </button>
        )}
      </div>
    </div>
  );
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-textMuted mb-1 font-semibold">{label}</p>
      <p className="text-white leading-relaxed text-sm">{value}</p>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-textMuted">{label}</span>
      <span className="text-white text-right text-sm">{value}</span>
    </div>
  );
}
