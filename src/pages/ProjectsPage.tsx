import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { useProject, getStoredProjectRoot } from "../context/ProjectContext";
import { openProject, getProject } from "../services/pipelineService";
import { formatTranscriptionError } from "../utils/transcriptionErrors";

export function ProjectsPage() {
  const { project, setProject } = useProject();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = getStoredProjectRoot();
    if (!stored || project) return;
    getProject(stored)
      .then(setProject)
      .catch(() => localStorage.removeItem("devotiontime.projectRoot"));
  }, [project, setProject]);

  async function pickFolder() {
    setError(null);
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select video project folder",
    });
    if (!selected || typeof selected !== "string") return;

    setLoading(true);
    try {
      const manifest = await openProject(selected);
      setProject(manifest);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <h1>Projects</h1>
        <p>Open a folder containing your show video clips.</p>
      </header>

      <div className="card actions-row">
        <button type="button" className="btn primary" onClick={pickFolder} disabled={loading}>
          {loading ? "Opening…" : "Open video folder"}
        </button>
        {project && (
          <>
            <Link to="/transcribe" className="btn">
              Transcribe
            </Link>
            <Link to="/overlays" className="btn">
              Overlays
            </Link>
          </>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {project ? (
        <div className="card">
          <h2>{project.rootPath}</h2>
          <p className="muted">{project.videos.length} video(s) found</p>
          <table className="data-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {project.videos.map((video) => (
                <tr key={video.id}>
                  <td>{video.fileName}</td>
                  <td className="status-cell">
                    <div className="status-cell-stack">
                      <span className={`status-pill status-${video.status}`}>
                        {video.status}
                      </span>
                      {video.error ? (
                        <p className="error-summary">
                          {formatTranscriptionError(video.error)}
                        </p>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No project open yet.</p>
      )}
    </section>
  );
}
