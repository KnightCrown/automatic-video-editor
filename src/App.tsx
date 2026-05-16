import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { ProjectProvider } from "./context/ProjectContext";
import { ProjectsPage } from "./pages/ProjectsPage";
import { TranscribePage } from "./pages/TranscribePage";
import { OverlaysPage } from "./pages/OverlaysPage";
import { ImagesPage } from "./pages/ImagesPage";
import { GalleryPage } from "./pages/GalleryPage";
import { SettingsPage } from "./pages/SettingsPage";
import "./App.css";

function App() {
  return (
    <ProjectProvider>
      <BrowserRouter>
        <div className="app-shell">
          <nav className="sidebar">
            <div className="brand">
              <span className="brand-mark">DT</span>
              <div>
                <strong>DevotionTime</strong>
                <p>Overlay Generator</p>
              </div>
            </div>
            <div className="sidebar-main-nav">
              <NavLink to="/" end className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
                Projects
              </NavLink>
              <NavLink to="/transcribe" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
                Transcribe
              </NavLink>
              <NavLink to="/overlays" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
                Overlays
              </NavLink>
              <NavLink to="/images" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
                Images
              </NavLink>
            </div>
            <div className="sidebar-bottom-nav">
              <NavLink to="/gallery" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
                Gallery
              </NavLink>
              <NavLink to="/settings" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
                Settings
              </NavLink>
            </div>
          </nav>
          <main className="main-content">
            <Routes>
              <Route path="/" element={<ProjectsPage />} />
              <Route path="/transcribe" element={<TranscribePage />} />
              <Route path="/overlays" element={<OverlaysPage />} />
              <Route path="/images" element={<ImagesPage />} />
              <Route path="/gallery" element={<GalleryPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </ProjectProvider>
  );
}

export default App;
