import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { openProject } from "../services/pipelineService";
import type { ProjectManifest } from "../types/pipeline";

interface ProjectContextValue {
  project: ProjectManifest | null;
  setProject: (project: ProjectManifest | null) => void;
  refreshProject: () => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

const STORAGE_KEY = "devotiontime.projectRoot";

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, setProjectState] = useState<ProjectManifest | null>(null);

  const setProject = useCallback((next: ProjectManifest | null) => {
    setProjectState(next);
    if (next?.rootPath) {
      localStorage.setItem(STORAGE_KEY, next.rootPath);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const refreshProject = useCallback(async () => {
    const root = project?.rootPath ?? localStorage.getItem(STORAGE_KEY);
    if (!root) return;
    const manifest = await openProject(root);
    setProjectState(manifest);
  }, [project?.rootPath]);

  const value = useMemo(
    () => ({ project, setProject, refreshProject }),
    [project, setProject, refreshProject],
  );

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
}

export function useProject() {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error("useProject must be used within ProjectProvider");
  }
  return ctx;
}

export function getStoredProjectRoot(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}
