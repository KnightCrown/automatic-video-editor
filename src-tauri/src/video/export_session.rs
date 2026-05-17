use tokio::process::Child;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

/// Returned to the frontend when the user cancels an in-progress export.
pub const EXPORT_CANCELLED: &str = "export_cancelled";

struct Inner {
    video_id: Option<String>,
    cancelled: bool,
}

/// Tracks the active final-video export so the user can cancel FFmpeg.
#[derive(Default)]
pub struct VideoExportController {
    inner: Mutex<Inner>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            video_id: None,
            cancelled: false,
        }
    }
}

impl VideoExportController {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn begin(&self, video_id: &str) {
        let mut g = self.inner.lock().await;
        g.video_id = Some(video_id.to_string());
        g.cancelled = false;
    }

    pub async fn end(&self, video_id: &str) {
        let mut g = self.inner.lock().await;
        if g.video_id.as_deref() == Some(video_id) {
            g.video_id = None;
            g.cancelled = false;
        }
    }

    pub async fn request_cancel(&self, video_id: &str) -> bool {
        let mut g = self.inner.lock().await;
        if g.video_id.as_deref() != Some(video_id) {
            return false;
        }
        g.cancelled = true;
        true
    }

    pub async fn is_cancelled(&self, video_id: &str) -> bool {
        let g = self.inner.lock().await;
        g.video_id.as_deref() == Some(video_id) && g.cancelled
    }

    pub fn cancelled_error() -> String {
        EXPORT_CANCELLED.to_string()
    }
}

/// Wait for FFmpeg while polling for user cancellation.
pub async fn wait_child_or_cancel(
    controller: &VideoExportController,
    video_id: &str,
    child: &mut Child,
) -> Result<std::process::ExitStatus, String> {
    loop {
        if controller.is_cancelled(video_id).await {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(VideoExportController::cancelled_error());
        }

        match timeout(Duration::from_millis(200), child.wait()).await {
            Ok(Ok(status)) => {
                if controller.is_cancelled(video_id).await {
                    return Err(VideoExportController::cancelled_error());
                }
                return Ok(status);
            }
            Ok(Err(e)) => return Err(format!("ffmpeg_wait_failed:{e}")),
            Err(_) => continue,
        }
    }
}
