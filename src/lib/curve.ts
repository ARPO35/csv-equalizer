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

export function sumCurves(baseCurve: CurvePoint[], overlayCurve: CurvePoint[]) {
  return baseCurve.map((point, index) => ({
    frequencyHz: point.frequencyHz,
    gainDb: point.gainDb + (overlayCurve[index]?.gainDb ?? 0),
  }))
}
