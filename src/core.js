// ─────────────────────────────────────────────────────────────
//  사진 측정 코어 : EXIF 초점거리 · 기울기 보정 기하 · 자동 인식
//  (React와 무관한 순수 함수 — 단위 테스트 가능)
// ─────────────────────────────────────────────────────────────

/** 흔한 35mm 환산 초점거리 (EXIF가 없을 때 선택) — 아이폰·갤럭시 공통 */
export const LENSES = [
  { id: '13', label: '초광각 13mm (아이폰 0.5배)', f35: 13 },
  { id: '23', label: '기본 23mm (갤럭시 1배)', f35: 23 },
  { id: '24', label: '기본 24mm (아이폰 1배)', f35: 24 },
  { id: '26', label: '기본 26mm (구형 아이폰 1배)', f35: 26 },
  { id: '28', label: '28mm', f35: 28 },
  { id: '35', label: '35mm', f35: 35 },
  { id: '48', label: '48mm (아이폰 2배)', f35: 48 },
  { id: '70', label: '70mm (갤럭시 3배)', f35: 70 },
  { id: '120', label: '120mm (아이폰 5배)', f35: 120 },
];

const FULL_FRAME_DIAG = Math.hypot(36, 24); // 43.27 mm

// ── EXIF (JPEG APP1) ──────────────────────────────────────────
/** JPEG의 EXIF에서 초점거리 정보를 읽습니다. 실패하면 {} */
export function readExif(buf) {
  try {
    const dv = new DataView(buf);
    if (dv.getUint16(0) !== 0xffd8) return {};
    let off = 2;
    while (off + 4 < dv.byteLength) {
      const marker = dv.getUint16(off);
      const len = dv.getUint16(off + 2);
      if (marker === 0xffe1 && dv.getUint32(off + 4) === 0x45786966) {
        return parseTiff(dv, off + 10);
      }
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      off += 2 + len;
    }
  } catch (e) { /* 손상된 EXIF는 무시 */ }
  return {};
}

function parseTiff(dv, t) {
  const le = dv.getUint16(t) === 0x4949;
  const u16 = (o) => dv.getUint16(t + o, le);
  const u32 = (o) => dv.getUint32(t + o, le);
  const out = {};
  const ascii = (o, n) => {
    let s = '';
    for (let i = 0; i < n; i++) { const c = dv.getUint8(t + o + i); if (!c) break; s += String.fromCharCode(c); }
    return s.trim();
  };
  const readIfd = (ifd, cb) => {
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
      const valOff = (type === 2 && cnt <= 4) ? e + 8 : (type === 5 || type === 2) ? u32(e + 8) : e + 8;
      let val;
      if (type === 3) val = u16(e + 8);
      else if (type === 4) val = u32(e + 8);
      else if (type === 5) val = u32(valOff) / (u32(valOff + 4) || 1);
      else if (type === 2) val = ascii(valOff, cnt);
      cb(tag, val);
    }
  };
  let exifPtr = 0;
  readIfd(u32(4), (tag, v) => {
    if (tag === 0x010f) out.make = v;
    if (tag === 0x0110) out.model = v;
    if (tag === 0x0112) out.orientation = v;
    if (tag === 0x8769) exifPtr = v;
  });
  if (exifPtr) {
    readIfd(exifPtr, (tag, v) => {
      if (tag === 0xa405) out.focal35 = v;
      if (tag === 0x920a) out.focalMm = v;
      if (tag === 0xa434) out.lens = v;
    });
  }
  return out;
}

/** EXIF 제조사·모델 → 표시용 기종 이름 ('Apple iPhone 16 Pro' → 'iPhone 16 Pro') */
export function deviceName(exif) {
  const make = (exif?.make || '').trim(), model = (exif?.model || '').trim();
  if (!model) return '';
  if (!make || model.toLowerCase().startsWith(make.toLowerCase()) || /^apple$/i.test(make)) return model;
  return `${make.charAt(0).toUpperCase()}${make.slice(1)} ${model}`;
}

/** 35mm 환산 초점거리 → 픽셀 단위 초점거리 (대각선 기준이라 크기 조정에 무관) */
export function focalPx(f35, width, height) {
  return f35 * Math.hypot(width, height) / FULL_FRAME_DIAG;
}

