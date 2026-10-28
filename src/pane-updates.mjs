import { InMemoryServerEventBus } from '@modelcontextprotocol/server';
import { directoryText, PANES_URI, readDirectory } from './directory.mjs';

// One bounded CLI observer per bridge, not per client or pane. The SDK owns
// subscription acknowledgements, filtering, IDs and notification delivery.
export function createPaneUpdates({ runner, intervalMs = 2000 }) {
  const events = new InMemoryServerEventBus();
  let users = 0, generation = 0, controller, timer, pending, latest, observedAt = 0, closed = false;

  function stop() {
    generation++;
    clearTimeout(timer);
    controller?.abort();
    controller = undefined;
    pending = undefined;
    latest = undefined;
    observedAt = 0;
  }

  async function sample(epoch, signal) {
    const text = directoryText(await readDirectory(runner, signal));
    if (epoch !== generation || signal.aborted) return;
    const changed = latest !== undefined && text !== latest;
    latest = text;
    observedAt = Date.now();
    if (changed) events.publish({ kind: 'resource_updated', uri: PANES_URI });
    // Schedule after completion: slow Herdr responses never overlap observations.
    timer = setTimeout(() => { pending = sample(epoch, signal); }, intervalMs);
    timer.unref();
  }

  const bus = {
    publish(event) { events.publish(event); },
    subscribe(listener) {
      if (closed) throw new Error('Pane observer closed');
      const unsubscribe = events.subscribe(listener);
      if (++users === 1) {
        controller = new AbortController();
        pending = sample(++generation, controller.signal);
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        unsubscribe();
        if (--users === 0) stop();
      };
    },
  };

  return {
    bus,
    async read(signal) {
      signal?.throwIfAborted();
      if (users > 0 && latest !== undefined && Date.now() - observedAt <= intervalMs * 2) return latest;
      if (users > 0 && pending) {
        // A separate first read could finish older than the observer's baseline,
        // leaving the client stale with no change notification. Share that read.
        const epoch = generation;
        let abort;
        const cancelled = new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          signal?.addEventListener('abort', abort, { once: true });
        });
        try { await Promise.race([pending, cancelled]); }
        finally { signal?.removeEventListener('abort', abort); }
        if (epoch === generation && latest !== undefined) return latest;
      }
      return directoryText(await readDirectory(runner, signal));
    },
    close() { closed = true; stop(); },
  };
}
