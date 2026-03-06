declare module 'heic-convert' {
  interface ConvertOptions {
    buffer: Buffer | ArrayBuffer
    format: 'JPEG' | 'PNG'
    quality?: number
  }
  function convert(options: ConvertOptions): Promise<Buffer | ArrayBuffer>
  export = convert
}