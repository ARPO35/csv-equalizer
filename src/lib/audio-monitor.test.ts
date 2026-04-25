import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FFT_ANALYSER_MAX_DB,
  FFT_ANALYSER_MIN_DB,
  createGraphEqNodes,
  createMonitorGraph,
  disconnectMonitorGraph,
  mapFrequencyDataToSpectrum,
  syncMonitorGraph,
  useEqPlaybackMonitor,
} from './audio-monitor'
import type { CurvePoint, EqBand } from '../types'

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
  gain = { value: 1 }
}

class FakeBiquadFilterNode extends FakeAudioNode {
  type: BiquadFilterType = 'peaking'
  frequency = { value: 1000 }
  gain = { value: 0 }
  Q = { value: 1 }
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
  gainNodes: FakeGainNode[] = []
  analyserNodes: FakeAnalyserNode[] = []
  mediaSources: FakeMediaElementSourceNode[] = []

  createGain() {
    const node = new FakeGainNode()
    this.gainNodes.push(node)
    return node
  }

  createBiquadFilter() {
    return new FakeBiquadFilterNode()
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

let lastCreatedContext: FakeAudioContext | null = null
let createdContextCount = 0

class HookFakeAudioContext extends FakeAudioContext {
  constructor() {
    super()
    createdContextCount += 1
    // eslint-disable-next-line @typescript-eslint/no-this-alias
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
    createdContextCount = 0
    vi.restoreAllMocks()
  })

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

  it('reuses filter nodes when only continuous band parameters change', () => {
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

    const updatedBand: EqBand = {
      id: 'band-1',
      type: 'peaking',
      frequencyHz: 1600,
      isBypassed: false,
      gainDb: 6,
      q: 1.8,
      slopeDbPerOct: 12,
    }

    syncMonitorGraph(context, graph, [updatedBand], baselineCurve, false, false, -6)

    expect(graph.filterNodes[0]).toBe(initialNode)
    expect((graph.filterNodes[0] as unknown as FakeBiquadFilterNode).frequency.value).toBe(1600)
    expect((graph.filterNodes[0] as unknown as FakeBiquadFilterNode).gain.value).toBe(3)
    expect((graph.filterNodes[0] as unknown as FakeBiquadFilterNode).Q.value).toBe(1.8)
    expect(graph.preGainNode.gain.value).toBeCloseTo(10 ** (-6 / 20))
  })

  it('rebuilds filter nodes when the filter topology changes', () => {
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

    const initialNodes = [...graph.filterNodes]

    syncMonitorGraph(
      context,
      graph,
      [{ ...initialBands[0], slopeDbPerOct: 48 }],
      baselineCurve,
      false,
      false,
      -8,
    )

    expect(graph.filterNodes).toHaveLength(4)
    expect(graph.filterNodes[0]).not.toBe(initialNodes[0])
  })

  it('does not create or reconnect filters after the audio context is closed', () => {
    const context = new HookFakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))
    const bands: EqBand[] = [
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

    syncMonitorGraph(context, graph, bands, baselineCurve, false, false, -8)
    expect(graph.filterNodes).toHaveLength(2)

    void (context as unknown as HookFakeAudioContext).close()
    syncMonitorGraph(context, graph, [], baselineCurve, false, false, -8)

    expect(graph.filterNodes).toHaveLength(2)
    expect(graph.isConfigured).toBe(false)
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
    const wetGain = context.gainNodes[3]
    const preAnalyser = context.analyserNodes[0]

    expect(getConnections(wetInput)).toEqual([preGainNode])
    expect(getConnections(preGainNode)).toEqual([
      preAnalyser as unknown as FakeAudioNode,
      wetGain as unknown as FakeAudioNode,
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
})

function createAudioElementHarness() {
  const element = document.createElement('audio')
  let paused = true
  let ended = false

  Object.defineProperty(element, 'paused', {
    configurable: true,
    get: () => paused,
  })
  Object.defineProperty(element, 'ended', {
    configurable: true,
    get: () => ended,
  })

  return {
    element,
    play() {
      paused = false
      ended = false
      element.dispatchEvent(new Event('play'))
    },
    pause() {
      paused = true
      element.dispatchEvent(new Event('pause'))
    },
    end() {
      paused = true
      ended = true
      element.dispatchEvent(new Event('ended'))
    },
  }
}

const StrictModeWrapper = ({ children }: { children: ReactNode }) =>
  createElement(StrictMode, null, children)

describe('useEqPlaybackMonitor StrictMode lifecycle', () => {
  afterEach(() => {
    lastCreatedContext = null
    createdContextCount = 0
    vi.restoreAllMocks()
  })

  it('creates a new audio context when the previous one has been closed', () => {
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: HookFakeAudioContext,
    })

    const audio = createAudioElementHarness()
    const { rerender } = renderHook(
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
        initialProps: { element: audio.element },
        wrapper: StrictModeWrapper,
      },
    )

    const initialContext = lastCreatedContext as HookFakeAudioContext
    void initialContext.close()

    rerender({ element: null })
    rerender({ element: audio.element })

    expect(createdContextCount).toBe(2)
    expect((lastCreatedContext as HookFakeAudioContext).state).toBe('running')
  })

  it('produces FFT frames after play in StrictMode', async () => {
    const rafCallbacks = new Map<number, FrameRequestCallback>()
    let rafId = 0

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      rafId += 1
      rafCallbacks.set(rafId, callback)
      return rafId
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      rafCallbacks.delete(id)
    })
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: HookFakeAudioContext,
    })

    const audio = createAudioElementHarness()
    const { result } = renderHook(
      () =>
        useEqPlaybackMonitor({
          audioElement: audio.element,
          bands: [],
          baselineCurve,
          monitorBypassed: false,
          monitorBaselineEnabled: false,
          preGainDb: -8,
        }),
      { wrapper: StrictModeWrapper },
    )

    act(() => {
      audio.play()
    })

    await waitFor(() => {
      expect(result.current.hasFftFrame).toBe(true)
    })
    expect(rafCallbacks.size).toBeGreaterThan(0)
  })

  it('stops sampling on pause or ended, then can restart on play', async () => {
    let rafId = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => {
      rafId += 1
      return rafId
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: HookFakeAudioContext,
    })

    const audio = createAudioElementHarness()
    const { result } = renderHook(
      () =>
        useEqPlaybackMonitor({
          audioElement: audio.element,
          bands: [],
          baselineCurve,
          monitorBypassed: false,
          monitorBaselineEnabled: false,
          preGainDb: -8,
        }),
      { wrapper: StrictModeWrapper },
    )

    act(() => {
      audio.play()
    })
    await waitFor(() => {
      expect(result.current.hasFftFrame).toBe(true)
    })

    act(() => {
      audio.pause()
    })
    await waitFor(() => {
      expect(result.current.hasFftFrame).toBe(false)
    })

    act(() => {
      audio.play()
    })
    await waitFor(() => {
      expect(result.current.hasFftFrame).toBe(true)
    })

    act(() => {
      audio.end()
    })
    await waitFor(() => {
      expect(result.current.hasFftFrame).toBe(false)
    })

    act(() => {
      audio.play()
    })
    await waitFor(() => {
      expect(result.current.hasFftFrame).toBe(true)
    })
  })
})
