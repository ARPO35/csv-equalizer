export type CurvePoint = {
  frequencyHz: number
  gainDb: number
}

type BaseBand = {
  id: string
  frequencyHz: number
}

export type PeakingBand = BaseBand & {
  type: 'peaking'
  gainDb: number
  q: number
}

export type ShelfBand = BaseBand & {
  type: 'lowShelf' | 'highShelf'
  gainDb: number
}

export type CutBand = BaseBand & {
  type: 'lowCut' | 'highCut'
  slopeDbPerOct: 12 | 24 | 36 | 48
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
  curve: CurvePoint[]
  bands: EqBand[]
  selectedBandId?: string
  errorMessage?: string
}
