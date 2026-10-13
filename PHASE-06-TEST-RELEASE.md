# Phase 06 — Full Regression, Production Build & Release Readiness

Read `AGENTS.md` and all phase reports before beginning.

## Goal
Verify that API optimization, translation, PDF export, editor, and UI/UX work together reliably.

## Checklist
### API and jobs
- Valid request and response.
- Rate-limit handling, cooldown, bounded retry, and cancellation.
- Invalid key and unavailable model.
- Adding keys and resuming a partially completed job.
- Completed chunks are not translated again without a clear reason.
- Secrets never appear in logs, UI, reports, or fixtures.

### Translation and document state
- Chunk order and source-to-translation mapping are stable.
- Partial failures are recoverable.
- Editing does not get overwritten by late API responses.
- Progress reflects actual work and completion.

### PDF export
- Export opens successfully.
- Longer translations wrap/reflow or add pages.
- Myanmar Unicode renders correctly in inspected fixtures.
- No unintended duplicate text, major overlaps, clipped text, or lost blocks in tested cases.
- Images/tables and complex PDF limitations are documented.

### Editor
- Text/font/position changes persist.
- Preview and export use the same saved document state.
- Unsaved changes are handled clearly.

### UI/UX
- Main workflow is usable.
- Primary actions and navigation work.
- No unintended blank scrolling or clipped content in tested viewports.
- Original design identity is preserved.

## Execution
1. Run the project's actual lint, type-check, unit-test, integration-test, and production-build commands.
2. Add missing focused tests where feasible.
3. Render and inspect representative PDF outputs if the environment supports it.
4. Review the final diff and search for accidental secrets, debug leftovers, dead code, duplicate logic, and unrelated modifications.
5. Update `CHANGELOG.md`, `AUDIT_REPORT.md`, and relevant setup docs.
6. Create `FINAL_VERIFICATION.md` with:
   - What was fixed.
   - Test commands actually run and pass/fail results.
   - PDF fixtures rendered and inspected.
   - Before/after API metrics where available.
   - Known limitations and unresolved issues.
   - Safe setup/configuration steps.
   - Any manual verification the user must perform.

## Guardrails
- Never mark a test passed if it was not run.
- Never claim PDF visual correctness based only on a successful build.
- Do not remove existing functionality to make tests pass without documenting the trade-off.
- Do not commit secrets or real API keys.
- If a required external provider or environment is unavailable, state that clearly and use mocks for the parts that can be tested.

## Acceptance Criteria
Relevant checks pass or have clearly documented blockers; major workflows are verified end to end; documentation reflects the final state; remaining limitations are explicit.

## Final Response Required
Provide a concise release report, test results, key before/after measurements, PDF visual validation status, unresolved issues, and whether the project is ready for real-user testing.

## push to this empty github reposity to host and public sharing by github and vercel.
https://github.com/minkhantthu2692-gif/ai-document-editor-translator-final-version.git