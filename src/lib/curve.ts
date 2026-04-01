import type { CurvePoint } from '../types'

export const DEFAULT_GRID_SIZE = 512
export const MIN_FREQUENCY = 20
export const MAX_FREQUENCY = 20_000

export function createLogFrequencyGrid(size = DEFAULT_GRID_SIZE) {
  const minLog = Math.log10(MIN_FREQUENCY)
  const maxLog = Math.log10(MAX_FREQUENCY)
  return Array.from({ length: size }, (_, index) => {
    const ratio = index / (size - 1)
    return 10 ** (minLog + ratio * (maxLog - minLog))
  })
}

export function createFlatCurve(
  frequencies = createLogFrequencyGrid(),
  gainDb = 0,
): CurvePoint[] {
  return frequencies.map((frequencyHz) => ({
    frequencyHz,
    gainDb,
  }))
}

export function sortCurvePoints(points: CurvePoint[]) {
  return [...points].sort((left, right) => left.frequencyHz - right.frequencyHz)
}

export function sampleCurveGain(
  curve: CurvePoint[],
  frequencyHz: number,
): number {
  if (curve.length === 0) {
    return 0
  }

  if (frequencyHz <= curve[0].frequencyHz) {
    return curve[0].gainDb
  }

  if (frequencyHz >= curve[curve.length - 1].frequencyHz) {
    return curve[curve.length - 1].gainDb
  }

  for (let index = 0; index < curve.length - 1; index += 1) {
    const left = curve[index]
    const right = curve[index + 1]

    if (frequencyHz >= left.frequencyHz && frequencyHz <= right.frequencyHz) {
      const leftLog = Math.log10(left.frequencyHz)
      const rightLog = Math.log10(right.frequencyHz)
      const targetLog = Math.log10(frequencyHz)
      const ratio = (targetLog - leftLog) / (rightLog - leftLog)
      return left.gainDb + (right.gainDb - left.gainDb) * ratio
    }
  }

  return curve[curve.length - 1].gainDb
}

export function resampleCurve(
  curve: CurvePoint[],
  frequencies: number[],
): CurvePoint[] {
  const sortedCurve = sortCurvePoints(curve)

  return frequencies.map((frequencyHz) => ({
    frequencyHz,
    gainDb: sampleCurveGain(sortedCurve, frequencyHz),
  }))
}

export function sumCurves(baseCurve: CurvePoint[], overlayCurve: CurvePoint[]) {
  return baseCurve.map((point, index) => ({
    frequencyHz: point.frequencyHz,
    gainDb: point.gainDb + (overlayCurve[index]?.gainDb ?? 0),
  }))
}
