# Phase 05 — UI/UX, Layout, Scrolling & Visual Consistency

Read `AGENTS.md`, `AUDIT_REPORT.md`, and `IMPLEMENTATION_PLAN.md` first.

## Goal
Improve usability without losing the original visual identity or breaking working features.

## Audit
Review the complete workflow:
Import → Configure → Translate → Review/Edit → Preview → Export.

Look for:
- Duplicate UI elements, repeated status panels, redundant actions, and inconsistent component variants.
- Buttons or controls that do nothing or are visual-only.
- Confusing action hierarchy and important actions placed too far away or below relevant content.
- Unnecessary page scrolling, excessive blank space after content ends, nested scroll conflicts, and clipped content.
- Incorrect min-height/height, overflow rules, sticky/fixed elements, viewport calculations, and unnecessary bottom padding.
- Responsive layout problems, modal overflow, focus visibility, keyboard navigation, and unclear loading/error/empty states.

## Requirements
1. Preserve original colors, typography, spacing style, component language, and overall visual identity.
2. Prefer small targeted changes over a full redesign.
3. Put primary actions near the context where users need them; move a lower-page button upward only when it improves workflow and does not obscure content.
4. Fix excess blank scrolling at its actual source. Do not simply hide overflow or clip legitimate content.
5. Make all visible controls perform their advertised action or clearly indicate that the capability is unavailable.
6. Ensure progress indicators reflect real job state, not fabricated percentages.
7. Keep API diagnostics useful without exposing secrets or overwhelming ordinary users.
8. Provide clear errors, retry choices, disabled states, and unsaved-edit indicators.
9. Test desktop and narrower viewports using the project's available browser/test setup.
10. Check focus order, keyboard operation, and text labels for important controls.

## Tests
- Capture/inspect key workflow screens before and after where tooling allows.
- Verify all primary buttons and navigation actions.
- Check page end at multiple viewport heights and widths.
- Confirm no content is clipped and no large accidental blank region remains.
- Check editor, translation status, and export controls remain functional.
- Run lint/type/build and relevant UI tests.

## Guardrails
- Do not change the visual identity merely to make the UI look newer.
- Do not remove controls without checking their dependencies and purpose.
- Do not introduce a large UI framework solely for minor polish.

## Acceptance Criteria
The interface is clearer, duplicate/inert controls are resolved, scrolling fits actual content, and the original design remains recognizable.

## Final Response Required
Summarize UX issues fixed, changed files, viewport/workflow checks performed, and any remaining accessibility or layout limitations.
