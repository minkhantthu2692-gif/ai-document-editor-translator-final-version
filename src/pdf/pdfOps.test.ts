import { describe, expect, it } from 'vitest'
import { OPS as realOps } from 'pdfjs-dist'
import {
  OPS,
  addFont,
  assignColors,
  classifyFontName,
  countImages,
  emptyFontStats,
  normalizeColor,
  traceTextRuns,
  type OpList,
} from './pdfOps'

function opList(entries: Array<[number, unknown[]]>): OpList {
  return {
    fnArray: entries.map(([fn]) => fn),
    argsArray: entries.map(([, args]) => args),
  }
}

describe('OPS mirror', () => {
  it('stays in sync with pdfjs-dist', () => {
    expect({ ...OPS }).toEqual({ ...realOps })
  })
})

describe('normalizeColor', () => {
  it('keeps hex strings from pdf.js', () => {
    expect(normalizeColor(['#FF00AA'])).toBe('#ff00aa')
    expect(normalizeColor(['#f0a'])).toBe('#ff00aa')
  })

  it('reads the normalised 0xRRGGBB number', () => {
    expect(normalizeColor([0x3366cc])).toBe('#3366cc')
  })

  it('reads raw RGB triples with either scale', () => {
    expect(normalizeColor([255, 0, 0])).toBe('#ff0000')
    expect(normalizeColor([0, 1, 0])).toBe('#00ff00')
  })

  it('reads a fractional grey level', () => {
    expect(normalizeColor([0.5])).toBe('#808080')
    expect(normalizeColor([1])).toBe('#ffffff')
    expect(normalizeColor([0])).toBe('#000000')
  })

  it('converts CMYK', () => {
    // magenta + yellow = red, no cyan, no key
    expect(normalizeColor([0, 1, 1, 0])).toBe('#ff0000')
    // full cyan
    expect(normalizeColor([1, 0, 0, 0])).toBe('#00ffff')
    expect(normalizeColor([0, 0, 0, 0])).toBe('#ffffff')
  })

  it('returns null for unusable input', () => {
    expect(normalizeColor(undefined)).toBeNull()
    expect(normalizeColor([])).toBeNull()
    expect(normalizeColor(['rgb(1,2,3)'])).toBeNull()
    expect(normalizeColor(['#zzzzzz'])).toBeNull()
  })
})

