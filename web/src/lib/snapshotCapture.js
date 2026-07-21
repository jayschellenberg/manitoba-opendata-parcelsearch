/** Browser-independent readiness/retry helpers for parcel snapshots. */

export class MapRenderTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Map did not become idle within ${timeoutMs} ms.`);
    this.name = 'MapRenderTimeoutError';
  }
}

export class StaleSnapshotFrameError extends Error {
  constructor(currentName, priorName) {
    super(`Snapshot ${currentName} duplicated the rendered frame for ${priorName}.`);
    this.name = 'StaleSnapshotFrameError';
  }
}

/**
 * Wait until MapLibre reports that the current frame is idle. A timeout is a
 * failure, not a substitute for readiness: accepting it would capture the
 * previous parcel still present in the WebGL canvas.
 *
 * Kept separate from snapshotExport.js so this contract can be tested without
 * importing MapLibre's browser-only CSS in Node.
 */
export function waitForMapIdle(map, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      map.off('idle', onIdle);
      clearTimeout(timer);
    };
    const onIdle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new MapRenderTimeoutError(timeoutMs));
    }, timeoutMs);
    map.on('idle', onIdle);
    map.triggerRepaint();
  });
}

function retryableCaptureError(err) {
  return err instanceof MapRenderTimeoutError || err instanceof StaleSnapshotFrameError;
}

/**
 * Run one parcel capture with bounded retries for readiness/stale-frame errors.
 * Other failures (canvas encoding, teardown, programming errors) surface
 * immediately instead of being hidden behind repeated attempts.
 */
export async function captureSnapshotWithRetry({
  prepare,
  waitUntilReady,
  capture,
  validate,
  attempts = 3,
  onRetry,
}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError('Snapshot capture attempts must be a positive integer.');
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await prepare(attempt);
    try {
      await waitUntilReady(attempt);
      const result = await capture(attempt);
      await validate?.(result, attempt);
      return result;
    } catch (err) {
      if (!retryableCaptureError(err) || attempt === attempts) throw err;
      onRetry?.({ attempt, nextAttempt: attempt + 1, error: err });
    }
  }

  throw new Error('Snapshot capture exhausted its retry loop.');
}

function sameBounds(a, b) {
  return Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Return the prior parcel whose exact JPEG bytes were reused for a different
 * geographic extent. Identical bytes are allowed when the input legitimately
 * repeats the same parcel bounds.
 */
export function findStaleSnapshotFrame(priorFrames, candidate) {
  for (const prior of priorFrames || []) {
    if (sameBounds(prior.bounds, candidate.bounds)) continue;
    if (sameBytes(prior.data, candidate.data)) return prior;
  }
  return null;
}
