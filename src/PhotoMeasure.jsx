// ─────────────────────────────────────────────────────────────
//  사진으로 수목 측정 (수고·지하고·수관폭·흉고직경)
//  → Supabase tree_measurements 에 저장 → 기초현황조사표 '측정값 가져오기'로 반영
// ─────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LENSES, readExif, deviceName, focalPx, autoDetect, computeMeasures, breastRow, findTrunkEdges, rowForY, toPlane,
} from './core.js';
import { readQueue, writeQueue, flushQueue as flushRows } from './queue.js';
import './PhotoMeasure.css';

const HANDLES = {
  top: { label: '꼭대기', color: '#ef4444' },
  cb: { label: '지하고(첫 가지)', color: '#f59e0b' },
  base: { label: '밑동', color: '#a855f7' },
  cl: { label: '수관 좌', color: '#22c55e' },
  cr: { label: '수관 우', color: '#22c55e' },
  dl: { label: '흉고 좌', color: '#38bdf8' },
  dr: { label: '흉고 우', color: '#38bdf8' },
  poleT: { label: '기준자 위', color: '#f472b6' },
  poleB: { label: '기준자 아래', color: '#f472b6' },
};
const DEFAULT_SPECIES = ['은행나무', '왕벚나무', '느티나무', '이팝나무', '양버즘나무', '소나무', '메타세쿼이아', '회화나무', '단풍나무', '중국단풍', '팽나무', '벚나무', '스트로브잣나무', '배롱나무'];
const TABLE = 'tree_measurements';

const round = (v, d) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const fmt = (v, d) => (v == null || !isFinite(v) ? '–' : v.toFixed(d));
const getLS = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setLS = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 무시 */ } };
const presetF35 = (id) => LENSES.find((l) => l.id === id)?.f35;
/** 렌즈 선택값 → 35mm 환산 초점거리 */
const resolveF35 = (sel, mm, ph) => {
  if (sel === 'exif' && ph?.f35Exif) return ph.f35Exif;
  if (sel === 'custom') { const v = parseFloat(mm); return v > 5 && v < 400 ? v : null; }
  return presetF35(sel) || 24;
};
const isNetworkError = (err) => !navigator.onLine || /fetch|network|load failed|timed out/i.test(err?.message || '');

