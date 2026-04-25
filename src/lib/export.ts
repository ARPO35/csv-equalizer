import { createLogFrequencyGrid, resampleCurve } from './curve'
import type { CurvePoint } from '../types'

export type ExportAlignment = 'current' | 'max-to-zero' | 'min-to-zero'

export type ExportSerializer = 'csv' | 'graphic-eq' | 'fixed-band-text'

export type ExportFrequencyMode = 'custom-log' | 'fixed'

export type ExportFormatConfig = {
  id: string
  label: string
  description: string
  extension: string
  mimeType: string
  serializer: ExportSerializer
  frequencyMode: ExportFrequencyMode
  defaultPointCount?: number
  fixedFrequencies?: number[]
  fixedLabels?: string[]
  gainDecimals?: number
  frequencyDecimals?: number
}

export type ExportCurveOptions = {
  sourceCurve: CurvePoint[]
  frequencies: number[]
  preGainDb: number
  alignment: ExportAlignment
  invert: boolean
}

const formatModules = import.meta.glob('../export-formats/*.json', {
  eager: true,
  import: 'default',
})

function formatDecimal(value: number, decimals: number) {
  return Number(value.toFixed(decimals)).toString()
}

function isExportFormatConfig(value: unknown): value is ExportFormatConfig {
  if (typeof value !== 'object' || !value) {
    return false
  }

  const candidate = value as Partial<ExportFormatConfig>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.description === 'string' &&
    typeof candidate.extension === 'string' &&
    typeof candidate.mimeType === 'string' &&
    (candidate.serializer === 'csv' ||
      candidate.serializer === 'graphic-eq' ||
      candidate.serializer === 'fixed-band-text') &&
    (candidate.frequencyMode === 'custom-log' ||
      candidate.frequencyMode === 'fixed')
  )
}

export function getExportFormats() {
  return Object.values(formatModules)
    .filter(isExportFormatConfig)
    .sort((left, right) => left.label.localeCompare(right.label))
}

export function getExportFrequencies(
  format: ExportFormatConfig,
  pointCount: number,
) {
  if (format.frequencyMode === 'fixed') {
    return format.fixedFrequencies ?? []
  }

  return createLogFrequencyGrid(Math.max(2, Math.round(pointCount)))
}

export function prepareExportCurve({
  sourceCurve,
  frequencies,
  preGainDb,
  alignment,
  invert,
}: ExportCurveOptions) {
  const resampledCurve = resampleCurve(sourceCurve, frequencies).map((point) => ({
    frequencyHz: point.frequencyHz,
    gainDb: point.gainDb + preGainDb,
  }))
  const transformedCurve = invert
    ? resampledCurve.map((point) => ({
        frequencyHz: point.frequencyHz,
        gainDb: -point.gainDb,
      }))
    : resampledCurve
  if (transformedCurve.length === 0) {
    return []
  }

  const gains = transformedCurve.map((point) => point.gainDb)
  const offsetDb =
    alignment === 'max-to-zero'
      ? -Math.max(...gains)
      : alignment === 'min-to-zero'
        ? -Math.min(...gains)
        : 0

  return transformedCurve.map((point) => ({
    frequencyHz: point.frequencyHz,
    gainDb: point.gainDb + offsetDb,
  }))
}

export function serializeExportCurve(
  format: ExportFormatConfig,
  points: CurvePoint[],
) {
  const gainDecimals = format.gainDecimals ?? 2
  const frequencyDecimals = format.frequencyDecimals ?? 2

  if (format.serializer === 'csv') {
    return [
      'frequency,gain',
      ...points.map(
        (point) =>
          `${formatDecimal(point.frequencyHz, frequencyDecimals)},${formatDecimal(point.gainDb, gainDecimals)}`,
      ),
    ].join('\n')
  }

  if (format.serializer === 'graphic-eq') {
    const entries = points.map(
      (point) =>
        `${formatDecimal(point.frequencyHz, frequencyDecimals)} ${formatDecimal(point.gainDb, gainDecimals)}`,
    )
    return `GraphicEQ: ${entries.join('; ')}`
  }

  return points
    .map((point, index) => {
      const label =
        format.fixedLabels?.[index] ??
        `${formatDecimal(point.frequencyHz, frequencyDecimals)} Hz`
      return `${label}: ${formatDecimal(point.gainDb, gainDecimals)} dB`
    })
    .join('\n')
}
