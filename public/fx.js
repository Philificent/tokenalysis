/* Tokenalysis ambient FX: mote field, glass spotlight, card tilt.
   Purely decorative — dashboard works fine if this file fails. */
'use strict';

(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- activity governor ----------
     None of this file is load-bearing, so none of it should burn a GPU when
     nobody is looking at it. Three levels, published as :root[data-fx] so the
     stylesheet can park its ambient CSS animations at the same time:
       active — foreground and in use: full frame rate
       dim    — window unfocused, or no input for a while: motes throttled
       off    — tab hidden: every loop stopped dead */
  const IDLE_MS = 75000;
  const DIM_FRAME_MS = 50;        // ~20fps is plenty for drifting dust

  const fx = { level: 'active' };
  const wakers = [];
  let focused = document.hasFocus();
  let idle = false;
  let idleTimer = 0;

  function apply() {
    const next = document.hidden ? 'off' : (!focused || idle) ? 'dim' : 'active';
    if (next === fx.level) return;
    fx.level = next;
    document.documentElement.dataset.fx = next;
    if (next !== 'off') for (const wake of wakers) wake();
  }

  function markActive() {
    idle = false;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idle = true; apply(); }, IDLE_MS);
    apply();   // must run even when we were not idle: regaining focus lifts 'dim'
  }

  document.documentElement.dataset.fx = 'active';
  document.addEventListener('visibilitychange', apply);
  window.addEventListener('focus', () => { focused = true; markActive(); });
  window.addEventListener('blur', () => { focused = false; apply(); });
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart']) {
    window.addEventListener(ev, markActive, { passive: true });
  }
  markActive();
  apply();      // may already be hidden or unfocused on load

  /* ---------- floating motes: two depth layers ----------
     both canvases are painted *under* the content layer, so motes stay sharp
     and bright in the open gaps and get frosted/dimmed by the cards'
     backdrop-filter the moment they drift behind glass — real occlusion,
     no per-frame rect math. two layers exist purely for parallax depth. */

  const cursor = { x: -1e4, y: -1e4 };

  function startMotes(canvas, depth) {
    // depth 1 = foreground; depth < 1 = further back: slower, dimmer, softer
    const ctx = canvas.getContext('2d');
    const near = depth >= 1;
    let W = 0, H = 0, dpr = 1, motes = [];

    /* duotone-aware mote hues: read the theme's hue pair off :root */
    function moteHues() {
      const cs = getComputedStyle(document.documentElement);
      const ha = parseFloat(cs.getPropertyValue('--ha')) || 199;
      const hb = parseFloat(cs.getPropertyValue('--hb')) || 252;
      const dh = ha - 199;
      return [ha - 3, ha + 11, hb + 6, 168 + dh];
    }
    let hues = moteHues();
    window.addEventListener('tokenalysis-theme', () => {
      hues = moteHues();
      for (const m of motes) m.hue = hues[Math.random() * 4 | 0];
    });

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }

    function seed() {
      // most of the dust lives in the back layer so plenty actually crosses behind glass
      const n = Math.max(24, Math.min(near ? 70 : 110, Math.round((W * H) / 16000 * (near ? 0.55 : 0.9))));
      motes = Array.from({ length: n }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        r: (0.4 + Math.random() * 1.4) * (near ? 1.2 : 1.7),  // far dust is bigger, so the frost visibly smears it
        base: near ? 0.26 + Math.random() * 0.5 : 0.12 + Math.random() * 0.4,
        hue: hues[Math.random() * 4 | 0],
        vy: -(0.04 + Math.random() * 0.16) * depth,   // parallax: far dust drifts slower
        sway: (8 + Math.random() * 26) * depth,       // arc amplitude
        swaySpeed: 0.2 + Math.random() * 0.5,
        phase: Math.random() * Math.PI * 2,
        twinkle: 0.6 + Math.random() * 1.6,
      }));
    }

    let last = performance.now();
    let running = false;

    function schedule() {
      if (!running) return;
      // throttled instead of per-frame while dimmed: rAF alone still wakes at 60Hz
      if (fx.level === 'dim') setTimeout(() => requestAnimationFrame(frame), DIM_FRAME_MS);
      else requestAnimationFrame(frame);
    }

    function frame(now) {
      if (fx.level === 'off') { running = false; return; }
      const dt = Math.min(48, now - last) / 16.7;   // normalize to ~60fps ticks
      last = now;
      const t = now / 1000;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';

      for (const m of motes) {
        m.y += m.vy * dt;
        if (m.y < -8) { m.y = H + 8; m.x = Math.random() * W; }
        // arcs: horizontal position follows a gentle sine path
        const x = m.x + Math.sin(t * m.swaySpeed + m.phase) * m.sway;

        // proximity bloom: near layer only — the far dust ignores the cursor
        let prox = 0;
        if (near) {
          const dx = x - cursor.x, dy = m.y - cursor.y;
          const d2 = dx * dx + dy * dy;
          prox = Math.max(0, 1 - d2 / (200 * 200));
          if (prox > 0) m.x += (dx / (Math.sqrt(d2) + 1)) * prox * 0.7 * dt;
        }

        const a = Math.min(1, m.base * (0.55 + 0.45 * Math.sin(t * m.twinkle + m.phase)) + prox * 0.75);
        const r = m.r * (1 + prox * 1.6);
        // the near layer keeps a tight halo and a hard core, so it reads as *in
        // focus* against the soft far dust — and against its own frosted self
        // the moment it slips behind a card
        const spread = near ? 3.2 : 7;

        const g = ctx.createRadialGradient(x, m.y, 0, x, m.y, r * spread);
        if (near) {
          g.addColorStop(0, `hsla(${m.hue}, 95%, 88%, ${a})`);
          g.addColorStop(0.22, `hsla(${m.hue}, 92%, 76%, ${a * 0.6})`);
          g.addColorStop(0.6, `hsla(${m.hue}, 88%, 70%, ${a * 0.14})`);
        } else {
          g.addColorStop(0, `hsla(${m.hue}, 90%, 82%, ${a})`);
          g.addColorStop(0.35, `hsla(${m.hue}, 85%, 70%, ${a * 0.35})`);
        }
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, m.y, r * spread, 0, Math.PI * 2);
        ctx.fill();

        if (near) {   // crisp centre: the detail the glass blur then destroys
          ctx.fillStyle = `hsla(${m.hue}, 100%, 97%, ${a * 0.85})`;
          ctx.beginPath();
          ctx.arc(x, m.y, Math.max(0.55, r * 0.6), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      schedule();
    }

    wakers.push(() => {
      if (running) return;
      running = true;
      last = performance.now();
      requestAnimationFrame(frame);
    });
    window.addEventListener('resize', resize);
    resize();
    running = true;
    requestAnimationFrame(frame);
  }

  if (!reduced) {
    const front = document.getElementById('motes');
    const back = document.getElementById('motes-back');
    if (front) startMotes(front, 1);
    if (back) startMotes(back, 0.55);
  }

  /* ---------- shared cursor tracking: motes + glass spotlight ring ---------- */

  let spotRaf = 0;
  window.addEventListener('pointermove', (e) => {
    cursor.x = e.clientX;
    cursor.y = e.clientY;
    if (reduced || spotRaf) return;
    spotRaf = requestAnimationFrame(() => {
      spotRaf = 0;
      for (const el of document.querySelectorAll('.glass')) {
        const b = el.getBoundingClientRect();
        if (b.bottom < -80 || b.top > innerHeight + 80) continue;
        el.style.setProperty('--mx', `${((cursor.x - b.left) / b.width) * 100}%`);
        el.style.setProperty('--my', `${((cursor.y - b.top) / b.height) * 100}%`);
      }
    });
  }, { passive: true });

  /* ---------- headline card tilt (solid drawing: subtle 3D weight) ---------- */

  const cardsEl = document.getElementById('cards');
  if (cardsEl && !reduced) {
    cardsEl.addEventListener('pointermove', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      const b = card.getBoundingClientRect();
      const px = (e.clientX - b.left) / b.width - 0.5;
      const py = (e.clientY - b.top) / b.height - 0.5;
      card.style.transform =
        `rotateX(${(-py * 4).toFixed(2)}deg) rotateY(${(px * 5).toFixed(2)}deg) translateZ(6px)`;
      card.style.transition = 'transform 0.08s linear';
    });
    cardsEl.addEventListener('pointerleave', () => {
      for (const card of cardsEl.querySelectorAll('.card')) {
        card.style.transition = 'transform 0.7s cubic-bezier(0.34, 1.45, 0.42, 1)';
        card.style.transform = '';
      }
    }, true);
    cardsEl.addEventListener('pointerout', (e) => {
      const card = e.target.closest('.card');
      if (card && !card.contains(e.relatedTarget)) {
        card.style.transition = 'transform 0.7s cubic-bezier(0.34, 1.45, 0.42, 1)';
        card.style.transform = '';
      }
    });
  }
})();
