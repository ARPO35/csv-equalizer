import {
  type PointerEvent,
  useRef,
  useState,
} from 'react'
import type { CurvePoint, EqBand } from '../types'

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

function formatFrequencyLabel(value: number) {
  return value >= 1_000 ? `${value / 1_000}k` : `${value}`
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

function getChartBounds(
  sourceCurve: CurvePoint[],
  eqCurve: CurvePoint[],
  adjustedCurve: CurvePoint[],
) {
  const values = [...sourceCurve, ...eqCurve, ...adjustedCurve].map((point) => point.gainDb)
  const minValue = Math.min(...values, -12)
  const maxValue = Math.max(...values, 12)
  const padding = Math.max(3, (maxValue - minValue) * 0.12)
  const minDb = Math.floor((minValue - padding) / 3) * 3
  const maxDb = Math.ceil((maxValue + padding) / 3) * 3
  return {
    minDb,
    maxDb: maxDb === minDb ? maxDb + 6 : maxDb,
  }
}

export function EqChart({
  sourceCurve,
  eqCurve,
  adjustedCurve,
  bands,
  selectedBandId,
  onBandChange,
  onBandSelect,
}: {
  sourceCurve: CurvePoint[]
  eqCurve: CurvePoint[]
  adjustedCurve: CurvePoint[]
  bands: EqBand[]
  selectedBandId?: string
  onBandChange: (
    bandId: string,
    nextValues: { frequencyHz: number; gainDb?: number },
  ) => void
  onBandSelect: (bandId: string) => void
}) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [draggingBandId, setDraggingBandId] = useState<string | null>(null)
  const { minDb, maxDb } = getChartBounds(sourceCurve, eqCurve, adjustedCurve)
  const yLines = Array.from({ length: Math.floor((maxDb - minDb) / 6) + 1 }, (_, index) => maxDb - index * 6)

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
    const clampedX = Math.min(
      PADDING.left + chartWidth,
      Math.max(PADDING.left, x),
    )
    const minLog = Math.log10(MIN_FREQUENCY)
    const maxLog = Math.log10(MAX_FREQUENCY)
    const ratio = (clampedX - PADDING.left) / chartWidth
    return 10 ** (minLog + ratio * (maxLog - minLog))
  }

  function getGainFromY(y: number) {
    const chartHeight = VIEWBOX_HEIGHT - PADDING.top - PADDING.bottom
    const clampedY = Math.min(
      PADDING.top + chartHeight,
      Math.max(PADDING.top, y),
    )
    const ratio = (clampedY - PADDING.top) / chartHeight
    return maxDb - ratio * (maxDb - minDb)
  }

  function handlePointerMove(event: PointerEvent<SVGCircleElement>, band: EqBand) {
    if (draggingBandId !== band.id) {
      return
    }

    const point = getSvgPoint(event.clientX, event.clientY)
    if (!point) {
      return
    }

    onBandChange(band.id, {
      frequencyHz: getFrequencyFromX(point.x),
      gainDb: 'gainDb' in band ? getGainFromY(point.y) : undefined,
    })
  }

  return (
    <div className="chart-frame">
      <svg
        ref={svgRef}
        className="chart-svg"
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        role="img"
        aria-label="Frequency response chart"
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

        {yLines.map((value) => {
          const y = getY(value, minDb, maxDb)
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

        <path className="curve curve-source" d={createPath(sourceCurve, minDb, maxDb)} />
        <path className="curve curve-eq" d={createPath(eqCurve, minDb, maxDb)} />
        <path className="curve curve-preview" d={createPath(adjustedCurve, minDb, maxDb)} />

        {bands.map((band) => (
          <g key={band.id}>
            <circle
              className={`band-node ${band.id === selectedBandId ? 'is-selected' : ''}`}
              cx={getX(band.frequencyHz)}
              cy={getY('gainDb' in band ? band.gainDb : 0, minDb, maxDb)}
              r={band.id === selectedBandId ? 11 : 8}
              onClick={() => onBandSelect(band.id)}
              onPointerDown={(event) => {
                onBandSelect(band.id)
                setDraggingBandId(band.id)
                event.currentTarget.setPointerCapture(event.pointerId)
                handlePointerMove(event, band)
              }}
              onPointerMove={(event) => handlePointerMove(event, band)}
              onPointerUp={(event) => {
                setDraggingBandId(null)
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId)
                }
              }}
              onPointerCancel={() => setDraggingBandId(null)}
            />
          </g>
        ))}
      </svg>
    </div>
  )
}
