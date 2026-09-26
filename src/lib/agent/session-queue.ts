// src/lib/agent/session-queue.ts
const queues = new Map<string, Promise<unknown>>();

/** Runs one session's turns one after another (per server instance). */
export function inSessionOrder<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  queues.set(sessionId, tail);
  void tail.then(() => {
    if (queues.get(sessionId) === tail) queues.delete(sessionId);
  });
  return run;
}
