# PDF Translator Agent Kit

This kit provides persistent agent rules and one prompt per implementation phase.

## Files
- `AGENTS.md` — shared rules for all phases.
- `PHASE-01-AUDIT.md` — discover the codebase and produce audit/plan reports.
- `PHASE-02-API-PIPELINE.md` — diagnose API limits, token usage, chunking, retries, key rotation, and resume.
- `PHASE-03-PDF-EXPORT.md` — fix readable PDF reconstruction, longer translated text, Myanmar fonts, and pagination.
- `PHASE-04-EDITOR.md` — find or implement a real pre-export editor connected to export.
- `PHASE-05-UI-UX.md` — fix duplicate/inert UI, confusing layouts, and blank scrolling while preserving the design.
- `PHASE-06-TEST-RELEASE.md` — full regression and production-readiness verification.

## Recommended workflow
1. Copy `AGENTS.md` into the repository root. Most coding agents recognize it; some tools specifically use `AGENTS.md`, while others may use `AGENT.md` or another rules file. If your agent requires a different filename, follow that tool's convention and keep one authoritative copy.
2. Start a fresh agent session and ask it to read `AGENTS.md` and `PHASE-01-AUDIT.md`.
3. Review `AUDIT_REPORT.md` and `IMPLEMENTATION_PLAN.md` before authorizing major changes.
4. Run one phase at a time. For each phase, paste the corresponding phase prompt and require its final report.
5. Run tests and inspect the diff after every phase. Commit or create a backup checkpoint before moving to the next phase if Git is available.
6. Do not start the next phase until the current phase's acceptance criteria are met or its blockers are documented.

## Suggested first message to the agent
Read `AGENTS.md` and `PHASE-01-AUDIT.md` completely. Inspect this repository and produce `AUDIT_REPORT.md` and `IMPLEMENTATION_PLAN.md`. Do not make broad code changes or delete files yet. Distinguish verified findings from hypotheses and report the exact files/functions that support each conclusion.