// ── 기하 : 카메라 → 나무가 서 있는 수직면(거리 D) ───────────────
// cam = { W, H, f(px), pitch(도, 위로 +), D(m) }
// 반환 X: 오른쪽(m), Y: 카메라 높이 기준 위쪽(m)
export function toPlane(p, cam) {
  const ph = (cam.pitch || 0) * Math.PI / 180;
  const u = p.x - cam.W / 2;
  const v = cam.H / 2 - p.y;
  const den = cam.f * Math.cos(ph) - v * Math.sin(ph);
  const t = cam.D / den;
  return { X: u * t, Y: (v * Math.cos(ph) + cam.f * Math.sin(ph)) * t };
}

/** 수직면에서 높이 Y(m)가 찍히는 사진 행(y 픽셀) */
export function rowForY(Y, cam) {
  const ph = (cam.pitch || 0) * Math.PI / 180;
  const k = Y / cam.D;
  const v = cam.f * (k * Math.cos(ph) - Math.sin(ph)) / (Math.cos(ph) + k * Math.sin(ph));
  return cam.H / 2 - v;
}

/**
 * 측정값 계산
 * pts: { top, base, cb, cl, cr, dl, dr, poleT?, poleB? } (작업 이미지 픽셀)
 * opt: { D, f, W, H, pitch, surface(거리를 줄기 표면까지 쟀는지), poleLen(m) }
 */
export function computeMeasures(pts, opt) {
  const cam = { W: opt.W, H: opt.H, f: opt.f, pitch: opt.pitch || 0, D: opt.D };
  let D = opt.D;
  let method = 'distance';

  // 기준자 : 길이 L인 막대가 줄기 옆에 서 있으면 거리를 역산
  if (opt.poleLen > 0 && pts.poleT && pts.poleB) {
    const unit = { ...cam, D: 1 };
    const dy = toPlane(pts.poleT, unit).Y - toPlane(pts.poleB, unit).Y;
    if (dy > 1e-6) { D = opt.poleLen / dy; method = 'pole'; }
  }

  const calc = (Dc) => {
    const c = { ...cam, D: Dc };
    const P = (k) => (pts[k] ? toPlane(pts[k], c) : null);
    const top = P('top'), base = P('base'), cb = P('cb');
    const cl = P('cl'), cr = P('cr'), dl = P('dl'), dr = P('dr');
    const r = {};
    if (top && base) r.height = top.Y - base.Y;
    if (cb && base) r.clear = cb.Y - base.Y;
    if (cl && cr) r.crown = Math.abs(cr.X - cl.X);
    if (dl && dr) {
      // 원통의 접선 보정 : 겉보기 반폭 → 실제 반지름
      const half = Math.abs(dr.X - dl.X) / 2;
      r.radius = half * Dc / Math.hypot(Dc, half);
      r.dbh = r.radius * 2 * 100; // cm
    }
    return r;
  };

  let r = calc(D);
  // 줄기 표면까지 잰 거리라면 반지름만큼 더해 줄기 중심 거리로 환산
  if (opt.surface && method === 'distance' && r.radius) {
    for (let i = 0; i < 3; i++) r = calc(opt.D + r.radius);
    D = opt.D + r.radius;
  }
  return { ...r, Dused: D, method };
}

/** 흉고(지면에서 bh m) 위치의 사진 행 */
export function breastRow(pts, opt, bh = 1.2) {
  if (!pts.base) return null;
  const cam = { W: opt.W, H: opt.H, f: opt.f, pitch: opt.pitch || 0, D: opt.D };
  const yb = toPlane(pts.base, cam).Y;
  return rowForY(yb + bh, cam);
}

/**
 * 줄기 경계 : 행 rowY(±2행 평균)에서 cx 양쪽으로 가장 강한 밝기 변화 위치.
 * 경계는 두 픽셀 사이에 있으므로 x+0.5 위치로 반환. 못 찾으면 null
 */
