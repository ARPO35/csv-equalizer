import { describe, expect, it, vi } from 'vitest'
import {
  AUDIO_PARAM_RAMP_MS,
  FFT_ANALYSER_MAX_DB,
  FFT_ANALYSER_MIN_DB,
  GRAPH_CROSSFADE_MS,
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

class FakeMediaElementSourceNode extends FakeAudioNode {
  context: FakeAudioContext

  constructor(context: FakeAudioContext) {
    super()
    this.context = context
  }
}

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
    return new FakeMediaElementSourceNode(this)
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
    expect(getConnections(graph.wetInput)).toEqual([
      graph.preGainNode as unknown as FakeAudioNode,
    ])
    expect(getConnections(graph.preGainNode)).toEqual([
      graph.preAnalyser as unknown as FakeAudioNode,
      graph.branchA.entry as unknown as FakeAudioNode,
      graph.branchB.entry as unknown as FakeAudioNode,
    ])
    expect(getConnections(graph.branchA.output)).toEqual([
      graph.wetGain as unknown as FakeAudioNode,
    ])
    expect(getConnections(graph.branchB.output)).toEqual([
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
    expect(graph.activeBranchKey).toBe('a')
    expect(getConnections(graph.branchA.entry)).toEqual([
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
    expect(graph.activeBranchKey).toBe('a')
    expect(getConnections(graph.branchA.entry)).toEqual([
      graph.branchA.output as unknown as FakeAudioNode,
    ])
    expect(graph.preGainNode.gain.value).toBeCloseTo(10 ** (-8 / 20))
    expect(graph.dryGain.gain.value).toBe(0)
    expect(graph.wetGain.gain.value).toBe(1)
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
    const firstPreGainEvents = [
      ...(graph.preGainNode.gain as unknown as FakeAudioParam).events,
    ]

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
    expect((graph.preGainNode.gain as unknown as FakeAudioParam).events.length).toBeGreaterThan(
      firstPreGainEvents.length,
    )
  })

  it('keeps the first synchronized graph on the current active branch', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))
    const band: EqBand = {
      id: 'band-1',
      type: 'peaking',
      frequencyHz: 1000,
      isBypassed: false,
      gainDb: 3,
      q: 1.1,
      slopeDbPerOct: 12,
    }

    syncMonitorGraph(context, graph, [band], baselineCurve, false, false, -8)

    expect(graph.activeBranchKey).toBe('a')
    expect(graph.branchA.filterNodes).toHaveLength(2)
    expect(graph.branchB.filterNodes).toHaveLength(0)
    expect((graph.branchA.output.gain as unknown as FakeAudioParam).events.at(-1)).toEqual({
      type: 'set',
      time: 1,
      value: 1,
    })
  })

  it('uses immediate set operations for zero-ramp gain switching', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))
    const band: EqBand = {
      id: 'band-1',
      type: 'peaking',
      frequencyHz: 1000,
      isBypassed: false,
      gainDb: 3,
      q: 1.1,
      slopeDbPerOct: 12,
    }

    syncMonitorGraph(context, graph, [band], baselineCurve, false, false, -8)

    expect((graph.branchA.output.gain as unknown as FakeAudioParam).events).toContainEqual({
      type: 'set',
      time: 1,
      value: 1,
    })
    expect((graph.branchA.output.gain as unknown as FakeAudioParam).events).not.toContainEqual({
      type: 'ramp',
      time: 1,
      value: 1,
    })
  })

  it('crossfades to a rebuilt branch when the monitor structure changes', () => {
    vi.useFakeTimers()
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))
    const firstBand: EqBand = {
      id: 'band-1',
      type: 'peaking',
      frequencyHz: 1000,
      isBypassed: false,
      gainDb: 3,
      q: 1.1,
      slopeDbPerOct: 12,
    }
    const secondBand: EqBand = {
      id: 'band-2',
      type: 'highCut',
      frequencyHz: 9000,
      isBypassed: false,
      slopeDbPerOct: 24,
    }

    syncMonitorGraph(context, graph, [firstBand], baselineCurve, false, false, -8)
    const previousActiveBranch = graph.activeBranchKey
    const previousActiveOutput =
      previousActiveBranch === 'a' ? graph.branchA.output : graph.branchB.output

    syncMonitorGraph(
      context,
      graph,
      [firstBand, secondBand],
      baselineCurve,
      false,
      false,
      -8,
    )

    expect(graph.activeBranchKey).not.toBe(previousActiveBranch)
    expect((previousActiveOutput.gain as unknown as FakeAudioParam).events.at(-1)).toEqual({
      type: 'ramp',
      time: 1 + GRAPH_CROSSFADE_MS / 1000,
      value: 0,
    })

    vi.advanceTimersByTime(GRAPH_CROSSFADE_MS + 1)

    const inactiveBranch =
      graph.activeBranchKey === 'a' ? graph.branchB : graph.branchA
    expect(inactiveBranch.filterNodes).toHaveLength(0)
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
