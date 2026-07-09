/**
 * Reassembles UTF-8 text from a byte stream where multibyte codepoints may be split
 * across frames. Wraps a streaming TextDecoder (available in browsers and Node >= 18).
 *
 * The Tabby desktop guest gets equivalent behaviour from Tabby's UTF8SplitterMiddleware;
 * the web-client and future native/mobile clients use this.
 */
export class Utf8Splitter {
    private readonly decoder = new TextDecoder('utf-8')

    /** Decode a chunk, holding back any trailing incomplete multibyte sequence. */
    write(bytes: Uint8Array): string {
        return this.decoder.decode(bytes, { stream: true })
    }

    /** Flush any buffered bytes at end of stream (emits U+FFFD for a truncated tail). */
    flush(): string {
        return this.decoder.decode()
    }
}
