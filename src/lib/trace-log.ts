// Toggleable per-call tracing for controllers and middleware — separate from the structured
// pino logger in logger.ts. Meant to be cheap to read on a live console while chasing a
// request through the stack. Flip it off with CONSOLE_TRACE=false (or disableConsoleTrace())
// once it's not needed, and swap the body of traceLog() for a winston call later — every call
// site stays the same either way.

import { env } from "../config/env.js";

let enabled = env.CONSOLE_TRACE;

export function enableConsoleTrace(): void {
  enabled = true;
}

export function disableConsoleTrace(): void {
  enabled = false;
}

export function isConsoleTraceEnabled(): boolean {
  return enabled;
}

export function traceLog(name: string, data?: Record<string, unknown>): void {
  if (!enabled) return;
  console.log(`[trace] ${name}`, data ?? {});
}
