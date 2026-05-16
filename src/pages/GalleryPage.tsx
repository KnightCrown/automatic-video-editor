import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useProject } from "../context/ProjectContext";
import { EpisodeAccordion, type EpisodePanelSpec } from "../components/EpisodeAccordion";
import {
  getOverlayImageDisplayUrl,
  getOverlayImagesManifest,
} from "../services/pipelineService";
import type { GeneratedOverlayImage, OverlayImagesManifest } from "../types/pipeline";
import { downloadFromUrl, sanitizeDownloadFilename, savePngListToChosenFolder } from "../utils/download";

async function downloadAllEpisodeImages(
  videoId: string,
  manifest: OverlayImagesManifest,
  displayUrls: Record<string, string>,
): Promise<void> {
  const images = manifest.images.filter((img) => displayUrls[img.suggestionId]);
  const items = images.map((img) => {
    const name = `${sanitizeDownloadFilename(img.title)}-${img.suggestionId.slice(0, 8)}.png`;
    return {
      url: displayUrls[img.suggestionId],
      filename: `${videoId}-${name}`,
    };
  });
  await savePngListToChosenFolder(items);
}

function excerptSnippet(text: string, maxLen: number): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}

export function GalleryPage() {
  const { project } = useProject();
  const location = useLocation();
  const transcribedVideos = useMemo(
    () => project?.videos.filter((v) => v.status === "transcribed") ?? [],
    [project?.videos],
  );

  const [manifestByVideo, setManifestByVideo] = useState<
    Record<string, OverlayImagesManifest | null>
  >({});
  const [displayUrlsByVideo, setDisplayUrlsByVideo] = useState<
    Record<string, Record<string, string>>
  >({});
  const [previewErrorsByVideo, setPreviewErrorsByVideo] = useState<
    Record<string, Record<string, string>>
  >({});
  const [downloadingVideoId, setDownloadingVideoId] = useState<string | null>(null);

  useEffect(() => {
    if (!project || transcribedVideos.length === 0) {
      setManifestByVideo({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        transcribedVideos.map(async (v) => {
          const m = await getOverlayImagesManifest(project.rootPath, v.id);
          return [v.id, m] as const;
        }),
      );
      if (cancelled) return;
      setManifestByVideo(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [project, transcribedVideos, location.pathname]);

  useEffect(() => {
    if (!project?.rootPath) {
      setDisplayUrlsByVideo({});
      setPreviewErrorsByVideo({});
      return;
    }
    const rp = project.rootPath;
    let cancelled = false;
    void (async () => {
      const entries = Object.entries(manifestByVideo);
      const urlOut: Record<string, Record<string, string>> = {};
      const errOut: Record<string, Record<string, string>> = {};
      await Promise.all(
        entries.map(async ([videoId, manifest]) => {
          if (!manifest?.images?.length) {
            urlOut[videoId] = {};
            errOut[videoId] = {};
            return;
          }
          const results = await Promise.all(
            manifest.images.map(async (img) => {
              try {
                const url = await getOverlayImageDisplayUrl(rp, img.relativePath);
                return { id: img.suggestionId, ok: true as const, url };
              } catch (e) {
                return { id: img.suggestionId, ok: false as const, message: String(e) };
              }
            }),
          );
          const urls: Record<string, string> = {};
          const errs: Record<string, string> = {};
          for (const r of results) {
            if (r.ok) urls[r.id] = r.url;
            else errs[r.id] = r.message;
          }
          urlOut[videoId] = urls;
          errOut[videoId] = errs;
        }),
      );
      if (!cancelled) {
        setDisplayUrlsByVideo(urlOut);
        setPreviewErrorsByVideo(errOut);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.rootPath, manifestByVideo]);

  const handleDownloadAll = useCallback(
    async (videoId: string) => {
      const manifest = manifestByVideo[videoId];
      const urls = displayUrlsByVideo[videoId];
      if (!manifest?.images?.length || !urls) return;
      const ready = manifest.images.some((img) => urls[img.suggestionId]);
      if (!ready) return;
      setDownloadingVideoId(videoId);
      try {
        await downloadAllEpisodeImages(videoId, manifest, urls);
      } catch (e) {
        console.error(e);
      } finally {
        setDownloadingVideoId(null);
      }
    },
    [manifestByVideo, displayUrlsByVideo],
  );

  const panels: EpisodePanelSpec[] = useMemo(
    () =>
      transcribedVideos.map((v) => {
        const manifest = manifestByVideo[v.id] ?? null;
        const urls = displayUrlsByVideo[v.id];
        const canDownloadAll =
          !!manifest?.images?.length &&
          !!urls &&
          manifest.images.some((img) => urls[img.suggestionId]);

        return {
          id: v.id,
          title: v.fileName,
          subtitle: v.status,
          headerActions: (
            <button
              type="button"
              className="btn small primary"
              disabled={downloadingVideoId === v.id || !canDownloadAll}
              onClick={() => void handleDownloadAll(v.id)}
            >
              {downloadingVideoId === v.id ? "Downloading…" : "Download all"}
            </button>
          ),
          renderContent: () => (
            <GalleryEpisodeBody
              manifest={manifest}
              displayUrls={displayUrlsByVideo[v.id] ?? {}}
              previewErrors={previewErrorsByVideo[v.id] ?? {}}
              videoId={v.id}
            />
          ),
        };
      }),
    [
      transcribedVideos,
      manifestByVideo,
      displayUrlsByVideo,
      previewErrorsByVideo,
      downloadingVideoId,
      handleDownloadAll,
    ],
  );

  if (!project) {
    return (
      <section className="page">
        <p className="muted">Open a project first from the Projects page.</p>
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-header">
        <h1>Gallery</h1>
        <p>
          Generated overlay images are saved under{" "}
          <code>.devotiontime/images/&lt;episode&gt;/</code> in your project. Browse by episode,
          preview, and download PNGs. Each card shows a short <strong>transcript</strong> excerpt
          the image was based on.
        </p>
      </header>

      {transcribedVideos.length === 0 ? (
        <p className="muted">
          Transcribe a video first. Images appear here after you generate them on the Images tab.
        </p>
      ) : (
        <EpisodeAccordion panels={panels} />
      )}
    </section>
  );
}

function GalleryEpisodeBody({
  videoId,
  manifest,
  displayUrls,
  previewErrors,
}: {
  videoId: string;
  manifest: OverlayImagesManifest | null;
  displayUrls: Record<string, string>;
  previewErrors: Record<string, string>;
}) {
  if (!manifest || manifest.images.length === 0) {
    return (
      <p className="muted">
        No generated images for this episode yet. Use the <strong>Images</strong> tab and run{" "}
        <em>Generate images</em>.
      </p>
    );
  }

  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        {manifest.images.length} image{manifest.images.length === 1 ? "" : "s"} ·{" "}
        {new Date(manifest.generatedAt).toLocaleString()} · {manifest.model}
      </p>
      <div className="gallery-grid">
        {manifest.images.map((img) => (
          <GalleryImageCard
            key={img.suggestionId}
            img={img}
            displayUrl={displayUrls[img.suggestionId]}
            previewError={previewErrors[img.suggestionId]}
            videoId={videoId}
          />
        ))}
      </div>
    </>
  );
}

function GalleryImageCard({
  img,
  displayUrl,
  previewError,
  videoId,
}: {
  img: GeneratedOverlayImage;
  displayUrl?: string;
  previewError?: string;
  videoId: string;
}) {
  const name = `${sanitizeDownloadFilename(img.title)}-${img.suggestionId.slice(0, 8)}.png`;
  const excerpt = img.transcriptExcerpt?.trim() ?? "";
  const excerptPreview = excerptSnippet(excerpt, 160);

  return (
    <div className="gallery-card">
      <h4>{img.title}</h4>
      <p className="muted gallery-card-excerpt" title={excerpt || undefined}>
        {excerpt ? (
          <>
            <strong>Transcript</strong> · {excerptPreview}
          </>
        ) : (
          <span className="muted">No transcript excerpt on file for this image.</span>
        )}
      </p>
      <div>
        {displayUrl ? (
          <img src={displayUrl} alt={img.title} />
        ) : previewError ? (
          <p className="error" style={{ margin: 0, fontSize: "0.85rem" }}>
            Could not load: {previewError}
          </p>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
      {displayUrl && (
        <button
          type="button"
          className="btn small primary"
          onClick={() => {
            void downloadFromUrl(displayUrl, `${videoId}-${name}`);
          }}
        >
          Download PNG
        </button>
      )}
    </div>
  );
}
