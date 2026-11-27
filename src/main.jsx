import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './App.css';

const root = document.getElementById('root');
root.dataset.rendered = '1';
createRoot(root).render(<App />);

// 서비스워커 (홈 화면 앱·오프라인용) — 배포 주소(https)에서만 등록
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
