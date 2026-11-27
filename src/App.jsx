import { useCallback, useEffect, useRef, useState } from 'react';
import PhotoMeasure from './photo-measure/PhotoMeasure.jsx';
import { flushQueue, readQueue, writeQueue } from './photo-measure/queue.js';
import { supabase, TABLE } from './supabaseClient.js';

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const f1 = (v) => (v == null ? '' : (Math.round(v * 10) / 10).toFixed(1));
const hm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const getSetting = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setSetting = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 무시 */ } };

export default function App() {
  const [measuring, setMeasuring] = useState(false);
  const [redoNo, setRedoNo] = useState(null);   // 삭제 후 다시 측정할 No.
  const [replace, setReplace] = useState(null); // 재측정 대상 (기존 기록 대체)
  const [redoInput, setRedoInput] = useState('');
  const [date, setDate] = useState(todayStr());
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('');
  const [notice, setNotice] = useState(null);   // { text, no, error }
  const [busyKey, setBusyKey] = useState(null);
  const lastServer = useRef({ date: null, rows: [] }); // 마지막으로 받은 서버 목록 (오프라인 표시용)
  const [pending, setPending] = useState(readQueue().length);
  const [showSettings, setShowSettings] = useState(false);
  const [surveyUrl, setSurveyUrl] = useState(() => getSetting('surveyUrl', import.meta.env.VITE_SURVEY_URL || ''));
  const [eyeHeight, setEyeHeight] = useState(() => getSetting('eyeHeight', '1.4'));

  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;

  const load = useCallback(async () => {
    setPending(readQueue().length);
    const [y, m, d] = date.split('-').map(Number);
    const ds = new Date(y, m - 1, d), de = new Date(y, m - 1, d + 1);
    // 아직 전송 안 된(대기) 기록도 목록에 표시
    const queued = readQueue()
      .filter((r) => { const t = new Date(r.created_at || Date.now()); return t >= ds && t < de; })
      .map((r) => ({ ...r, pending: true, key: `q${r.created_at}_${r.tree_no}` }));
    if (!supabase) {
      setRows(queued);
      setStatus(queued.length ? '' : '이 날짜에 측정 기록이 없습니다.');
      return;
    }
    const cached = lastServer.current.date === date ? lastServer.current.rows : [];
    const offline = !navigator.onLine;
    if (offline) {
      setRows([...queued, ...cached]);
      setStatus('오프라인 — 마지막으로 불러온 목록과 휴대폰에 보관된 기록을 표시합니다.');
      return;
    }
    setRows([...queued, ...cached]);
    setStatus('불러오는 중…');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000); // 오프라인에서 무한 대기 방지
    const { data, error } = await supabase.from(TABLE)
      .select('id,created_at,tree_no,species,height,clear_length,dbh,crown_width')
      .eq('archived', false).gte('created_at', ds.toISOString()).lt('created_at', de.toISOString())
      .order('created_at', { ascending: false })
      .abortSignal(ctrl.signal);
    clearTimeout(timer);
    if (error) {
      setRows([...queued, ...cached]);
      setStatus('불러오기 실패: ' + error.message);
      return;
    }
    const server = (data || []).map((r) => ({ ...r, key: `id${r.id}` }));
    lastServer.current = { date, rows: server };
    const all = [...queued, ...server];
    setRows(all);
    setStatus(all.length ? '' : '이 날짜에 저장된 측정값이 없습니다.');
  }, [date]);

  // ── 측정 기록 삭제 : DB에서 실제로 지워 번호도 비움 ──
  const removeRow = async (r) => {
    const label = `No.${r.tree_no ?? '–'}${r.species ? ' ' + r.species : ''}`;
    const ok = window.confirm(
      `${label} 기록을 삭제할까요? (수고 ${f1(r.height)}m)\n\n`
      + '· 되돌릴 수 없습니다.\n'
      + '· 이 번호는 비워져 다시 측정할 때 쓸 수 있습니다.\n'
      + '· 이미 조사표로 가져온 값은 조사표에서 따로 지워야 합니다.',
    );
    if (!ok) return;
    setBusyKey(r.key);
    try {
      if (r.pending) {
        writeQueue(readQueue().filter((q) => !(q.created_at === r.created_at && q.tree_no === r.tree_no)));
      } else {
        if (!supabase) throw new Error('Supabase 연결 정보가 없습니다');
        const { data, error } = await supabase.from(TABLE).delete().eq('id', r.id).select('id');
        if (error) throw error;
        if (!data?.length) {
          throw new Error('삭제 권한이 없습니다. Supabase SQL Editor에서 supabase/allow_delete.sql을 실행하세요. (최근 7일 안의 기록만 삭제할 수 있습니다)');
        }
      }
      // 폰에 기억한 '오늘 마지막 No.'가 지운 번호였다면 남은 기록 기준으로 되돌림
      try {
        const last = JSON.parse(getSetting('photoMeasure.lastNo', '{}'));
        if (date === todayStr() && last.day === new Date().toDateString() && last.no === r.tree_no) {
          const rest = rows.filter((x) => x.key !== r.key).map((x) => x.tree_no || 0);
          setSetting('photoMeasure.lastNo', JSON.stringify({ day: last.day, no: Math.max(0, ...rest) }));
        }
      } catch { /* 무시 */ }
      setNotice({ text: `${label} 기록을 삭제했습니다.`, no: r.tree_no });
      await load();
    } catch (err) {
      setNotice({ text: '삭제 실패: ' + (err?.message || err), error: true });
    } finally { setBusyKey(null); }
  };

  // ── 번호로 재측정 : 이 날짜 목록에서 같은 No. 기록을 찾아 대체 모드로 측정 화면 열기 ──
  const startRemeasure = (no) => {
    const n = parseInt(no, 10);
    if (!n) { setNotice({ text: '재측정할 No.를 입력하세요.', error: true }); return; }
    const same = rows.filter((r) => r.tree_no === n)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    if (!same.length) {
      if (!window.confirm(`${date} 기록에 No.${n}이(가) 없습니다.\nNo.${n}(으)로 새로 측정할까요?`)) return;
      setReplace(null); setRedoNo(n); setMeasuring(true); return;
    }
    setRedoNo(null);
    setReplace({
      treeNo: n,
      species: same[0].species || '',
      prev: same[0],
      ids: same.filter((r) => !r.pending).map((r) => r.id),
      queued: same.filter((r) => r.pending).map((r) => ({ created_at: r.created_at, tree_no: r.tree_no })),
    });
    setMeasuring(true);
  };

  const sendPending = useCallback(async () => {
    const { sent, left } = await flushQueue(supabase, TABLE);
    setPending(left);
    if (sent) load();
  }, [load]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const off = () => load();
    window.addEventListener('offline', off);
    return () => window.removeEventListener('offline', off);
  }, [load]);
  useEffect(() => {
    sendPending();
    window.addEventListener('online', sendPending);
    return () => window.removeEventListener('online', sendPending);
  }, [sendPending]);

  if (measuring) {
    return (
      <PhotoMeasure
        supabase={supabase}
        surveyUrl={surveyUrl || undefined}
        eyeHeight={parseFloat(eyeHeight) || 1.4}
        initialTreeNo={redoNo || undefined}
        replace={replace || undefined}
        onClose={() => { setMeasuring(false); setRedoNo(null); setReplace(null); setRedoInput(''); setNotice(null); load(); }}
      />
    );
  }

  const surveyHref = surveyUrl ? surveyUrl + (surveyUrl.includes('?') ? '&' : '?') + 'import=1' : null;

  return (
    <div className="app">
      <header className="app-head">
        <h1>🌳 사진 수목측정</h1>
        <button className="btn" onClick={() => setShowSettings((v) => !v)} aria-label="설정">⚙︎</button>
      </header>

      {!supabase && (
        <div className="banner warn">
          Supabase 연결 정보가 없습니다. 측정값은 휴대폰에만 보관됩니다.
          (VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY 확인)
        </div>
      )}
      {pending > 0 && (
        <div className="banner">
          전송 대기 {pending}건 <button className="btn sm" onClick={sendPending}>지금 전송</button>
        </div>
      )}
      {notice && (
        <div className={'banner' + (notice.error ? ' warn' : '')}>
          <span>{notice.text}</span>
          <span className="banner-btns">
            {notice.no && !notice.error && (
              <button className="btn sm" onClick={() => { setReplace(null); setRedoNo(notice.no); setMeasuring(true); }}>No.{notice.no} 다시 측정</button>
            )}
            <button className="btn sm" onClick={() => setNotice(null)} aria-label="닫기">✕</button>
          </span>
        </div>
      )}

      {showSettings && (
        <section className="card">
          <h2>설정</h2>
          <label>기초현황조사표 주소
            <input value={surveyUrl} placeholder="https://…/survey/index.html"
              onChange={(e) => { setSurveyUrl(e.target.value.trim()); setSetting('surveyUrl', e.target.value.trim()); }} />
          </label>
          <label>촬영 높이 (m) — 밑동 자동 추정용
            <input inputMode="decimal" value={eyeHeight}
              onChange={(e) => { setEyeHeight(e.target.value); setSetting('eyeHeight', e.target.value); }} />
          </label>
        </section>
      )}

      <div className="main-actions">
        <button className="btn primary big" onClick={() => { setRedoNo(null); setReplace(null); setMeasuring(true); }}>📷 사진으로 측정</button>
        {surveyHref && <a className="btn big" href={surveyHref}>📋 기초조사표 열기</a>}
      </div>

      <section className="card">
        <div className="list-head">
          <h2>측정 기록</h2>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <button className="btn sm" onClick={load}>새로고침</button>
        </div>
        <div className="redo-row">
          <input inputMode="numeric" placeholder="No." value={redoInput} aria-label="재측정할 No."
            onChange={(e) => setRedoInput(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') startRemeasure(redoInput); }} />
          <button className="btn sm" onClick={() => startRemeasure(redoInput)}>🔁 번호로 재측정</button>
        </div>
        {status && <p className="muted">{status}</p>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>No.</th><th>수종</th><th>수고<br />m</th><th>흉고<br />cm</th><th>수관폭<br />m</th><th>지하고<br />m</th><th>시각</th><th>관리</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className={r.pending ? 'pending' : ''}>
                    <td><b>{r.tree_no ?? '–'}</b></td><td>{r.species || ''}</td>
                    <td>{f1(r.height)}</td><td>{f1(r.dbh)}</td><td>{f1(r.crown_width)}</td><td>{f1(r.clear_length)}</td>
                    <td className="muted">{r.pending ? '대기' : hm(r.created_at)}</td>
                    <td className="acts">
                      <button className="redo" onClick={() => startRemeasure(r.tree_no)} disabled={!r.tree_no}
                        aria-label={`No.${r.tree_no ?? ''} 재측정`}>🔁</button>
                      <button className="del" disabled={busyKey === r.key} onClick={() => removeRow(r)}
                        aria-label={`No.${r.tree_no ?? ''} 삭제`}>{busyKey === r.key ? '…' : '🗑'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.some((r) => r.pending) && <p className="muted">노란색 = 아직 서버로 보내지 않은 기록</p>}
      </section>

      {!standalone && (
        <p className="muted tip">
          아이폰: 사파리 <b>공유 → 홈 화면에 추가</b> · 안드로이드: 크롬 <b>⋮ → 홈 화면에 추가</b>
        </p>
      )}
    </div>
  );
}
