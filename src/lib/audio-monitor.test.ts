import { describe, expect, it } from 'vitest'
import {
  createGraphEqNodes,
  createMonitorGraph,
  disconnectMonitorGraph,
  syncMonitorGraph,
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

class FakeMediaElementSourceNode extends FakeAudioNode {}

function getConnections(node: unknown) {
  return (node as FakeAudioNode).connections
}

class FakeAudioContext {
  destination = new FakeAudioNode()

  createGain() {
    return new FakeGainNode()
  }

  createBiquadFilter() {
    return new FakeBiquadFilterNode()
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
    expect(getConnections(graph.wetGain)).toEqual([context.destination])
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
      },
      {
        id: 'band-2',
        type: 'highCut',
        frequencyHz: 8000,
        isBypassed: false,
        slopeDbPerOct: 24,
      },
    ]

    syncMonitorGraph(context, graph, bands, baselineCurve, false, true)

    expect(graph.filterNodes).toHaveLength(33)
    expect((graph.filterNodes[0] as unknown as FakeBiquadFilterNode).type).toBe('lowshelf')
    expect((graph.filterNodes[30] as unknown as FakeBiquadFilterNode).type).toBe('highshelf')
    expect((graph.filterNodes[31] as unknown as FakeBiquadFilterNode).type).toBe('lowpass')
    expect(graph.dryGain.gain.value).toBe(0)
    expect(graph.wetGain.gain.value).toBe(1)
  })

  it('skips baseline graph EQ nodes when the monitor toggle is disabled', () => {
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

    syncMonitorGraph(context, graph, bands, baselineCurve, true, false)

    expect(graph.filterNodes).toHaveLength(2)
    expect((graph.filterNodes[0] as unknown as FakeBiquadFilterNode).type).toBe('lowpass')
    expect(graph.dryGain.gain.value).toBe(1)
    expect(graph.wetGain.gain.value).toBe(0)
  })

  it('disconnects the monitor graph cleanly', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(context, document.createElement('audio'))

    syncMonitorGraph(context, graph, [], baselineCurve, false, true)
    disconnectMonitorGraph(graph)

    expect(getConnections(graph.source)).toEqual([])
    expect(getConnections(graph.dryGain)).toEqual([])
    expect(getConnections(graph.wetInput)).toEqual([])
    expect(getConnections(graph.wetGain)).toEqual([])
  })
})

