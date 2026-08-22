// Lightcone — entry point. Wires the three-stage camera (§6.1) to the point
// field (§6.2), the imagery (§6.3), the parsec-scale star ball (§6.4), picking
// and the drill-down panel (§6.5), the HUD (§6.6) and the tour (§6.7).
import * as THREE from '../vendor/three/three.module.js';
import {
  STAGE, LAYERS, GROUPS, REDUCED_MOTION, FOV_PHOTO_START,
  DPR_MAX, LOW_POWER, QUALITY, LENS_HALF_GYR, R_SKY, LOCATE_FOV
} from './config.js?v=3';
import { loadManifest, ChunkStream } from './loader.js';
import { initCosmo, xyzToRaDec, zOfTlb, dcOfZ, tlbOfZ, zOfDc } from './cosmo.js';
import { PointField } from './points.js';
import { StarField } from './stars.js';
import { Sky } from './sky.js?v=3';
import { CameraRig } from './camera.js';
import { Picker } from './pick.js';
import { Panel } from './panel.js?v=3';
import { Hud } from './hud.js';
import { Tour } from './tour.js';
import { readHash, writeHash } from './urlstate.js';

const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, alpha: false, powerPreference: 'high-performance',
  stencil: false, depth: true
});
renderer.autoClear = false;
renderer.setClearColor(0x05070B, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

let dpr = Math.min(DPR_MAX, devicePixelRatio || 1);
let W = 1, H = 1;

// -------------------------------------------------- HDR accumulation + rolloff
//
// Two million additively-blended points stack far past 1.0 wherever the cone
// converges, and an 8-bit canvas clips that to a featureless white disc — the
// densest, most interesting part of the cosmic web is exactly the part that
// disappears. So the scene accumulates into a half-float buffer and one
// fullscreen pass rolls the highlights off: identity below the knee, asymptotic
// to 1 above it, applied to the brightest channel so hue survives.
const Composite = (() => {
  // The lite catalog is already sparse enough to avoid highlight clipping; skip
  // an extra half-float framebuffer on memory-constrained phones.
  if (LOW_POWER) return null;
  const ext = renderer.extensions;
  const floatRT = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
  // no float target (or no WebGL2): render straight to the canvas and accept
  // that the densest knots clip — everything else still works
  if (!renderer.capabilities.isWebGL2 || !floatRT) return null;
  const rt = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: rt.texture }, uKnee: { value: 0.62 } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      precision highp float;
      uniform sampler2D uTex;
      uniform float uKnee;
      varying vec2 vUv;
      void main() {
        vec3 c = max(texture2D(uTex, vUv).rgb, 0.0);
        float m = max(c.r, max(c.g, c.b));
        if (m > uKnee) {
          float k = uKnee + (1.0 - uKnee) * (1.0 - exp(-(m - uKnee) / (1.0 - uKnee)));
          c *= k / m;
        }
        gl_FragColor = vec4(c, 1.0);
      }`,
    depthTest: false, depthWrite: false
  });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return {
    rt, scene, cam,
    resize(w, h) { rt.setSize(Math.max(1, w), Math.max(1, h)); },
    begin() { renderer.setRenderTarget(rt); renderer.clear(true, true, false); },
    end() { renderer.setRenderTarget(null); renderer.render(scene, cam); }
  };
})();

const field = new PointField();
const stars = new StarField();
const rig = new CameraRig(canvas);
const picker = new Picker(renderer, field);
const panel = new Panel(document.getElementById('panel'));
let sky = null, tour = null, hud = null, stream = null;

const _v = new THREE.Vector3();
const _markPos = new THREE.Vector3();
const selectionMark = document.getElementById('selectionMark');
const selectionLabel = document.getElementById('selectionLabel');
const pointer = { x: 0, y: 0, on: false, moved: false };
let selected = null, markX = NaN, markY = NaN;
let hoverKey = '', lastPick = 0, lastHash = 0;

// ---------------------------------------------------------------- selection

function selectAt(cx, cy) {
  const hit = picker.pick(rig.camera, cx, cy, W, H);
  if (!hit) return null;
  const c = field.chunks[hit.chunk];
  const i = hit.index;
  const x = c.pos[i * 3], y = c.pos[i * 3 + 1], z = c.pos[i * 3 + 2];
  const rd = xyzToRaDec(x, y, z);
  return {
    chunk: hit.chunk, index: i, layer: c.layer, px: x, py: y, pz: z,
    ra: rd.ra, dec: rd.dec, z: c.sec[i], distance: Math.hypot(x, y, z),
    // §2a: TARGETID is int64 > 2^53 — it never becomes a Number
    tidStr: c.tid ? c.tid[i].toString() : null
  };
}

function setSelected(sel) {
  selected = sel || null;
  selectionMark.hidden = true;       // projection reveals it on the next frame
  markX = markY = NaN;
  if (!selected) return;
  selectionLabel.textContent = `selected ${String(LAYERS[selected.layer]?.label || 'object').toLowerCase()}`;
  selectionMark.classList.remove('ping');
  // Restart the restrained acquisition pulse when a different point is picked.
  void selectionMark.offsetWidth;
  selectionMark.classList.add('ping');
}

function updateSelectionMark() {
  if (!selected) return;
  let { px: x, py: y, pz: z } = selected;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    const r = selected.distance || dcOfZ(selected.z);
    const ra = selected.ra * Math.PI / 180, dec = selected.dec * Math.PI / 180;
    const cd = Math.cos(dec);
    x = r * cd * Math.cos(ra); y = r * cd * Math.sin(ra); z = r * Math.sin(dec);
  }
  const d = Math.hypot(x, y, z);
  if (!(d > 0)) { selectionMark.hidden = true; return; }
  // Match the point shader exactly: sky-sphere position in 2D, measured xyz in 3D.
  const scale = (1 - rig.st.u) * R_SKY / d + rig.st.u;
  _markPos.set(x * scale, y * scale, z * scale).project(rig.camera);
  const visible = _markPos.z >= -1 && _markPos.z <= 1 &&
    Math.abs(_markPos.x) <= 1.03 && Math.abs(_markPos.y) <= 1.03;
  const hide = !visible;
  if (selectionMark.hidden !== hide) selectionMark.hidden = hide;
  if (!visible) return;
  const sx = (_markPos.x * 0.5 + 0.5) * W;
  const sy = (0.5 - _markPos.y * 0.5) * H;
  if (!Number.isFinite(markX) || Math.abs(sx - markX) > 0.05) {
    markX = sx; selectionMark.style.left = `${sx}px`;
  }
  if (!Number.isFinite(markY) || Math.abs(sy - markY) > 0.05) {
    markY = sy; selectionMark.style.top = `${sy}px`;
  }
}

function openSelection(sel) {
  if (!sel) { panel.close(); return; }
  setSelected(sel);
  panel.open(sel);
  document.getElementById('hud').classList.add('panelopen');
}

function setLens(on, lookback, updateHud = true) {
  const t = Math.max(0, Math.min(12.8, Number(lookback) || 0));
  const loT = Math.max(0, t - LENS_HALF_GYR);
  const hiT = Math.min(12.866, t + LENS_HALF_GYR);
  const lo = dcOfZ(zOfTlb(loT));
  const hi = dcOfZ(zOfTlb(hiT));
  field.setLens(on, lo, hi);
  stars.setLens(on);
  if (updateHud && hud) hud.setLensState(on, t);
  queueHash();
}

// ------------------------------------------------------------------ permalink

const currentHash = () => location.hash;
let lastWritten = '';

function applyHash(h) {
  if (!h) return;
  Object.assign(rig.st, {
    ra: h.ra, dec: h.dec, fov: h.fov, u: h.u, dist: h.dist,
    oyaw: h.oyaw, opitch: h.opitch, fx: h.fx, fy: h.fy, fz: h.fz
  });
  rig.stage = h.stage;
  rig.released = h.stage === STAGE.FREE;
  rig.fovPhoto = h.u < 0.5 ? h.fov : FOV_PHOTO_START;
  rig.tw = null;
  rig.dirty = true;
  sky.setEnabled(h.photo);
  hud.setPhotoChip(h.photo);
  hud.setGroups(h.off);
  for (const g of GROUPS) {
    const on = !h.off.includes(g.id);
    if (g.id === 'stars') stars.setEnabled(on); else field.setGroupVisible(g.id, on);
  }
  setLens(h.lens, h.lookback, true);
  hud.setMode(rig.stage, rig.st.u);
}

// -------------------------------------------------------------------- boot

async function boot() {
  const manifest = await loadManifest();
  initCosmo(manifest);
  sky = new Sky(field.scene, manifest.__root, renderer.capabilities.maxTextureSize);

  hud = new Hud({
    onGroup: (g, on) => {
      if (g === 'stars') stars.setEnabled(on); else field.setGroupVisible(g, on);
      queueHash();
    },
    onPhoto: (on) => { sky.setEnabled(on); queueHash(); },
    onMode: (m) => { m ? rig.unfold() : rig.home(); if (tour) tour.stop(); },
    onHome: () => { panel.close(); setSelected(null); rig.home(); if (tour) tour.stop(); },
    onFree: () => rig.release(),
    onLens: (on, lookback) => setLens(on, lookback, false),
    onTour: () => tour && tour.toggle()
  });
  sky.onSource = (s) => hud.setSource(s);
  panel.onClose = () => {
    hoverKey = '';
    setSelected(null);
    document.getElementById('hud').classList.remove('panelopen');
  };
  panel.onLocate = (sel) => {
    panel.close();
    setSelected(sel);
    sky.setEnabled(true);
    hud.setPhotoChip(true);
    const t = tlbOfZ(zOfDc(sel.distance));
    setLens(true, t, true);
    rig.showSky(sel.ra, sel.dec, LOCATE_FOV);
    hud.dismissHint();
  };

  tour = new Tour(rig, {
    card: document.getElementById('tourCard'),
    step: document.getElementById('tStep'),
    title: document.getElementById('tTitle'),
    text: document.getElementById('tText'),
    next: document.getElementById('tNext'),
    prev: document.getElementById('tPrev'),
    exit: document.getElementById('tExit')
  }, () => hud.setMode(rig.stage, rig.st.u));
  // a stale object panel over a moving tour reads as a bug — every stop clears it
  tour.onGo = () => { panel.close(); setLens(false, hud.lookback, true); };
  tour.load(manifest.__root);

  // permalink restore (§6.6)
  applyHash(readHash());
  // a hash pasted into the address bar of a running page must land too;
  // our own writes go through replaceState, which never fires this
  addEventListener('hashchange', () => { if (currentHash() !== lastWritten) applyHash(readHash()); });

  let first = true;
  stream = new ChunkStream(manifest, (job) => {
    if (job.isStars) stars.add(job);
    else {
      const c = field.add(job);
      if (c && hud.off.has(c.group)) { c.mesh.visible = false; if (c.pick) c.pick.visible = false; }
    }
    hud.setPoints(field.pointsLoaded + stars.count);
    if (first) { first = false; hud.bootDone(); }
  }, (s) => {
    console.info(`[lightcone] ${s.loadedPoints.toLocaleString()} points in ${s.loaded}/${s.total} chunks`);
  });
  stream.start();
  setTimeout(() => hud.bootDone(), 6000);

  if (new URLSearchParams(location.search).has('debug')) {
    window.__lc = { renderer, field, stars, sky, rig, picker, panel, hud, tour, manifest, quality: QUALITY, setLens };
  }
  rig.onChange = () => { hud.setMode(rig.stage, rig.st.u); queueHash(); };
  hud.setMode(rig.stage, rig.st.u);
  bindInput();
  resize();
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------- input

function bindInput() {
  rig.onClick = (e) => {
    const sel = selectAt(e.clientX, e.clientY);
    openSelection(sel);
    hud.dismissHint();
  };
  rig.onDoubleClick = (e) => {
    const sel = selectAt(e.clientX, e.clientY);
    if (!sel) return;
    field.truePos(sel.chunk, sel.index, _v);
    rig.focusOn(_v);
    hud.setMode(rig.stage, rig.st.u);
  };
  canvas.addEventListener('pointermove', (e) => {
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.on = true; pointer.moved = true;
  });
  canvas.addEventListener('pointerleave', () => {
    pointer.on = false; hud.tip(0, 0, ''); canvas.classList.remove('over');
  });
  canvas.addEventListener('pointerdown', () => canvas.classList.add('grabbing'));
  addEventListener('pointerup', () => canvas.classList.remove('grabbing'));
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.isOpen) { panel.close(); return; }
    if (e.target !== document.body && e.target !== canvas) return;
    if (e.key === 'h' || e.key === 'H') rig.home();
    else if (e.key === 'd' || e.key === 'D') rig.unfold();
  });
  addEventListener('resize', resize);
}

function resize() {
  W = Math.max(1, innerWidth);
  H = Math.max(1, innerHeight);
  dpr = Math.min(DPR_MAX, devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);
  renderer.setSize(W, H, false);
  if (Composite) Composite.resize(Math.round(W * dpr), Math.round(H * dpr));
  rig.resize(W, H);
}

let hashPending = false;
function queueHash() { hashPending = true; }

// -------------------------------------------------------------- render loop

function loop(now) {
  requestAnimationFrame(loop);

  // Hover picking runs first: readRenderTargetPixels syncs with the GPU, and at
  // the top of a frame last frame's work has already drained, so the stall is
  // ~0.9 ms instead of a full pipeline flush. One 15×15 id pass, throttled.
  if (pointer.on && pointer.moved && !rig.tw && now - lastPick > 90) {
    lastPick = now; pointer.moved = false;
    const sel = selectAt(pointer.x, pointer.y);
    const key = sel ? `${sel.chunk}:${sel.index}` : '';
    if (key !== hoverKey) {
      hoverKey = key;
      canvas.classList.toggle('over', !!sel);
      hud.tip(pointer.x, pointer.y, sel
        ? `${LAYERS[sel.layer].label}   z ${sel.z.toFixed(4)}${sel.tidStr ? `   ${sel.tidStr}` : ''}`
        : '');
    } else if (sel) {
      hud.tip(pointer.x, pointer.y, hud.tipEl.textContent);
    }
  }

  rig.update(now);
  updateSelectionMark();

  const u = rig.st.u;
  const atten = rig.atten(H);
  field.mix = u;
  // Exposure + density gain track the camera's stand-off, so whatever you flew
  // to is legible at every scale from 40 Mpc to 8 Gpc. Ring markers come up only
  // where a real photograph is behind the dots (§6.3).
  const ring = sky.detailOn ? Math.max(0, 1 - u / 0.25) : 0;
  if (pointer.on) field.shared.uCursor.value.set((pointer.x / W) * 2 - 1, 1 - (pointer.y / H) * 2);
  else field.shared.uCursor.value.set(0, 0);
  field.frame(atten, dpr, rig.st.dist || 420, ring, rig.focus);
  sky.setMix(u);
  sky.update(rig.st.ra, rig.st.dec, rig.st.fov, u, W / H);

  if (Composite) Composite.begin(); else renderer.clear(true, true, false);
  renderer.render(field.scene, rig.camera);
  if (stars.sync(rig.camera, atten, dpr)) renderer.render(stars.scene, stars.camera);
  if (Composite) Composite.end();

  hud.setReadout(rig);
  hud.tick(now);

  if (hashPending && now - lastHash > 260) {
    hashPending = false; lastHash = now;
    writeHash(rig, hud.photo, hud.offGroups, hud.lens, hud.lookback);
    lastWritten = location.hash;
  }
}

boot().catch((err) => {
  console.error('[lightcone] boot failed', err);
  const b = document.getElementById('boot');
  if (b) b.innerHTML = `<span style="color:#D9A84E">could not load app/data — ${String(err.message || err)}</span>`;
});

if (REDUCED_MOTION) document.documentElement.classList.add('reduced');
