import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { convertBandType, createDefaultBand, describeBand } from '../lib/bands'
import type {
  CurvePoint,
  EqBand,
  EqBandType,
  FftOverlay,
  SpectrumPoint,
} from '../types'

const VIEWBOX_WIDTH = 1200
const VIEWBOX_HEIGHT = 700
const PADDING = {
  top: 36,
  right: 36,
  bottom: 48,
  left: 56,
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
const SPECTRUM_SMOOTHING_SAMPLES_PER_SEGMENT = 2

type EditableField = 'frequencyHz' | 'gainDb' | 'q' | 'slopeDbPerOct'

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

function createPath(points: CurvePoint[], minDb: number, maxDb: number) {
  if (points.length === 0) {
    return ''
  }

  return points
    .map((point, index) => {
      const command = index === 0 ? 'M' : 'L'
      return `${command}${getX(point.frequencyHz)},${getY(point.gainDb, minDb, maxDb)}`
    })
    .join(' ')
}

function interpolateCatmullRom(
  previousValue: number,
  startValue: number,
  endValue: number,
  nextValue: number,
  t: number,
) {
  const tSquared = t * t
  const tCubed = tSquared * t

  return (
    0.5 *
    ((2 * startValue) +
      (-previousValue + endValue) * t +
      (2 * previousValue - 5 * startValue + 4 * endValue - nextValue) *
        tSquared +
      (-previousValue + 3 * startValue - 3 * endValue + nextValue) * tCubed)
  )
}

function createSmoothedSpectrumPoints(points: SpectrumPoint[]) {
  if (points.length <= 1) {
    return points
  }

  const smoothedPoints: SpectrumPoint[] = [points[0]]

  for (let index = 0; index < points.length - 1; index += 1) {
    const previousPoint = points[Math.max(0, index - 1)]
    const startPoint = points[index]
    const endPoint = points[index + 1]
    const nextPoint = points[Math.min(points.length - 1, index + 2)]

    for (
      let step = 1;
      step <= SPECTRUM_SMOOTHING_SAMPLES_PER_SEGMENT;
      step += 1
    ) {
      const t = step / SPECTRUM_SMOOTHING_SAMPLES_PER_SEGMENT
      smoothedPoints.push({
        frequencyHz: clampValue(
          interpolateCatmullRom(
            previousPoint.frequencyHz,
            startPoint.frequencyHz,
            endPoint.frequencyHz,
            nextPoint.frequencyHz,
            t,
          ),
          startPoint.frequencyHz,
          endPoint.frequencyHz,
        ),
        levelDb: interpolateCatmullRom(
          previousPoint.levelDb,
          startPoint.levelDb,
          endPoint.levelDb,
          nextPoint.levelDb,
          t,
        ),
      })
    }
  }

  return smoothedPoints
}

function createSpectrumLinePath(points: SpectrumPoint[], visualGainDb: number) {
  if (points.length === 0) {
    return ''
  }

  return points
    .map((point, index) => {
      const command = index === 0 ? 'M' : 'L'
      return `${command}${getX(point.frequencyHz)},${getSpectrumY(point.levelDb, point.frequencyHz, visualGainDb)}`
    })
    .join(' ')
}

function createSpectrumFillPath(points: SpectrumPoint[], visualGainDb: number) {
  if (points.length === 0) {
    return ''
  }

  const bottomY = VIEWBOX_HEIGHT - PADDING.bottom
  const linePath = createSpectrumLinePath(points, visualGainDb)
  const lastPoint = points[points.length - 1]
  const firstPoint = points[0]

  return `${linePath} L${getX(lastPoint.frequencyHz)},${bottomY} L${getX(firstPoint.frequencyHz)},${bottomY} Z`
}

function getX(frequencyHz: number) {
  const chartWidth = VIEWBOX_WIDTH - PADDING.left - PADDING.right
  const minLog = Math.log10(MIN_FREQUENCY)
  const maxLog = Math.log10(MAX_FREQUENCY)
  const value = Math.log10(Math.min(MAX_FREQUENCY, Math.max(MIN_FREQUENCY, frequencyHz)))

  return PADDING.left + ((value - minLog) / (maxLog - minLog)) * chartWidth
}

function getY(gainDb: number, minDb: number, maxDb: number) {
  const chartHeight = VIEWBOX_HEIGHT - PADDING.top - PADDING.bottom
  return PADDING.top + ((maxDb - gainDb) / (maxDb - minDb)) * chartHeight
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
) {
  const chartHeight = VIEWBOX_HEIGHT - PADDING.top - PADDING.bottom
  const compensatedLevelDb = getSpectrumDisplayLevelDb(
    levelDb,
    frequencyHz,
    visualGainDb,
  )
  const magnitude = clampValue(10 ** (compensatedLevelDb / 20), 0, 1)
  const shapedMagnitude = magnitude ** FFT_DISPLAY_GAMMA

  return PADDING.top + (1 - shapedMagnitude) * chartHeight
}

function createSpectrumSegments(
  preSpectrum: SpectrumPoint[],
  postSpectrum: SpectrumPoint[],
  visualGainDb: number,
) {
  const segmentCount = Math.min(preSpectrum.length, postSpectrum.length)

  return Array.from({ length: Math.max(0, segmentCount - 1) }, (_, index) => {
    const leftPre = preSpectrum[index]
    const rightPre = preSpectrum[index + 1]
    const leftPost = postSpectrum[index]
    const rightPost = postSpectrum[index + 1]
    const averageDiff =
      (Math.abs(leftPost.levelDb - leftPre.levelDb) +
        Math.abs(rightPost.levelDb - rightPre.levelDb)) /
      2
    const opacity = getFadeOpacity(averageDiff)

    if (opacity <= 0) {
      return null
    }

    return {
      id: `${leftPost.frequencyHz}-${rightPost.frequencyHz}`,
      x1: getX(leftPost.frequencyHz),
      y1: getSpectrumY(leftPost.levelDb, leftPost.frequencyHz, visualGainDb),
      x2: getX(rightPost.frequencyHz),
      y2: getSpectrumY(rightPost.levelDb, rightPost.frequencyHz, visualGainDb),
      opacity,
    }
  }).filter((segment): segment is NonNullable<typeof segment> => segment !== null)
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

export function EqChart({
  baselineCurve,
  bandCurve,
  outputCurve,
  fftOverlay,
  visualGainDb,
  bands,
  selectedBandId,
  showFlatHint,
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
  fftOverlay?: FftOverlay | null
  visualGainDb: number
  bands: EqBand[]
  selectedBandId?: string
  showFlatHint: boolean
  viewMinDb: number
  viewMaxDb: number
  onBandCommit: (band: EqBand) => void
  onBandCreate: (band: EqBand) => void
  onBandDelete: (bandId: string) => void
  onBandToggleBypass: (bandId: string) => void
  onBandSelect: (bandId?: string) => void
  onIncreaseViewMax: () => void
  onDecreaseViewMax: () => void
  onIncreaseViewMin: () => void
  onDecreaseViewMin: () => void
}) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const hoverCloseTimerRef = useRef<number | null>(null)
  const frameCommitRef = useRef<number | null>(null)
  const pendingBandCommitRef = useRef<EqBand | null>(null)
  const [draggingBandId, setDraggingBandId] = useState<string | null>(null)
  const [hoveredBandId, setHoveredBandId] = useState<string | null>(null)
  const [pinnedBandId, setPinnedBandId] = useState<string | null>(null)
  const [editingField, setEditingField] = useState<EditableField | null>(null)
  const [editingDraft, setEditingDraft] = useState('')

  const yTicks = useMemo(
    () => createYAxisTicks(viewMinDb, viewMaxDb),
    [viewMaxDb, viewMinDb],
  )
  const smoothedPreSpectrum = useMemo(
    () => createSmoothedSpectrumPoints(fftOverlay?.preSpectrum ?? []),
    [fftOverlay],
  )
  const smoothedPostSpectrum = useMemo(
    () => createSmoothedSpectrumPoints(fftOverlay?.postSpectrum ?? []),
    [fftOverlay],
  )
  const fftPreLinePath = useMemo(
    () => createSpectrumLinePath(smoothedPreSpectrum, visualGainDb),
    [smoothedPreSpectrum, visualGainDb],
  )
  const fftPreFillPath = useMemo(
    () => createSpectrumFillPath(smoothedPreSpectrum, visualGainDb),
    [smoothedPreSpectrum, visualGainDb],
  )
  const fftPostSegments = useMemo(
    () =>
      createSpectrumSegments(
        smoothedPreSpectrum,
        smoothedPostSpectrum,
        visualGainDb,
      ),
    [smoothedPostSpectrum, smoothedPreSpectrum, visualGainDb],
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


  useEffect(() => () => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current)
    }

    if (frameCommitRef.current !== null) {
      window.cancelAnimationFrame(frameCommitRef.current)
    }
  }, [])

  function flushPendingBandCommit() {
    if (!pendingBandCommitRef.current) {
      return
    }

    const nextBand = pendingBandCommitRef.current
    pendingBandCommitRef.current = null
    onBandCommit(nextBand)
  }

  function scheduleBandCommit(nextBand: EqBand) {
    pendingBandCommitRef.current = nextBand

    if (frameCommitRef.current !== null) {
      return
    }

    frameCommitRef.current = window.requestAnimationFrame(() => {
      frameCommitRef.current = null
      flushPendingBandCommit()
    })
  }

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
      x: ((clientX - rect.left) / rect.width) * VIEWBOX_WIDTH,
      y: ((clientY - rect.top) / rect.height) * VIEWBOX_HEIGHT,
    }
  }

  function getFrequencyFromX(x: number) {
    const chartWidth = VIEWBOX_WIDTH - PADDING.left - PADDING.right
    const clampedX = Math.min(PADDING.left + chartWidth, Math.max(PADDING.left, x))
    const minLog = Math.log10(MIN_FREQUENCY)
    const maxLog = Math.log10(MAX_FREQUENCY)
    const ratio = (clampedX - PADDING.left) / chartWidth
    return 10 ** (minLog + ratio * (maxLog - minLog))
  }

  function getGainFromY(y: number) {
    const chartHeight = VIEWBOX_HEIGHT - PADDING.top - PADDING.bottom
    const clampedY = Math.min(PADDING.top + chartHeight, Math.max(PADDING.top, y))
    const ratio = (clampedY - PADDING.top) / chartHeight
    return viewMaxDb - ratio * (viewMaxDb - viewMinDb)
  }

  function handlePointerMove(event: PointerEvent<SVGCircleElement>, band: EqBand) {
    if (draggingBandId !== band.id) {
      return
    }

    const point = getSvgPoint(event.clientX, event.clientY)
    if (!point) {
      return
    }

    if ('gainDb' in band) {
      scheduleBandCommit({
        ...band,
        frequencyHz: clampFrequency(getFrequencyFromX(point.x)),
        gainDb: clampGain(getGainFromY(point.y)),
      })
      return
    }

    scheduleBandCommit({
      ...band,
      frequencyHz: clampFrequency(getFrequencyFromX(point.x)),
    })
  }

  function handleChartWheel(event: WheelEvent<HTMLDivElement>) {
    if (!draggingBand || event.deltaY === 0) {
      return
    }

    event.preventDefault()
    const direction = event.deltaY < 0 ? 1 : -1

    if (draggingBand.type === 'peaking') {
      onBandCommit({
        ...draggingBand,
        q: roundQ(clampQ(draggingBand.q + direction * WHEEL_Q_STEP)),
      })
      return
    }

    if (draggingBand.type === 'lowCut' || draggingBand.type === 'highCut') {
      const nextSlope = getNextSlope(
        draggingBand.slopeDbPerOct,
        direction,
        CUT_SLOPE_VALUES,
      )

      if (nextSlope === draggingBand.slopeDbPerOct) {
        return
      }

      onBandCommit({
        ...draggingBand,
        slopeDbPerOct: nextSlope,
      })
      return
    }

    if (draggingBand.type !== 'lowShelf' && draggingBand.type !== 'highShelf') {
      return
    }

    const nextSlope = getNextSlope(
      draggingBand.slopeDbPerOct,
      direction,
      MUSICAL_SLOPE_VALUES,
    )

    if (nextSlope === draggingBand.slopeDbPerOct) {
      return
    }

    onBandCommit({
      ...draggingBand,
      slopeDbPerOct: nextSlope,
    })
  }

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
      onBandCommit(nextBand)
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
        left: `${(getX(popupBand.frequencyHz) / VIEWBOX_WIDTH) * 100}%`,
        top: `${(getY('gainDb' in popupBand ? popupBand.gainDb : 0, viewMinDb, viewMaxDb) / VIEWBOX_HEIGHT) * 100}%`,
      }
    : undefined

  const popupAlign = popupBand && getX(popupBand.frequencyHz) > VIEWBOX_WIDTH * 0.68
    ? 'is-left'
    : 'is-right'

  return (
    <div className="chart-frame" onWheel={handleChartWheel}>
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
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        role="img"
        aria-label="EQ editing surface"
        onClick={handleChartClick}
        onDoubleClick={handleChartDoubleClick}
      >
        <rect
          x={PADDING.left}
          y={PADDING.top}
          width={VIEWBOX_WIDTH - PADDING.left - PADDING.right}
          height={VIEWBOX_HEIGHT - PADDING.top - PADDING.bottom}
          className="chart-area"
        />

        {GRID_FREQUENCIES.map((frequency) => {
          const x = getX(frequency)
          return (
            <g key={frequency}>
              <line
                className="grid-line"
                x1={x}
                x2={x}
                y1={PADDING.top}
                y2={VIEWBOX_HEIGHT - PADDING.bottom}
              />
              <text className="axis-label" x={x} y={VIEWBOX_HEIGHT - 18} textAnchor="middle">
                {formatFrequencyLabel(frequency)}
              </text>
            </g>
          )
        })}

        {yTicks.map((value) => {
          const y = getY(value, viewMinDb, viewMaxDb)
          return (
            <g key={value}>
              <line
                className={value === 0 ? 'grid-line zero-line' : 'grid-line'}
                x1={PADDING.left}
                x2={VIEWBOX_WIDTH - PADDING.right}
                y1={y}
                y2={y}
              />
              <text className="axis-label" x={PADDING.left - 14} y={y + 5} textAnchor="end">
                {value}
              </text>
            </g>
          )
        })}

        <path className="curve curve-source" d={createPath(baselineCurve, viewMinDb, viewMaxDb)} />
        <path className="curve curve-eq" d={createPath(bandCurve, viewMinDb, viewMaxDb)} />
        <path className="curve curve-preview" d={createPath(outputCurve, viewMinDb, viewMaxDb)} />
        {fftOverlay ? (
          <g aria-hidden="true">
            <path
              data-testid="fft-pre-fill"
              className="fft-overlay-fill"
              d={fftPreFillPath}
            />
            <path
              data-testid="fft-pre-line"
              className="curve curve-fft-pre-line"
              d={fftPreLinePath}
            />
            {fftPostSegments.map((segment) => (
              <line
                key={segment.id}
                data-testid="fft-post-segment"
                className="curve-fft-post-segment"
                x1={segment.x1}
                y1={segment.y1}
                x2={segment.x2}
                y2={segment.y2}
                strokeOpacity={segment.opacity}
              />
            ))}
          </g>
        ) : null}

        {bands.map((band) => (
          <g key={band.id}>
            <circle
              aria-label={`${describeBand(band)} band`}
              className={`band-node ${band.id === selectedBandId ? 'is-selected' : ''} ${band.isBypassed ? 'is-bypassed' : ''}`}
              cx={getX(band.frequencyHz)}
              cy={getY('gainDb' in band ? band.gainDb : 0, viewMinDb, viewMaxDb)}
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
                if ('setPointerCapture' in event.currentTarget) {
                  event.currentTarget.setPointerCapture(event.pointerId)
                }
                handlePointerMove(event, band)
              }}
              onPointerMove={(event) => handlePointerMove(event, band)}
              onPointerUp={(event) => {
                flushPendingBandCommit()
                setDraggingBandId(null)
                if (
                  'hasPointerCapture' in event.currentTarget &&
                  event.currentTarget.hasPointerCapture(event.pointerId)
                ) {
                  event.currentTarget.releasePointerCapture(event.pointerId)
                }
              }}
              onPointerCancel={() => {
                flushPendingBandCommit()
                setDraggingBandId(null)
              }}
            />
          </g>
        ))}
      </svg>

      {showFlatHint && bands.length === 0 ? (
        <div className="chart-hint">
          <p className="section-label">Flat start</p>
          <h3>Import an EQ curve or double-click to start from flat</h3>
          <p>The chart is already live. Double-click anywhere in the plot to create a peaking band.</p>
        </div>
      ) : null}

      {popupBand ? (
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
                onBandCommit(convertBandType(popupBand, event.target.value as EqBandType))
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
                onDoubleClick={() => startEditing('frequencyHz', popupBand.frequencyHz.toFixed(0))}
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
        </div>
      ) : null}
    </div>
  )
}

