/* Tokenalysis ambient FX: mote field, glass spotlight, card tilt.
   Purely decorative — dashboard works fine if this file fails. */
'use strict';

(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- floating motes: two depth layers ----------
     both canvases are painted *under* the content layer, so motes stay sharp
     and bright in the open gaps and get frosted/dimmed by the cards'
     backdrop-filter the moment they drift behind glass — real occlusion,
     no per-frame rect math. two layers exist purely for parallax depth. */

  const cursor = { x: -1e4, y: -1e4 };

  function startMotes(canvas, depth) {
    // depth 1 = foreground; depth < 1 = further back: slower, dimmer, softer
    const ctx = canvas.getContext('2d');
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
      const n = Math.max(24, Math.min(depth < 1 ? 110 : 70, Math.round((W * H) / 16000 * (depth < 1 ? 0.9 : 0.55))));
      motes = Array.from({ length: n }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        r: (0.4 + Math.random() * 1.4) * (depth < 1 ? 1.7 : 1),  // far dust is bigger, so the frost visibly smears it
        base: 0.12 + Math.random() * 0.4,       // resting brightness — the glass itself does the dimming
        hue: hues[Math.random() * 4 | 0],
        vy: -(0.04 + Math.random() * 0.16) * depth,   // parallax: far dust drifts slower
        sway: (8 + Math.random() * 26) * depth,       // arc amplitude
        swaySpeed: 0.2 + Math.random() * 0.5,
        phase: Math.random() * Math.PI * 2,
        twinkle: 0.6 + Math.random() * 1.6,
      }));
    }

    let last = performance.now();
    function frame(now) {
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
        let near = 0;
        if (depth >= 1) {
          const dx = x - cursor.x, dy = m.y - cursor.y;
          const d2 = dx * dx + dy * dy;
          near = Math.max(0, 1 - d2 / (200 * 200));
          if (near > 0) m.x += (dx / (Math.sqrt(d2) + 1)) * near * 0.7 * dt;
        }

        const a = m.base * (0.55 + 0.45 * Math.sin(t * m.twinkle + m.phase)) + near * 0.75;
        const r = m.r * (1 + near * 1.6);
        const spread = depth < 1 ? 7 : 5;   // far motes render softer

        const g = ctx.createRadialGradient(x, m.y, 0, x, m.y, r * spread);
        g.addColorStop(0, `hsla(${m.hue}, 90%, 82%, ${Math.min(1, a)})`);
        g.addColorStop(0.35, `hsla(${m.hue}, 85%, 70%, ${Math.min(1, a) * 0.35})`);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, m.y, r * spread, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!document.hidden) requestAnimationFrame(frame);
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { last = performance.now(); requestAnimationFrame(frame); }
    });
    window.addEventListener('resize', resize);
    resize();
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
