import type { EqBand } from '../types'

export const CUT_STAGE_Q = Math.SQRT1_2

export type BandStageProfile = {
  stageCount: number
  stageGainDb?: number
  stageQ?: number
}

export function getBandStageProfile(band: EqBand): BandStageProfile {
  if (band.type === 'lowCut' || band.type === 'highCut') {
    return {
      stageCount: band.slopeDbPerOct / 12,
      stageQ: CUT_STAGE_Q,
    }
  }

  const stageCount = band.slopeDbPerOct / 6

  if (band.type === 'peaking') {
    return {
      stageCount,
      stageGainDb: band.gainDb / stageCount,
      stageQ: band.q * Math.sqrt(stageCount),
    }
  }

  if (band.type === 'lowShelf' || band.type === 'highShelf') {
    return {
      stageCount,
      stageGainDb: band.gainDb / stageCount,
    }
  }

  return {
    stageCount,
  }
}
