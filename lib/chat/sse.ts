import { subscribe, type ChatEvent } from "./bus";

const HEARTBEAT_MS = 25_000;

/**
 * A Server-Sent-Events response that forwards chat events this viewer is
 * allowed to know about. Events are ids only ("conversation X has a new
 * message"); the browser then fetches through the normal, checked API.
 *
 * `no-transform` keeps `next start`'s gzip (and proxies) from buffering
 * the stream; `X-Accel-Buffering: no` does the same for nginx-style
 * proxies. The heartbeat keeps idle connections alive and doubles as the
 * presence signal.
 */
export function chatEventStream(
  request: Request,
  options: {
    accept: (event: ChatEvent) => boolean;
    onHeartbeat?: () => void;
  },
): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };

      const unsubscribe = subscribe((event) => {
        if (options.accept(event)) send(`event: chat\ndata: ${JSON.stringify(event)}\n\n`);
      });
      const timer = setInterval(() => {
        options.onHeartbeat?.();
        send(`: ping ${Date.now()}\n\n`);
      }, HEARTBEAT_MS);

      function close() {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
      cleanup = close;
      request.signal.addEventListener("abort", close);

      options.onHeartbeat?.();
      // Tells the browser how long to wait before reconnecting, and that
      // the stream is live.
      send(`retry: 3000\nevent: ready\ndata: {}\n\n`);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
