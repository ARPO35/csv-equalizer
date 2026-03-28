export function computeAutoPreGainDb(rawOutputPeakDb: number) {
  return -8 - Math.max(0, rawOutputPeakDb - 8)
}