export default function PhotoMeasure({
  supabase,              // createClient(...) 로 만든 클라이언트 (필수)
  onClose,               // 닫기
  onSaved,               // (row) => void  저장 후 호출
  surveyUrl,             // 기초현황조사표 주소 (예: '../survey/index.html') — 있으면 '조사표 열기' 버튼 표시
  speciesList = DEFAULT_SPECIES,
  eyeHeight = 1.4,       // 촬영 높이(m) — 밑동 자동 추정에 사용
  bhHeight = 1.2,        // 흉고 높이(m)
}) {
  // ── 입력값 ──
  const [step, setStep] = useState('setup');
  const [treeNo, setTreeNo] = useState('');
  const [species, setSpecies] = useState('');
  const [dist, setDist] = useState(() => localStorage.getItem('photoMeasure.dist') || '20');
  const [pitch, setPitch] = useState('0');
  const [surface, setSurface] = useState(false);
  const [usePole, setUsePole] = useState(false);
  const [poleLen, setPoleLen] = useState('2');
  const [lensSel, setLensSel] = useState(() => getLS('photoMeasure.lensSel', '24'));
  const [customMm, setCustomMm] = useState(() => getLS('photoMeasure.customMm', ''));
  const [showLens, setShowLens] = useState(false);
  const [photo, setPhoto] = useState(null); // { canvas, W, H, exif }
  const [pts, setPts] = useState(null);
  const [notes, setNotes] = useState([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(() => readQueue().length);
  const [savedNo, setSavedNo] = useState(null);
  const [selected, setSelected] = useState(null);

  const f35 = resolveF35(lensSel, customMm, photo) || 24;
  const f35Valid = resolveF35(lensSel, customMm, photo) !== null;
  const device = deviceName(photo?.exif);
  const f35Source = lensSel === 'exif' && photo?.f35Exif ? '사진 정보' : lensSel === 'custom' ? '직접 입력' : '선택값';

  // 렌즈 변경 : 기본값으로 기억하고, 초점 정보가 없는 기종이면 기종별로도 기억
  const changeLens = (sel, mm = customMm) => {
    setLensSel(sel); setCustomMm(mm);
    if (sel !== 'exif') { setLS('photoMeasure.lensSel', sel); setLS('photoMeasure.customMm', mm); }
    if (device && !photo?.f35Exif && sel !== 'exif') setLS('photoMeasure.f35:' + device, JSON.stringify({ sel, mm }));
  };

  const cvRef = useRef(null);
  const view = useRef({ s: 1, ox: 0, oy: 0 });
  const ptsRef = useRef(null);
  const drag = useRef(null);
  const pointers = useRef(new Map());
  const pinch = useRef(null);
  const raf = useRef(0);
  const camRef = useRef(null);
  const noTouched = useRef(false);

  const D = parseFloat(dist) || 0;
  const pitchDeg = parseFloat(pitch) || 0;
  const cam = useMemo(() => (photo ? {
    W: photo.W, H: photo.H, f: focalPx(f35, photo.W, photo.H), pitch: pitchDeg, D: D || 20,
  } : null), [photo, f35, pitchDeg, D]);
  camRef.current = cam;
  ptsRef.current = pts;

  // 흉고 행에 흉고 좌우점을 고정
  const effPts = useCallback((p, c) => {
    if (!p || !c) return p;
    const by = breastRow(p, c, bhHeight);
    return { ...p, dl: { x: p.dl.x, y: by }, dr: { x: p.dr.x, y: by } };
  }, [bhHeight]);

  const measures = useMemo(() => {
    if (!pts || !cam) return null;
    return computeMeasures(effPts(pts, cam), {
      ...cam, D: D || 0, surface, poleLen: usePole ? parseFloat(poleLen) || 0 : 0,
    });
  }, [pts, cam, D, surface, usePole, poleLen, effPts]);

  // ── 다음 No. 제안 (오늘 저장된 최대 No. + 1) & 대기열 전송 ──
  const flushQueue = useCallback(async () => {
    const { sent, left } = await flushRows(supabase, TABLE);
    setPending(left);
    if (sent) setMsg(`대기 중이던 ${sent}건을 저장했습니다.`);
  }, [supabase]);

  useEffect(() => {
    flushQueue();
    const on = () => flushQueue();
    window.addEventListener('online', on);
    (async () => {
      // 1) 폰에 기억한 오늘 마지막 No.·대기열로 바로 채움 (오프라인에서도 즉시)
      const today = new Date().toDateString();
      let last = {};
      try { last = JSON.parse(getLS('photoMeasure.lastNo', '{}')); } catch { /* 무시 */ }
      const local = Math.max(last.day === today ? last.no || 0 : 0, ...readQueue().map((r) => r.tree_no || 0));
      if (!noTouched.current) setTreeNo(String(local + 1));
      if (!supabase) return;
      // 2) 서버에서 오늘 최대 No. 확인 (5초 제한)
      try {
        const d0 = new Date(); d0.setHours(0, 0, 0, 0);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const { data, error } = await supabase.from(TABLE).select('tree_no')
          .eq('archived', false).gte('created_at', d0.toISOString())
          .not('tree_no', 'is', null).order('tree_no', { ascending: false }).limit(1)
          .abortSignal(ctrl.signal);
        clearTimeout(timer);
        if (!error && !noTouched.current) setTreeNo(String(Math.max(data?.[0]?.tree_no || 0, local) + 1));
      } catch { /* 오프라인 : 폰에 기억한 값 유지 */ }
    })();
    return () => window.removeEventListener('online', on);
  }, [supabase, flushQueue]);

  // ── 사진 불러오기 ──
  const loadFile = async (file) => {
    if (!file) return;
    setMsg('사진을 불러오는 중…'); setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const exif = readExif(buf);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await img.decode();
      const W0 = img.naturalWidth, H0 = img.naturalHeight;
      // iOS 사파리 캔버스 한도(약 1,670만 화소) 안으로 축소
      const sc = Math.min(1, 4096 / Math.max(W0, H0), Math.sqrt(15e6 / (W0 * H0)));
      const W = Math.round(W0 * sc), H = Math.round(H0 * sc);
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      canvas.getContext('2d').drawImage(img, 0, 0, W, H);
      URL.revokeObjectURL(url);
      const fx = exif.focal35 && exif.focal35 > 5 && exif.focal35 < 400 ? exif.focal35 : null;
      const ph = { canvas, W, H, exif, f35Exif: fx };
      const dev = deviceName(exif);
      // 렌즈 결정 : 사진 정보 → 이 기종에 저장해 둔 값 → 마지막 선택값
      let sel = lensSel === 'exif' ? getLS('photoMeasure.lensSel', '24') : lensSel, mm = customMm;
      if (fx) sel = 'exif';
      else if (dev) {
        try { const m = JSON.parse(getLS('photoMeasure.f35:' + dev, 'null')); if (m?.sel) { sel = m.sel; mm = m.mm || ''; } } catch { /* 무시 */ }
      }
      setLensSel(sel); setCustomMm(mm);
      setShowLens(!fx);
      setPhoto(ph);
      setStep('measure');
      setSavedNo(null);
      runDetect(ph, resolveF35(sel, mm, ph) || 24);
      setMsg(fx ? '' : `사진에 초점거리 정보가 없습니다${dev ? ` (${dev})` : ''}. 아래 렌즈/초점거리를 확인하세요.`);
    } catch (e) {
      setMsg('사진을 열 수 없습니다. JPEG로 다시 시도해 주세요. (' + (e?.message || e) + ')');
    } finally { setBusy(false); }
  };

  // ── 자동 인식 ──
  const runDetect = (ph = photo, f35v = f35) => {
    if (!ph) return;
    const { canvas, W, H } = ph;
    const a = 600 / Math.max(W, H);
    const aw = Math.round(W * a), ah = Math.round(H * a);
    const ac = document.createElement('canvas');
    ac.width = aw; ac.height = ah;
    const actx = ac.getContext('2d', { willReadFrequently: true });
    actx.drawImage(canvas, 0, 0, aw, ah);
    const imgData = actx.getImageData(0, 0, aw, ah);
    const Dv = D || 20;
    const { pts: p, notes: nt } = autoDetect(imgData, { f: focalPx(f35v, aw, ah), D: Dv, pitch: pitchDeg, eye: eyeHeight });
    const k = W / aw;
    const full = {};
    for (const key of Object.keys(p)) full[key] = { x: p[key].x * k, y: p[key].y * k };

    // 흉고 경계는 원본 해상도에서 다시 찾기
    const c = { W, H, f: focalPx(f35v, W, H), pitch: pitchDeg, D: Dv };
    const by = breastRow(full, c, bhHeight);
    const pxPerM = c.f / Dv;
    const minH = Math.max(2, Math.round(0.03 * pxPerM)), maxH = Math.round(0.9 * pxPerM);
    const x0 = Math.max(0, Math.round(full.base.x - maxH - 3));
    const x1 = Math.min(W, Math.round(full.base.x + maxH + 3));
    const y0 = Math.max(0, Math.round(by) - 4);
    if (x1 - x0 > 4 && y0 + 9 <= H) {
      const strip = canvas.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, x1 - x0, 9);
      const e = findTrunkEdges(strip, full.base.x - x0, 4, minH, maxH);
      if (e) { full.dl.x = e[0] + x0; full.dr.x = e[1] + x0; }
    }
    // 기준자 초기 위치 : 줄기 오른쪽 0.6 m, 밑동~2 m
    const yb = toPlane(full.base, c).Y;
    full.poleB = { x: full.base.x + 0.6 * pxPerM, y: full.base.y };
    full.poleT = { x: full.base.x + 0.6 * pxPerM, y: rowForY(yb + (parseFloat(poleLen) || 2), c) };
    setPts(full);
    setNotes(nt);
    fitView(ph);
  };

  // ── 화면 맞춤 / 그리기 ──
  const fitView = (ph = photo) => {
    const cv = cvRef.current;
    if (!cv || !ph) return;
    const r = cv.getBoundingClientRect();
    const s = Math.min(r.width / ph.W, r.height / ph.H) * 0.96;
    view.current = { s, ox: (r.width - ph.W * s) / 2, oy: (r.height - ph.H * s) / 2 };
    schedule();
  };

  const drawOverlay = (ctx, p, c, s, ox, oy, opts = {}) => {
    const S = (q) => ({ x: q.x * s + ox, y: q.y * s + oy });
    const lw = opts.scale || 1;
    ctx.lineWidth = 2 * lw;
    const line = (a, b, color, dash) => {
      const A = S(a), B = S(b);
      ctx.strokeStyle = color; ctx.setLineDash(dash ? [6 * lw, 5 * lw] : []);
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    };
    const e = effPts(p, c);
    line({ x: e.base.x, y: e.top.y }, e.base, '#ffffffaa', true);
    line(e.top, { x: e.base.x, y: e.top.y }, '#ef4444aa', true);
    line(e.cl, e.cr, '#22c55e', false);
    line({ x: e.base.x - 40 / s, y: e.cb.y }, { x: e.base.x + 40 / s, y: e.cb.y }, '#f59e0b', false);
    // 흉고 안내선
    const by = e.dl.y;
    line({ x: e.base.x - 120 / s * lw, y: by }, { x: e.base.x + 120 / s * lw, y: by }, '#38bdf866', true);
    line(e.dl, e.dr, '#38bdf8', false);
    if (usePole) line(e.poleB, e.poleT, '#f472b6', false);
    ctx.setLineDash([]);
    const keys = Object.keys(HANDLES).filter((k) => usePole || !k.startsWith('pole'));
    ctx.font = `${12 * lw}px system-ui, sans-serif`;
    for (const k of keys) {
      const q = S(e[k]);
      const active = opts.active === k;
      ctx.fillStyle = HANDLES[k].color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = (active ? 3 : 2) * lw;
      ctx.beginPath(); ctx.arc(q.x, q.y, (active ? 11 : 8) * lw, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(q.x, q.y, 1.5 * lw, 0, Math.PI * 2); ctx.fillStyle = '#000'; ctx.fill();
      if (opts.labels !== false) {
        const t = HANDLES[k].label;
        const left = k === 'cl' || k === 'dl';
        const tw = ctx.measureText(t).width;
        const tx = left ? q.x - 14 * lw - tw : q.x + 14 * lw;
        ctx.fillStyle = '#000a'; ctx.fillRect(tx - 3 * lw, q.y - 9 * lw, tw + 6 * lw, 17 * lw);
        ctx.fillStyle = '#fff'; ctx.fillText(t, tx, q.y + 4 * lw);
      }
    }
  };

  const draw = () => {
    raf.current = 0;
    const cv = cvRef.current, p = ptsRef.current, c = camRef.current;
    if (!cv || !photo) return;
    const dpr = window.devicePixelRatio || 1;
    const r = cv.getBoundingClientRect();
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) {
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, r.width, r.height);
    const { s, ox, oy } = view.current;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(photo.canvas, ox, oy, photo.W * s, photo.H * s);
    if (!p || !c) return;
    const act = drag.current?.key;
    drawOverlay(ctx, p, c, s, ox, oy, { active: act });

    // 돋보기 : 끄는 동안 손가락 반대편 위쪽에 4배 확대
    if (act) {
      const e = effPts(p, c)[act];
      const R = 62, Z = Math.max(s * 4, 0.6);
      const fx = drag.current.sx;
      const lx = fx < r.width / 2 ? r.width - R - 12 : R + 12, ly = R + 12;
      ctx.save();
      ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = '#000'; ctx.fillRect(lx - R, ly - R, 2 * R, 2 * R);
      ctx.drawImage(photo.canvas, lx - e.x * Z, ly - e.y * Z, photo.W * Z, photo.H * Z);
      drawOverlay(ctx, p, c, Z, lx - e.x * Z, ly - e.y * Z, { active: act, labels: false });
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(lx - R, ly); ctx.lineTo(lx + R, ly); ctx.moveTo(lx, ly - R); ctx.lineTo(lx, ly + R); ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = HANDLES[act].color; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2); ctx.stroke();
    }
  };
  const schedule = () => { if (!raf.current) raf.current = requestAnimationFrame(draw); };

  useEffect(() => { schedule(); });
  useEffect(() => { if (step === 'measure' && photo) fitView(photo); }, [step, photo]); // eslint-disable-line
  useEffect(() => {
    const on = () => fitView();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  });

  // ── 터치 조작 : 점 끌기 / 이동 / 두 손가락 확대 ──
  const local = (ev) => { const r = cvRef.current.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  const toImg = (q) => ({ x: (q.x - view.current.ox) / view.current.s, y: (q.y - view.current.oy) / view.current.s });

  const onDown = (ev) => {
    if (!ptsRef.current) return;
    cvRef.current.setPointerCapture(ev.pointerId);
    const q = local(ev);
    pointers.current.set(ev.pointerId, q);
    if (pointers.current.size === 2) {
      drag.current = null;
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v: { ...view.current } };
      schedule(); return;
    }
    const { s, ox, oy } = view.current;
    const e = effPts(ptsRef.current, camRef.current);
    let best = null, bd = 30;
    for (const k of Object.keys(HANDLES)) {
      if (!usePole && k.startsWith('pole')) continue;
      const d = Math.hypot(e[k].x * s + ox - q.x, e[k].y * s + oy - q.y);
      if (d < bd) { bd = d; best = k; }
    }
    if (best) {
      drag.current = { key: best, start: q, orig: { ...ptsRef.current[best] }, sx: q.x };
      setSelected(best);
    } else drag.current = { pan: true, start: q, v: { ...view.current } };
    schedule();
  };

  const onMove = (ev) => {
    if (!pointers.current.has(ev.pointerId)) return;
    const q = local(ev);
    pointers.current.set(ev.pointerId, q);
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const P = pinch.current;
      const s = Math.min(Math.max(P.v.s * d / P.d, 0.02), 8);
      const ix = (P.m.x - P.v.ox) / P.v.s, iy = (P.m.y - P.v.oy) / P.v.s;
      view.current = { s, ox: m.x - ix * s, oy: m.y - iy * s };
      schedule(); return;
    }
    const g = drag.current;
    if (!g) return;
    if (g.pan) {
      view.current = { ...g.v, ox: g.v.ox + q.x - g.start.x, oy: g.v.oy + q.y - g.start.y };
    } else {
      // 손가락 이동량의 0.5배로 움직여 미세 조정
      const k = 0.5 / view.current.s;
      const np = { x: g.orig.x + (q.x - g.start.x) * k, y: g.orig.y + (q.y - g.start.y) * k };
      np.x = Math.min(Math.max(np.x, 0), photo.W); np.y = Math.min(Math.max(np.y, 0), photo.H);
      g.sx = q.x;
      const next = { ...ptsRef.current, [g.key]: np };
      ptsRef.current = next;
      setPts(next);
    }
    schedule();
  };

  const onUp = (ev) => {
    pointers.current.delete(ev.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
    schedule();
  };

  // 선택한 점을 화살표 버튼으로 1px씩 이동
  const nudge = (dx, dy) => {
    if (!selected || !pts) return;
    const p = pts[selected];
    setPts({ ...pts, [selected]: { x: p.x + dx, y: p.y + dy } });
  };

  // ── 저장 ──
  const save = async () => {
    if (!measures) return;
    if (!(D > 0) && measures.method !== 'pole') { setMsg('거리(m)를 입력하세요.'); return; }
    const row = {
      tree_no: parseInt(treeNo, 10) || null,
      species: species.trim() || null,
      height: round(measures.height, 2),
      clear_length: round(measures.clear, 2),
      dbh: round(measures.dbh, 1),
      crown_width: round(measures.crown, 2),
    };
    const bad = [];
    if (!(row.height > 0.3 && row.height < 80)) bad.push('수고');
    if (!(row.clear_length >= 0 && row.clear_length < row.height)) bad.push('지하고');
    if (!(row.crown_width > 0 && row.crown_width < 60)) bad.push('수관폭');
    if (!(row.dbh > 1 && row.dbh < 500)) bad.push('흉고직경');
    if (bad.length && !window.confirm(`${bad.join('·')} 값이 비정상적입니다. 그래도 저장할까요?`)) return;

    setBusy(true); setMsg('저장 중…');
    try {
      if (!supabase) throw new Error('Supabase 클라이언트가 연결되지 않았습니다');
      const { error } = await supabase.from(TABLE).insert(row);
      if (error) throw error;
      setMsg(`No.${row.tree_no ?? '–'} 저장 완료 — 조사표의 '📥 측정값 가져오기'에서 불러오세요.`);
      afterSave(row);
    } catch (err) {
      if (!supabase || isNetworkError(err)) {
        const q = [...readQueue(), row]; writeQueue(q); setPending(q.length);
        setMsg(`인터넷 연결이 없어 휴대폰에 보관했습니다 (대기 ${q.length}건). 연결되면 자동 전송됩니다.`);
        afterSave(row);
      } else setMsg('저장 실패: ' + (err?.message || err));
    } finally { setBusy(false); }
  };
  const afterSave = (row) => {
    localStorage.setItem('photoMeasure.dist', dist);
    setSavedNo(row.tree_no);
    onSaved?.(row);
    if (row.tree_no) {
      setTreeNo(String(row.tree_no + 1));
      setLS('photoMeasure.lastNo', JSON.stringify({ day: new Date().toDateString(), no: row.tree_no }));
    }
    setSpecies('');
  };

  // ── 측정 사진(표시 포함) 저장 ──
  const exportPhoto = async () => {
    if (!photo || !pts || !cam) return;
    const k = Math.min(1, 2048 / Math.max(photo.W, photo.H));
    const c = document.createElement('canvas');
    c.width = Math.round(photo.W * k); c.height = Math.round(photo.H * k);
    const ctx = c.getContext('2d');
    ctx.drawImage(photo.canvas, 0, 0, c.width, c.height);
    const sc = c.width / 700;
    drawOverlay(ctx, pts, cam, k, 0, 0, { scale: sc });
    const lines = [
      `No.${treeNo || '–'} ${species || ''}`.trim(),
      `수고 ${fmt(measures.height, 1)}m  지하고 ${fmt(measures.clear, 1)}m  수관폭 ${fmt(measures.crown, 1)}m  흉고 ${fmt(measures.dbh, 1)}cm`,
      `${device ? device + ' · ' : ''}거리 ${fmt(measures.Dused, 2)}m · 초점 ${f35}mm(${f35Source}) · 기울기 ${pitchDeg}° · ${new Date().toLocaleString('ko-KR')}`,
    ];
    ctx.font = `${14 * sc}px system-ui, sans-serif`;
    const bh = (lines.length * 20 + 12) * sc;
    ctx.fillStyle = '#000b'; ctx.fillRect(0, c.height - bh, c.width, bh);
    ctx.fillStyle = '#fff';
    lines.forEach((t, i) => ctx.fillText(t, 10 * sc, c.height - bh + (22 + i * 20) * sc));
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
    const file = new File([blob], `수목측정_No${treeNo || ''}_${Date.now()}.jpg`, { type: 'image/jpeg' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch { /* 취소 */ }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  };

  const lensPicker = (
    <div className="pm-lens">
      <select value={lensSel === 'exif' && !photo?.f35Exif ? '24' : lensSel} onChange={(e) => changeLens(e.target.value)}>
        {photo?.f35Exif && <option value="exif">사진 정보 {photo.f35Exif}mm (자동)</option>}
        {LENSES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        <option value="custom">직접 입력 (mm)</option>
      </select>
      {lensSel === 'custom' && (
        <input inputMode="decimal" placeholder="예: 23" value={customMm} aria-label="35mm 환산 초점거리"
          className={f35Valid ? '' : 'pm-bad'} onChange={(e) => changeLens('custom', e.target.value)} />
      )}
    </div>
  );
  const lensHint = (
    <p className="pm-hint">
      📱 {device || '기종 정보 없음'} · 초점 {f35}mm ({f35Source})
      {!photo?.f35Exif && <><br />사진에 초점 정보가 없으면 휴대폰 사양표의 <b>35mm 환산 초점거리</b>를 직접 입력하세요. 기종별로 기억됩니다. 모르면 <b>기준자</b>를 쓰면 정확합니다.</>}
    </p>
  );

  // ── 화면 ──
  return (
    <div className="pm-root">
      <header className="pm-head">
        {step === 'measure'
          ? <button className="pm-btn" onClick={() => setStep('setup')}>‹ 설정</button>
          : <span />}
        <h1>📷 사진으로 측정</h1>
        <button className="pm-btn" onClick={onClose} aria-label="닫기">닫기</button>
      </header>

      {step === 'setup' && (
        <div className="pm-setup">
          <div className="pm-grid">
            <label>No.<input inputMode="numeric" value={treeNo} onChange={(e) => { noTouched.current = true; setTreeNo(e.target.value.replace(/\D/g, '')); }} /></label>
            <label>수종<input list="pm-species" value={species} onChange={(e) => setSpecies(e.target.value)} placeholder="선택 또는 입력" /></label>
            <datalist id="pm-species">{speciesList.map((s) => <option key={s} value={s} />)}</datalist>
            <label>줄기까지 수평거리 (m)<input inputMode="decimal" value={dist} onChange={(e) => setDist(e.target.value)} /></label>
            <label>렌즈 / 초점거리 (35mm 환산){lensPicker}</label>
            <label>카메라 기울기 (°, 위로 +)<input inputMode="decimal" value={pitch} onChange={(e) => setPitch(e.target.value)} /></label>
            <label className="pm-chk"><input type="checkbox" checked={surface} onChange={(e) => setSurface(e.target.checked)} /> 거리를 줄기 표면까지 쟀음</label>
            <label className="pm-chk"><input type="checkbox" checked={usePole} onChange={(e) => setUsePole(e.target.checked)} /> 기준자 사용 (거리 대신)</label>
            {usePole && <label>기준자 길이 (m)<input inputMode="decimal" value={poleLen} onChange={(e) => setPoleLen(e.target.value)} /></label>}
          </div>
          {photo && lensHint}
          <div className="pm-shoot">
            <label className="pm-btn pm-primary pm-big">
              📸 카메라로 촬영
              <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { loadFile(e.target.files[0]); e.target.value = ''; }} />
            </label>
            <label className="pm-btn pm-big">
              🖼 앨범에서 선택
              <input type="file" accept="image/*" hidden onChange={(e) => { loadFile(e.target.files[0]); e.target.value = ''; }} />
            </label>
            {photo && <button className="pm-btn pm-big" onClick={() => setStep('measure')}>현재 사진으로 계속</button>}
          </div>
          <ul className="pm-tips">
            <li>1배 렌즈로 세로로 들고, <b>폰을 수평으로</b> 유지한 채 나무 전체가 들어오게 찍으세요.</li>
            <li>거리는 줄자나 레이저 거리계로 <b>줄기 중심까지 수평거리</b>를 재세요. 수고 이상 떨어지면 정확합니다.</li>
            <li>밑동이 가려지거나 경사지라면 <b>기준자</b>(예: 2 m 측간)를 줄기 옆에 세우고 찍으세요.</li>
          </ul>
          {msg && <p className="pm-msg">{msg}</p>}
          {pending > 0 && <p className="pm-msg">전송 대기 {pending}건 <button className="pm-btn" onClick={flushQueue}>지금 전송</button></p>}
        </div>
      )}

      {step === 'measure' && (
        <div className="pm-measure">
          <canvas
            ref={cvRef}
            className="pm-canvas"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
          <div className="pm-panel">
            <div className="pm-results">
              <div><span>수고</span><b>{fmt(measures?.height, 1)}</b><i>m</i></div>
              <div><span>지하고</span><b>{fmt(measures?.clear, 1)}</b><i>m</i></div>
              <div><span>수관폭</span><b>{fmt(measures?.crown, 1)}</b><i>m</i></div>
              <div><span>흉고직경</span><b>{fmt(measures?.dbh, 1)}</b><i>cm</i></div>
            </div>
            <div className="pm-row">
              <label>No.<input inputMode="numeric" value={treeNo} onChange={(e) => { noTouched.current = true; setTreeNo(e.target.value.replace(/\D/g, '')); }} /></label>
              <label>수종<input list="pm-species" value={species} onChange={(e) => setSpecies(e.target.value)} /></label>
              <label>거리m<input inputMode="decimal" value={dist} onChange={(e) => setDist(e.target.value)} disabled={measures?.method === 'pole'} /></label>
              <label>기울기°<input inputMode="decimal" value={pitch} onChange={(e) => setPitch(e.target.value)} /></label>
            </div>
            <datalist id="pm-species">{speciesList.map((s) => <option key={s} value={s} />)}</datalist>
            <div className="pm-sub">
              <button className="pm-link" onClick={() => setShowLens((v) => !v)}>
                📱 {device || '기종 정보 없음'} · {f35}mm ({f35Source}) {showLens ? '▴' : '▾'}
              </button>
              {measures?.method === 'pole' && <span>기준자 거리 {fmt(measures.Dused, 2)} m</span>}
              {selected && <span className="pm-nudge">
                {HANDLES[selected].label}
                <button onClick={() => nudge(-1, 0)}>←</button><button onClick={() => nudge(1, 0)}>→</button>
                <button onClick={() => nudge(0, -1)}>↑</button><button onClick={() => nudge(0, 1)}>↓</button>
              </span>}
            </div>
            {showLens && <div className="pm-lensbox">{lensPicker}{lensHint}</div>}
            {notes.length > 0 && <p className="pm-note">⚠ {notes.join(' · ')}</p>}
            {msg && <p className="pm-msg">{msg}</p>}
            <div className="pm-actions">
              <button className="pm-btn" onClick={() => runDetect()} disabled={busy}>다시 인식</button>
              <button className="pm-btn" onClick={() => fitView()}>화면 맞춤</button>
              <button className="pm-btn" onClick={exportPhoto}>사진 저장</button>
              <button className="pm-btn pm-primary" onClick={save} disabled={busy || !measures}>저장</button>
            </div>
            {savedNo !== null && (
              <div className="pm-actions">
                <label className="pm-btn pm-primary">
                  📸 다음 나무 촬영
                  <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { loadFile(e.target.files[0]); e.target.value = ''; }} />
                </label>
                {surveyUrl && <a className="pm-btn" href={surveyUrl + (surveyUrl.includes('?') ? '&' : '?') + 'import=1'}>기초조사표 열기</a>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
