import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** Supabase 주소·키가 없으면 null (화면에 안내 표시, 측정값은 휴대폰에 보관) */
export const supabase = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
export const TABLE = 'tree_measurements';
