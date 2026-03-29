import type { CutSlopeDbPerOct, EqBand, EqBandType, MusicalSlopeDbPerOct } from '../types'

type DefaultBandOptions = {
  frequencyHz?: number
  gainDb?: number
  q?: number
  slopeDbPerOct?: number
  id?: string
  isBypassed?: boolean
}

const MUSICAL_SLOPE_VALUES: MusicalSlopeDbPerOct[] = [6, 12, 18, 24, 30, 36, 42, 48]
const CUT_SLOPE_VALUES: CutSlopeDbPerOct[] = [12, 24, 36, 48]

function isMusicalSlope(value: number): value is MusicalSlopeDbPerOct {
  return MUSICAL_SLOPE_VALUES.includes(value as MusicalSlopeDbPerOct)
}

function isCutSlope(value: number): value is CutSlopeDbPerOct {
  return CUT_SLOPE_VALUES.includes(value as CutSlopeDbPerOct)
}

function resolveSlopeForType(
  type: 'lowCut' | 'highCut',
  source?: number,
): CutSlopeDbPerOct
function resolveSlopeForType(
  type: 'peaking' | 'lowShelf' | 'highShelf',
  source?: number,
): MusicalSlopeDbPerOct
function resolveSlopeForType(type: EqBandType, source?: number) {
  if (type === 'lowCut' || type === 'highCut') {
    if (source !== undefined && isCutSlope(source)) {
      return source
    }
    return 24 as CutSlopeDbPerOct
  }

  if (source !== undefined && isMusicalSlope(source)) {
    return source
  }
  return 12 as MusicalSlopeDbPerOct
}

function createBandId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `band-${Date.now()}-${Math.round(Math.random() * 1e6)}`
}

export function createDefaultBand(
  type: EqBandType,
  options: DefaultBandOptions = {},
): EqBand {
  const frequencyHz = options.frequencyHz ?? 1_000
  const id = options.id ?? createBandId()
  const isBypassed = options.isBypassed ?? false

  switch (type) {
    case 'peaking':
      return {
        id,
        type,
        frequencyHz,
        isBypassed,
        gainDb: options.gainDb ?? 0,
        q: options.q ?? 1,
        slopeDbPerOct: resolveSlopeForType(type, options.slopeDbPerOct),
      }
    case 'lowShelf':
    case 'highShelf':
      return {
        id,
        type,
        frequencyHz,
        isBypassed,
        gainDb: options.gainDb ?? 0,
        slopeDbPerOct: resolveSlopeForType(type, options.slopeDbPerOct),
      }
    case 'lowCut':
    case 'highCut':
      return {
        id,
        type,
        frequencyHz,
        isBypassed,
        slopeDbPerOct: resolveSlopeForType(type, options.slopeDbPerOct),
      }
  }
}

export function sortBandsByFrequency(bands: EqBand[]) {
  return [...bands].sort((left, right) => left.frequencyHz - right.frequencyHz)
}

export function describeBand(band: EqBand) {
  switch (band.type) {
    case 'peaking':
      return 'Bell'
    case 'lowShelf':
      return 'Low shelf'
    case 'highShelf':
      return 'High shelf'
    case 'lowCut':
      return 'Low cut'
    case 'highCut':
      return 'High cut'
  }
}

export function convertBandType(band: EqBand, nextType: EqBandType): EqBand {
  if (band.type === nextType) {
    return band
  }

  return createDefaultBand(nextType, {
    id: band.id,
    frequencyHz: band.frequencyHz,
    isBypassed: band.isBypassed,
    gainDb: 'gainDb' in band ? band.gainDb : 0,
    q: band.type === 'peaking' ? band.q : 1,
    slopeDbPerOct: band.slopeDbPerOct,
  })
}
