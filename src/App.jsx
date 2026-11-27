import { useCallback, useEffect, useState } from 'react';
import PhotoMeasure from './photo-measure/PhotoMeasure.jsx';
import { flushQueue, readQueue } from './photo-measure/queue.js';
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
  const [date, setDate] = useState(todayStr());
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(readQueue().length);
  const [showSettings, setShowSettings] = useState(false);
  const [surveyUrl, setSurveyUrl] = useState(() => getSetting('surveyUrl', import.meta.env.VITE_SURVEY_URL || ''));
  const [eyeHeight, setEyeHeight] = useState(() => getSetting('eyeHeight', '1.4'));

  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;

  const load = useCallback(async () => {
    setPending(readQueue().length);
    if (!supabase) return;
    setStatus('불러오는 중…');
    const [y, m, d] = date.split('-').map(Number);
    const s = new Date(y, m - 1, d).toISOString(), e = new Date(y, m - 1, d + 1).toISOString();
    const { data, error } = await supabase.from(TABLE)
      .select('id,created_at,tree_no,species,height,clear_length,dbh,crown_width')
      .eq('archived', false).gte('created_at', s).lt('created_at', e)
      .order('created_at', { ascending: false });
    if (error) { setStatus('불러오기 실패: ' + error.message); return; }
    setRows(data || []);
    setStatus(data?.length ? '' : '이 날짜에 저장된 측정값이 없습니다.');
  }, [date]);

  const sendPending = useCallback(async () => {
    const { sent, left } = await flushQueue(supabase, TABLE);
    setPending(left);
    if (sent) load();
  }, [load]);

  useEffect(() => { load(); }, [load]);
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
        onClose={() => { setMeasuring(false); setDate(todayStr()); load(); }}
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
          (GitHub Secrets의 VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY 확인)
        </div>
      )}
      {pending > 0 && (
        <div className="banner">
          전송 대기 {pending}건 <button className="btn sm" onClick={sendPending}>지금 전송</button>
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
        <button className="btn primary big" onClick={() => setMeasuring(true)}>📷 사진으로 측정</button>
        {surveyHref && <a className="btn big" href={surveyHref}>📋 기초조사표 열기</a>}
      </div>

      <section className="card">
        <div className="list-head">
          <h2>측정 기록</h2>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <button className="btn sm" onClick={load}>새로고침</button>
        </div>
        {status && <p className="muted">{status}</p>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>No.</th><th>수종</th><th>수고<br />m</th><th>흉고<br />cm</th><th>수관폭<br />m</th><th>지하고<br />m</th><th>시각</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.tree_no ?? '–'}</b></td><td>{r.species || ''}</td>
                    <td>{f1(r.height)}</td><td>{f1(r.dbh)}</td><td>{f1(r.crown_width)}</td><td>{f1(r.clear_length)}</td>
                    <td className="muted">{hm(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!standalone && (
        <p className="muted tip">
          아이폰: 사파리 하단 <b>공유</b> → <b>홈 화면에 추가</b>를 누르면 앱처럼 설치됩니다.
        </p>
      )}
    </div>
  );
}
