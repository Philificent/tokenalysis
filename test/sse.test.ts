import { describe, expect, it } from 'vitest';
import { parseSseData, tapSseStream } from '../src/proxy/sse.js';

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20250514","usage":{"input_tokens":25,"cache_creation_input_tokens":1024,"cache_read_input_tokens":40000,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

describe('parseSseData', () => {
  it('extracts JSON payloads from SSE events', () => {
    const events = parseSseData(ANTHROPIC_SSE);
    expect(events).toHaveLength(5);
    expect((events[0] as { type: string }).type).toBe('message_start');
    expect((events[4] as { type: string }).type).toBe('message_stop');
  });

  it('skips [DONE] and non-JSON payloads', () => {
    const text = 'data: {"a":1}\n\ndata: [DONE]\n\ndata: not-json\n\n';
    const events = parseSseData(text);
    expect(events).toEqual([{ a: 1 }]);
  });

  it('joins multi-line data fields', () => {
    const text = 'data: {"a":\ndata: 1}\n\n';
    expect(parseSseData(text)).toEqual([{ a: 1 }]);
  });

  it('handles CRLF separators', () => {
    const text = 'data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n';
    expect(parseSseData(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('tapSseStream', () => {
  it('client receives byte-identical stream while tap parses events', async () => {
    const encoder = new TextEncoder();
    // Split the fixture into awkward chunk boundaries to exercise reassembly.
    const bytes = encoder.encode(ANTHROPIC_SSE);
    const chunks = [bytes.slice(0, 7), bytes.slice(7, 150), bytes.slice(150, 151), bytes.slice(151)];
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    const { clientStream, events } = tapSseStream(upstream);

    const received: Uint8Array[] = [];
    const reader = clientStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(value);
    }
    const clientText = new TextDecoder().decode(
      new Uint8Array(received.reduce<number[]>((acc, c) => acc.concat([...c]), []))
    );
    expect(clientText).toBe(ANTHROPIC_SSE);

    const parsed = await events;
    expect(parsed).toHaveLength(5);
    expect((parsed[3] as { usage: { output_tokens: number } }).usage.output_tokens).toBe(42);
  });
});
