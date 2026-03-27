interface FileSystemCreateWritableOptions {
  keepExistingData?: boolean
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: FileSystemWriteChunkType): Promise<void>
  close(): Promise<void>
}

interface FileSystemFileHandle {
  createWritable(
    options?: FileSystemCreateWritableOptions,
  ): Promise<FileSystemWritableFileStream>
}

interface FilePickerAcceptType {
  description?: string
  accept: Record<string, string[]>
}

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: FilePickerAcceptType[]
}

interface Window {
  showSaveFilePicker?: (
    options?: SaveFilePickerOptions,
  ) => Promise<FileSystemFileHandle>
}
