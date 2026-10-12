# Phase 03 — Readable PDF Reconstruction & Export Quality

Read `AGENTS.md`, `AUDIT_REPORT.md`, and `IMPLEMENTATION_PLAN.md` first. Also inspect the current post-Phase-02 document data model.

## Goal
Produce a valid, readable translated PDF. Do not force the output to retain the original page count when translated text no longer fits.

## Diagnose
Determine how the current project handles:
- Born-digital PDFs versus scanned/image-only PDFs.
- Text extraction/OCR, reading order, block coordinates, columns, tables, images, headers/footers, and page geometry.
- Original text removal/replacement versus overlay rendering.
- Font selection/embedding, Myanmar Unicode shaping, glyph coverage, line wrapping, and text measurement.
- Page breaks, overflow, and export validation.

Identify why current output duplicates, overlaps, clips, or mixes text. Avoid treating every PDF as a simple sequence of text boxes.

## Implementation Requirements
1. Keep a stable mapping between source blocks, translated text, page/block IDs, and reading order.
2. Ensure original text is not accidentally left visible underneath a translated overlay. Choose a safe replacement/reconstruction strategy supported by the current library.
3. Measure translated text using the actual selected font/rendering metrics where possible.
4. Implement line wrapping and fit calculations that account for longer translations, especially English-to-Burmese.
5. Adjust text box dimensions, spacing, and font size within readable bounds. Never shrink text indefinitely to force a fit.
6. If a block cannot fit, continue it on the next page or create additional pages. Preserve the logical order of text and avoid splitting in unsuitable places when possible.
7. Preserve original images, diagrams, tables, and page size/layout where practical; use a readable reflow layout when exact reconstruction is unreliable.
8. Support Myanmar Unicode correctly with an appropriate font/shaping path and embedding where licensing and library support allow. Verify actual rendered glyphs rather than assuming the font setting is enough.
9. Keep PDF text searchable/selectable where practical, with correct Unicode mapping where supported.
10. Validate the output file structure and report partial support for unsupported or image-only content.

## Test Fixtures and Validation
Use available project fixtures; if none exist, create small synthetic test PDFs without private content:
- Short English paragraph translated into longer Burmese.
- Long paragraphs and headings.
- Lists and tables.
- Two-column pages.
- Image-heavy pages.
- Scanned/OCR-like page if OCR is supported.
- Content that requires at least one additional page.
- Myanmar Unicode with representative stacked characters/diacritics.

For each test:
- Export the PDF and ensure it opens.
- Render pages to images using available tools and inspect visually.
- Check for unintended duplicate/overlapping/clipped text and missing glyphs.
- Check page count may increase when required.
- Verify content order and text extraction/searchability where supported.

Automated geometry/overlap checks may be approximate; combine them with visual inspection. Do not claim visual validation if pages were not rendered and inspected.

## Guardrails
- Do not promise pixel-perfect preservation for every PDF type.
- Do not overlay translations over original text without a reliable removal/reconstruction method.
- Do not silently omit overflow text.
- Do not change the overall application UI in this phase except what is necessary to expose export errors or warnings.

## Acceptance Criteria
- Exported PDFs are valid and readable in the tested cases.
- Longer translated text wraps/reflows or continues onto additional pages.
- No unintended duplicate text or major overlaps in tested outputs.
- Myanmar rendering is verified on actual output pages.
- Limitations for complex/scanned PDFs are documented.

## Final Response Required
Explain the selected export strategy, changed files, test PDFs/cases, rendered-page validation performed, results, and known limitations. Then recommend proceeding to Phase 04.
