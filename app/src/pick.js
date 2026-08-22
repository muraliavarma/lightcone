// Picking (§6.5). An id-buffer pass: the pick shader runs the *same* §6.1 unfold
// as the display shader, so hover and click stay exact at every value of u —
// mid-animation included — with no CPU-side copy of 2.5M positions to keep in
// sync. Only a SIZE×SIZE window around the cursor is rendered (camera view
// offset), so the readback is 15×15 pixels.
import * as THREE from '../vendor/three/three.module.js';

const SIZE = 15;
const HALF = (SIZE - 1) / 2;

export class Picker {
  constructor(renderer, field) {
    this.renderer = renderer;
    this.field = field;
    this.rt = new THREE.WebGLRenderTarget(SIZE, SIZE, {
      depthBuffer: true, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter
    });
    this.buf = new Uint8Array(SIZE * SIZE * 4);
    this.enabled = true;
  }

  /** @returns {{chunk:number,index:number}|null} */
  pick(camera, xCss, yCss, wCss, hCss) {
    if (!this.enabled || !this.field.pickScene.children.length) return null;
    const r = this.renderer;
    camera.setViewOffset(wCss, hCss, xCss - HALF, yCss - HALF, SIZE, SIZE);
    const prevTarget = r.getRenderTarget();
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(this._prevColor || (this._prevColor = new THREE.Color()));
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(this.field.pickScene, camera);
    r.readRenderTargetPixels(this.rt, 0, 0, SIZE, SIZE, this.buf);
    r.setRenderTarget(prevTarget);
    r.setClearColor(this._prevColor, prevAlpha);
    camera.clearViewOffset();

    let best = null, bestD = 1e9;
    const b = this.buf;
    for (let py = 0; py < SIZE; py++) {
      for (let px = 0; px < SIZE; px++) {
        const o = (py * SIZE + px) * 4;
        if (b[o + 3] === 0) continue;
        const dx = px - HALF, dy = py - HALF;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { chunk: b[o + 3] - 1, index: b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) };
        }
      }
    }
    if (!best) return null;
    const c = this.field.chunks[best.chunk];
    if (!c || best.index >= c.count) return null;
    return best;
  }

  dispose() { this.rt.dispose(); }
}
