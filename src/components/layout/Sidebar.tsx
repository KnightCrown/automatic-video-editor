import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { Home, Edit3, Image as ImageIcon, Video, Settings } from "lucide-react";
import clsx from "clsx";
import { useProject } from "../../context/ProjectContext";
import { getOverlayImagesManifest } from "../../services/pipelineService";

export const Sidebar = () => {
  const { project } = useProject();
  const [imageCount, setImageCount] = useState<number | null>(null);

  useEffect(() => {
    if (!project) {
      setImageCount(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      let count = 0;
      for (const video of project.videos) {
        const m = await getOverlayImagesManifest(project.rootPath, video.id);
        count += m?.images.length ?? 0;
      }
      if (!cancelled) setImageCount(count);
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.rootPath, project?.updatedAt, project?.videos.length]);

  const navItems = [
    { to: "/", icon: Home, label: "Overview", end: true },
    { to: "/editing", icon: Edit3, label: "Editing", end: false },
    { to: "/gallery", icon: ImageIcon, label: "Gallery", end: false },
    { to: "/videos", icon: Video, label: "Videos", end: false },
    { to: "/settings", icon: Settings, label: "Settings", end: false },
  ];

  return (
    <aside className="w-64 min-w-[14rem] flex-shrink-0 bg-background border-r border-border border-opacity-50 flex flex-col justify-between h-screen p-4 text-textMain transition-all">
      <div className="flex flex-col space-y-6">
        <div className="flex items-center gap-3 px-2">
          <div className="bg-primary bg-opacity-20 text-primary w-10 h-10 rounded-xl flex items-center justify-center font-bold text-lg">
            DT
          </div>
          <div>
            <h1 className="font-semibold text-[15px] leading-tight text-white mb-0 pb-0">DevotionTime</h1>
            <p className="text-xs text-textMuted mt-0 pt-0">AI Video Editor</p>
          </div>
        </div>

        <nav className="flex flex-col space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.label}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  clsx(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg text-[14px] font-medium transition-colors",
                    isActive
                      ? "bg-surface text-primary border border-white border-opacity-5"
                      : "text-textMuted hover:text-textMain hover:bg-surface hover:bg-opacity-50"
                  )
                }
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
      </div>

      {/* Placeholder functionality for bottom sections based on the mockup. */}
      {/* If any elements existed here previously we'd include them, but setting up the visual skeleton now */}
      <div className="space-y-6">
        {/* We can hardcode the collections from the UI mockup since there's no backend for this yet */}
        <div className="px-2">
          <h3 className="text-xs font-semibold text-textMuted uppercase tracking-wider mb-3">Collections</h3>
          <ul className="space-y-2 text-sm text-textMuted">
            <li className="flex justify-between items-center px-1">
              <span className="flex items-center gap-2">
                <ImageIcon size={14} /> All Images
              </span>
              <span className="text-xs">{imageCount ?? "—"}</span>
            </li>
          </ul>
        </div>
        
        {/* User profile */}
        <div className="flex items-center justify-between p-2 rounded-xl bg-surface border border-white border-opacity-5 hover:bg-opacity-80 cursor-pointer">
          <div className="flex items-center gap-3">
            <div className="bg-primary w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shadow-sm">
              PC
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-medium text-white leading-tight">Peter Crown</span>
              <span className="text-xs text-textMuted">Pro Plan</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};
