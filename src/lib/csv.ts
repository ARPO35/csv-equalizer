import type { CurvePoint } from '../types'
import { sortCurvePoints } from './curve'

function normalizeCell(cell: string) {
  return cell.trim().replace(/^\uFEFF/, '')
}

function isNumericCell(cell: string) {
  const value = Number(normalizeCell(cell))
  return Number.isFinite(value)
}

function detectDelimiter(line: string) {
  if (line.includes('\t')) {
    return '\t'
  }
  if (line.includes(',')) {
    return ','
  }
  if (line.includes(';')) {
    return ';'
  }
  return 'whitespace'
}

function splitLine(line: string, delimiter: string) {
  if (delimiter === 'whitespace') {
    return line.trim().split(/\s+/).map(normalizeCell)
  }
  return line.split(delimiter).map(normalizeCell)
}

function isFrequencyHeader(cell: string) {
  const normalized = normalizeCell(cell).toLowerCase()
  return ['frequency', 'freq', 'hz'].includes(normalized)
}

function isGainHeader(cell: string) {
  const normalized = normalizeCell(cell).toLowerCase()
  return ['gain', 'db', 'gain_db', 'gaindb'].includes(normalized)
}

export function parseCurveCsv(csvText: string): CurvePoint[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\uFEFF/, ''))
    .filter((line) => line.length > 0)

  if (lines.length === 0) {
    throw new Error('CSV must include at least one data row.')
  }

  const delimiter = detectDelimiter(lines[0])
  const firstCells = splitLine(lines[0], delimiter)
  if (firstCells.length !== 2) {
    throw new Error('CSV rows must contain exactly two columns.')
  }

  const hasHeader = !firstCells.every(isNumericCell)
  if (
    hasHeader &&
    (!isFrequencyHeader(firstCells[0]) || !isGainHeader(firstCells[1]))
  ) {
    throw new Error(
      'CSV must provide recognizable frequency and gain columns.',
    )
  }

  const dataLines = hasHeader ? lines.slice(1) : lines
  if (dataLines.length === 0) {
    throw new Error('CSV must include at least one data row.')
  }

  const curve = dataLines.map((line, index) => {
    const cells = splitLine(line, delimiter)
    if (cells.length !== 2) {
      throw new Error(
        `Row ${index + 1 + (hasHeader ? 2 : 1)} must contain exactly two columns.`,
      )
    }

    const frequencyHz = Number(cells[0])
    const gainDb = Number(cells[1])
    if (!Number.isFinite(frequencyHz) || !Number.isFinite(gainDb)) {
      throw new Error(
        `Row ${index + 1 + (hasHeader ? 2 : 1)} contains non-numeric values.`,
      )
    }

    return {
      frequencyHz,
      gainDb,
    }
  })

  const sortedCurve = sortCurvePoints(curve)

  for (let index = 1; index < sortedCurve.length; index += 1) {
    if (sortedCurve[index].frequencyHz === sortedCurve[index - 1].frequencyHz) {
      throw new Error('Frequency values must be unique.')
    }
  }

  return sortedCurve
}