export function findTrunkEdges(img, cx, rowY, minH, maxH) {
  const { data, width: w, height: h } = img;
  const prof = (x) => {
    let s = 0, c = 0;
    for (let y = Math.round(rowY) - 2; y <= Math.round(rowY) + 2; y++) {
      if (y < 0 || y >= h || x < 0 || x >= w) continue;
      const i = (y * w + x) * 4; s += (data[i] + data[i + 1] + data[i + 2]) / 3; c++;
    }
    return c ? s / c : 0;
  };
  const edge = (dir) => {
    let bx = null, bg = 0;
    for (let d = minH; d <= maxH; d++) {
      const x = Math.round(cx) + dir * d;
      const x2 = x + dir;
      if (Math.min(x, x2) < 0 || Math.max(x, x2) >= w) break;
      const g = Math.abs(prof(x2) - prof(x));
      if (g > bg) { bg = g; bx = (x + x2) / 2 + 0.5; }
    }
    return bg > 12 ? bx : null;
  };
  const l = edge(-1), r = edge(1);
  return l !== null && r !== null ? [l, r] : null;
}

// ── 자동 인식 (색·하늘 대비 기반, 오프라인 동작) ─────────────────
/**
 * img: { data, width, height } (RGBA, 분석용 축소 이미지)
 * cam: { f(px, 이 축소 이미지 기준), D, pitch, eye(촬영 높이 m) }
 * 반환: { pts, notes[] } — pts 좌표는 입력 이미지 기준
 */
