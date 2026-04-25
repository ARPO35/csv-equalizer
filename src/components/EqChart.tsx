import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { convertBandType, createDefaultBand, describeBand } from '../lib/bands'
import type { FftOverlayStore } from '../lib/audio-monitor'
import type {
  BandUpdateMode,
  CurvePoint,
  EqBand,
  EqBandType,
} from '../types'

const BASE_CHART_WIDTH = 1200
const BASE_CHART_HEIGHT = 700
const PADDING_RATIO = {
  top: 36 / BASE_CHART_HEIGHT,
  right: 36 / BASE_CHART_WIDTH,
  bottom: 48 / BASE_CHART_HEIGHT,
  left: 56 / BASE_CHART_WIDTH,
}
const MIN_FREQUENCY = 20
const MAX_FREQUENCY = 20_000
const GRID_FREQUENCIES = [20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000]
const MIN_Q = 0.1
const MAX_Q = 12
const WHEEL_Q_STEP = 0.05
const MUSICAL_SLOPE_VALUES = [6, 12, 18, 24, 30, 36, 42, 48] as const
const CUT_SLOPE_VALUES = [12, 24, 36, 48] as const
const FFT_FADE_FLOOR_DB = 0.75
const FFT_FADE_CEIL_DB = 6
const FFT_DISPLAY_REFERENCE_FREQUENCY = 1_000
const FFT_DISPLAY_SLOPE_COMPENSATION_DB_PER_OCT = 3
const FFT_DISPLAY_GAMMA = 0.35
const FFT_FILL_STYLE = 'rgba(255, 255, 255, 0.12)'
const FFT_PRE_LINE_WIDTH = 1.9
const FFT_POST_LINE_WIDTH = 2.1
const FALLBACK_FFT_PRE_COLOR = '#9bc6ff'
const FALLBACK_FFT_POST_COLOR = '#ffca62'

type EditableField = 'frequencyHz' | 'gainDb' | 'q' | 'slopeDbPerOct'
type FftRenderBuffers = {
  width: number
  height: number
  x: Float32Array
  preY: Float32Array
  postY: Float32Array
}
type ChartLayout = {
  width: number
  height: number
  padding: {
    top: number
    right: number
    bottom: number
    left: number
  }
  plotRect: {
    top: number
    right: number
    bottom: number
    left: number
    width: number
    height: number
  }
}
type ChartFrameRect = {
  top: number
  left: number
  width: number
  height: number
}

function clampValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function formatFrequencyLabel(value: number) {
  return value >= 1_000 ? `${value / 1_000}k` : `${value}`
}

function formatFrequencyValue(value: number) {
  return `${Math.round(value)} Hz`
}

