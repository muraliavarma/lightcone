// Chunk worker (§6.2): fetches a binary chunk off the main thread, validates the
// struct-of-arrays layout from §4, computes the bounds the renderer needs, and
// transfers the raw ArrayBuffer back. Zero copies — the main thread builds
// typed-array views straight onto this buffer.
//
// Layout, little-endian:
//   [Float32 xyz × 3N][Float32 z(or mag) × N][BigInt64 targetid × N  (optional)]

self.onmessage = async (ev) => {
  const { id, url, count, hasTid, isStars } = ev.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();

    const need = count * 16 + (hasTid ? count * 8 : 0);
    if (buf.byteLength < need) {
      throw new Error(`short chunk: ${buf.byteLength} B < ${need} B for ${count} pts`);
    }

    // Bounds (used for the boundingSphere; the shader remaps positions, so this
    // is an upper bound only — chunks render with frustumCulled = false).
    const xyz = new Float32Array(buf, 0, count * 3);
    let dmin = Infinity, dmax = 0, bad = 0;
    for (let i = 0; i < count; i++) {
      const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
      const d2 = x * x + y * y + z * z;
      if (!(d2 > 0) || !isFinite(d2)) { bad++; continue; }
      if (d2 < dmin) dmin = d2;
      if (d2 > dmax) dmax = d2;
    }
    dmin = dmin === Infinity ? 0 : Math.sqrt(dmin);
    dmax = Math.sqrt(dmax);

    // Secondary array range (redshift, or magnitude for the stars layer).
    const sec = new Float32Array(buf, count * 12, count);
    let smin = Infinity, smax = -Infinity;
    for (let i = 0; i < count; i++) {
      const v = sec[i];
      if (!isFinite(v)) continue;
      if (v < smin) smin = v;
      if (v > smax) smax = v;
    }

    self.postMessage({ id, ok: true, buf, count, hasTid, isStars, dmin, dmax, smin, smax, bad }, [buf]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
