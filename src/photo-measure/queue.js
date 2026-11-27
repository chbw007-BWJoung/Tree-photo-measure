// 인터넷이 없을 때 측정값을 휴대폰(localStorage)에 보관하는 대기열
// 항목의 _replace 칸 = 전송 후 지울 기존 기록 id 목록 (재측정)
export const QUEUE_KEY = 'photoMeasure.pending.v1';
export const readQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } };
export const writeQueue = (q) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* 저장 불가 */ } };

let running = null; // 동시에 두 번 전송되지 않도록 (중복 저장 방지)

/** 대기열을 Supabase로 전송. 반환: { sent, left } */
export function flushQueue(supabase, table = 'tree_measurements') {
  if (running) return running;
  running = flushOnce(supabase, table).finally(() => { running = null; });
  return running;
}

async function flushOnce(supabase, table) {
  const q = readQueue();
  if (!supabase || !q.length || !navigator.onLine) return { sent: 0, left: q.length };
  const done = [];
  for (const item of q) {
    const { _replace, ...row } = item;
    const { error } = await supabase.from(table).insert(row);
    if (error) continue; // 실패한 항목은 대기열에 남음
    done.push(item);
    if (_replace?.length) await supabase.from(table).delete().in('id', _replace);
  }
  // 전송 중에 새로 추가된 항목은 남김
  const sentKeys = new Set(done.map((r) => r.created_at + '|' + r.tree_no));
  const now = readQueue().filter((r) => !sentKeys.has(r.created_at + '|' + r.tree_no));
  writeQueue(now);
  return { sent: done.length, left: now.length };
}

