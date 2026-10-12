# PDF Translator — Agent Working Rules

## Mission
Maintain and improve the existing PDF Translator Web Application with evidence-driven changes. Priorities are:
1. Correctly diagnose API request/token consumption and rate-limit behavior.
2. Produce readable, valid translated PDFs without duplicated or overlapping text.
3. Provide a real pre-export editor whose changes persist into exported output.
4. Improve UI/UX while preserving the existing visual identity and working features.

## Mandatory Rules
- Read this file before starting any phase.
- Inspect the existing codebase and follow its framework, architecture, conventions, and dependency choices unless evidence justifies a change.
- Do not assume the user's suspected cause is correct. Distinguish confirmed findings from hypotheses.
- Do not rewrite the whole application as a first step.
- Do not delete files, replace major libraries, run destructive migrations, or remove features without documenting the reason and impact first.
- Preserve the original UI design language, colors, typography, and component style. Prefer targeted fixes.
- Never expose API keys or secrets in logs, UI, screenshots, reports, or test fixtures.
- Do not claim a feature works unless its behavior has been verified.
- Do not claim provider quota has been increased or bypassed. Respect provider limits and terms.
- Use existing scripts and test commands where possible. Do not invent test results.
- Keep changes small, reviewable, and phase-scoped. Avoid unrelated refactors.
- If a required credential, provider response, sample PDF, or environment is unavailable, state the limitation and test with safe mocks/fixtures where possible.

## Required Workflow for Every Phase
1. Read `AGENTS.md` and the current phase file.
2. Inspect relevant files and trace the real data flow before editing.
3. Record confirmed issues, hypotheses, and risks.
4. Implement only changes in the current phase unless a dependency requires otherwise.
5. Run targeted tests after each meaningful change.
6. Review the diff for regressions, secrets, dead code, and accidental scope expansion.
7. Update `CHANGELOG.md` and the audit/progress report.
8. Report: files inspected, files changed, tests actually run, results, unresolved issues, and the next phase recommendation.

Do not silently skip a phase. If a phase cannot be completed, document why and what is needed.

## Shared Engineering Requirements
- Prefer typed, validated data structures for translation jobs, chunks, page/block geometry, and editor state where supported by the project.
- Keep provider-specific API behavior behind clear adapters where practical.
- Keep API usage telemetry separate from secrets.
- Treat actual provider-reported usage as authoritative when available; label estimates clearly.
- Make retries bounded and idempotent where practical.
- Preserve completed translation chunks and avoid retranslating them unnecessarily.
- Handle cancellation, partial failure, resume, and stale job state safely.
- PDF export must prioritize legibility and document integrity over forcing the original page count.
- Support Myanmar Unicode shaping and font embedding/fallback where the chosen PDF pipeline permits it.
- Editor changes must update the same document model used by preview and export.
- Accessibility, keyboard usability, responsive behavior, and meaningful loading/error states matter.
- Do not make a control look functional if it is not wired to a real action.

## Phase Boundaries
- Phase 01: audit/report/plan only, unless a tiny diagnostic is essential and explicitly documented.
- Phase 02: API and translation pipeline.
- Phase 03: PDF layout reconstruction and export quality.
- Phase 04: pre-export editor.
- Phase 05: UI/UX and layout polish.
- Phase 06: cross-feature regression tests and release readiness.

## Completion Standard
A successful build alone is not proof of correctness. Use targeted tests and, for PDF work, inspect rendered pages. Report known limitations honestly.
