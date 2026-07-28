/**
 * Pass-through SSE tap: pipes upstream bytes to the client untouched while
 * accumulating `data:` payloads for side-channel parsing.
 */

/** Parse a complete SSE body into JSON data payloads (ignores non-JSON, [DONE], comments). */
export function parseSseData(text: string): unknown[] {
  const out: unknown[] = [];
  // Events are separated by blank lines; data may span multiple `data:` lines.
  const events = text.split(/\r?\n\r?\n/);
  for (const event of events) {
    const dataLines: string[] = [];
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      // non-JSON data payload; skip
    }
  }
  return out;
}

export interface TappedStream {
  /** Stream to hand to the client; bytes are identical to upstream. */
  clientStream: ReadableStream<Uint8Array>;
  /** Resolves with parsed SSE JSON payloads when upstream completes (or errors). */
  events: Promise<unknown[]>;
}

/**
 * Tee an upstream body: the client gets a byte-identical stream, and a
 * background reader accumulates the text and parses SSE events at end.
 * Parsing failures never affect the client stream.
 */
export function tapSseStream(upstream: ReadableStream<Uint8Array>): TappedStream {
  const [clientBranch, tapBranch] = upstream.tee();

  const events = (async (): Promise<unknown[]> => {
    const decoder = new TextDecoder();
    let text = '';
    try {
      const reader = tapBranch.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch {
      // tap failure must not break anything; parse what we have
    }
    return parseSseData(text);
  })();

  return { clientStream: clientBranch, events };
}