export function autoDetect(img, cam) {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const L = new Float32Array(n);
  const skyRaw = new Uint8Array(n);
  const veg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = (r + g + b) / 3, sat = (mx - mn) / (mx + 1);
    L[i] = l;
    skyRaw[i] = ((b >= r && b >= g - 8 && b > 120 && l > 110 && b - r > 12) || (l > 185 && sat < 0.18)) ? 1 : 0;
    const exg = (2 * g - r - b) / (r + g + b + 1);
    veg[i] = (exg > 0.06 && l < 235) || (sat > 0.25 && r > b + 25 && l < 220 && l > 40) ? 1 : 0; // 녹색 + 단풍색
  }
  // 위쪽 가장자리와 이어진 하늘만 하늘로 인정 (밝은 줄기·지면 오인 방지)
  const sky = new Uint8Array(n);
  const stack = [];
  for (let x = 0; x < w; x++) if (skyRaw[x]) { sky[x] = 1; stack.push(x); }
  while (stack.length) {
    const i = stack.pop(), x = i % w;
    const nb = [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1];
    for (const j of nb) if (j >= 0 && j < n && skyRaw[j] && !sky[j]) { sky[j] = 1; stack.push(j); }
  }
  const notes = [];
  const pitch = cam.pitch || 0;
  const camFull = { W: w, H: h, f: cam.f, pitch, D: cam.D };

  // 1) 하늘선(skyline)에서 가장 높은 지점 = 수관 꼭대기 (가운데 60% 범위)
  const sl = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h && sky[y * w + x]) y++;
    sl[x] = y;
  }
  const x0 = Math.floor(w * 0.2), x1 = Math.ceil(w * 0.8);
  let best = h, xs = [];
  for (let x = x0; x < x1; x++) {
    if (sl[x] < best - 1) { best = sl[x]; xs = [x]; } else if (Math.abs(sl[x] - best) <= 1) xs.push(x);
  }
  const hasSky = best < h * 0.9;
  let topX = xs.length ? xs[Math.floor(xs.length / 2)] : Math.round(w / 2);
  let topY = hasSky ? best : Math.round(h * 0.08);
  if (!hasSky) notes.push('하늘이 보이지 않아 꼭대기를 추정했습니다');
  if (hasSky && topY <= 1) notes.push('나무 꼭대기가 사진 위로 잘렸을 수 있습니다');

  // 2) 밑동 = 촬영 높이(eye)와 거리로 예측한 지면 행 (평지 가정)
  const eye = cam.eye ?? 1.4;
  let baseY = Math.round(rowForY(-eye, camFull));
  if (!(baseY > topY + 10 && baseY < h)) { baseY = Math.round(h * 0.92); notes.push('밑동 위치를 추정했습니다'); }

  // 3) 수관 좌우 : 꼭대기 아래로 내려가며, 꼭대기 열을 포함한 '하늘 아닌' 구간의 폭
  const runAt = (y, xc) => {
    if (sky[y * w + xc]) return null;
    const gap = 3;
    let a = xc, b = xc, s = 0;
    for (let x = xc - 1; x >= 0; x--) { if (sky[y * w + x]) { if (++s >= gap) break; } else { s = 0; a = x; } }
    s = 0;
    for (let x = xc + 1; x < w; x++) { if (sky[y * w + x]) { if (++s >= gap) break; } else { s = 0; b = x; } }
    return [a, b];
  };
  let maxW = 0, crownRow = topY, cl = topX, cr = topX, cbY = null, trunkX = topX;
  let narrow = 0;
  if (hasSky) {
    for (let y = Math.max(topY, 0); y < baseY; y++) {
      const run = runAt(y, trunkX);
      if (!run) continue;
      const [a, b] = run;
      if (a === 0 || b === w - 1) break; // 배경(지평선·건물)과 이어짐
      const wd = b - a;
      if (wd > maxW) { maxW = wd; crownRow = y; cl = a; cr = b; }
      if (maxW > 8 && wd < maxW * 0.2) {           // 수관 아래 줄기만 남음
        if (++narrow >= 3) { cbY = y - 3; trunkX = Math.round((a + b) / 2); break; }
      } else narrow = 0;
      if (wd > maxW * 0.5) trunkX = Math.round((a + b) / 2) * 0.3 + trunkX * 0.7 | 0;
    }
  }
  if (maxW < 8) {
    // 하늘 대비가 없으면 식생(녹색·단풍색) 덩어리 범위로 대체
    let a = w, b = 0;
    const y = Math.round(topY + (baseY - topY) * 0.3);
    for (let x = 0; x < w; x++) if (veg[y * w + x]) { a = Math.min(a, x); b = Math.max(b, x); }
    if (b > a) { cl = a; cr = b; crownRow = y; } else { cl = Math.round(topX - w * 0.2); cr = Math.round(topX + w * 0.2); crownRow = y; }
    notes.push('수관 폭은 색상으로 추정했습니다 — 확인하세요');
  }
  if (cbY === null) {
    // 줄기 주변 식생 비율로 수관 하단 찾기
    const span = Math.max(4, Math.round((cr - cl) * 0.15));
    for (let y = crownRow; y < baseY; y++) {
      let c = 0, t = 0;
      for (let x = Math.max(0, trunkX - span); x <= Math.min(w - 1, trunkX + span); x++) { t++; c += veg[y * w + x]; }
      if (c / t < 0.15) { cbY = y; break; }
    }
    if (cbY === null || cbY >= baseY - 2) { cbY = Math.round(topY + (baseY - topY) * 0.65); notes.push('지하고는 추정값입니다 — 첫 가지 위치로 옮겨 주세요'); }
  }

  // 4) 흉고 좌우 : 흉고 행에서 줄기 중심 양쪽의 가장 강한 밝기 경계
  const ptsBase = { x: trunkX, y: baseY };
  const yb = toPlane(ptsBase, camFull).Y;
  const bhY = Math.round(rowForY(yb + 1.2, camFull));
  const pxPerM = cam.f / cam.D;
  const minH = Math.max(1, Math.round(0.03 * pxPerM)), maxH = Math.max(minH + 2, Math.round(0.9 * pxPerM));
  const e = findTrunkEdges(img, trunkX, bhY, minH, maxH);
  let dl = e && e[0], dr = e && e[1];
  if (!e) {
    const half = Math.round(0.15 * pxPerM);
    dl = trunkX - half; dr = trunkX + half;
    notes.push('흉고 줄기 경계를 찾지 못했습니다 — 양쪽 점을 줄기 가장자리에 맞추세요');
  }

  return {
    trunkFound: !!e,
    pts: {
      top: { x: topX, y: topY },
      base: { x: trunkX, y: baseY },
      cb: { x: trunkX, y: cbY },
      cl: { x: cl, y: crownRow },
      cr: { x: cr, y: crownRow },
      dl: { x: dl, y: bhY },
      dr: { x: dr, y: bhY },
    },
    notes,
  };
}
