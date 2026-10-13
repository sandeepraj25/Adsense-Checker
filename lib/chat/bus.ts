/**
 * In-process notifications for live chat.
 *
 * A message saved by one request has to reach browsers holding open
 * Server-Sent-Event streams in other requests. On a single Node server —
 * how this app is deployed (one `next start` with SQLite on its disk) —
 * an EventEmitter on globalThis does that with no extra service.
 *
 * Events carry ids only, never message text: each stream re-reads what
 * changed through the same ownership checks as the REST endpoints, so the
 * bus cannot leak a message to the wrong subscriber. Behind several
 * instances this would move to Redis pub/sub; the call sites would not
 * change. Clients also re-sync on reconnect, so a missed event costs a
 * second of latency, not a message.
 */

import { EventEmitter } from "node:events";

export type ChatEvent =
  | { type: "message"; conversationId: string; from: "customer" | "agent" }
  | { type: "conversation"; conversationId: string }
  | { type: "presence" };

type GlobalWithBus = typeof globalThis & { __chatBus?: EventEmitter };
const globalRef = globalThis as GlobalWithBus;

function bus(): EventEmitter {
  if (!globalRef.__chatBus) {
    globalRef.__chatBus = new EventEmitter();
    // One listener per open stream; the default warning at 10 is noise.
    globalRef.__chatBus.setMaxListeners(0);
  }
  return globalRef.__chatBus;
}

export function publish(event: ChatEvent): void {
  bus().emit("chat", event);
}

export function subscribe(listener: (event: ChatEvent) => void): () => void {
  bus().on("chat", listener);
  return () => bus().off("chat", listener);
}
