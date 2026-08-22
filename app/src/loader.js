// Manifest + chunk streaming (§6.2). Near shells first, then the rest in the
// background, parsed in a small worker pool.
import { DATA_ROOT, LAYERS } from './config.js';

const POOL = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

export async function loadManifest() {
  const res = await fetch(`${DATA_ROOT}/manifest.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${DATA_ROOT}/manifest.json`);
  const m = await res.json();
  if (!m.layers) throw new Error('manifest has no layers');
  m.__root = DATA_ROOT;
  return m;
}

/**
 * Streams every chunk in the manifest. Emits via onChunk({layer, path, buf, ...}).
 * Ordering: stars → local → DESI/quasar shells sorted by distance, so the first
 * thing on screen is the sky you actually stand in.
 */
export class ChunkStream {
  constructor(manifest, onChunk, onDone) {
    this.root = manifest.__root || DATA_ROOT;
    this.onChunk = onChunk;
    this.onDone = onDone;
    this.queue = [];
    this.inflight = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.loaded = 0;
    this.totalPoints = 0;
    this.loadedPoints = 0;

    const prio = { stars: 0, local: 1, web_bgs: 2, web_lrg: 3, qso_desi: 3, web_elg: 4, qso_sky: 5 };
    for (const layer of manifest.layers) {
      if (!LAYERS[layer.name]) { console.warn(`[lightcone] unknown layer "${layer.name}" — skipped`); continue; }
      layer.files.forEach((f, i) => {
        this.totalPoints += f.count;
        this.queue.push({
          layer: layer.name, path: f.path, count: f.count,
          hasTid: (f.arrays || []).includes('targetid'),
          isStars: layer.name === 'stars',
          key: (prio[layer.name] ?? 9) * 1000 + (f.dmax != null ? Math.min(999, Math.round(f.dmax / 12)) : i)
        });
      });
    }
    this.queue.sort((a, b) => a.key - b.key);
    this.total = this.queue.length;

    this.workers = [];
    for (let i = 0; i < POOL; i++) {
      const w = new Worker(new URL('./workers/chunk.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => this._done(w, ev.data);
      w.onerror = (e) => console.error('[lightcone] worker error', e.message);
      this.workers.push({ w, busy: false });
    }
  }

  start() { this._pump(); }

  _pump() {
    for (const slot of this.workers) {
      if (slot.busy || !this.queue.length) continue;
      const job = this.queue.shift();
      const id = this.nextId++;
      this.pending.set(id, job);
      slot.busy = true;
      // absolute — the worker's base URL is src/workers/, not the document's
      const url = new URL(`${this.root}/${job.path}`, location.href).href;
      slot.w.postMessage({ id, url, count: job.count, hasTid: job.hasTid, isStars: job.isStars });
    }
    if (!this.queue.length && !this.workers.some((s) => s.busy)) this._finish();
  }

  _done(w, msg) {
    const slot = this.workers.find((s) => s.w === w);
    if (slot) slot.busy = false;
    const job = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (!msg.ok) {
      console.error(`[lightcone] chunk ${job && job.path} failed: ${msg.error}`);
    } else {
      this.loaded++;
      this.loadedPoints += msg.count;
      try { this.onChunk({ ...job, ...msg }); }
      catch (e) { console.error('[lightcone] chunk install failed', e); }
    }
    this._pump();
  }

  _finish() {
    if (this._finished) return;
    this._finished = true;
    for (const s of this.workers) s.w.terminate();
    this.workers.length = 0;
    if (this.onDone) this.onDone(this);
  }
}
