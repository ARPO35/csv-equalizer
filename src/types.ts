export type CurvePoint = {
  frequencyHz: number
  gainDb: number
}

export type SpectrumPoint = {
  frequencyHz: number
  levelDb: number
}

export type FftOverlay = {
  preSpectrum: SpectrumPoint[]
  postSpectrum: SpectrumPoint[]
}

export type MusicalSlopeDbPerOct = 6 | 12 | 18 | 24 | 30 | 36 | 42 | 48
export type CutSlopeDbPerOct = 12 | 24 | 36 | 48

type BaseBand = {
  id: string
  frequencyHz: number
  isBypassed: boolean
}

export type PeakingBand = BaseBand & {
  type: 'peaking'
  gainDb: number
  q: number
  slopeDbPerOct: MusicalSlopeDbPerOct
}

export type ShelfBand = BaseBand & {
  type: 'lowShelf' | 'highShelf'
  gainDb: number
  slopeDbPerOct: MusicalSlopeDbPerOct
}

export type CutBand = BaseBand & {
  type: 'lowCut' | 'highCut'
  slopeDbPerOct: CutSlopeDbPerOct
}

export type EqBand = PeakingBand | ShelfBand | CutBand

export type EqBandType = EqBand['type']

export type ProjectPresetV1 = {
  version: 1
  sourceFileName?: string
  bands: EqBand[]
}

export type EqEditorState = {
  sourceFileName?: string
  baselineCurve: CurvePoint[]
  bands: EqBand[]
  selectedBandId?: string
  monitorBypassed: boolean
  monitorBaselineEnabled: boolean
  viewMaxDb: number
  viewMinDb: number
  preGainMode: 'auto' | 'manual'
  manualPreGainDb: number
  audioFileName?: string
  errorMessage?: string
}
