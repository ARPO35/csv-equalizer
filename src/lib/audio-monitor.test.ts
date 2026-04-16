import { describe, expect, it } from 'vitest'
import {
  AUDIO_PARAM_RAMP_MS,
  FFT_ANALYSER_MAX_DB,
  FFT_ANALYSER_MIN_DB,
  createGraphEqNodes,
  createMonitorGraph,
  disconnectMonitorGraph,
  mapFrequencyDataToSpectrum,
  syncMonitorGraph,
} from './audio-monitor'
import type { CurvePoint, EqBand } from '../types'

type ParamEvent =
  | { type: 'cancel'; time: number }
  | { type: 'set'; time: number; value: number }
  | { type: 'ramp'; time: number; value: number }

class FakeAudioParam {
  value: number
  events: ParamEvent[] = []

  constructor(initialValue: number) {
    this.value = initialValue
  }

  cancelScheduledValues(time: number) {
    this.events.push({ type: 'cancel', time })
  }

  setValueAtTime(value: number, time: number) {
    this.value = value
    this.events.push({ type: 'set', time, value })
  }

  linearRampToValueAtTime(value: number, time: number) {
    this.value = value
    this.events.push({ type: 'ramp', time, value })
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

class FakeBiquadFilterNode extends FakeAudioNode {
  type: BiquadFilterType = 'peaking'
  frequency = new FakeAudioParam(1000)
  gain = new FakeAudioParam(0)
  Q = new FakeAudioParam(1)
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
  destination = new FakeAudioNode()
  sampleRate = 48_000
  currentTime = 1

  createGain() {
    return new FakeGainNode()
  }

  createBiquadFilter() {
    return new FakeBiquadFilterNode()
  }

  createAnalyser() {
    return new FakeAnalyserNode()
  }

  createMediaElementSource() {
    return new FakeMediaElementSourceNode()
  }
}

const baselineCurve: CurvePoint[] = [
  { frequencyHz: 20, gainDb: -4 },
  { frequencyHz: 1000, gainDb: 2 },
  { frequencyHz: 20000, gainDb: -1 },
]

describe('audio monitor graph', () => {
  it('routes dry and wet monitor paths from the media source', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))

    expect(getConnections(graph.source)).toHaveLength(2)
    expect(getConnections(graph.dryGain)).toEqual([context.destination])
    expect(getConnections(graph.wetGain)).toEqual([
      context.destination,
      graph.postAnalyser as unknown as FakeAudioNode,
    ])
    expect(getConnections(graph.preGainNode)).toEqual([])
    expect(graph.preAnalyser.fftSize).toBe(8192)
    expect(graph.preAnalyser.minDecibels).toBe(FFT_ANALYSER_MIN_DB)
    expect(graph.postAnalyser.maxDecibels).toBe(FFT_ANALYSER_MAX_DB)
  })