describe('traceTextRuns', () => {
  it('records position and colour for every text-showing operator', () => {
    const ops = opList([
      [OPS.beginText, []],
      [OPS.setFillRGBColor, ['#ff0000']],
      [OPS.moveText, [10, 700]],
      [OPS.showText, [1]],
      [OPS.setLeadingMoveText, [0, -14]],
      [OPS.showText, [1]],
      [OPS.setFillGray, [0.5]],
      [OPS.setTextMatrix, [11, 0, 0, 11, 40, 600]],
      [OPS.nextLineShowText, [1]],
      [OPS.endText, []],
    ])

    expect(traceTextRuns(ops)).toEqual([
      { color: '#ff0000', x: 10, y: 700 },
      { color: '#ff0000', x: 10, y: 686 },
      { color: '#808080', x: 40, y: 600 },
    ])
  })

  it('resets the position at every BT', () => {
    const ops = opList([
      [OPS.beginText, []],
      [OPS.moveText, [72, 770]],
      [OPS.showText, [1]],
      [OPS.endText, []],
      [OPS.beginText, []],
      [OPS.moveText, [72, 740]],
      [OPS.showText, [1]],
    ])
    expect(traceTextRuns(ops).map((run) => [run.x, run.y])).toEqual([
      [72, 770],
      [72, 740],
    ])
  })

  // Regression: the exporter collapsed every run near the origin because it
  // ignored `cm` (`OPS.transform`) and `q`/`Q`. Real PDFs wrap each run in
  // `q … cm … q … rg … BT … Tj … ET … Q … Q`, so without CTM tracking every
  // run landed at (0,0) and `assignColors` painted the whole page one colour.
  it('applies the `cm` transform so translated runs report page-space position', () => {
    const ops = opList([
      [OPS.save, []],
      [OPS.transform, [1, 0, 0, 1, 62.69291, 749.1969]], // cm
      [OPS.setFillRGBColor, [0.121569, 0.227451, 0.372549]], // rg
      [OPS.beginText, []],
      [OPS.setTextMatrix, [12, 0, 0, 12, 10, 20]], // Tm
      [OPS.showText, [1]], // Tj
      [OPS.endText, []],
      [OPS.restore, []], // Q
    ])
    const [run] = traceTextRuns(ops)
    expect(run.color).toBe('#1f3a5f')
    expect(run.x).toBeCloseTo(72.69291, 5)
    expect(run.y).toBeCloseTo(769.1969, 5)
  })

  it('restores fill colour at Q so a colour set inside q…Q does not leak', () => {
    const ops = opList([
      [OPS.beginText, []],
      [OPS.setFillRGBColor, [1, 0, 0]], // red outside any scope
      [OPS.moveText, [10, 700]],
      [OPS.showText, [1]],
      [OPS.save, []], // q
      [OPS.setFillRGBColor, [0, 0, 1]], // blue inside q…Q
      [OPS.setLeadingMoveText, [0, -14]],
      [OPS.showText, [1]],
      [OPS.restore, []], // Q → back to red
      [OPS.setLeadingMoveText, [0, -14]],
      [OPS.showText, [1]],
      [OPS.endText, []],
    ])
    expect(traceTextRuns(ops).map((run) => run.color)).toEqual([
      '#ff0000',
      '#0000ff',
      '#ff0000',
    ])
  })

  it('composes a form-XObject matrix and restores it at the end', () => {
    const ops = opList([
      [OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 100, 50]]], // form Matrix
      [OPS.beginText, []],
      [OPS.setTextMatrix, [10, 0, 0, 10, 5, 5]],
      [OPS.setFillRGBColor, [0, 0.5, 0]],
      [OPS.showText, [1]],
      [OPS.endText, []],
      [OPS.paintFormXObjectEnd, []],
    ])
    const [run] = traceTextRuns(ops)
    expect(run.color).toBe('#008000')
    expect(run.x).toBeCloseTo(105, 5)
    expect(run.y).toBeCloseTo(55, 5)
  })

  it('ignores an unparsable transform matrix', () => {
    const ops = opList([
      [OPS.transform, [1, 0]], // malformed — not 6 numbers
      [OPS.beginText, []],
      [OPS.moveText, [10, 700]],
      [OPS.showText, [1]],
    ])
    expect(traceTextRuns(ops)[0]).toEqual({ color: null, x: 10, y: 700 })
  })

  // pdf.js hands `Tm` (and form matrices) as a Float32Array nested in the args
  // array, not a plain number[]. The exporter used to destructure those as
  // `args[1..5]` → undefined → every run collapsed to the origin and the whole
  // page took the first run's colour. This is the exact shape real PDFs emit.
  it('reads a Float32Array text matrix and transform (pdf.js real arg shape)', () => {
    const t = (a: number, b: number, c: number, d: number, e: number, f: number) =>
      [new Float32Array([a, b, c, d, e, f])] as unknown as unknown[]
    const ops = opList([
      [OPS.save, []],
      [OPS.transform, t(1, 0, 0, 1, 62.69291, 722.1969)],
      [OPS.setFillRGBColor, ['#2b2b2b']],
      [OPS.beginText, []],
      [OPS.setTextMatrix, t(1, 0, 0, 1, 0, 19)],
      [OPS.showText, [1]],
      [OPS.endText, []],
      [OPS.restore, []],
    ])
    const [run] = traceTextRuns(ops)
    expect(run.color).toBe('#2b2b2b')
    expect(run.x).toBeCloseTo(62.69291, 4)
    expect(run.y).toBeCloseTo(741.1969, 4)
  })

  it('composes a Float32Array form-XObject matrix', () => {
    const ops = opList([
      [OPS.paintFormXObjectBegin, [new Float32Array([1, 0, 0, 1, 100, 50]), null]],
      [OPS.beginText, []],
      [OPS.setTextMatrix, [new Float32Array([10, 0, 0, 10, 5, 5])] as unknown as unknown[]],
      [OPS.showText, [1]],
      [OPS.endText, []],
      [OPS.paintFormXObjectEnd, []],
    ])
    const [run] = traceTextRuns(ops)
    expect(run.x).toBeCloseTo(105, 4)
    expect(run.y).toBeCloseTo(55, 4)
  })
})

