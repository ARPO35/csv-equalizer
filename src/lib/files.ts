import type { CurvePoint, ProjectPresetV1 } from '../types'

type SaveFilePickerOptions = {
  suggestedName: string
  mimeType: string
  contents: string
  handle?: FileSystemFileHandle | null
}

type SaveTextFileResult = {
  handle: FileSystemFileHandle | null
  mode: 'picker' | 'download'
}

function formatDecimal(value: number) {
  return Number(value.toFixed(6)).toString()
}

function downloadTextFile(
  suggestedName: string,
  mimeType: string,
  contents: string,
) {
  const blob = new Blob([contents], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = suggestedName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function serializeCurveCsv(points: CurvePoint[]) {
  return [
    'frequency,gain',
    ...points.map(
      (point) =>
        `${formatDecimal(point.frequencyHz)},${formatDecimal(point.gainDb)}`,
    ),
  ].join('\n')
}

export function serializePreset(preset: ProjectPresetV1) {
  return `${JSON.stringify(preset, null, 2)}\n`
}

export async function saveTextFile({
  suggestedName,
  mimeType,
  contents,
  handle,
}: SaveFilePickerOptions): Promise<SaveTextFileResult> {
  if (window.showSaveFilePicker) {
    const fileHandle =
      handle ??
      (await window.showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: mimeType,
            accept: {
              [mimeType]: [suggestedName.endsWith('.json') ? '.json' : '.csv'],
            },
          },
        ],
      }))

    const writable = await fileHandle.createWritable()
    await writable.write(contents)
    await writable.close()
    return {
      handle: fileHandle,
      mode: 'picker',
    }
  }

  downloadTextFile(suggestedName, mimeType, contents)
  return {
    handle: null,
    mode: 'download',
  }
}
