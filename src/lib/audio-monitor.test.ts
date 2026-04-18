import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FFT_ANALYSER_MAX_DB,
  FFT_ANALYSER_MIN_DB,
  FFT_DISPLAY_GRID_SIZE,
  createMonitorGraph,
  disconnectMonitorGraph,
  mapFrequencyDataToSpectrum,
  syncMonitorGraph,
  useEqPlaybackMonitor,
} from './audio-monitor'
import type { CurvePoint, CutBand, EqBand, PeakingBand } from '../types'

class FakeAudioParam {
  value: number

  constructor(value = 0) {
    this.value = value
  }

  cancelScheduledValues() {}

  setValueAtTime(value: number) {
    this.value = value
    return this
  }

  linearRampToValueAtTime(value: number) {
    this.value = value
    return this
  }
}

class FakeAudioNode {
  connections: FakeAudioNode[] = []

  connect(target: FakeAudioNode) {
    this.connections.push(target)
    return target
  }

  disconnect() {
    this.connections = []
  }
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam(1)
}

class FakeIIRFilterNode extends FakeAudioNode {
  feedforward: number[]
  feedback: number[]

  constructor(feedforward: number[], feedback: number[]) {
    super()
    this.feedforward = feedforward
    this.feedback = feedback
  }
}

class FakeAnalyserNode extends FakeAudioNode {
  #fftSize = 2048
  minDecibels = -100
  maxDecibels = -30
  smoothingTimeConstant = 0.8
  frequencyBinCount = this.#fftSize / 2

  get fftSize() {
    return this.#fftSize
  }

  set fftSize(value: number) {
    this.#fftSize = value
    this.frequencyBinCount = value / 2
  }

  getFloatFrequencyData(array: Float32Array) {
    array.fill(-48)
  }
}

class FakeMediaElementSourceNode extends FakeAudioNode {}

function getConnections(node: unknown) {
  return (node as FakeAudioNode).connections
}

class FakeAudioContext {
  currentTime = 0
  destination = new FakeAudioNode()
  sampleRate = 48_000
  gainNodes: FakeGainNode[] = []
  analyserNodes: FakeAnalyserNode[] = []
  mediaSources: FakeMediaElementSourceNode[] = []
  iirFilters: FakeIIRFilterNode[] = []

  createGain() {
    const node = new FakeGainNode()
    this.gainNodes.push(node)
    return node
  }

  createIIRFilter(feedforward: number[], feedback: number[]) {
    const node = new FakeIIRFilterNode(feedforward, feedback)
    this.iirFilters.push(node)
    return node
  }

  createAnalyser() {
    const node = new FakeAnalyserNode()
    this.analyserNodes.push(node)
    return node
  }

  createMediaElementSource() {
    const node = new FakeMediaElementSourceNode()
    this.mediaSources.push(node)
    return node
  }
}

const baselineCurve: CurvePoint[] = [
  { frequencyHz: 20, gainDb: -4 },
  { frequencyHz: 1000, gainDb: 2 },
  { frequencyHz: 20000, gainDb: -1 },
]

let lastCreatedContext: HookFakeAudioContext | null = null

class HookFakeAudioContext extends FakeAudioContext {
  constructor() {
    super()
    lastCreatedContext = this
  }

  state: AudioContextState = 'running'

  close() {
    this.state = 'closed'
    return Promise.resolve()
  }

  resume() {
    this.state = 'running'
    return Promise.resolve()
  }
}

