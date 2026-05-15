use async_trait::async_trait;

use crate::types::ProjectSettings;

#[derive(Debug, Clone)]
pub struct ImageGenOptions {
    pub size: String,
    pub quality: String,
}

impl Default for ImageGenOptions {
    fn default() -> Self {
        Self {
            size: "1536x1024".to_string(),
            quality: "medium".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct GeneratedImage {
    pub bytes: Vec<u8>,
    pub mime: String,
}

#[async_trait]
pub trait ImageProvider: Send + Sync {
    async fn generate(
        &self,
        prompt: &str,
        settings: &ProjectSettings,
        options: ImageGenOptions,
    ) -> Result<GeneratedImage, String>;
}

pub struct NoopImageProvider;

#[async_trait]
impl ImageProvider for NoopImageProvider {
    async fn generate(
        &self,
        _prompt: &str,
        _settings: &ProjectSettings,
        _options: ImageGenOptions,
    ) -> Result<GeneratedImage, String> {
        Err("noop_image_provider".to_string())
    }
}

pub fn provider_for_name(name: &str) -> Box<dyn ImageProvider> {
    match name {
        "openai" => Box::new(super::openai::OpenAiImageProvider),
        "noop" | "none" => Box::new(NoopImageProvider),
        _ => Box::new(super::openai::OpenAiImageProvider),
    }
}
