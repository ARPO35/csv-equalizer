import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  areBandsEqual,
  BAND_SMOOTHING_DURATION_MS,
  useAppliedBands,
} from './applied-bands'
import type { EqBand, PeakingBand, ShelfBand } from '../types'

const baseBand: PeakingBand = {
  id: 'band-1',
  type: 'peaking',
  frequencyHz: 1000,
  isBypassed: false,
  gainDb: 0,
  q: 1,
  slopeDbPerOct: 12,
}

function getAppliedPeakingGain(bands: ReturnType<typeof useAppliedBands>['appliedBands']) {
  return (bands[0] as PeakingBand).gainDb
}

describe('useAppliedBands', () => {
  let frameTime = 0
  let nextFrameHandle = 1
  let queuedFrames = new Map<number, FrameRequestCallback>()
  let rafBaseTime = 0

  function advanceFrames(durationMs: number) {
    const frameCount = Math.ceil(durationMs / 16)

    for (let index = 0; index < frameCount; index += 1) {
      const currentFrames = [...queuedFrames.entries()]
      queuedFrames = new Map()
      frameTime += 16
      currentFrames.forEach(([, callback]) => callback(rafBaseTime + frameTime))
    }
  }

  beforeEach(() => {
    frameTime = 0
    nextFrameHandle = 1
    queuedFrames = new Map()
    rafBaseTime = performance.now()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const handle = nextFrameHandle
      nextFrameHandle += 1
      queuedFrames.set(handle, callback)
      return handle
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => {
      queuedFrames.delete(handle)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('smoothly chases the latest target during drag updates', () => {
    const { result, rerender } = renderHook(
      ({ bands }) => useAppliedBands(bands),
      {
        initialProps: {
          bands: [baseBand] as EqBand[],
        },
      },
    )

    act(() => {
      result.current.markNextBandChange('smooth')
      rerender({
        bands: [{ ...baseBand, gainDb: 6 }] as EqBand[],
      })
    })
    act(() => {})

    expect(getAppliedPeakingGain(result.current.appliedBands)).toBe(0)

    act(() => {
      advanceFrames(BAND_SMOOTHING_DURATION_MS / 2)
    })

    expect(getAppliedPeakingGain(result.current.appliedBands)).toBeGreaterThan(0)
    expect(getAppliedPeakingGain(result.current.appliedBands)).toBeLessThan(6)

    act(() => {
      advanceFrames(BAND_SMOOTHING_DURATION_MS)
    })

    expect(getAppliedPeakingGain(result.current.appliedBands)).toBeCloseTo(6, 3)
  })

  it('restarts smoothing from the current applied snapshot on retarget', () => {
    const { result, rerender } = renderHook(
      ({ bands }) => useAppliedBands(bands),
      {
        initialProps: {
          bands: [baseBand] as EqBand[],
        },
      },
    )

    act(() => {
      result.current.markNextBandChange('smooth')
      rerender({
        bands: [{ ...baseBand, gainDb: 6 }] as EqBand[],
      })
    })
    act(() => {})
    act(() => {
      advanceFrames(96)
    })

    const midGain = getAppliedPeakingGain(result.current.appliedBands)
    expect(midGain).toBeGreaterThan(0)
    expect(midGain).toBeLessThan(6)

    act(() => {
      result.current.markNextBandChange('smooth')
      rerender({
        bands: [{ ...baseBand, gainDb: 12 }] as EqBand[],
      })
    })
    act(() => {})
    act(() => {
      advanceFrames(96)
    })

    expect(getAppliedPeakingGain(result.current.appliedBands)).toBeGreaterThan(midGain)
    expect(getAppliedPeakingGain(result.current.appliedBands)).toBeLessThan(12)
  })

  it('snaps immediately when topology changes', () => {
    const { result, rerender } = renderHook(
      ({ bands }) => useAppliedBands(bands),
      {
        initialProps: {
          bands: [baseBand] as EqBand[],
        },
      },
    )

    const lowShelfBand: ShelfBand = {
      id: 'band-1',
      type: 'lowShelf',
      frequencyHz: 1000,
      isBypassed: false,
      gainDb: 6,
      slopeDbPerOct: 12,
    }

    act(() => {
      result.current.markNextBandChange('smooth')
      rerender({
        bands: [lowShelfBand] as EqBand[],
      })
    })

    expect(
      areBandsEqual(result.current.appliedBands, [lowShelfBand]),
    ).toBe(true)
  })

  it('flushes the current drag target immediately when requested', () => {
    const { result, rerender } = renderHook(
      ({ bands }) => useAppliedBands(bands),
      {
        initialProps: {
          bands: [baseBand] as EqBand[],
        },
      },
    )

    act(() => {
      result.current.markNextBandChange('smooth')
      rerender({
        bands: [{ ...baseBand, gainDb: 6 }] as EqBand[],
      })
    })
    act(() => {})
    act(() => {
      advanceFrames(64)
    })

    expect(getAppliedPeakingGain(result.current.appliedBands)).toBeGreaterThan(0)
    expect(getAppliedPeakingGain(result.current.appliedBands)).toBeLessThan(6)

    act(() => {
      result.current.flushAppliedBands()
    })

    expect(getAppliedPeakingGain(result.current.appliedBands)).toBe(6)
  })
})