describe('audio monitor graph', () => {
  afterEach(() => {
    lastCreatedContext = null
    vi.restoreAllMocks()
  })

  it('routes dry and wet monitor paths from the media source', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))

    expect(getConnections(graph.source)).toHaveLength(2)
    expect(getConnections(graph.dryGain)).toEqual([context.destination])
    expect(getConnections(graph.wetInput)).toEqual([
      graph.preGainNode as unknown as FakeAudioNode,
    ])
    expect(getConnections(graph.preGainNode)).toEqual([
      graph.preAnalyser as unknown as FakeAudioNode,
      graph.activeLane.input as unknown as FakeAudioNode,
      graph.stagingLane.input as unknown as FakeAudioNode,
    ])
    expect(getConnections(graph.activeLane.output)).toEqual([
      graph.wetGain as unknown as FakeAudioNode,
    ])
    expect(getConnections(graph.stagingLane.output)).toEqual([
      graph.wetGain as unknown as FakeAudioNode,
    ])
    expect(getConnections(graph.wetGain)).toEqual([
      context.destination,
      graph.postAnalyser as unknown as FakeAudioNode,
    ])
    expect(graph.preAnalyser.fftSize).toBe(8192)
    expect(graph.preAnalyser.minDecibels).toBe(FFT_ANALYSER_MIN_DB)
    expect(graph.postAnalyser.maxDecibels).toBe(FFT_ANALYSER_MAX_DB)
  })

  it('adds baseline sections ahead of active param sections when enabled', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))
    const bands: EqBand[] = [
      {
        id: 'band-1',
        type: 'peaking',
        frequencyHz: 1000,
        isBypassed: true,
        gainDb: 4,
        q: 1.1,
        slopeDbPerOct: 12,
      },
      {
        id: 'band-2',
        type: 'highCut',
        frequencyHz: 8000,
        isBypassed: false,
        slopeDbPerOct: 24,
      },
    ]

    syncMonitorGraph(context, graph, bands, baselineCurve, false, true, -10)

    expect(graph.filterDescriptors).toHaveLength(33)
    expect(graph.filterDescriptors[0]?.key).toBe('baseline:0:0')
    expect(graph.filterDescriptors[30]?.key).toBe('baseline:30:0')
    expect(graph.filterDescriptors[31]?.key).toBe('band-2:0')
    expect(graph.filterNodes).toHaveLength(33)
    expect((graph.filterNodes[0] as unknown as FakeIIRFilterNode).feedforward).toHaveLength(
      3,
    )
    expect(getConnections(graph.activeLane.input)).toEqual([
      graph.filterNodes[0] as unknown as FakeAudioNode,
    ])
    expect(graph.preGainNode.gain.value).toBeCloseTo(10 ** (-10 / 20))
    expect(graph.dryGain.gain.value).toBe(0)
    expect(graph.wetGain.gain.value).toBe(1)
  })

  it('keeps pre-gain active and bypasses EQ sections when monitor bypass is enabled', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))
    const bands: EqBand[] = [
      {
        id: 'band-1',
        type: 'highCut',
        frequencyHz: 8000,
        isBypassed: false,
        slopeDbPerOct: 24,
      },
    ]

    syncMonitorGraph(context, graph, bands, baselineCurve, true, false, -8)

    expect(graph.filterNodes).toHaveLength(0)
    expect(getConnections(graph.activeLane.input)).toEqual([
      graph.activeLane.output as unknown as FakeAudioNode,
    ])
    expect(graph.preGainNode.gain.value).toBeCloseTo(10 ** (-8 / 20))
    expect(graph.activeLane.output.gain.value).toBe(1)
    expect(graph.stagingLane.output.gain.value).toBe(0)
  })

  it('builds stacked IIR sections for shelf slopes in the monitor chain', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))
    const bands: EqBand[] = [
      {
        id: 'band-1',
        type: 'lowShelf',
        frequencyHz: 120,
        isBypassed: false,
        gainDb: 6,
        q: Math.SQRT1_2,
        slopeDbPerOct: 30,
      },
    ]

    syncMonitorGraph(context, graph, bands, baselineCurve, false, false, -8)

    expect(graph.filterNodes).toHaveLength(5)
    expect(graph.filterDescriptors.every((descriptor) => descriptor.key.startsWith('band-1:'))).toBe(
      true,
    )
  })

  it('changes shelf coefficients when q changes', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))
    const band: EqBand = {
      id: 'band-1',
      type: 'highShelf',
      frequencyHz: 4000,
      isBypassed: false,
      gainDb: 6,
      q: 0.7,
      slopeDbPerOct: 18,
    }

    syncMonitorGraph(context, graph, [band], baselineCurve, false, false, -8)
    const initialFeedforward = [
      ...(graph.filterNodes[0] as unknown as FakeIIRFilterNode).feedforward,
    ]

    syncMonitorGraph(
      context,
      graph,
      [{ ...band, q: 1.6 }],
      baselineCurve,
      false,
      false,
      -8,
    )

    expect((graph.filterNodes[0] as unknown as FakeIIRFilterNode).feedforward).not.toEqual(
      initialFeedforward,
    )
  })

  it('rebuilds the active chain when continuous band parameters change', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))
    const initialBands: EqBand[] = [
      {
        id: 'band-1',
        type: 'peaking',
        frequencyHz: 1000,
        isBypassed: false,
        gainDb: 4,
        q: 1.1,
        slopeDbPerOct: 12,
      },
    ]

    syncMonitorGraph(context, graph, initialBands, baselineCurve, false, false, -8)

    const initialNode = graph.filterNodes[0]
    const initialActiveInputConnections = getConnections(graph.activeLane.input)
    const updatedBand: PeakingBand = {
      id: 'band-1',
      type: 'peaking',
      frequencyHz: 1600,
      isBypassed: false,
      gainDb: 6,
      q: 1.8,
      slopeDbPerOct: 12,
    }

    syncMonitorGraph(
      context,
      graph,
      [updatedBand],
      baselineCurve,
      false,
      false,
      -6,
    )

    expect(graph.filterNodes[0]).not.toBe(initialNode)
    expect(getConnections(graph.activeLane.input)).not.toBe(initialActiveInputConnections)
    expect(graph.activeLane.output.gain.value).toBe(1)
    expect(graph.stagingLane.output.gain.value).toBe(0)
    expect(graph.preGainNode.gain.value).toBeCloseTo(10 ** (-6 / 20))
  })

  it('rebuilds the active chain when topology changes', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))
    const initialBands: EqBand[] = [
      {
        id: 'band-1',
        type: 'lowCut',
        frequencyHz: 120,
        isBypassed: false,
        slopeDbPerOct: 24,
      },
    ]

    syncMonitorGraph(context, graph, initialBands, baselineCurve, false, false, -8)

    const initialNode = graph.filterNodes[0]
    const updatedBand: CutBand = {
      id: 'band-1',
      type: 'lowCut',
      frequencyHz: 120,
      isBypassed: false,
      slopeDbPerOct: 48,
    }

    syncMonitorGraph(
      context,
      graph,
      [updatedBand],
      baselineCurve,
      false,
      false,
      -8,
    )

    expect(graph.filterNodes).toHaveLength(4)
    expect(graph.filterNodes[0]).not.toBe(initialNode)
  })

  it('disconnects the monitor graph cleanly', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))

    syncMonitorGraph(context, graph, [], baselineCurve, false, true, -8)
    disconnectMonitorGraph(graph)

    expect(getConnections(graph.source)).toEqual([])
    expect(getConnections(graph.dryGain)).toEqual([])
    expect(getConnections(graph.wetInput)).toEqual([])
    expect(getConnections(graph.preGainNode)).toEqual([])
    expect(getConnections(graph.wetGain)).toEqual([])
    expect(getConnections(graph.activeLane.input)).toEqual([])
    expect(getConnections(graph.activeLane.output)).toEqual([])
  })

  it('synchronizes the monitor graph immediately when an audio element is attached', () => {
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: HookFakeAudioContext,
    })
    const audioElement = document.createElement('audio')

    renderHook(
      ({ element }) =>
        useEqPlaybackMonitor({
          audioElement: element,
          bands: [],
          baselineCurve,
          monitorBypassed: false,
          monitorBaselineEnabled: false,
          preGainDb: -8,
        }),
      {
        initialProps: {
          element: audioElement,
        },
      },
    )

    expect(lastCreatedContext).toBeTruthy()
    const context = lastCreatedContext as HookFakeAudioContext
    const wetInput = context.gainNodes[1]
    const preGainNode = context.gainNodes[2]
    const activeLaneInput = context.gainNodes[4]
    const activeLaneOutput = context.gainNodes[5]
    const preAnalyser = context.analyserNodes[0]

    expect(getConnections(wetInput)).toEqual([preGainNode])
    expect(getConnections(preGainNode)).toEqual([
      preAnalyser as unknown as FakeAudioNode,
      activeLaneInput as unknown as FakeAudioNode,
      context.gainNodes[6] as unknown as FakeAudioNode,
    ])
    expect(getConnections(activeLaneInput)).toEqual([
      activeLaneOutput as unknown as FakeAudioNode,
    ])
  })

  it('interpolates analyser bins onto the log-spaced overlay grid without band averaging', () => {
    const frequencyData = Float32Array.from([-90, -30, -24])
    const spectrum = mapFrequencyDataToSpectrum(
      frequencyData,
      24_000,
      [8_000, 12_000, 16_000],
      FFT_ANALYSER_MIN_DB,
    )

    expect(spectrum[0]).toEqual({ frequencyHz: 8_000, levelDb: -30 })
    expect(spectrum[1]).toEqual({ frequencyHz: 12_000, levelDb: -27 })
    expect(spectrum[2]).toEqual({ frequencyHz: 16_000, levelDb: -24 })
  })

  it('preserves narrow peaks instead of merging neighboring bins', () => {
    const frequencyData = Float32Array.from([-90, -18, -90, -90])

    const spectrum = mapFrequencyDataToSpectrum(
      frequencyData,
      24_000,
      [6_000, 12_000],
      FFT_ANALYSER_MIN_DB,
    )

    expect(spectrum[0]).toEqual({ frequencyHz: 6_000, levelDb: -18 })
    expect(spectrum[1]).toEqual({ frequencyHz: 12_000, levelDb: -90 })
  })

  it('uses the reduced display grid size for default FFT overlays', () => {
    const spectrum = mapFrequencyDataToSpectrum(Float32Array.from([]), 24_000)

    expect(spectrum).toHaveLength(FFT_DISPLAY_GRID_SIZE)
  })
})
