# Phase 01 — Project Discovery, Root-Cause Audit & Plan

Read `AGENTS.md` first.

## Goal
Understand the existing application and produce an evidence-based audit before major implementation changes.

## Tasks
1. Inspect the project tree, README/docs, package manifests, environment/config examples, routes/pages, state management, API adapters, PDF extraction/OCR, chunking, translation orchestration, export code, editor-related code, CSS/layout, and existing tests.
2. Identify the actual framework, runtime, architecture, PDF libraries, AI providers, and current test/build commands. Do not assume technologies before inspecting.
3. Trace these end-to-end flows:
   - Import PDF → extract/OCR → normalize → chunk → translate → store results → preview/edit → export.
   - Add API key → choose key/model/provider → send request → classify failure → rotate/cooldown/retry → resume.
4. Search for duplicated request triggers, effect loops, repeated prompt/context construction, duplicate chunk processing, incorrect token estimates, unsafe concurrency, infinite retries, and false rate-limit detection.
5. Find PDF text overlay/replacement behavior that may leave original text visible underneath, mis-map text blocks, ignore translated text expansion, or fail Myanmar font shaping.
6. Determine whether an editor exists, where it is mounted, whether navigation hides it, and whether edits connect to export data.
7. Inspect page/container heights, overflow, nested scrolling, excess bottom padding, duplicate UI, and inert controls.
8. Separate every finding into:
   - Confirmed with code/test evidence
   - Likely but not yet verified
   - Unknown because runtime/provider/sample input is unavailable
9. Create `AUDIT_REPORT.md` with architecture/data-flow diagrams or concise flow descriptions, severity, affected files, evidence, risks, and recommended minimal fixes.
10. Create `IMPLEMENTATION_PLAN.md` with ordered tasks, dependencies, acceptance checks, and rollback considerations.

## Guardrails
- Do not begin a full rewrite.
- Do not delete files or replace core libraries in this phase.
- Do not report a hypothesis as a verified root cause.
- If possible, add a safe way to inspect request counts and errors without logging secrets, but avoid broad implementation before documenting it.

## Acceptance Criteria
- The real API request and PDF export flows are mapped.
- The key-rotation implementation and rate-limit classification are understood.
- The export overlap mechanism and current layout strategy are identified.
- Editor presence/accessibility/data binding are verified.
- Findings and plan are written to the two Markdown reports.
- The report names the exact files/functions involved where possible.

## Final Response Required
Summarize findings, cite project paths/functions, identify the highest-risk root causes, list planned changes, and state which tests/commands were actually run. Do not proceed to Phase 02 until the audit and plan are reviewed or the user explicitly asks to continue.
