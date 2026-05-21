import type { TimelineVideoClip } from "../types/pipeline";

export type InsertOffset = {
  clipId?: string;
  insertAtMs: number;
  durationMs: number;
};

export type TimelineInsertEntry = {
  clipId: string;
  insertAtMs: number;
  finalStartMs: number;
  finalEndMs: number;
  durationMs: number;
};

export type TimelineInsertPlan = {
  contentStartMs: number;
  contentEndMs: number;
  inserts: TimelineInsertEntry[];
  insertOffsets: InsertOffset[];
};

export type TimelineBaseSegment = {
  key: string;
  finalStartMs: number;
  finalEndMs: number;
};

export function isScheduledInsertKind(kind?: string | null): boolean {
  return (
    kind === "scheduled_start" ||
    kind === "scheduled_end" ||
    kind === "intro" ||
    kind === "outro"
  );
}

export function isInsertClip(clip: TimelineVideoClip): boolean {
  return (
    clip.renderMode === "insert" ||
    clip.timelineMode === "insert" ||
    isScheduledInsertKind(clip.placementKind)
  );
}

export function effectiveClipDurationMs(clip: TimelineVideoClip): number {
  const trimStart = Math.min(clip.trimStartMs ?? 0, clip.sourceDurationMs);
  return Math.max(1, Math.min(clip.durationMs, clip.sourceDurationMs - trimStart));
}

export function clipInsertAtMs(
  clip: TimelineVideoClip,
  contentStartMs: number,
  contentEndMs: number,
): number {
  const kind = clip.placementKind;
  if (kind === "scheduled_start" || kind === "intro" || clip.startMs <= contentStartMs) {
    return contentStartMs;
  }
  if (kind === "scheduled_end" || kind === "outro" || clip.startMs >= contentEndMs) {
    return contentEndMs;
  }
  return Math.max(contentStartMs, Math.min(contentEndMs, clip.startMs));
}

export function buildTimelineInsertPlan(
  videoClips: TimelineVideoClip[],
  contentStartMs: number,
  contentEndMs: number,
): TimelineInsertPlan {
  const contentStart = contentStartMs;
  const contentEnd = Math.max(contentStart + 1, contentEndMs);

  const sortedInserts = videoClips
    .filter(isInsertClip)
    .map((clip) => ({
      clip,
      insertAtMs: clipInsertAtMs(clip, contentStart, contentEnd),
      durationMs: effectiveClipDurationMs(clip),
    }))
    .sort((a, b) => {
      return a.insertAtMs - b.insertAtMs || a.clip.trackIndex - b.clip.trackIndex;
    });

  let insertedBeforeMs = 0;
  const inserts: TimelineInsertEntry[] = sortedInserts.map(({ clip, insertAtMs, durationMs }) => {
    const finalStartMs = Math.max(0, insertAtMs - contentStart) + insertedBeforeMs;
    insertedBeforeMs += durationMs;
    return {
      clipId: clip.id,
      insertAtMs,
      finalStartMs,
      finalEndMs: finalStartMs + durationMs,
      durationMs,
    };
  });

  return {
    contentStartMs: contentStart,
    contentEndMs: contentEnd,
    inserts,
    insertOffsets: inserts.map((insert) => ({
      clipId: insert.clipId,
      insertAtMs: insert.insertAtMs,
      durationMs: insert.durationMs,
    })),
  };
}

export function sourceToFinalMs(
  sourceMs: number,
  contentStartMs: number,
  insertOffsets: InsertOffset[],
): number {
  const clamped = Math.max(contentStartMs, sourceMs);
  const insertedBefore = insertOffsets
    .filter((insert) => insert.insertAtMs <= clamped)
    .reduce((sum, insert) => sum + insert.durationMs, 0);
  return Math.max(0, clamped - contentStartMs) + insertedBefore;
}

export function finalToSourceMs(
  finalMs: number,
  contentStartMs: number,
  insertOffsets: InsertOffset[],
): number {
  const sorted = [...insertOffsets].sort((a, b) => a.insertAtMs - b.insertAtMs);
  let remaining = Math.max(0, finalMs);
  let sourceCursor = contentStartMs;

  for (const insert of sorted) {
    const sourceSpan = Math.max(0, insert.insertAtMs - sourceCursor);
    if (remaining <= sourceSpan) {
      return sourceCursor + remaining;
    }
    remaining -= sourceSpan;
    if (remaining <= insert.durationMs) {
      return insert.insertAtMs;
    }
    remaining -= insert.durationMs;
    sourceCursor = insert.insertAtMs;
  }

  return sourceCursor + remaining;
}

export function buildBaseVideoSegments(
  contentStartMs: number,
  contentEndMs: number,
  insertOffsets: InsertOffset[],
): TimelineBaseSegment[] {
  const contentStart = contentStartMs;
  const contentEnd = Math.max(contentStart + 1, contentEndMs);
  const segments: TimelineBaseSegment[] = [];
  let cursor = contentStart;
  let finalCursor = 0;

  for (const insert of insertOffsets) {
    if (insert.insertAtMs > cursor) {
      const duration = insert.insertAtMs - cursor;
      segments.push({
        key: `base-${cursor}`,
        finalStartMs: finalCursor,
        finalEndMs: finalCursor + duration,
      });
      finalCursor += duration;
      cursor = insert.insertAtMs;
    }
    finalCursor += insert.durationMs;
  }

  if (contentEnd > cursor) {
    segments.push({
      key: `base-${cursor}`,
      finalStartMs: finalCursor,
      finalEndMs: finalCursor + (contentEnd - cursor),
    });
  }

  if (segments.length === 0) {
    segments.push({
      key: "base",
      finalStartMs: 0,
      finalEndMs: Math.max(1, contentEnd - contentStart),
    });
  }

  return segments;
}

export function computeFinalTimelineDuration(
  contentStartMs: number,
  contentEndMs: number,
  insertOffsets: InsertOffset[],
): number {
  const segments = buildBaseVideoSegments(contentStartMs, contentEndMs, insertOffsets);
  return segments[segments.length - 1]?.finalEndMs ?? Math.max(1, contentEndMs - contentStartMs);
}

export function clipFinalStartMs(
  clip: TimelineVideoClip,
  plan: TimelineInsertPlan,
): number {
  const inserted = plan.inserts.find((entry) => entry.clipId === clip.id);
  if (inserted) return inserted.finalStartMs;
  return sourceToFinalMs(clip.startMs, plan.contentStartMs, plan.insertOffsets);
}
