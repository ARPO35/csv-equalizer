import type { EqBand, EqBandType } from '../types'

type DefaultBandOptions = {
  frequencyHz?: number
  gainDb?: number
  q?: number
  id?: string
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

  switch (type) {
    case 'peaking':
      return {
        id,
        type,
        frequencyHz,
        gainDb: options.gainDb ?? 0,
        q: options.q ?? 1,
      }
    case 'lowShelf':
    case 'highShelf':
      return {
        id,
        type,
        frequencyHz,
        gainDb: options.gainDb ?? 0,
      }
    case 'lowCut':
    case 'highCut':
      return {
        id,
        type,
        frequencyHz,
        slopeDbPerOct: 24,
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
    gainDb: 'gainDb' in band ? band.gainDb : 0,
    q: band.type === 'peaking' ? band.q : 1,
  })
}
