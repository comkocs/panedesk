/** Streaming UTF-8 decoding for worker-host byte-stream transports. */
export class StringDecoder {
  private readonly decoder: TextDecoder

  /**
   * @param encoding - UTF-8, the encoding used by worker-host transports.
   * @throws When the caller requests an unsupported encoding.
   */
  constructor(encoding = 'utf8') {
    if (encoding.toLowerCase().replace('-', '') !== 'utf8') {
      throw new TypeError(`Worker StringDecoder does not support encoding: ${encoding}`)
    }
    this.decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  }

  /**
   * Decode a chunk without flushing an incomplete UTF-8 sequence.
   * @param buffer - The next byte chunk, or already-decoded text.
   * @returns Complete characters, retaining any incomplete trailing sequence.
   */
  write(buffer: Uint8Array | string): string {
    return typeof buffer === 'string' ? buffer : this.decoder.decode(buffer, { stream: true })
  }

  /**
   * Finish the current byte stream and reset the decoder for reuse.
   * @param buffer - Optional final bytes.
   * @returns Final characters, replacing an incomplete trailing sequence.
   */
  end(buffer?: Uint8Array): string {
    return this.decoder.decode(buffer)
  }
}

/** CommonJS default export for the worker module loader. */
export default { StringDecoder }