function formatGainValue(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`
}

function formatQValue(value: number) {
  return value.toFixed(2)
}

function createChartLayout(width: number, height: number): ChartLayout {
  const normalizedWidth = Math.max(1, width)
  const normalizedHeight = Math.max(1, height)
  const padding = {
    top: normalizedHeight * PADDING_RATIO.top,
    right: normalizedWidth * PADDING_RATIO.right,
    bottom: normalizedHeight * PADDING_RATIO.bottom,
    left: normalizedWidth * PADDING_RATIO.left,
  }
  const plotRect = {
    top: padding.top,
    right: normalizedWidth - padding.right,
    bottom: normalizedHeight - padding.bottom,
    left: padding.left,
    width: Math.max(1, normalizedWidth - padding.left - padding.right),
    height: Math.max(1, normalizedHeight - padding.top - padding.bottom),
  }

  return {
    width: normalizedWidth,
    height: normalizedHeight,
    padding,
    plotRect,
  }
}

const DEFAULT_CHART_LAYOUT = createChartLayout(BASE_CHART_WIDTH, BASE_CHART_HEIGHT)

function layoutEquals(a: ChartLayout, b: ChartLayout) {
  return a.width === b.width && a.height === b.height
}

function frameRectEquals(a: ChartFrameRect | null, b: ChartFrameRect | null) {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return false
  }

  return (
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height
  )
}

function createPath(
  points: CurvePoint[],
  minDb: number,
  maxDb: number,
  layout: ChartLayout,
) {
  if (points.length === 0) {
    return ''
  }

  return points
    .map((point, index) => {
      const command = index === 0 ? 'M' : 'L'
      return `${command}${getX(point.frequencyHz, layout)},${getY(
        point.gainDb,
        minDb,
        maxDb,
        layout,
      )}`
    })
    .join(' ')
}

function getX(frequencyHz: number, layout: ChartLayout) {
  const minLog = Math.log10(MIN_FREQUENCY)
  const maxLog = Math.log10(MAX_FREQUENCY)
  const value = Math.log10(Math.min(MAX_FREQUENCY, Math.max(MIN_FREQUENCY, frequencyHz)))

  return layout.plotRect.left + ((value - minLog) / (maxLog - minLog)) * layout.plotRect.width
}

function getY(gainDb: number, minDb: number, maxDb: number, layout: ChartLayout) {
  return layout.plotRect.top + ((maxDb - gainDb) / (maxDb - minDb)) * layout.plotRect.height
}

export function getSpectrumDisplayLevelDb(
  levelDb: number,
  frequencyHz: number,
  visualGainDb = 0,
) {
  return (
    levelDb +
    Math.log2(
      clampValue(frequencyHz, MIN_FREQUENCY, MAX_FREQUENCY) /
        FFT_DISPLAY_REFERENCE_FREQUENCY,
    ) *
      FFT_DISPLAY_SLOPE_COMPENSATION_DB_PER_OCT +
    visualGainDb
  )
}

export function getSpectrumY(
  levelDb: number,
  frequencyHz: number,
  visualGainDb = 0,
  layout: ChartLayout = DEFAULT_CHART_LAYOUT,
) {
  const compensatedLevelDb = getSpectrumDisplayLevelDb(
    levelDb,
    frequencyHz,
    visualGainDb,
  )
  const magnitude = clampValue(10 ** (compensatedLevelDb / 20), 0, 1)
  const shapedMagnitude = magnitude ** FFT_DISPLAY_GAMMA

  return layout.plotRect.top + (1 - shapedMagnitude) * layout.plotRect.height
}

function ensureFftRenderBuffers(
  buffers: FftRenderBuffers | null,
  length: number,
  width: number,
  height: number,
) {
  if (
    !buffers ||
    buffers.x.length !== length ||
    buffers.width !== width ||
    buffers.height !== height
  ) {
    return {
      width,
      height,
      x: new Float32Array(length),
      preY: new Float32Array(length),
      postY: new Float32Array(length),
    } satisfies FftRenderBuffers
  }

  return buffers
}

function getCssVarColor(
  element: HTMLElement,
  variableName: string,
  fallback: string,
) {
  const value = getComputedStyle(element).getPropertyValue(variableName).trim()
  return value || fallback
}

function FftCanvasOverlay({
  fftStore,
  visualGainDb,
  hasFftFrame,
  layout,
}: {
  fftStore: FftOverlayStore
  visualGainDb: number
  hasFftFrame: boolean
  layout: ChartLayout
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const renderBuffersRef = useRef<FftRenderBuffers | null>(null)
  const pendingDrawRef = useRef<number | null>(null)
  const lastVersionRef = useRef<number>(-1)
  const lastVisualGainRef = useRef<number>(visualGainDb)

  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const context = canvas.getContext('2d')
    if (!context) {
      return
    }

    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width === 0 || height === 0) {
      return
    }

    const snapshot = fftStore.getSnapshot()
    const visualGainChanged = lastVisualGainRef.current !== visualGainDb
    if (
      !visualGainChanged &&
      lastVersionRef.current === snapshot.version &&
      hasFftFrame
    ) {
      return
    }

    lastVersionRef.current = snapshot.version
    lastVisualGainRef.current = visualGainDb
    context.clearRect(0, 0, width, height)

    if (!hasFftFrame || !snapshot.hasData) {
      return
    }

    const pointCount = snapshot.frequencies.length
    if (pointCount === 0) {
      return
    }

    renderBuffersRef.current = ensureFftRenderBuffers(
      renderBuffersRef.current,
      pointCount,
      width,
      height,
    )
    const { x, preY, postY } = renderBuffersRef.current
    const bottomY = layout.plotRect.bottom
    const preColor = getCssVarColor(
      canvas,
      '--curve-fft-pre',
      FALLBACK_FFT_PRE_COLOR,
    )
    const postColor = getCssVarColor(
      canvas,
      '--curve-fft-post',
      FALLBACK_FFT_POST_COLOR,
    )

    for (let index = 0; index < pointCount; index += 1) {
      const frequencyHz = snapshot.frequencies[index]
      x[index] = getX(frequencyHz, layout)
      preY[index] = getSpectrumY(
        snapshot.preLevels[index],
        frequencyHz,
        visualGainDb,
        layout,
      )
      postY[index] = getSpectrumY(
        snapshot.postLevels[index],
        frequencyHz,
        visualGainDb,
        layout,
      )
    }

    context.globalAlpha = 1
    context.beginPath()
    context.moveTo(x[0], preY[0])
    for (let index = 1; index < pointCount; index += 1) {
      context.lineTo(x[index], preY[index])
    }
    context.lineTo(x[pointCount - 1], bottomY)
    context.lineTo(x[0], bottomY)
    context.closePath()
    context.fillStyle = FFT_FILL_STYLE
    context.fill()

    context.beginPath()
    context.moveTo(x[0], preY[0])
    for (let index = 1; index < pointCount; index += 1) {
      context.lineTo(x[index], preY[index])
    }
    context.strokeStyle = preColor
    context.lineWidth = FFT_PRE_LINE_WIDTH
    context.lineCap = 'round'
    context.stroke()

    context.strokeStyle = postColor
    context.lineWidth = FFT_POST_LINE_WIDTH
    context.lineCap = 'round'
    for (let index = 0; index < pointCount - 1; index += 1) {
      const averageDiff =
        (Math.abs(snapshot.postLevels[index] - snapshot.preLevels[index]) +
          Math.abs(snapshot.postLevels[index + 1] - snapshot.preLevels[index + 1])) /
        2
      const opacity = getFadeOpacity(averageDiff)

      if (opacity <= 0) {
        continue
      }

      context.globalAlpha = opacity
      context.beginPath()
      context.moveTo(x[index], postY[index])
      context.lineTo(x[index + 1], postY[index + 1])
      context.stroke()
    }
    context.globalAlpha = 1
  }, [fftStore, hasFftFrame, layout, visualGainDb])

  const scheduleDraw = useCallback(() => {
    if (pendingDrawRef.current !== null) {
      return
    }

    pendingDrawRef.current = window.requestAnimationFrame(() => {
      pendingDrawRef.current = null
      drawOverlay()
    })
  }, [drawOverlay])

  const syncCanvasSize = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const dpr = window.devicePixelRatio || 1
    const displayWidth = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const displayHeight = Math.max(1, Math.round(canvas.clientHeight * dpr))

    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
      canvas.width = displayWidth
      canvas.height = displayHeight
      const context = canvas.getContext('2d')
      if (context) {
        context.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      lastVersionRef.current = -1
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const unsub = fftStore.subscribe(scheduleDraw)
    const handleResize = () => {
      syncCanvasSize()
      scheduleDraw()
    }

    syncCanvasSize()
    scheduleDraw()

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(handleResize)
      observer.observe(canvas)
      return () => {
        unsub()
        observer.disconnect()
        if (pendingDrawRef.current !== null) {
          cancelAnimationFrame(pendingDrawRef.current)
          pendingDrawRef.current = null
        }
      }
    }

    window.addEventListener('resize', handleResize)
    return () => {
      unsub()
      window.removeEventListener('resize', handleResize)
      if (pendingDrawRef.current !== null) {
        cancelAnimationFrame(pendingDrawRef.current)
        pendingDrawRef.current = null
      }
    }
  }, [fftStore, scheduleDraw, syncCanvasSize])

  useEffect(() => {
    scheduleDraw()
  }, [hasFftFrame, scheduleDraw, visualGainDb])

  return (
    <canvas
      ref={canvasRef}
      className="chart-fft-canvas"
      aria-hidden="true"
      data-testid="fft-canvas"
    />
  )
}

function createYAxisTicks(minDb: number, maxDb: number) {
  const range = maxDb - minDb
  const step = range <= 24 ? 3 : 6
  const start = Math.ceil(minDb / step) * step
  const end = Math.floor(maxDb / step) * step
  const ticks: number[] = []

  for (let value = start; value <= end; value += step) {
    ticks.push(value)
  }

  return ticks
}

function clampFrequency(value: number) {
  return Math.min(MAX_FREQUENCY, Math.max(MIN_FREQUENCY, value))
}

function clampGain(value: number) {
  return Math.max(-24, Math.min(24, value))
}

function clampQ(value: number) {
  return Math.max(MIN_Q, Math.min(MAX_Q, value))
}

function roundQ(value: number) {
  return Number(value.toFixed(2))
}

function getNearestStep<T extends number>(value: number, steps: readonly T[]): T {
  const nearest = steps.reduce((best, current) =>
    Math.abs(current - value) < Math.abs(best - value) ? current : best,
  )
  return nearest
}

function getNextSlope<T extends number>(
  current: T,
  direction: number,
  values: readonly T[],
) {
  const currentIndex = values.indexOf(current)
  if (currentIndex < 0) {
    return current
  }

  const nextIndex = Math.min(
    values.length - 1,
    Math.max(0, currentIndex + direction),
  )
  return values[nextIndex]
}

function updateBandField(
  band: EqBand,
  field: EditableField,
  rawValue: string,
): EqBand | null {
  const numericValue = Number(rawValue)
  if (Number.isNaN(numericValue)) {
    return null
  }

  if (field === 'frequencyHz') {
    return {
      ...band,
      frequencyHz: clampFrequency(numericValue),
    }
  }

  if (field === 'gainDb' && 'gainDb' in band) {
    return {
      ...band,
      gainDb: clampGain(numericValue),
    }
  }

  if (field === 'q' && band.type === 'peaking') {
    return {
      ...band,
      q: clampQ(numericValue),
    }
  }

  if (field === 'slopeDbPerOct') {
    if (band.type === 'lowCut' || band.type === 'highCut') {
      return {
        ...band,
        slopeDbPerOct: getNearestStep(numericValue, CUT_SLOPE_VALUES),
      }
    }

    if (
      band.type === 'peaking' ||
      band.type === 'lowShelf' ||
      band.type === 'highShelf'
    ) {
      return {
        ...band,
        slopeDbPerOct: getNearestStep(numericValue, MUSICAL_SLOPE_VALUES),
      }
    }
  }

  return null
}

function getFadeOpacity(diffDb: number) {
  if (diffDb <= FFT_FADE_FLOOR_DB) {
    return 0
  }

  if (diffDb >= FFT_FADE_CEIL_DB) {
    return 1
  }

  return (diffDb - FFT_FADE_FLOOR_DB) / (FFT_FADE_CEIL_DB - FFT_FADE_FLOOR_DB)
}

function commitBand(
  onBandCommit: (band: EqBand, mode: BandUpdateMode) => void,
  band: EqBand,
  mode: BandUpdateMode,
) {
  onBandCommit(band, mode)
}

export function EqChart({
  baselineCurve,
  bandCurve,
  outputCurve,
  fftStore,
  hasFftFrame = false,
  visualGainDb,
  bands,
  selectedBandId,
  viewMinDb,
  viewMaxDb,
  onBandCommit,
  onBandCreate,
  onBandDelete,
  onBandToggleBypass,
  onBandSelect,
  onIncreaseViewMax,
  onDecreaseViewMax,
  onIncreaseViewMin,
  onDecreaseViewMin,
}: {
  baselineCurve: CurvePoint[]
  bandCurve: CurvePoint[]
  outputCurve: CurvePoint[]
  fftStore?: FftOverlayStore | null
  hasFftFrame?: boolean
  visualGainDb: number
  bands: EqBand[]
  selectedBandId?: string
  viewMinDb: number
  viewMaxDb: number
  onBandCommit: (band: EqBand, mode: BandUpdateMode) => void
  onBandCreate: (band: EqBand) => void
  onBandDelete: (bandId: string) => void
  onBandToggleBypass: (bandId: string) => void
  onBandSelect: (bandId?: string) => void
  onIncreaseViewMax: () => void
  onDecreaseViewMax: () => void
  onIncreaseViewMin: () => void
  onDecreaseViewMin: () => void
}) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const hoverCloseTimerRef = useRef<number | null>(null)
  const dragCommitFrameRef = useRef<number | null>(null)
  const pendingDragBandRef = useRef<EqBand | null>(null)
  const draggingBandRef = useRef<EqBand | null>(null)
  const didDragPointChangeRef = useRef(false)
  const onBandCommitRef = useRef(onBandCommit)
  const [draggingBandId, setDraggingBandId] = useState<string | null>(null)
  const [hoveredBandId, setHoveredBandId] = useState<string | null>(null)
  const [pinnedBandId, setPinnedBandId] = useState<string | null>(null)
  const [editingField, setEditingField] = useState<EditableField | null>(null)
  const [editingDraft, setEditingDraft] = useState('')
  const [layout, setLayout] = useState<ChartLayout>(DEFAULT_CHART_LAYOUT)
  const [frameRect, setFrameRect] = useState<ChartFrameRect | null>(null)

  const yTicks = useMemo(
    () => createYAxisTicks(viewMinDb, viewMaxDb),
    [viewMaxDb, viewMinDb],
  )
  const popupBandId = draggingBandId ?? hoveredBandId ?? pinnedBandId
  const popupBand = useMemo(
    () => bands.find((band) => band.id === popupBandId),
    [bands, popupBandId],
  )
  const draggingBand = useMemo(
    () => bands.find((band) => band.id === draggingBandId),
    [bands, draggingBandId],
  )

  useEffect(() => {
    onBandCommitRef.current = onBandCommit
  }, [onBandCommit])

  useEffect(() => {
    draggingBandRef.current = draggingBand ?? null
  }, [draggingBand])

  useEffect(() => () => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current)
    }
    if (dragCommitFrameRef.current !== null) {
      cancelAnimationFrame(dragCommitFrameRef.current)
    }
  }, [])

  useEffect(() => {
    const frame = frameRef.current
    const svg = svgRef.current
    if (!frame && !svg) {
      return
    }

    const updateLayout = () => {
      const frameBounds = frameRef.current?.getBoundingClientRect() ?? null
      const svgBounds = svgRef.current?.getBoundingClientRect() ?? null
      const sourceBounds =
        frameBounds && frameBounds.width > 0 && frameBounds.height > 0
          ? frameBounds
          : svgBounds
      const width = sourceBounds?.width ?? DEFAULT_CHART_LAYOUT.width
      const height = sourceBounds?.height ?? DEFAULT_CHART_LAYOUT.height
      const nextLayout = createChartLayout(width, height)
      const nextFrameRect = sourceBounds
        ? {
            top: sourceBounds.top,
            left: sourceBounds.left,
            width: sourceBounds.width,
            height: sourceBounds.height,
          }
        : null

      setLayout((current) =>
        layoutEquals(current, nextLayout) ? current : nextLayout,
      )
      setFrameRect((current) =>
        frameRectEquals(current, nextFrameRect) ? current : nextFrameRect,
      )
    }

    updateLayout()

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateLayout)
      if (frame) {
        observer.observe(frame)
      }
      if (svg) {
        observer.observe(svg)
      }
      return () => {
        observer.disconnect()
      }
    }

    window.addEventListener('resize', updateLayout)
    return () => {
      window.removeEventListener('resize', updateLayout)
    }
  }, [])

  function clearHoverTimer() {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current)
      hoverCloseTimerRef.current = null
    }
  }

  function scheduleHoverClose(bandId: string) {
    if (bandId === pinnedBandId) {
      return
    }

    clearHoverTimer()
    hoverCloseTimerRef.current = window.setTimeout(() => {
      setHoveredBandId((current) => (current === bandId ? null : current))
    }, 120)
  }

  function getSvgPoint(clientX: number, clientY: number) {
    const svg = svgRef.current
    if (!svg) {
      return null
    }

    const rect = svg.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      return null
    }

    return {
      x: ((clientX - rect.left) / rect.width) * layout.width,
      y: ((clientY - rect.top) / rect.height) * layout.height,
    }
  }

  function getFrequencyFromX(x: number) {
    const clampedX = Math.min(layout.plotRect.right, Math.max(layout.plotRect.left, x))
    const minLog = Math.log10(MIN_FREQUENCY)
    const maxLog = Math.log10(MAX_FREQUENCY)
    const ratio = (clampedX - layout.plotRect.left) / layout.plotRect.width
    return 10 ** (minLog + ratio * (maxLog - minLog))
  }

  function getGainFromY(y: number) {
    const clampedY = Math.min(layout.plotRect.bottom, Math.max(layout.plotRect.top, y))
    const ratio = (clampedY - layout.plotRect.top) / layout.plotRect.height
    return viewMaxDb - ratio * (viewMaxDb - viewMinDb)
  }

  function hasBandPointValueChanged(leftBand: EqBand, rightBand: EqBand) {
    if (leftBand.frequencyHz !== rightBand.frequencyHz) {
      return true
    }

    if ('gainDb' in leftBand && 'gainDb' in rightBand) {
      return leftBand.gainDb !== rightBand.gainDb
    }

    return false
  }

  function handlePointerMove(
    event: PointerEvent<SVGCircleElement>,
    band: EqBand,
    shouldTrackDragChange = true,
  ) {
    if (draggingBandId !== band.id) {
      return
    }

    const point = getSvgPoint(event.clientX, event.clientY)
    if (!point) {
      return
    }

    const nextBand =
      'gainDb' in band
        ? {
            ...band,
            frequencyHz: clampFrequency(getFrequencyFromX(point.x)),
            gainDb: clampGain(getGainFromY(point.y)),
          }
        : {
            ...band,
            frequencyHz: clampFrequency(getFrequencyFromX(point.x)),
          }

    if (!hasBandPointValueChanged(nextBand, band)) {
      return
    }

    if (shouldTrackDragChange) {
      didDragPointChangeRef.current = true
    }

    pendingDragBandRef.current = nextBand
    if (dragCommitFrameRef.current !== null) {
      return
    }

    dragCommitFrameRef.current = requestAnimationFrame(() => {
      dragCommitFrameRef.current = null
      const pendingBand = pendingDragBandRef.current
      if (!pendingBand) {
        return
      }
      pendingDragBandRef.current = null
      commitBand(onBandCommitRef.current, pendingBand, 'smooth')
    })
  }

  function flushPendingDragCommit(mode: BandUpdateMode) {
    if (dragCommitFrameRef.current !== null) {
      cancelAnimationFrame(dragCommitFrameRef.current)
      dragCommitFrameRef.current = null
    }

    const pendingBand = pendingDragBandRef.current
    pendingDragBandRef.current = null
    if (!pendingBand) {
      return null
    }

    commitBand(onBandCommitRef.current, pendingBand, mode)
    return pendingBand
  }

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) {
      return
    }

    const handleWheel = (event: globalThis.WheelEvent) => {
      const activeBand = draggingBandRef.current
      if (!activeBand || event.deltaY === 0) {
        return
      }

      event.preventDefault()
      const direction = event.deltaY < 0 ? 1 : -1

      if (activeBand.type === 'peaking') {
        commitBand(
          onBandCommitRef.current,
          {
            ...activeBand,
            q: roundQ(clampQ(activeBand.q + direction * WHEEL_Q_STEP)),
          },
          'immediate',
        )
        return
      }

      if (activeBand.type === 'lowCut' || activeBand.type === 'highCut') {
        const nextSlope = getNextSlope(
          activeBand.slopeDbPerOct,
          direction,
          CUT_SLOPE_VALUES,
        )

        if (nextSlope === activeBand.slopeDbPerOct) {
          return
        }

        commitBand(
          onBandCommitRef.current,
          {
            ...activeBand,
            slopeDbPerOct: nextSlope,
          },
          'immediate',
        )
        return
      }

      if (activeBand.type !== 'lowShelf' && activeBand.type !== 'highShelf') {
        return
      }

      const nextSlope = getNextSlope(
        activeBand.slopeDbPerOct,
        direction,
        MUSICAL_SLOPE_VALUES,
      )

      if (nextSlope === activeBand.slopeDbPerOct) {
        return
      }

      commitBand(
        onBandCommitRef.current,
        {
          ...activeBand,
          slopeDbPerOct: nextSlope,
        },
        'immediate',
      )
    }

    frame.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      frame.removeEventListener('wheel', handleWheel)
    }
  }, [])

  function startEditing(field: EditableField, value: string) {
    setEditingField(field)
    setEditingDraft(value)
  }

  function stopEditing() {
    setEditingField(null)
    setEditingDraft('')
  }

  function commitEditing() {
    if (!popupBand || !editingField) {
      stopEditing()
      return
    }

    const nextBand = updateBandField(popupBand, editingField, editingDraft)
    if (nextBand) {
      commitBand(onBandCommit, nextBand, 'immediate')
    }
    stopEditing()
  }

  function handleChartDoubleClick(event: MouseEvent<SVGSVGElement>) {
    const target = event.target
    if (
      target instanceof Element &&
      target instanceof SVGElement &&
      target.tagName.toLowerCase() === 'circle'
    ) {
      return
    }

    const point = getSvgPoint(event.clientX, event.clientY)
    if (!point) {
      return
    }

    const band = createDefaultBand('peaking', {
      frequencyHz: clampFrequency(getFrequencyFromX(point.x)),
      gainDb: clampGain(getGainFromY(point.y)),
      q: 1,
    })
    onBandCreate(band)
    onBandSelect(band.id)
    setPinnedBandId(band.id)
    setHoveredBandId(band.id)
  }

  function handleChartClick(event: MouseEvent<SVGSVGElement>) {
    const target = event.target
    if (
      target instanceof Element &&
      target instanceof SVGElement &&
      target.tagName.toLowerCase() === 'circle'
    ) {
      return
    }

    setPinnedBandId(null)
    setHoveredBandId(null)
    onBandSelect(undefined)
  }

  const popupStyle = popupBand
    ? {
        left: `${(frameRect?.left ?? 0) + getX(popupBand.frequencyHz, layout)}px`,
        top: `${(frameRect?.top ?? 0) + getY('gainDb' in popupBand ? popupBand.gainDb : 0, viewMinDb, viewMaxDb, layout)}px`,
      }
    : undefined

  const popupAlign = popupBand && getX(popupBand.frequencyHz, layout) > layout.width * 0.68
    ? 'is-left'
    : 'is-right'

  return (
    <div ref={frameRef} className="chart-frame">
      <div className="chart-bound-controls chart-bound-controls-top">
        <button type="button" className="axis-button" onClick={onIncreaseViewMax}>
          +
        </button>
        <button type="button" className="axis-button" onClick={onDecreaseViewMax}>
          -
        </button>
      </div>

      <div className="chart-bound-controls chart-bound-controls-bottom">
        <button type="button" className="axis-button" onClick={onDecreaseViewMin}>
          -
        </button>
        <button type="button" className="axis-button" onClick={onIncreaseViewMin}>
          +
        </button>
      </div>

      <svg
        ref={svgRef}
        className="chart-svg"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label="EQ editing surface"
        onClick={handleChartClick}
        onDoubleClick={handleChartDoubleClick}
      >
        <rect
          x={layout.plotRect.left}
          y={layout.plotRect.top}
          width={layout.plotRect.width}
          height={layout.plotRect.height}
          className="chart-area"
        />

        {GRID_FREQUENCIES.map((frequency) => {
          const x = getX(frequency, layout)
          return (
            <g key={frequency}>
              <line
                className="grid-line"
                x1={x}
                x2={x}
                y1={layout.plotRect.top}
                y2={layout.plotRect.bottom}
              />
              <text
                className="axis-label"
                x={x}
                y={layout.height - layout.padding.bottom * 0.375}
                textAnchor="middle"
              >
                {formatFrequencyLabel(frequency)}
              </text>
            </g>
          )
        })}

        {yTicks.map((value) => {
          const y = getY(value, viewMinDb, viewMaxDb, layout)
          return (
            <g key={value}>
              <line
                className={value === 0 ? 'grid-line zero-line' : 'grid-line'}
                x1={layout.plotRect.left}
                x2={layout.plotRect.right}
                y1={y}
                y2={y}
              />
              <text className="axis-label" x={layout.plotRect.left - 14} y={y + 5} textAnchor="end">
                {value}
              </text>
            </g>
          )
        })}

        <path className="curve curve-source" d={createPath(baselineCurve, viewMinDb, viewMaxDb, layout)} />
        <path className="curve curve-eq" d={createPath(bandCurve, viewMinDb, viewMaxDb, layout)} />
        <path className="curve curve-preview" d={createPath(outputCurve, viewMinDb, viewMaxDb, layout)} />

        {bands.map((band) => (
          <g key={band.id}>
            <circle
              aria-label={`${describeBand(band)} band`}
              className={`band-node ${band.id === selectedBandId ? 'is-selected' : ''} ${band.isBypassed ? 'is-bypassed' : ''}`}
              cx={getX(band.frequencyHz, layout)}
              cy={getY('gainDb' in band ? band.gainDb : 0, viewMinDb, viewMaxDb, layout)}
              r={band.id === selectedBandId ? 8 : 6}
              onMouseEnter={() => {
                clearHoverTimer()
                setHoveredBandId(band.id)
              }}
              onMouseLeave={() => scheduleHoverClose(band.id)}
              onClick={(event) => {
                event.stopPropagation()
                setPinnedBandId(band.id)
                setHoveredBandId(band.id)
                onBandSelect(band.id)
              }}
              onDoubleClick={(event) => {
                event.stopPropagation()
                onBandDelete(band.id)
              }}
              onPointerDown={(event) => {
                event.stopPropagation()
                onBandSelect(band.id)
                setPinnedBandId(null)
                clearHoverTimer()
                setHoveredBandId(band.id)
                setDraggingBandId(band.id)
                didDragPointChangeRef.current = false
                if ('setPointerCapture' in event.currentTarget) {
                  event.currentTarget.setPointerCapture(event.pointerId)
                }
                handlePointerMove(event, band, false)
              }}
              onPointerMove={(event) => handlePointerMove(event, band)}
              onPointerUp={(event) => {
                setDraggingBandId(null)
                const releaseMode: BandUpdateMode = didDragPointChangeRef.current
                  ? 'smooth'
                  : 'immediate'
                const committedBand = flushPendingDragCommit(releaseMode)
                if (!committedBand && draggingBandRef.current) {
                  commitBand(onBandCommitRef.current, draggingBandRef.current, releaseMode)
                }
                didDragPointChangeRef.current = false
                if (
                  'hasPointerCapture' in event.currentTarget &&
                  event.currentTarget.hasPointerCapture(event.pointerId)
                ) {
                  event.currentTarget.releasePointerCapture(event.pointerId)
                }
              }}
              onPointerCancel={() => {
                flushPendingDragCommit('immediate')
                setDraggingBandId(null)
                didDragPointChangeRef.current = false
              }}
            />
          </g>
        ))}
      </svg>
      {fftStore ? (
        <FftCanvasOverlay
          fftStore={fftStore}
          visualGainDb={visualGainDb}
          hasFftFrame={hasFftFrame}
          layout={layout}
        />
      ) : null}

      {popupBand && typeof document !== 'undefined'
        ? createPortal(
            <div
              className={`band-popover ${popupAlign} ${popupBand.isBypassed ? 'is-bypassed' : ''}`}
              style={popupStyle}
              onMouseEnter={() => {
                clearHoverTimer()
                setHoveredBandId(popupBand.id)
              }}
              onMouseLeave={() => {
                if (popupBand.id !== pinnedBandId) {
                  setHoveredBandId(null)
                }
              }}
            >
              <div className="band-popover-header">
                <div>
                  <p className="section-label">Selected node</p>
                  <strong>{describeBand(popupBand)}</strong>
                </div>
                <button
                  type="button"
                  className="band-popover-close"
                  aria-label="Delete band"
                  onClick={() => onBandDelete(popupBand.id)}
                >
                  x
                </button>
              </div>

              <div className="popover-row">
                <span>Band bypass</span>
                <button
                  type="button"
                  className={`chip-button ${popupBand.isBypassed ? 'is-active' : ''}`}
                  aria-pressed={popupBand.isBypassed}
                  onClick={() => onBandToggleBypass(popupBand.id)}
                >
                  {popupBand.isBypassed ? 'Bypassed' : 'Active'}
                </button>
              </div>

              <label className="popover-row">
                <span>Type</span>
                <select
                  value={popupBand.type}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    commitBand(
                      onBandCommit,
                      convertBandType(popupBand, event.target.value as EqBandType),
                      'immediate',
                    )
                  }
                >
                  <option value="peaking">Bell</option>
                  <option value="lowShelf">Low shelf</option>
                  <option value="highShelf">High shelf</option>
                  <option value="lowCut">Low cut</option>
                  <option value="highCut">High cut</option>
                </select>
              </label>

              <div className="popover-row">
                <span>Frequency</span>
                {editingField === 'frequencyHz' ? (
                  <input
                    aria-label="Frequency"
                    className="popover-input"
                    type="number"
                    autoFocus
                    value={editingDraft}
                    onChange={(event) => setEditingDraft(event.target.value)}
                    onBlur={commitEditing}
                    onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                      if (event.key === 'Enter') {
                        commitEditing()
                      }
                      if (event.key === 'Escape') {
                        stopEditing()
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="popover-value"
                    aria-label="Edit frequency"
                    onDoubleClick={() =>
                      startEditing('frequencyHz', popupBand.frequencyHz.toFixed(0))
                    }
                  >
                    {formatFrequencyValue(popupBand.frequencyHz)}
                  </button>
                )}
              </div>

              {'gainDb' in popupBand ? (
                <div className="popover-row">
                  <span>Gain</span>
                  {editingField === 'gainDb' ? (
                    <input
                      aria-label="Gain"
                      className="popover-input"
                      type="number"
                      autoFocus
                      step={0.1}
                      value={editingDraft}
                      onChange={(event) => setEditingDraft(event.target.value)}
                      onBlur={commitEditing}
                      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                        if (event.key === 'Enter') {
                          commitEditing()
                        }
                        if (event.key === 'Escape') {
                          stopEditing()
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="popover-value"
                      aria-label="Edit gain"
                      onDoubleClick={() => startEditing('gainDb', popupBand.gainDb.toFixed(1))}
                    >
                      {formatGainValue(popupBand.gainDb)}
                    </button>
                  )}
                </div>
              ) : null}

              {popupBand.type === 'peaking' ? (
                <div className="popover-row">
                  <span>Q</span>
                  {editingField === 'q' ? (
                    <input
                      aria-label="Q"
                      className="popover-input"
                      type="number"
                      autoFocus
                      step={0.05}
                      value={editingDraft}
                      onChange={(event) => setEditingDraft(event.target.value)}
                      onBlur={commitEditing}
                      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                        if (event.key === 'Enter') {
                          commitEditing()
                        }
                        if (event.key === 'Escape') {
                          stopEditing()
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="popover-value"
                      aria-label="Edit q"
                      onDoubleClick={() => startEditing('q', popupBand.q.toFixed(2))}
                    >
                      {formatQValue(popupBand.q)}
                    </button>
                  )}
                </div>
              ) : null}

              <div className="popover-row">
                <span>Slope</span>
                {editingField === 'slopeDbPerOct' ? (
                  <input
                    aria-label="Slope"
                    className="popover-input"
                    type="number"
                    autoFocus
                    step={
                      popupBand.type === 'lowCut' || popupBand.type === 'highCut'
                        ? 12
                        : 6
                    }
                    value={editingDraft}
                    onChange={(event) => setEditingDraft(event.target.value)}
                    onBlur={commitEditing}
                    onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                      if (event.key === 'Enter') {
                        commitEditing()
                      }
                      if (event.key === 'Escape') {
                        stopEditing()
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="popover-value"
                    aria-label="Edit slope"
                    onDoubleClick={() =>
                      startEditing('slopeDbPerOct', popupBand.slopeDbPerOct.toString())
                    }
                  >
                    {popupBand.slopeDbPerOct} dB/oct
                  </button>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

