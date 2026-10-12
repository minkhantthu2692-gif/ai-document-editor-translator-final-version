# Phase 02 — API Consumption, Token Budgeting, Chunking & Key Rotation

Read `AGENTS.md`, `AUDIT_REPORT.md`, and `IMPLEMENTATION_PLAN.md` first.

## Goal
Fix proven causes of unnecessary API usage and unreliable rate-limit/key-rotation behavior while preserving provider limits.

## Diagnose Before Editing
Use Phase 01 evidence to inspect:
- Duplicate request triggers, repeated translation, unnecessary polling, request loops, and over-parallelization.
- Input text duplicated between chunks or repeated in every prompt.
- Token estimation that ignores system prompts, structured output, tokenizer differences, or output budgets.
- Context-window/output-token overflow.
- Retries that repeat non-idempotent work or retry permanent errors.
- Confusion between rate limits, daily quota exhaustion, invalid keys, authentication, billing/quota errors, context overflow, network errors, and malformed responses.
- Key rotation that advances too early, never advances, cycles through cooling-down keys, or ignores provider/project shared quotas.

## Implementation Requirements
1. Add structured, secret-safe diagnostics for request ID, provider/model, key alias/index (never the key itself), chunk ID, attempt, duration, error category, reported usage, and estimated usage.
2. Label estimated token counts as estimates; prefer provider-reported usage when available.
3. Build safe, model-aware chunk budgets that reserve room for instructions and output. Do not assume characters equal tokens or all models share one tokenizer.
4. Avoid duplicate/overlapping content unless a documented overlap is needed for context. Preserve source order and stable chunk IDs.
5. Deduplicate repeated work using stable job/chunk identifiers and a cache only where correctness permits.
6. Use bounded concurrency, provider-aware rate limiting, and bounded exponential backoff with jitter for transient errors.
7. Do not retry permanent errors such as invalid credentials or unsupported model configuration indefinitely.
8. Track key state and cooldown by the actual provider/model/account/project scope where known. Do not assume different keys have independent quotas.
9. When adding keys during a job, validate configuration safely and make newly eligible keys available without losing job state.
10. Resume only incomplete/failed chunks and retain completed results.
11. Make cancellation and retry behavior explicit and prevent duplicate concurrent processing of the same chunk.
12. Surface actionable errors without exposing secrets or falsely claiming a key is exhausted.

## Tests
Use mocks/fixtures for:
- Valid response with usage metadata.
- Provider response without usage metadata.
- Rate limit with retry-after information.
- Invalid key/authentication failure.
- Daily or account quota exhaustion.
- Context/output limit errors.
- Timeout/network error.
- Duplicate trigger and duplicate chunk submission.
- Multiple keys with different cooldown states.
- Shared quota behavior where it can be represented by a mock.
- Add key mid-job and resume partial job.
- Repeated retry cap and cancellation.

Compare baseline and new behavior where measurements exist: request count, retry count, token usage, duplicate work, and translation output integrity.

## Guardrails
- Do not claim a free key can translate unlimited documents.
- Do not attempt to bypass provider restrictions.
- Do not rotate keys blindly on every request.
- Do not optimize by silently dropping source text or sacrificing translation completeness.
- Avoid unrelated UI redesign; only make necessary diagnostics/status updates.

## Acceptance Criteria
- Root cause(s) from Phase 01 are addressed or explicitly marked unresolved with evidence.
- Request and token usage are measurable.
- Retry/key rotation/resume behavior has targeted tests.
- Successful chunks are not needlessly retransmitted.
- Error messages distinguish known failure classes.
- Build/lint/type checks relevant to changed code pass, or blockers are documented.

## Final Response Required
List the root cause fixed, changed files, before/after measurements if available, tests run and results, remaining provider-side limitations, and whether Phase 03 can safely proceed.
