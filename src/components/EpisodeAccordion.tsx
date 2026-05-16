import { useCallback, useMemo, useState } from "react";

export type EpisodePanelSpec = {
  id: string;
  /** Primary label (e.g. file name) */
  title: string;
  /** Secondary line (e.g. status) */
  subtitle?: string;
  /** Right side of the row (e.g. actions); not part of the expand/collapse control */
  headerActions?: React.ReactNode;
  /** Panel body when expanded */
  renderContent: () => React.ReactNode;
};

type ControlState =
  | { mode: "default" }
  | { mode: "all" }
  | { mode: "none" }
  | { mode: "custom"; open: Set<string> };

function effectiveOpenIds(control: ControlState, panelIds: string[]): Set<string> {
  if (panelIds.length === 0) return new Set();
  switch (control.mode) {
    case "default":
      return new Set([panelIds[0]]);
    case "all":
      return new Set(panelIds);
    case "none":
      return new Set();
    case "custom":
      return new Set(control.open);
  }
}

export function EpisodeAccordion({
  panels,
  className = "",
}: {
  panels: EpisodePanelSpec[];
  className?: string;
}) {
  const panelIds = useMemo(() => panels.map((p) => p.id), [panels]);
  const [control, setControl] = useState<ControlState>({ mode: "default" });

  const openSet = useMemo(
    () => effectiveOpenIds(control, panelIds),
    [control, panelIds],
  );

  const isOpen = useCallback((id: string) => openSet.has(id), [openSet]);

  const toggle = useCallback(
    (id: string) => {
      setControl((prev) => {
        const cur = effectiveOpenIds(prev, panelIds);
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return { mode: "custom", open: next };
      });
    },
    [panelIds],
  );

  if (panels.length === 0) {
    return null;
  }

  return (
    <div className={`episode-accordion ${className}`.trim()}>
      <div className="episode-accordion-toolbar">
        <button
          type="button"
          className="btn small"
          onClick={() => setControl({ mode: "all" })}
        >
          Open all
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => setControl({ mode: "none" })}
        >
          Close all
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => setControl({ mode: "default" })}
        >
          Default
        </button>
        <span className="muted episode-accordion-toolbar-hint">
          Default: first episode expanded only.
        </span>
      </div>

      <div className="episode-accordion-list">
        {panels.map((panel) => {
          const open = isOpen(panel.id);
          return (
            <div key={panel.id} className="episode-accordion-item">
              <div className="episode-accordion-header-row">
                <button
                  type="button"
                  className="episode-accordion-header"
                  aria-expanded={open}
                  onClick={() => toggle(panel.id)}
                >
                  <span className="episode-accordion-chevron" aria-hidden>
                    {open ? "▼" : "▶"}
                  </span>
                  <span className="episode-accordion-title">{panel.title}</span>
                  {panel.subtitle ? (
                    <span className="episode-accordion-subtitle">{panel.subtitle}</span>
                  ) : null}
                </button>
                {panel.headerActions ? (
                  <div className="episode-accordion-header-actions">{panel.headerActions}</div>
                ) : null}
              </div>
              {open ? (
                <div className="episode-accordion-body">
                  {panel.renderContent()}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
