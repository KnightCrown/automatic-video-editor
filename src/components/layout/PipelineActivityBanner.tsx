import { Loader2 } from "lucide-react";
import { usePipelineActivity } from "../../context/PipelineActivityContext";
import {
  imageGenerationHeadline,
  imageGenerationOverallPercent,
  transcriptionHeadline,
  transcriptionOverallPercent,
} from "../../utils/pipelineProgress";

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-1.5 bg-background rounded-full overflow-hidden flex-1 min-w-[8rem]">
      <div
        className="h-full bg-primary transition-all duration-300"
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  );
}

export function PipelineActivityBanner() {
  const { transcription, imageGeneration, analyzingIds, analyzingForVideo } =
    usePipelineActivity();

  const items: { key: string; headline: string; detail?: string; percent: number }[] = [];

  if (transcription) {
    const { episodeIndex, episodeTotal, progress } = transcription;
    const index = progress?.episodeIndex ?? episodeIndex;
    const total = progress?.episodeTotal ?? episodeTotal;
    items.push({
      key: "transcription",
      headline: transcriptionHeadline(index || 1, total || 1),
      detail: progress?.message ?? progress?.stage,
      percent: transcriptionOverallPercent(index || 1, total || 1, progress),
    });
  }

  for (const videoId of analyzingIds) {
    const meta = analyzingForVideo(videoId);
    items.push({
      key: `analyze-${videoId}`,
      headline: "Analyzing transcript",
      detail: meta?.fileName,
      percent: 50,
    });
  }

  if (imageGeneration) {
    items.push({
      key: "images",
      headline: imageGenerationHeadline(imageGeneration.progress),
      detail:
        imageGeneration.progress?.message ??
        imageGeneration.fileName ??
        imageGeneration.progress?.stage,
      percent: imageGenerationOverallPercent(imageGeneration.progress),
    });
  }

  if (items.length === 0) return null;

  return (
    <div
      className="flex-shrink-0 border-b border-border bg-[#151821] px-4 py-2.5 space-y-2"
      role="status"
      aria-live="polite"
    >
      <p className="text-xs text-textMuted">
        Background tasks keep running when you switch pages. You can keep working elsewhere.
      </p>
      {items.map((item) => (
        <div key={item.key} className="flex flex-wrap items-center gap-3 text-sm">
          <Loader2 size={16} className="text-primary animate-spin flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-white font-medium">{item.headline}</p>
            {item.detail ? (
              <p className="text-xs text-textMuted truncate">{item.detail}</p>
            ) : null}
          </div>
          <ProgressBar percent={item.percent} />
        </div>
      ))}
    </div>
  );
}
