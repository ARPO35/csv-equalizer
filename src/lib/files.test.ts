import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveTextFile, serializeCurveCsv, serializePreset } from './files'

describe('file serialization helpers', () => {
  it('serializes eq curves as csv', () => {
    expect(
      serializeCurveCsv([
        { frequencyHz: 20, gainDb: -3 },
        { frequencyHz: 1000, gainDb: 2.25 },
      ]),
    ).toBe('frequency,gain\n20,-3\n1000,2.25')
  })

  it('serializes presets as indented json', () => {
    expect(
      serializePreset({
        version: 1,
        sourceFileName: 'demo.csv',
        bands: [
          {
            id: 'band-1',
            type: 'peaking',
            frequencyHz: 1000,
            isBypassed: true,
            gainDb: 2,
            q: 1,
          },
        ],
      }),
    ).toContain('"isBypassed": true')
  })
})

describe('saveTextFile', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the file picker when available', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const createWritable = vi.fn().mockResolvedValue({ write, close })
    const handle = { createWritable } as unknown as FileSystemFileHandle

    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      writable: true,
      value: vi.fn().mockResolvedValue(handle),
    })

    const result = await saveTextFile({
      suggestedName: 'preset.heq.json',
      mimeType: 'application/json',
      contents: '{"version":1}',
    })

    expect(window.showSaveFilePicker).toHaveBeenCalled()
    expect(write).toHaveBeenCalledWith('{"version":1}')
    expect(result.mode).toBe('picker')
    expect(result.handle).toBe(handle)
  })

  it('falls back to browser download when the picker is unavailable', async () => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:test')
    const revokeObjectUrl = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => undefined)
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)

    const result = await saveTextFile({
      suggestedName: 'curve.csv',
      mimeType: 'text/csv',
      contents: 'frequency,gain\n20,0',
    })

    expect(createObjectUrl).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test')
    expect(result.mode).toBe('download')
  })
})