  it('builds a fixed graph EQ bank from the imported baseline curve', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const nodes = createGraphEqNodes(context, baselineCurve)

    expect(nodes).toHaveLength(31)
    expect((nodes[0] as unknown as FakeBiquadFilterNode).type).toBe('lowshelf')
    expect((nodes[15] as unknown as FakeBiquadFilterNode).type).toBe('peaking')
    expect((nodes[30] as unknown as FakeBiquadFilterNode).type).toBe('highshelf')
  })

  it('adds baseline graph EQ nodes ahead of active param bands when enabled', () => {
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

    expect(graph.filterNodes).toHaveLength(33)
    expect((graph.filterNodes[0] as unknown as FakeBiquadFilterNode).type).toBe('lowshelf')
    expect((graph.filterNodes[30] as unknown as FakeBiquadFilterNode).type).toBe('highshelf')
    expect((graph.filterNodes[31] as unknown as FakeBiquadFilterNode).type).toBe('lowpass')
    expect(getConnections(graph.preGainNode)).toEqual([
      graph.preAnalyser as unknown as FakeAudioNode,
      graph.filterNodes[0] as unknown as FakeAudioNode,
    ])
    expect(graph.preGainNode.gain.value).toBeCloseTo(10 ** (-10 / 20))
    expect(graph.dryGain.gain.value).toBe(0)
    expect(graph.wetGain.gain.value).toBe(1)
  })

  it('keeps pre-gain active and bypasses EQ filters when monitor bypass is enabled', () => {
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
    expect(getConnections(graph.wetInput)).toEqual([
      graph.preGainNode as unknown as FakeAudioNode,
    ])
    expect(getConnections(graph.preGainNode)).toEqual([
      graph.preAnalyser as unknown as FakeAudioNode,
      graph.wetGain as unknown as FakeAudioNode,
    ])
    expect(graph.preGainNode.gain.value).toBeCloseTo(10 ** (-8 / 20))
    expect(graph.dryGain.gain.value).toBe(0)
    expect(graph.wetGain.gain.value).toBe(1)
  })

  it('keeps a playable wet chain even when no EQ nodes are active', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))

    syncMonitorGraph(context, graph, [], baselineCurve, false, false, -8)

    expect(graph.filterNodes).toHaveLength(0)
    expect(getConnections(graph.preGainNode)).toEqual([
      graph.preAnalyser as unknown as FakeAudioNode,
      graph.wetGain as unknown as FakeAudioNode,
    ])
  })

  it('builds stacked filter stages for shelf slopes in the monitor chain', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))
    const bands: EqBand[] = [
      {
        id: 'band-1',
        type: 'lowShelf',
        frequencyHz: 120,
        isBypassed: false,
        gainDb: 6,
        slopeDbPerOct: 30,
      },
    ]

    syncMonitorGraph(context, graph, bands, baselineCurve, false, false, -8)

    expect(graph.filterNodes).toHaveLength(5)
    expect((graph.filterNodes[0] as unknown as FakeBiquadFilterNode).type).toBe('lowshelf')
    expect((graph.filterNodes[0] as unknown as FakeBiquadFilterNode).gain.value).toBeCloseTo(1.2)
  })

  it('updates matching filter topologies with parameter automation instead of rebuilding nodes', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))
    const initialBand: EqBand = {
      id: 'band-1',
      type: 'peaking',
      frequencyHz: 1000,
      isBypassed: false,
      gainDb: 3,
      q: 1.1,
      slopeDbPerOct: 12,
    }

    syncMonitorGraph(context, graph, [initialBand], baselineCurve, false, false, -8)

    const firstNode = graph.filterNodes[0] as unknown as FakeBiquadFilterNode

    syncMonitorGraph(
      context,
      graph,
      [{ ...initialBand, frequencyHz: 1400, gainDb: 5, q: 1.6 }],
      baselineCurve,
      false,
      false,
      -6,
    )

    expect(graph.filterNodes[0]).toBe(firstNode as unknown as BiquadFilterNode)
    expect(firstNode.frequency.events.at(-1)).toEqual({
      type: 'ramp',
      time: 1 + AUDIO_PARAM_RAMP_MS / 1000,
      value: 1400,
    })
    expect(firstNode.gain.events.at(-1)).toEqual({
      type: 'ramp',
      time: 1 + AUDIO_PARAM_RAMP_MS / 1000,
      value: 2.5,
    })
    expect(firstNode.Q.events.at(-1)).toEqual({
      type: 'ramp',
      time: 1 + AUDIO_PARAM_RAMP_MS / 1000,
      value: 1.6,
    })
    expect((graph.preGainNode.gain as unknown as FakeAudioParam).events.at(-1)).toEqual({
      type: 'ramp',
      time: 1 + AUDIO_PARAM_RAMP_MS / 1000,
      value: 10 ** (-6 / 20),
    })
  })

  it('updates baseline monitor gains in place when the graph structure is unchanged', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))

    syncMonitorGraph(context, graph, [], baselineCurve, false, true, -8)

    const firstBaselineNode = graph.filterNodes[0] as unknown as FakeBiquadFilterNode
    const updatedBaselineCurve: CurvePoint[] = [
      { frequencyHz: 20, gainDb: -2 },
      { frequencyHz: 1000, gainDb: 4 },
      { frequencyHz: 20000, gainDb: 1 },
    ]

    syncMonitorGraph(context, graph, [], updatedBaselineCurve, false, true, -8)

    expect(graph.filterNodes[0]).toBe(firstBaselineNode as unknown as BiquadFilterNode)
    expect(firstBaselineNode.gain.events.at(-1)).toEqual({
      type: 'ramp',
      time: 1 + AUDIO_PARAM_RAMP_MS / 1000,
      value: -2,
    })
  })

  it('disconnects the monitor graph cleanly and idempotently', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))

    syncMonitorGraph(context, graph, [], baselineCurve, false, true, -8)
    disconnectMonitorGraph(graph)
    disconnectMonitorGraph(graph)

    expect(getConnections(graph.source)).toEqual([])
    expect(getConnections(graph.dryGain)).toEqual([])
    expect(getConnections(graph.wetInput)).toEqual([])
    expect(getConnections(graph.preGainNode)).toEqual([])
    expect(getConnections(graph.wetGain)).toEqual([])
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
})
