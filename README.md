# Automatic Video Editor

A desktop **automatic video editing** assistant for producing kids and family video content with AI-assisted overlays. It turns raw episode files into transcripts, structured overlay suggestions, and generated images—so you can focus on the edit instead of manually storyboarding every beat.

Built with **Tauri 2**, **React**, and **TypeScript**. Speech recognition runs **locally** (Parakeet); analysis and images use **OpenAI** and **xAI Grok Imagine** when you add API keys.

## What it does

1. **Projects** — Point the app at a folder of video files (e.g. MP4).
2. **Transcribe** — Extract audio with FFmpeg and transcribe with a local Parakeet model (no audio leaves your machine for this step).
3. **Overlays** — Send the full transcript to OpenAI to suggest Bible-related moments and overlay prompts (titles, image prompts, on-screen text ideas, transcript excerpts).
4. **Images** — For each suggestion, call **xAI Grok Imagine** to generate images from the prompts; results and excerpts are saved next to your project.

Outputs are stored under each project’s `.devotiontime/` directory (transcripts, analysis, generated PNGs, manifests).

## Requirements

- **Node.js** (for dev/build) and **Rust** (for Tauri)
- **FFmpeg** on your `PATH` (for audio extraction)
- **OpenAI API key** — overlay script analysis  
- **xAI API key** — Grok Imagine image generation  
- **Parakeet ONNX model** — downloaded once from the app’s Settings (local transcription)

## Development

```bash
npm install
npm run tauri:dev
```

Production web build:

```bash
npm run build
```

Native app bundles:

```bash
npm run build:windows   # MSI on Windows
npm run build:mac      # DMG on macOS
```

## Privacy notes

- Transcription is offline once the speech model is downloaded.
- Sending a transcript to OpenAI or prompts to xAI requires network access and is subject to those providers’ terms.

## License

See the repository for license information (add a `LICENSE` file if you distribute the app).
