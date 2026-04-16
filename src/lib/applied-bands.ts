import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { BandUpdateMode, EqBand } from '../types'

export const BAND_SMOOTHING_DURATION_MS = 200

type BandAnimation = {
  frameId: number
  startTime: number
  startBands: EqBand[]
  targetBands: EqBand[]
}

function lerp(startValue: number, endValue: number, progress: number) {
  return startValue + (endValue - startValue) * progress
}

export function areBandsEqual(left: EqBand[], right: EqBand[]) {
  if (left.length !== right.length) {
    return false
  }

  return left.every((band, index) => {
    const otherBand = right[index]
    if (!otherBand) {
      return false
    }

    if (
      band.id !== otherBand.id ||
      band.type !== otherBand.type ||
      band.frequencyHz !== otherBand.frequencyHz ||
      band.isBypassed !== otherBand.isBypassed ||
      band.slopeDbPerOct !== otherBand.slopeDbPerOct
    ) {
      return false
    }

    if ('gainDb' in band !== 'gainDb' in otherBand) {
      return false
    }

    if ('gainDb' in band && 'gainDb' in otherBand && band.gainDb !== otherBand.gainDb) {
      return false
    }

    if ('q' in band !== 'q' in otherBand) {
      return false
    }

    if ('q' in band && 'q' in otherBand && band.q !== otherBand.q) {
      return false
    }

    return true
  })
}

export function haveCompatibleBandTopology(left: EqBand[], right: EqBand[]) {
  if (left.length !== right.length) {
    return false
  }

  return left.every((band, index) => {
    const otherBand = right[index]
    return Boolean(
      otherBand &&
        band.id === otherBand.id &&
        band.type === otherBand.type &&
        band.isBypassed === otherBand.isBypassed &&
        band.slopeDbPerOct === otherBand.slopeDbPerOct,
    )
  })
}

export function interpolateBands(
  startBands: EqBand[],
  targetBands: EqBand[],
  progress: number,
) {
  return startBands.map((band, index) => {
    const targetBand = targetBands[index]
    if (!targetBand) {
      return band
    }

    if (band.type === 'peaking' && targetBand.type === 'peaking') {
      return {
        ...band,
        frequencyHz: lerp(band.frequencyHz, targetBand.frequencyHz, progress),
        gainDb: lerp(band.gainDb, targetBand.gainDb, progress),
        q: lerp(band.q, targetBand.q, progress),
      }
    }

    if (
      (band.type === 'lowShelf' || band.type === 'highShelf') &&
      band.type === targetBand.type
    ) {
      return {
        ...band,
        frequencyHz: lerp(band.frequencyHz, targetBand.frequencyHz, progress),
        gainDb: lerp(band.gainDb, targetBand.gainDb, progress),
      }
    }

    if (
      (band.type === 'lowCut' || band.type === 'highCut') &&
      band.type === targetBand.type
    ) {
      return {
        ...band,
        frequencyHz: lerp(band.frequencyHz, targetBand.frequencyHz, progress),
      }
    }

    return targetBand
  })
}

export function useAppliedBands(targetBands: EqBand[]) {
  const [appliedBands, setAppliedBands] = useState(targetBands)
  const appliedBandsRef = useRef(targetBands)
  const nextChangeModeRef = useRef<BandUpdateMode>('immediate')
  const animationRef = useRef<BandAnimation | null>(null)
  const animationStepRef = useRef<(timestamp: number) => void>(() => undefined)

  const commitAppliedBands = useCallback((nextBands: EqBand[]) => {
    appliedBandsRef.current = nextBands
    setAppliedBands(nextBands)
  }, [])

  const stopAnimation = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current.frameId)
      animationRef.current = null
    }
  }, [])

  const flushAppliedBands = useCallback(() => {
    stopAnimation()
    commitAppliedBands(targetBands)
  }, [commitAppliedBands, stopAnimation, targetBands])

  const markNextBandChange = useCallback((mode: BandUpdateMode) => {
    nextChangeModeRef.current = mode
  }, [])

  animationStepRef.current = (timestamp: number) => {
    const animation = animationRef.current
    if (!animation) {
      return
    }

    const elapsedMs = Math.max(0, timestamp - animation.startTime)
    const progress = Math.min(1, elapsedMs / BAND_SMOOTHING_DURATION_MS)
    const nextBands = interpolateBands(
      animation.startBands,
      animation.targetBands,
      progress,
    )

    commitAppliedBands(nextBands)

    if (progress >= 1) {
      animationRef.current = null
      return
    }

    animationRef.current = {
      ...animation,
      frameId: requestAnimationFrame(animationStepRef.current),
    }
  }

  useEffect(() => {
    if (areBandsEqual(appliedBandsRef.current, targetBands)) {
      stopAnimation()
      commitAppliedBands(targetBands)
      return
    }

    const nextMode = nextChangeModeRef.current
    nextChangeModeRef.current = 'immediate'

    if (
      nextMode !== 'smooth' ||
      !haveCompatibleBandTopology(appliedBandsRef.current, targetBands)
    ) {
      stopAnimation()
      commitAppliedBands(targetBands)
      return
    }

    stopAnimation()
    const startTime = performance.now()
    animationRef.current = {
      frameId: requestAnimationFrame(animationStepRef.current),
      startTime,
      startBands: appliedBandsRef.current,
      targetBands,
    }
  }, [commitAppliedBands, stopAnimation, targetBands])

  useEffect(() => stopAnimation, [stopAnimation])

  return {
    appliedBands,
    flushAppliedBands,
    markNextBandChange,
  }
}
