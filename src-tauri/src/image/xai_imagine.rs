use std::time::Duration;

use base64::Engine;
use serde::Deserialize;
use serde_json::json;

const XAI_IMAGES_URL: &str = "https://api.x.ai/v1/images/generations";

/// Prepended to every Grok Imagine request before the OpenAI overlay scene prompt.
pub const GROK_IMAGINE_STYLE_PREFIX: &str = "Create a clean, cheerful 2D illustrated scene with simple hand-drawn line art, bold black outlines, and bright flat colors. Use the visual style, audience, tone, and subject matter from the user's production prompt. Keep the illustration warm, family-friendly, visually clear, and easy to read at video size. Use minimal shading, expressive faces, simple clean backgrounds, and colorful clothing when people are present. Avoid anime proportions, oversized heads, chibi style, exaggerated baby-like features, photorealism, and distracting text unless the prompt explicitly asks for it.";

/// Style guide first, then the OpenAI scene description — sent as one prompt to Grok Imagine.
pub fn compose_grok_imagine_prompt(scene_prompt: &str) -> String {
    let scene = scene_prompt.trim();
    if scene.is_empty() {
        return GROK_IMAGINE_STYLE_PREFIX.to_string();
    }
    format!("{GROK_IMAGINE_STYLE_PREFIX}\n\n{scene}")
}

#[derive(Debug, Deserialize)]
struct XaiImageItem {
    b64_json: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct XaiImageResponse {
    data: Vec<XaiImageItem>,
}

/// Generate one PNG from Grok Imagine (xAI) using the Images API.
pub async fn generate_imagine_png(
    api_key: &str,
    model: &str,
    prompt: &str,
) -> Result<Vec<u8>, String> {
    let scene = prompt.trim();
    if scene.is_empty() {
        return Err("image_prompt_empty".to_string());
    }
    let full_prompt = compose_grok_imagine_prompt(scene);

    let body = json!({
        "model": model,
        "prompt": full_prompt,
        "n": 1,
        "response_format": "b64_json",
        "aspect_ratio": "16:9",
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("http_client_failed:{e}"))?;

    let resp = client
        .post(XAI_IMAGES_URL)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("xai_image_network:{e}"))?;

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("xai_image_read_body:{e}"))?;

    if !status.is_success() {
        return Err(format!("xai_image_error:{status}:{body_text}"));
    }

    let parsed: XaiImageResponse =
        serde_json::from_str(&body_text).map_err(|e| format!("xai_image_parse:{e}:{body_text}"))?;

    let first = parsed
        .data
        .first()
        .ok_or_else(|| format!("xai_image_no_data:{body_text}"))?;

    if let Some(b64) = first.b64_json.as_ref().map(|s| s.trim()) {
        if !b64.is_empty() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| format!("xai_image_b64_decode:{e}"))?;
            return Ok(bytes);
        }
    }

    if let Some(url) = first.url.as_deref() {
        if !url.is_empty() {
            let bytes = client
                .get(url)
                .send()
                .await
                .map_err(|e| format!("xai_image_url_fetch:{e}"))?
                .bytes()
                .await
                .map_err(|e| format!("xai_image_url_read:{e}"))?
                .to_vec();
            return Ok(bytes);
        }
    }

    Err(format!("xai_image_no_payload:{body_text}"))
}
