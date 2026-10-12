# Phase 04 — Real Pre-Export Translation Editor

Read `AGENTS.md`, `AUDIT_REPORT.md`, and `IMPLEMENTATION_PLAN.md` first.

## Goal
Verify whether the planned editor exists. If it is missing, hidden, incomplete, or disconnected from export, provide a usable pre-export editor whose changes persist in the actual output.

## Inspect First
- Routes/tabs/views and feature flags that may hide the editor.
- Translation job state and document/block model.
- Preview rendering and export data source.
- Existing editor libraries/components and keyboard handling.
- State persistence across page navigation, rerenders, and resumed jobs.

Do not create a second disconnected document model if the project already has a suitable one.

## Required Basic Features
- Display translated pages or page/block previews.
- Edit translated text manually.
- Change supported font family and font size.
- Adjust text-block position and dimensions where the export strategy supports it.
- Navigate pages, zoom in/out, and see clear current-page status.
- Keyboard support for common editing/navigation actions; document shortcuts and avoid hijacking normal text input.
- Undo/redo if practical with the existing architecture.
- Show unsaved changes and export readiness.
- Preview layout updates before export.
- Handle overflow and warn when manual edits require reflow or extra pages.

## Data Integrity Requirements
- The editor must update the same document model used by preview and PDF export.
- Changes must survive page navigation, rerenders, and export.
- Manual edits must not be overwritten by late translation responses or autosave races.
- Keep translation status/progress separate from edit-dirty state.
- Preserve completed translations and allow users to return to editing after partial failures.
- Validate font/position values and handle unsupported fonts gracefully.

## Tests
- Editor is discoverable and accessible in the workflow.
- Edit a text block, navigate away/back, and confirm it persists.
- Change font size/type and supported layout coordinates, then confirm preview changes.
- Export and verify the exported PDF contains the edited content and intended styling/position.
- Test unsaved-change warnings and undo/redo if implemented.
- Test a longer edited block that triggers reflow or page growth.
- Test keyboard behavior without breaking normal typing.

## Guardrails
- Do not implement a visual-only mock editor.
- Do not add professional-grade features unrelated to the stated basic needs.
- Do not let editor changes corrupt source text, chunk progress, or other pages.
- Preserve the original UI design language.

## Acceptance Criteria
A user can edit translated text and basic typography/layout before export, see the change in preview, and verify that it is present in the final PDF.

## Final Response Required
State whether an editor existed and why it was inaccessible/incomplete, describe implemented capabilities, list changed files, and report tests proving edits survive export.
