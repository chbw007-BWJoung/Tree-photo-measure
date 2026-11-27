// 인터넷이 없을 때 측정값을 휴대폰(localStorage)에 보관하는 대기열
export const QUEUE_KEY = 'photoMeasure.pending.v1';
export const readQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } };
export const writeQueue = (q) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* 저장 불가 */ } };

/** 대기열을 Supabase로 전송. 반환: { sent, left } */
export async function flushQueue(supabase, table = 'tree_measurements') {
  const q = readQueue();
  if (!supabase || !q.length || !navigator.onLine) return { sent: 0, left: q.length };
  const left = [];
  for (const row of q) {
    const { error } = await supabase.from(table).insert(row);
    if (error) left.push(row);
  }
  writeQueue(left);
  return { sent: q.length - left.length, left: left.length };
}
