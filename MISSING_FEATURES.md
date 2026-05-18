# Missing Features (UI vs Backend Implementation)

This document tracks UI elements added during the visual overhaul that currently lack backend or state logic.

## Sidebar / Layout
- **User Accounts:** The user profile (name, avatar, plan) at the bottom left is hardcoded. There is currently no user authentication or profile management state.
- **Collections / Folders:** The "Collections" area (e.g. "All Images") is hardcoded.

## Overview Page
- **Recent Activity:** Hardcoded list of events (Completed, AI analysis...). Real-time backend activity feeds don't exist yet to populate this accurately.
- **Tips section:** Static textual content with inactive link.
- **"Start all ready" and "Clear completed":** UI buttons exist, but mass selection and mass project pipeline control functions aren't mapped.
- **Quick Operations:** The right-handed action buttons per video (Play, Stop/Square, Refresh) lack execution bindings.

## Editing Page
- **Add Episodes Button:** The "+ Add episodes" button in the Left Panel exists visually but requires backend implementation to append videos to an active project.
- **Transcripts Tab:** The Transcript tab contents were placeholder mapped since the original logic was deeply baked into `TranscribePage.tsx`.
- **Status Toggles & Accordions:** The approval dropdowns for individual suggested overlays are placeholder nodes.
- **Bottom Footer Actions:** "Approve selected", "Decline selected", "Regenerate selected" and "Generate more images" buttons exist logically in flow but are hardcoded or require selection set logic migration.
- **Prompt Details Editing:** The quick edit (pencil) inline prompt override doesn't bind to local state memory.

## Gallery Page
- **Filtering UI:** "All projects", "All episodes", "All statuses", and "Sort by: Newest" dropdowns are non-functional visual shells.
- **Favorites:** Heart icons on thumbnails don't reflect any backend schema for a "Favorite" state.
- **Image detail metadata:** Hardcoded resolution, timestamps, file sizes, format strings, model version.

## Settings Page
- **Model specific dropdowns:** Setting AI models via dropdowns (e.g., GPT-4o selection or Analysis depth "Deep vs Balanced") exist visually but don't bind to `updateProjectSettings`.
- **Threshold Slider:** Overlay confidence threshold slider is entirely a dummy visual track.
- **Output defaults:** Video resolution, framerate, and image quality selection dropdowns aren't bound.