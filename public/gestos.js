// ============================================================
// Efeitos de mao (gestos)
//
// Portado do prototipo "GESTO — efeitos por gesto". A deteccao roda no
// aparelho de quem liga a camera e os efeitos sao assados na imagem antes
// de ela ser transmitida — senao so quem fez o gesto veria o resultado.
//
// Diferencas em relacao ao prototipo:
//  - la o enquadramento acompanhava a janela; aqui o canvas tem tamanho fixo,
//    entao 'view' e uma constante e a conta de object-fit some.
//  - la a imagem era espelhada (voce se ve como num espelho); aqui NAO, porque
//    esta e a imagem que os outros recebem.
//  - la os efeitos de cor eram filtros CSS sobre a pilha de camadas; aqui viram
//    parametros do mesmo shader dos filtros, para poderem ser transmitidos.
//
// Exige ~18 MB de download na primeira vez (modelo + wasm do MediaPipe), por
// isso e carregado sob demanda e so no computador.
// ============================================================
(function (global) {
  'use strict';

  const CONFIG = {
    mediapipeVersion: "0.10.21",
    modelUrl: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
    numHands: 2,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.5,
    gestureMinScore: 0.6,
    gestureHoldMs: 150,
    handGraceMs: 180,
    pinchOn: 0.36,
    pinchOff: 0.50,
    joinFraction: 0.09,
    smoothing: { minCutoff: 1.6, beta: 12, dCutoff: 1.0 },
  };

  const GESTURES = [
    { id:"palma",   name:"Palma aberta", effect:"AURORA",  model:"Open_Palm",   fx:"aurora" },
    { id:"paz",     name:"Paz",          effect:"MOSAICO", model:"Victory",     fx:"mosaic" },
    { id:"joia",    name:"Joia",         effect:"VINTAGE", model:"Thumb_Up",
      shader:{ sepia:0.85, saturation:1.5, contrast:1.08, brightness:0.96, vignette:0.6 } },
    { id:"apontar", name:"Apontar",      effect:"CONTORNO",model:"Pointing_Up",
      shader:{ gray:1, contrast:2.1, brightness:1.15 } },
    { id:"linhas",  name:"Pinça dupla",  effect:"LINHAS",
      shader:{ brightness:0.55, saturation:0.65 } },
    { id:"triangulacao", name:"Pinça + mão aberta", effect:"TRIÂNGULOS",
      shader:{ brightness:0.6, saturation:0.7 } },
  ];
  const GESTURE_BY_ID = Object.fromEntries(GESTURES.map(g => [g.id, g]));
  const GESTURE_BY_MODEL = Object.fromEntries(GESTURES.filter(g => g.model).map(g => [g.model, g.id]));

  const TIP_IDX = [4, 8, 12, 16, 20];   // pontas: polegar, indicador, medio, anelar, mindinho
  const TAU = Math.PI * 2;
  const CYAN = "#63e8d4", AMBER = "#ffb648", WHITE = "#ffffff";
  const Z_WEIGHT = 0.5;

  // No prototipo o enquadramento acompanhava a janela e havia toda uma conta de
  // object-fit. Aqui o canvas de saida tem tamanho fixo e a camera ja vem nesse
  // tamanho, entao 'view' e constante e o recorte some.
  const view = { w: 424, h: 320, dpr: 1 };
  const cover = { dw: 424, dh: 320, dx: 0, dy: 0 };
  let vw = 424, vh = 320;

  let video = null;      // <video> escondido com a camera crua
  let base = null;       // canvas do shader: a imagem ja filtrada
  let fx = null, fctx = null;        // camada de efeito (aurora / mosaico)
  let overlay = null, octx = null;   // camada de desenho (linhas, rastros, prisma)
  let CTX_FILTER = false;

  // O prototipo espelhava a imagem, porque voce estava se olhando. Aqui NAO:
  // esta e a imagem que a sala recebe, e precisa sair na orientacao real.
  function toView(p){ return { x: p.x * view.w, y: p.y * view.h }; }
  function drawVideoMirrored(c, W, H){ if (base) c.drawImage(base, 0, 0, W, H); }
  function drawSource(c, W, H){ if (base) c.drawImage(base, 0, 0, W, H); }

  // Cada efeito pode ser desligado individualmente.
  // 'scanlines' comeca desligado porque e textura permanente, nao reacao a
  // gesto: ligado sem querer, sujaria a imagem o tempo todo.
  const ligados = { scanlines: false };
  const isOn = id => ligados[id] !== false;

  let aoMudarGesto = null;

  function applyEffect(){
    const g = currentGesture ? GESTURE_BY_ID[currentGesture] : null;
    const vivo = g && isOn(g.id) ? g : null;
    const kind = (vivo && vivo.fx) || null;
    if (kind !== fxKind) configureFx(kind);
    if (aoMudarGesto) aoMudarGesto(vivo);
  }

  function commitGesture(id){
    if (id === currentGesture) return;
    currentGesture = id;
    applyEffect();
  }

  // O medidor de dedos era so enfeite da interface do prototipo.
  function updateMeter(){}

  // ---------- geometria das maos, suavizacao e pinca ----------
  function hdist(a, b){
    return Math.hypot((a.x-b.x)*vw, (a.y-b.y)*vh, (a.z-b.z)*vw*Z_WEIGHT);
  }

  function jointAngle(center, a, b){
    const ax = (a.x-center.x)*vw, ay = (a.y-center.y)*vh, az = (a.z-center.z)*vw*Z_WEIGHT;
    const bx = (b.x-center.x)*vw, by = (b.y-center.y)*vh, bz = (b.z-center.z)*vw*Z_WEIGHT;
    const mag = (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz)) || 1e-6;
    const cos = Math.max(-1, Math.min(1, (ax*bx + ay*by + az*bz)/mag));
    return Math.acos(cos) * 180/Math.PI;
  }

  function palmSize(lm){
    return hdist(lm[0], lm[9]) || 1e-6;
  }

  function midpoint(a, b){
    return { x:(a.x+b.x)/2, y:(a.y+b.y)/2, z:(a.z+b.z)/2 };
  }

  function centroidOf(pts){
    let x = 0, y = 0;
    pts.forEach(p => { x += p.x; y += p.y; });
    return { x: x/pts.length, y: y/pts.length };
  }

  // per-finger extension, used for the meter and for which fingertips join
  // the triangulation fan. a finger counts as open when its middle joint is
  // fairly straight AND its tip reaches past that joint.
  function fingerStates(lm){
    const wrist = lm[0];
    const finger = (mcp, pip, tip) =>
      jointAngle(lm[pip], lm[mcp], lm[tip]) > 140 && hdist(wrist, lm[tip]) > hdist(wrist, lm[pip]) ? 1 : 0;
    // thumb: straight, away from the index knuckle, and not folded across the palm
    const thumb =
      jointAngle(lm[3], lm[2], lm[4]) > 140 &&
      hdist(lm[4], lm[5]) > palmSize(lm) * 0.5 &&
      hdist(lm[4], lm[17]) > hdist(lm[3], lm[17]);
    return [thumb ? 1 : 0, finger(5,6,8), finger(9,10,12), finger(13,14,16), finger(17,18,20)];
  }

  // ---------- hand slots: stable identity, smoothing, dropout grace ----------
  // MediaPipe doesn't keep hands in a fixed order between frames, so detections
  // are matched to two persistent slots by palm position. each slot owns its
  // smoothing filter, pinch state and fingertip trail.
  function makeSlot(){
    return {
      lm: null, gesture: null, lastSeen: -Infinity, fresh: false,
      pinching: false,
      filt: new Float64Array(63), dfilt: new Float64Array(63), filterReady: false, lastT: 0,
      tips: null,
    };
  }
  const slots = [makeSlot(), makeSlot()];

  function resetSlot(s){
    s.lm = null; s.gesture = null; s.fresh = false;
    s.pinching = false; s.filterReady = false; s.tips = null;
  }

  function palmCenter(lm){
    return { x:(lm[0].x+lm[9].x)/2, y:(lm[0].y+lm[9].y)/2 };
  }

  const NEW_HAND_COST = 0.3;   // in frame-heights; cost of starting a fresh slot
  const MAX_TRACK_JUMP = 0.35; // farther than this and it's treated as a different hand

  function assignHands(hands, now){
    const alive = slots.map(s => !!s.lm && now - s.lastSeen <= CONFIG.handGraceMs);
    const aspect = vw/vh;
    const cost = (hi, si) => {
      if (!alive[si]) return NEW_HAND_COST;
      const a = palmCenter(hands[hi].lm), b = palmCenter(slots[si].lm);
      return Math.hypot((a.x-b.x)*aspect, a.y-b.y);
    };

    const options = hands.length === 2 ? [[0,1],[1,0]] : hands.length === 1 ? [[0],[1]] : [[]];
    let best = options[0], bestCost = Infinity;
    for (const opt of options){
      const c = opt.reduce((sum, si, hi) => sum + cost(hi, si), 0);
      if (c < bestCost){ bestCost = c; best = opt; }
    }

    slots.forEach(s => { s.fresh = false; });
    best.forEach((si, hi) => {
      const s = slots[si];
      if (!alive[si] || cost(hi, si) > MAX_TRACK_JUMP) resetSlot(s);
      smoothInto(s, hands[hi].lm, now);
      s.gesture = hands[hi].gesture;
      s.lastSeen = now;
      s.fresh = true;
    });
    slots.forEach(s => {
      if (!s.fresh && s.lm && now - s.lastSeen > CONFIG.handGraceMs) resetSlot(s);
    });
  }

  function lowpassAlpha(cutoff, dt){
    const tau = 1 / (TAU * cutoff);
    return 1 / (1 + tau/dt);
  }

  // One Euro filter: heavy smoothing when the hand is still (kills jitter),
  // light smoothing when it moves fast (keeps drawing responsive)
  function smoothInto(s, raw, now){
    const { minCutoff, beta, dCutoff } = CONFIG.smoothing;
    const dt = Math.max((now - s.lastT)/1000, 1/240);
    s.lastT = now;
    if (!s.lm) s.lm = Array.from({ length: 21 }, () => ({ x:0, y:0, z:0 }));
    const aD = lowpassAlpha(dCutoff, dt);
    for (let i = 0; i < 21; i++){
      const r = raw[i], out = s.lm[i];
      const vals = [r.x, r.y, r.z || 0];
      for (let k = 0; k < 3; k++){
        const j = i*3 + k, v = vals[k];
        if (!s.filterReady){
          s.filt[j] = v; s.dfilt[j] = 0;
        } else {
          s.dfilt[j] += aD * ((v - s.filt[j])/dt - s.dfilt[j]);
          const cutoff = minCutoff + beta * Math.abs(s.dfilt[j]);
          s.filt[j] += lowpassAlpha(cutoff, dt) * (v - s.filt[j]);
        }
      }
      out.x = s.filt[i*3]; out.y = s.filt[i*3+1]; out.z = s.filt[i*3+2];
    }
    s.filterReady = true;
  }

  function pinchPoint(s){
    return toView(midpoint(s.lm[4], s.lm[8]));
  }

  // thumb tip (4) close to index tip (8), relative to the hand's own size,
  // with separate start/release thresholds so it doesn't flicker
  function updatePinch(s, now){
    const lm = s.lm;
    const ratio = hdist(lm[4], lm[8]) / palmSize(lm);
    if (!s.pinching){
      // in a plain fist the thumb rests right next to the curled index tip;
      // only start a pinch when the index still reaches out past its knuckle
      const reaching = hdist(lm[0], lm[8]) > hdist(lm[0], lm[5]) * 0.95;
      if (ratio < CONFIG.pinchOn && reaching) s.pinching = true;
    } else if (ratio > CONFIG.pinchOff){
      s.pinching = false;
      onPinchReleased(s, now);
    }
  }

  // ---------- interaction state ----------

  // ---------- estado dos gestos, rastros e estilingue ----------
  let currentGesture = null;   // stabilized gesture id or null
  let candidateGesture = null;
  let candidateSince = 0;

  let livePinch = null;          // {p1,p2} while both hands pinch and lines are active
  let liveTriangulation = null;  // {apex, basePts} while one hand pinches and the other is open
  let pendingJoin = null;        // {p1,p2} while both pinching but still apart, waiting to join
  let livePinchSolo = null;      // point marker while exactly one hand pinches alone
  let linesActive = false;       // true only after both pinches have been brought together
  let prismSnapshot = null;      // last active prism, used to aim the slingshot on release

  // ---------- light trails ----------
  const LINE_TRAIL_MAX_AGE = 1400;   // ms a line segment stays visible before fully fading
  const LINE_TRAIL_MAX_LEN = 260;
  const FINGER_TRAIL_MAX_AGE = 550;  // ms — short-lived, snappy sparkle trail
  const FINGER_TRAIL_MAX_LEN = 420;
  const SLINGSHOT_MAX_AGE = 750;
  const lineTrail = [];     // {p1,p2,t}
  const fingerTrail = [];   // {p1,p2,t}
  let slingshotBursts = [];

  function pushTrail(trail, p1, p2, maxLen, now){
    trail.push({ p1, p2, t: now });
    if (trail.length > maxLen) trail.splice(0, trail.length - maxLen);
  }

  function pruneTrail(trail, now, maxAge){
    let i = 0;
    while (i < trail.length && now - trail[i].t >= maxAge) i++;
    if (i) trail.splice(0, i);
  }

  function clearLightTrails(){
    lineTrail.length = 0;
    fingerTrail.length = 0;
    slingshotBursts = [];
    slots.forEach(s => { s.tips = null; });
  }

  // ambient fingertip light trails — active on any visible hand,
  // regardless of gesture, like glowing threads streaming off each finger
  function updateFingerTrail(s, now){
    const pts = TIP_IDX.map(i => toView(s.lm[i]));
    if (s.tips){
      const maxJump = Math.max(view.w, view.h) * 0.25;
      pts.forEach((p, i) => {
        const prev = s.tips[i];
        const d = Math.hypot(p.x-prev.x, p.y-prev.y);
        // ignore tiny jitter, and big jumps (hand re-entering frame elsewhere)
        if (d > 1.5 && d < maxJump) pushTrail(fingerTrail, prev, p, FINGER_TRAIL_MAX_LEN, now);
      });
    }
    s.tips = pts;
  }

  // ---- slingshot release, fired when the pinching hand lets go mid-prism ----
  function onPinchReleased(s, now){
    if (isOn("estilingue") && prismSnapshot && prismSnapshot.slot === s && now - prismSnapshot.t < 300){
      spawnSlingshotBurst(prismSnapshot, now);
    }
    prismSnapshot = null;
  }

  function spawnSlingshotBurst(snap, now){
    let dx = snap.apex.x - snap.baseCentroid.x;
    let dy = snap.apex.y - snap.baseCentroid.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;

    const particles = [];
    for (let i = 0; i < 9; i++){
      const spread = (Math.random() - 0.5) * 0.7;
      const cos = Math.cos(spread), sin = Math.sin(spread);
      const rdx = dx*cos - dy*sin;
      const rdy = dx*sin + dy*cos;
      const hue = ((Math.atan2(rdy, rdx) * 180/Math.PI) + 210 + 360) % 360;
      particles.push({ dx: rdx, dy: rdy, speed: 220 + Math.random()*260, hue });
    }

    slingshotBursts.push({ x: snap.apex.x, y: snap.apex.y, t: now, particles });
    if (slingshotBursts.length > 6) slingshotBursts.shift();
  }

  // ---------- per-frame gesture logic ----------

  function processFrame(result, now){
    const landmarks = (result && result.landmarks) || [];
    const hands = landmarks.map((lm, i) => {
      const top = result.gestures && result.gestures[i] && result.gestures[i][0];
      const gesture = top && top.score >= CONFIG.gestureMinScore ? (GESTURE_BY_MODEL[top.categoryName] || null) : null;
      return { lm, gesture };
    });
    assignHands(hands, now);

    const active = slots.filter(s => s.lm);
    active.forEach(s => {
      if (!s.fresh) return;
      updatePinch(s, now);
      if (isOn("rastro")) updateFingerTrail(s, now);
    });

    livePinch = null;
    liveTriangulation = null;
    pendingJoin = null;
    livePinchSolo = null;
    let matched = null;
    let meter = [0,0,0,0,0];

    if (active.length === 2){
      const [a, b] = active;
      if (a.pinching && b.pinching && isOn("linhas")){
        const p1 = pinchPoint(a), p2 = pinchPoint(b);
        const d = Math.hypot(p1.x-p2.x, p1.y-p2.y);
        // lines only turn on once both pinches are brought close together;
        // once that happens they stay on even as you pull the hands apart
        if (!linesActive && d < Math.min(view.w, view.h) * CONFIG.joinFraction) linesActive = true;
        if (linesActive){
          matched = "linhas";
          livePinch = { p1, p2 };
          pushTrail(lineTrail, p1, p2, LINE_TRAIL_MAX_LEN, now);
        } else {
          pendingJoin = { p1, p2 };
        }
      } else {
        linesActive = false;
        if (a.pinching !== b.pinching && isOn("triangulacao")){
          // exactly one hand pinching, the other free — triangulate between them
          const apexSlot = a.pinching ? a : b;
          const baseSlot = a.pinching ? b : a;
          const baseStates = fingerStates(baseSlot.lm);
          const apex = pinchPoint(apexSlot);
          // only fingers that are actually extended join the mesh — as you
          // open more of them, they enter the fan in thumb→pinky order
          const basePts = TIP_IDX.filter((_, i) => baseStates[i] === 1).map(i => toView(baseSlot.lm[i]));
          liveTriangulation = { apex, basePts };
          matched = "triangulacao";
          meter = baseStates;
          if (basePts.length >= 2){
            prismSnapshot = { slot: apexSlot, apex, baseCentroid: centroidOf(basePts), t: now };
          }
        } else {
          // neither hand pinching — use whichever hand shows a known gesture
          const src = a.gesture ? a : (b.gesture ? b : a);
          matched = src.gesture;
          meter = fingerStates(src.lm);
        }
      }
    } else {
      linesActive = false;
      if (active.length === 1){
        const s = active[0];
        // a lone pinch doesn't do anything but show a marker
        if (s.pinching && (isOn("linhas") || isOn("triangulacao"))) livePinchSolo = pinchPoint(s);
        matched = s.gesture;
        meter = fingerStates(s.lm);
      }
    }

    if (matched === "linhas" || matched === "triangulacao"){
      // react immediately — waiting for stability would lag the drawing
      candidateGesture = matched;
      candidateSince = now;
      commitGesture(matched);
    } else {
      if (matched !== candidateGesture){
        candidateGesture = matched;
        candidateSince = now;
      }
      if (now - candidateSince >= CONFIG.gestureHoldMs) commitGesture(candidateGesture);
    }

    updateMeter(meter);
  }


  // ---------- camada de efeito (aurora / mosaico) ----------
  let fxKind = null;
  let hueDeg = 0;
  let lastFxT = 0;


  function configureFx(kind){
    fxKind = kind;
    if (!fx) return;
    lastFxT = 0;
    fx.hidden = !kind;
    fx.classList.toggle("pixelated", kind === "mosaic");
    fx.style.filter = "";
    if (kind === "mosaic"){
      // render straight into a tiny canvas and let CSS scale it up with hard pixels
      const block = Math.max(6, Math.floor(view.w/48));
      fx.width = Math.ceil(view.w/block);
      fx.height = Math.ceil(view.h/block);
    } else if (kind === "aurora"){
      // the feedback trail is soft by nature, so a capped resolution looks the same and is much cheaper
      const scale = Math.min(view.dpr, 720/view.w);
      fx.width = Math.max(1, Math.round(view.w*scale));
      fx.height = Math.max(1, Math.round(view.h*scale));
      if (video.readyState >= 2) drawVideoMirrored(fctx, fx.width, fx.height);
    } else {
      fx.width = fx.height = 1;
    }
  }

  function renderFx(now){
    if (!fxKind || video.readyState < 2) return;
    const W = fx.width, H = fx.height;
    if (fxKind === "mosaic"){
      drawSource(fctx, W, H);
      return;
    }
    // aurora: light trail + drifting hue, normalized to a 60fps step so it
    // looks the same on 60Hz and 120Hz+ displays
    const steps = lastFxT ? Math.min(4, (now - lastFxT)/16.67) : 1;
    lastFxT = now;
    hueDeg = (hueDeg + 2.4*steps) % 360;
    fctx.globalAlpha = 1 - Math.pow(1 - 0.14, steps);
    fctx.fillStyle = "#000";
    fctx.fillRect(0, 0, W, H);
    fctx.globalAlpha = 1 - Math.pow(1 - 0.9, steps);
    const filter = `hue-rotate(${hueDeg.toFixed(1)}deg) saturate(1.8) brightness(1.05)`;
    if (CTX_FILTER){
      fctx.filter = filter;
      drawSource(fctx, W, H);
      fctx.filter = "none";
    } else {
      // browsers without canvas filters: tint the whole layer instead
      drawSource(fctx, W, H);
      fx.style.filter = filter;
    }
    fctx.globalAlpha = 1;
  }

  // ---------- overlay drawing ----------
  // glow is faked with a wide translucent stroke under a thin core, which is
  // far cheaper than canvas shadowBlur when hundreds of segments are on screen

  // ---------- camada de desenho (linhas, rastros, prisma) ----------
  function glowStroke(path, color, width, alpha = 1, glow = 0.22){
    octx.save();
    octx.globalCompositeOperation = "lighter";
    octx.strokeStyle = color;
    octx.lineCap = "round";
    octx.lineJoin = "round";
    octx.globalAlpha = Math.max(0, Math.min(1, alpha * glow));
    octx.lineWidth = width * 4;
    octx.stroke(path);
    octx.globalAlpha = Math.max(0, Math.min(1, alpha));
    octx.lineWidth = width;
    octx.stroke(path);
    octx.restore();
  }

  function linePath(p1, p2){
    const path = new Path2D();
    path.moveTo(p1.x, p1.y);
    path.lineTo(p2.x, p2.y);
    return path;
  }

  // segments are grouped into a few age buckets so a whole trail is a handful of strokes
  function drawTrail(trail, now, maxAge, color, width, peakAlpha){
    if (!trail.length) return;
    const BUCKETS = 6;
    const paths = [];
    for (const s of trail){
      const k = Math.min(BUCKETS - 1, Math.floor(((now - s.t)/maxAge) * BUCKETS));
      const path = paths[k] || (paths[k] = new Path2D());
      path.moveTo(s.p1.x, s.p1.y);
      path.lineTo(s.p2.x, s.p2.y);
    }
    paths.forEach((path, k) => {
      if (path) glowStroke(path, color, width, (1 - (k + 0.5)/BUCKETS) * peakAlpha);
    });
  }

  const spriteCache = new Map();
  function glowSprite(color){
    let sprite = spriteCache.get(color);
    if (sprite) return sprite;
    const n = parseInt(color.slice(1), 16);
    const rgb = `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
    sprite = document.createElement("canvas");
    sprite.width = sprite.height = 64;
    const c = sprite.getContext("2d");
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, `rgba(${rgb},0.85)`);
    g.addColorStop(0.3, `rgba(${rgb},0.3)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
    spriteCache.set(color, sprite);
    return sprite;
  }

  function drawDot(p, color = CYAN, radius = 5){
    const R = radius * 3.2;
    octx.drawImage(glowSprite(color), p.x - R, p.y - R, R*2, R*2);
    octx.fillStyle = color;
    octx.beginPath();
    octx.arc(p.x, p.y, radius, 0, TAU);
    octx.fill();
  }

  // fills the triangulated region with a faceted, radiant crystal burst —
  // a bright core plus many small colored shards fanning out, clipped to
  // the actual fan shape so it still grows with the open fingers
  function drawPrismFill(apex, basePts, now){
    octx.save();
    octx.beginPath();
    octx.moveTo(apex.x, apex.y);
    basePts.forEach(p => octx.lineTo(p.x, p.y));
    octx.closePath();
    octx.clip();

    const maxDist = Math.max(...basePts.map(p => Math.hypot(p.x-apex.x, p.y-apex.y)));
    const radius = Math.max(maxDist * 1.5, 40);
    const facetCount = 18;
    const rotation = (now/9000) % TAU;

    octx.globalCompositeOperation = "screen";

    // bright core glow at the pinch point, like light entering the crystal
    const core = octx.createRadialGradient(apex.x, apex.y, 0, apex.x, apex.y, radius*0.5);
    core.addColorStop(0, "rgba(255,255,255,0.85)");
    core.addColorStop(0.25, "rgba(255,255,255,0.25)");
    core.addColorStop(1, "rgba(255,255,255,0)");
    octx.fillStyle = core;
    octx.beginPath();
    octx.arc(apex.x, apex.y, radius*0.5, 0, TAU);
    octx.fill();

    // deterministic pseudo-random jitter (fixed per index) so the shards
    // don't flicker frame to frame, just slowly rotate together
    const spokes = new Path2D();
    for (let i = 0; i < facetCount; i++){
      const jA1 = Math.sin(i*12.9898 + 3.1) * 0.1;
      const jA2 = Math.sin((i+1)*12.9898 + 3.1) * 0.1;
      const a1 = rotation + (i/facetCount) * TAU + jA1;
      const a2 = rotation + ((i+1)/facetCount) * TAU + jA2;
      const r1 = radius * (0.7 + 0.3 * ((Math.sin(i*7.233)+1)/2));
      const r2 = radius * (0.7 + 0.3 * ((Math.sin((i+1)*7.233)+1)/2));
      const p1 = { x: apex.x + Math.cos(a1)*r1, y: apex.y + Math.sin(a1)*r1 };
      const p2 = { x: apex.x + Math.cos(a2)*r2, y: apex.y + Math.sin(a2)*r2 };
      const hue = (((a1+a2)/2)*180/Math.PI + 210) % 360;
      const mid = { x:(p1.x+p2.x)/2, y:(p1.y+p2.y)/2 };

      const grad = octx.createLinearGradient(apex.x, apex.y, mid.x, mid.y);
      grad.addColorStop(0,    `hsla(${hue},85%,85%,0.8)`);
      grad.addColorStop(0.45, `hsla(${hue},80%,60%,0.6)`);
      grad.addColorStop(1,    `hsla(${hue},85%,42%,0.45)`);

      octx.beginPath();
      octx.moveTo(apex.x, apex.y);
      octx.lineTo(p1.x, p1.y);
      octx.lineTo(p2.x, p2.y);
      octx.closePath();
      octx.fillStyle = grad;
      octx.fill();

      if (i % 3 === 0){
        spokes.moveTo(apex.x, apex.y);
        spokes.lineTo(p1.x, p1.y);
      }
    }
    octx.strokeStyle = "rgba(255,255,255,0.4)";
    octx.lineWidth = 1;
    octx.stroke(spokes);
    octx.restore();
  }

  // draws a fan of glowing triangles from an apex (the pinch point) out to
  // whichever of the other hand's fingertips are currently extended —
  // fingers join the mesh one by one as they open. once 2+ fingers are in,
  // a prism of shifting spectrum light fills the meshed area.
  function drawTriangulation(apex, basePts, now){
    if (basePts.length >= 2){
      drawPrismFill(apex, basePts, now);
      const warm = new Path2D(), cool = new Path2D();
      for (let i = 0; i < basePts.length - 1; i++){
        const path = i % 2 === 0 ? warm : cool;
        const p1 = basePts[i], p2 = basePts[i+1];
        path.moveTo(apex.x, apex.y);
        path.lineTo(p1.x, p1.y);
        path.lineTo(p2.x, p2.y);
        path.closePath();
      }
      glowStroke(warm, AMBER, 1.4);
      glowStroke(cool, CYAN, 1.4);
    } else if (basePts.length === 1){
      // only one finger open yet — not enough for a triangle, just a spoke
      glowStroke(linePath(apex, basePts[0]), AMBER, 2, 0.9);
    }
    basePts.forEach(p => drawDot(p, AMBER, 3.5));
    drawDot(apex, CYAN, 5);
  }

  function renderSlingshotBursts(now){
    if (!slingshotBursts.length) return;
    slingshotBursts = slingshotBursts.filter(b => now - b.t < SLINGSHOT_MAX_AGE);

    slingshotBursts.forEach(b => {
      const age = now - b.t;
      const p = age / SLINGSHOT_MAX_AGE;

      // expanding shockwave ring, like the released elastic snapping through the air
      const ring = new Path2D();
      ring.arc(b.x, b.y, 18 + p*150, 0, TAU);
      glowStroke(ring, WHITE, 2, (1-p)*0.6);

      // streaking shards flying off in the pull direction
      b.particles.forEach(pt => {
        const d = pt.speed * (age/1000);
        const tail = Math.max(d - 26, 0);
        glowStroke(
          linePath({ x: b.x + pt.dx*tail, y: b.y + pt.dy*tail }, { x: b.x + pt.dx*d, y: b.y + pt.dy*d }),
          `hsl(${pt.hue.toFixed(0)},85%,70%)`, 2.2, (1-p)*0.85
        );
      });
    });
  }

  function renderOverlay(now){
    octx.clearRect(0, 0, view.w, view.h);

    if (liveTriangulation) drawTriangulation(liveTriangulation.apex, liveTriangulation.basePts, now);

    // the light-line trail draws on top of whatever effect is active,
    // and keeps fading out on its own even after the pinch is released
    pruneTrail(lineTrail, now, LINE_TRAIL_MAX_AGE);
    drawTrail(lineTrail, now, LINE_TRAIL_MAX_AGE, AMBER, 2, 1);

    if (livePinch){
      glowStroke(linePath(livePinch.p1, livePinch.p2), CYAN, 3);
      drawDot(livePinch.p1);
      drawDot(livePinch.p2);
    }

    if (pendingJoin){
      // pinching with both hands but not joined yet — a faint guide line
      // makes it clear they need to come together first
      octx.save();
      octx.globalAlpha = 0.35;
      octx.strokeStyle = CYAN;
      octx.lineWidth = 1.5;
      octx.setLineDash([5, 7]);
      octx.stroke(linePath(pendingJoin.p1, pendingJoin.p2));
      octx.restore();
      drawDot(pendingJoin.p1, CYAN, 3.5);
      drawDot(pendingJoin.p2, CYAN, 3.5);
    }

    if (livePinchSolo){
      drawDot(livePinchSolo, CYAN, 5);
      octx.save();
      octx.globalAlpha = 0.6;
      octx.strokeStyle = CYAN;
      octx.lineWidth = 1.2;
      octx.beginPath();
      octx.arc(livePinchSolo.x, livePinchSolo.y, 11, 0, TAU);
      octx.stroke();
      octx.restore();
    }

    pruneTrail(fingerTrail, now, FINGER_TRAIL_MAX_AGE);
    drawTrail(fingerTrail, now, FINGER_TRAIL_MAX_AGE, WHITE, 1.4, 0.85);
    slots.forEach(s => {
      if (s.lm && s.tips) s.tips.forEach(p => drawDot(p, WHITE, 2.2));
    });

    renderSlingshotBursts(now);
  }


  // ---------- carregamento do MediaPipe ----------
  let recognizer = null;
  let recognizerDelegate = null;
  let recognizerPromise = null;

  function namedError(name, message, cause){
    const err = new Error(message);
    err.name = name;
    err.cause = cause;
    return err;
  }

  // loads the library, wasm and model once; a failed attempt can be retried
  function loadRecognizer(forceDelegate){
    if (!recognizerPromise){
      recognizerPromise = (async () => {
        const base = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${CONFIG.mediapipeVersion}`;
        const { FilesetResolver, GestureRecognizer } = await import(`${base}/vision_bundle.mjs`);
        const fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`);
        let lastErr;
        for (const delegate of forceDelegate ? [forceDelegate] : ["GPU", "CPU"]){
          try{
            const r = await GestureRecognizer.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: CONFIG.modelUrl, delegate },
              runningMode: "VIDEO",
              numHands: CONFIG.numHands,
              minHandDetectionConfidence: CONFIG.minHandDetectionConfidence,
              minHandPresenceConfidence: CONFIG.minHandPresenceConfidence,
              minTrackingConfidence: CONFIG.minTrackingConfidence,
            });
            recognizerDelegate = delegate;
            return r;
          } catch (err){
            console.warn(`[gesto] falha ao iniciar com ${delegate}`, err);
            lastErr = err;
          }
        }
        throw lastErr;
      })();
      recognizerPromise.catch(() => { recognizerPromise = null; });
    }
    return recognizerPromise;
  }

  // O download NAO comeca aqui de proposito: sao ~18 MB, e quem nunca ligar
  // os gestos nao deve pagar por eles. Quem dispara e o iniciar().


  // ============================================================
  // API usada pelo bot-tela
  // ============================================================
  let reconhecedor = null;
  let ultimoTempoVideo = -1;

  async function iniciar(opcoes) {
    video = opcoes.video;
    base = opcoes.base;
    view.w = base.width; view.h = base.height;
    cover.dw = view.w; cover.dh = view.h;
    vw = video.videoWidth || view.w;
    vh = video.videoHeight || view.h;

    fx = document.createElement('canvas');
    fctx = fx.getContext('2d');
    CTX_FILTER = typeof fctx.filter === 'string';
    overlay = document.createElement('canvas');
    overlay.width = view.w; overlay.height = view.h;
    octx = overlay.getContext('2d');
    octx.setTransform(1, 0, 0, 1, 0, 0);

    aoMudarGesto = opcoes.aoMudarGesto || null;
    configureFx(null);

    reconhecedor = await loadRecognizer();
    ultimoTempoVideo = -1;
    return true;
  }

  // O contexto da GPU pode morrer no meio da sessao (o PC dormiu, o driver
  // reiniciou). Sem isto a deteccao falhava em todo quadro, em silencio, ate
  // alguem recarregar a pagina. Como no prototipo: depois de varias falhas
  // seguidas, refaz o reconhecedor na CPU — uma vez so.
  let errosSeguidos = 0;
  let reconstruindo = false;

  async function recuperar() {
    if (reconstruindo || recognizerDelegate !== 'GPU') return;
    reconstruindo = true;
    try {
      try { reconhecedor && reconhecedor.close(); } catch (_) {}
      reconhecedor = null;
      recognizerPromise = null;
      reconhecedor = await loadRecognizer('CPU');
      errosSeguidos = 0;
    } catch (err) {
      console.warn('[gestos] a deteccao de maos parou e nao voltou', err);
    } finally {
      reconstruindo = false;
    }
  }

  // Roda a deteccao. So vale a pena quando o <video> avancou de quadro.
  function processar(agora) {
    if (!reconhecedor || reconstruindo || !video || video.readyState < 2) return;
    if (video.currentTime === ultimoTempoVideo) return;
    ultimoTempoVideo = video.currentTime;
    let r;
    try {
      r = reconhecedor.recognizeForVideo(video, agora);
      errosSeguidos = 0;
    } catch (_) {
      if (++errosSeguidos >= 8) recuperar();
      return;
    }
    processFrame(r, agora);
  }

  // Compoe tudo no canvas que vai virar o stream: a imagem (ja filtrada, ou
  // substituida pela camada de efeito) e por cima os desenhos.
  // Faixas claras de 1px a cada 3px, iguais ao repeating-linear-gradient do
  // prototipo. 'overlay' escurece o escuro e clareia o claro — e o que dava a
  // aparencia de tubo de TV.
  function desenharScanlines(ctx, w, h) {
    if (!isOn('scanlines')) return;
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
    ctx.restore();
  }

  function desenhar(ctx, agora) {
    renderFx(agora);
    renderOverlay(agora);
    if (fxKind === 'mosaic') {
      // o mosaico e um canvas minusculo esticado: sem suavizacao, senao vira borrao
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(fx, 0, 0, view.w, view.h);
      ctx.imageSmoothingEnabled = true;
    } else if (fxKind === 'aurora') {
      ctx.drawImage(fx, 0, 0, view.w, view.h);
    } else if (base) {
      ctx.drawImage(base, 0, 0, view.w, view.h);
    }
    ctx.drawImage(overlay, 0, 0, view.w, view.h);
  }

  // Os efeitos de cor do prototipo eram filtros CSS. Aqui viram parametros do
  // mesmo shader dos filtros, para irem junto na transmissao.
  function parametrosShader() {
    const g = currentGesture ? GESTURE_BY_ID[currentGesture] : null;
    return (g && isOn(g.id) && g.shader) || null;
  }

  function parar() {
    commitGesture(null);
    clearLightTrails();
    slingshotBursts = [];
    livePinch = liveTriangulation = pendingJoin = livePinchSolo = null;
    linesActive = false;
    video = base = fx = fctx = overlay = octx = null;
    ultimoTempoVideo = -1;
  }

  global.GestosCam = {
    GESTURES,
    iniciar, processar, desenhar, desenharScanlines, parametrosShader, parar,
    gestoAtual: () => currentGesture,
    ligar: (id, v) => { ligados[id] = v; applyEffect(); },
    estaLigado: isOn
  };
})(window);
