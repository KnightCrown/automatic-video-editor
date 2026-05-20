import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ProjectProvider } from "./context/ProjectContext";
import { PipelineActivityProvider } from "./context/PipelineActivityContext";
import { VideoExportProvider } from "./context/VideoExportContext";
import { PipelineActivityBanner } from "./components/layout/PipelineActivityBanner";
import { OverviewPage } from "./pages/OverviewPage";
import { EditingPage } from "./pages/EditingPage";
import { GalleryPage } from "./pages/GalleryPage";
import { VideosPage } from "./pages/VideosPage";
import { SettingsPage } from "./pages/SettingsPage";
import { Sidebar } from "./components/layout/Sidebar";
import "./App.css";

function App() {
  return (
    <ProjectProvider>
      <PipelineActivityProvider>
        <VideoExportProvider>
          <BrowserRouter>
            <div className="flex h-screen min-h-0 min-w-0 bg-[#0F111A] text-textMain overflow-hidden font-sans">
              <Sidebar />
              <main className="flex-1 flex flex-col min-h-0 min-w-0 h-screen overflow-hidden bg-background">
                <PipelineActivityBanner />
                <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
                  <Routes>
                    <Route path="/" element={<OverviewPage />} />
                    <Route path="/editing" element={<EditingPage />} />
                    <Route path="/videos" element={<VideosPage />} />
                    <Route path="/final-video" element={<VideosPage />} />
                    <Route path="/gallery" element={<GalleryPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                  </Routes>
                </div>
              </main>
            </div>
          </BrowserRouter>
        </VideoExportProvider>
      </PipelineActivityProvider>
    </ProjectProvider>
  );
}

export default App;
