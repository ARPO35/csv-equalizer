import type { CurvePoint } from '../types'

function normalizeCell(cell: string) {
  return cell.trim().replace(/^\uFEFF/, '')
}

export function parseCurveCsv(csvText: string): CurvePoint[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length < 2) {
    throw new Error('CSV must include a header row and at least one data row.')
  }

  const header = lines[0].split(',').map(normalizeCell)
  if (header.length !== 2 || header[0] !== 'frequency' || header[1] !== 'gain') {
    throw new Error('CSV header must be exactly: frequency,gain')
  }

  const curve = lines.slice(1).map((line, index) => {
    const cells = line.split(',').map(normalizeCell)
    if (cells.length !== 2) {
      throw new Error(`Row ${index + 2} must contain exactly two columns.`)
    }

    const frequencyHz = Number(cells[0])
    const gainDb = Number(cells[1])
    if (!Number.isFinite(frequencyHz) || !Number.isFinite(gainDb)) {
      throw new Error(`Row ${index + 2} contains non-numeric values.`)
    }

    return {
      frequencyHz,
      gainDb,
    }
  })

  for (let index = 1; index < curve.length; index += 1) {
    if (curve[index].frequencyHz <= curve[index - 1].frequencyHz) {
      throw new Error('Frequency values must be strictly increasing.')
    }
  }

  return curve
}
