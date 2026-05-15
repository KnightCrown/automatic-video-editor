use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use serde_json::json;

use super::provider::{GeneratedImage, ImageGenOptions, ImageProvider};
use crate::llm::openai::get_openai_api_key;
use crate::types::ProjectSettings;

pub struct OpenAiImageProvider;

#[async_trait]
impl ImageProvider for OpenAiImageProvider {
    async fn generate(
        &self,
        prompt: &str,
        settings: &ProjectSettings,
        options: ImageGenOptions,
    ) -> Result<GeneratedImage, String> {
        let api_key = get_openai_api_key()?;
        let trimmed = prompt.trim();
        if trimmed.is_empty() {
            return Err("image_prompt_empty".to_string());
        }

        let body = json!({
            "model": settings.openai_image_model,
            "prompt": trimmed,
            "size": options.size,
            "quality": options.quality,
            "background": "transparent",
            "output_format": "png",
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|e| format!("http_client_failed:{}", e))?;

        let resp = client
            .post("https://api.openai.com/v1/images/generations")
            .bearer_auth(&api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("openai_image_network:{}", e))?;

        let status = resp.status();
        let body_text = resp
            .text()
            .await
            .map_err(|e| format!("openai_image_read:{}", e))?;

        if !status.is_success() {
            return Err(format!("openai_image_error:{}:{}", status, body_text));
        }

        let parsed: serde_json::Value = serde_json::from_str(&body_text)
            .map_err(|e| format!("openai_image_parse:{}", e))?;

        if let Some(b64) = parsed
            .get("data")
            .and_then(|d| d.get(0))
            .and_then(|d| d.get("b64_json"))
            .and_then(|b| b.as_str())
        {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|e| format!("openai_image_b64_decode:{}", e))?;
            return Ok(GeneratedImage {
                bytes,
                mime: "image/png".to_string(),
            });
        }

        if let Some(url) = parsed
            .get("data")
            .and_then(|d| d.get(0))
            .and_then(|d| d.get("url"))
            .and_then(|u| u.as_str())
        {
            let bytes = client
                .get(url)
                .send()
                .await
                .map_err(|e| format!("openai_image_url_fetch:{}", e))?
                .bytes()
                .await
                .map_err(|e| format!("openai_image_url_read:{}", e))?
                .to_vec();
            return Ok(GeneratedImage {
                bytes,
                mime: "image/png".to_string(),
            });
        }

        Err(format!("openai_image_no_data:{}", body_text))
    }
}