describe('countImages', () => {
  it('counts painted images but not text-render masks', () => {
    const ops = opList([
      [OPS.showText, [1]],
      [OPS.paintImageXObject, []],
      [OPS.paintSolidColorImageMask, []],
      [OPS.paintInlineImageXObjectGroup, []],
    ])
    expect(countImages(ops)).toBe(2)
    expect(countImages(opList([]))).toBe(0)
  })
})

describe('assignColors', () => {
  it('gives every item the colour of its nearest run', () => {
    const ops = opList([
      [OPS.beginText, []],
      [OPS.setFillRGBColor, ['#ff0000']],
      [OPS.moveText, [10, 700]],
      [OPS.showText, [1]],
      [OPS.setFillRGBColor, ['#0000ff']],
      [OPS.setLeadingMoveText, [0, -14]],
      [OPS.showText, [1]],
      [OPS.endText, []],
    ])
    const items = [{ transform: [11, 0, 0, 11, 10, 700] }, { transform: [11, 0, 0, 11, 10, 686] }]
    expect(assignColors(ops, items)).toEqual(['#ff0000', '#0000ff'])
  })

  it('keeps split items on the colour of the run that produced them', () => {
    const ops = opList([
      [OPS.beginText, []],
      [OPS.setFillRGBColor, ['#ff0000']],
      [OPS.moveText, [10, 700]],
      [OPS.showText, [1]],
      [OPS.setFillRGBColor, ['#0000ff']],
      [OPS.setLeadingMoveText, [0, -14]],
      [OPS.showText, [1]],
      [OPS.endText, []],
    ])
    // pdf.js split the first run into two items (whitespace normalisation).
    const items = [
      { transform: [11, 0, 0, 11, 10, 700] },
      { transform: [11, 0, 0, 11, 60, 700] },
      { transform: [11, 0, 0, 11, 10, 686] },
    ]
    expect(assignColors(ops, items)).toEqual(['#ff0000', '#ff0000', '#0000ff'])
  })

  it('returns nulls when the page paints no text', () => {
    expect(assignColors(opList([[OPS.paintImageXObject, []]]), [{ transform: [1, 0] }])).toEqual([
      null,
    ])
  })
})

describe('classifyFontName', () => {
  it('recognises the base-14 fonts as not embedded', () => {
    expect(classifyFontName('Helvetica')).toBe('standard')
    expect(classifyFontName('/Times-BoldItalic')).toBe('standard')
    expect(classifyFontName('CourierNewPSMT')).toBe('standard')
  })

  it('treats subset prefixes as embedded', () => {
    expect(classifyFontName('ABCDEF+ArialMT')).toBe('embedded')
    expect(classifyFontName('ABCDEF+Helvetica')).toBe('embedded')
  })

  it('treats Type3 fonts as embedded (their glyphs live in the file)', () => {
    expect(classifyFontName('Whatever', { isType3: true })).toBe('embedded')
  })

  it('uses the missing-file flag as a non-embedded fallback', () => {
    expect(classifyFontName('MyCustomFont', { missingFile: true })).toBe('standard')
    expect(classifyFontName('MyCustomFont')).toBe('other')
    expect(classifyFontName(undefined)).toBe('other')
  })
})

describe('addFont', () => {
  it('folds classifications into totals, once per font id', () => {
    let stats = emptyFontStats()
    const seen = new Set<string>()
    stats = addFont(stats, seen, 'f1', 'embedded')
    stats = addFont(stats, seen, 'f2', 'standard')
    stats = addFont(stats, seen, 'f1', 'embedded')
    expect(stats).toEqual({ distinct: 2, embedded: 1, standard: 1, other: 0 })
  })
})
