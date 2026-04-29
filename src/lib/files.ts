import type { CurvePoint, ProjectPresetV1 } from '../types'

type SaveTextFileOptions = {
  suggestedName: string
  mimeType: string
  contents: string
  handle?: FileSystemFileHandle | null
  description?: string
  extensions?: string[]
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

function getSavePickerOptions({
  suggestedName,
  mimeType,
  description,
  extensions,
}: Omit<SaveTextFileOptions, 'contents' | 'handle'>): SaveFilePickerOptions {
  return {
    suggestedName,
    types: [
      {
        description: description ?? mimeType,
        accept: {
          [mimeType]:
            extensions ??
            [suggestedName.endsWith('.json') ? '.json' : '.csv'],
        },
      },
    ],
  }
}

async function writeTextFile(
  fileHandle: FileSystemFileHandle,
  contents: string,
) {
  const writable = await fileHandle.createWritable()
  await writable.write(contents)
  await writable.close()
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
  description,
  extensions,
}: SaveTextFileOptions): Promise<SaveTextFileResult> {
  if (window.showSaveFilePicker) {
    const pickerOptions = getSavePickerOptions({
      suggestedName,
      mimeType,
      description,
      extensions,
    })
    const fileHandle =
      handle ??
      (await window.showSaveFilePicker(pickerOptions))

    try {
      await writeTextFile(fileHandle, contents)
    } catch (error) {
      if (!handle) {
        throw error
      }

      const nextFileHandle = await window.showSaveFilePicker(pickerOptions)
      await writeTextFile(nextFileHandle, contents)
      return {
        handle: nextFileHandle,
        mode: 'picker',
      }
    }

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
