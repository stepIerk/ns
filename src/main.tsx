import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import Preview from './preview/Preview.tsx';

// Превью чата без входа: http://localhost:5173/test (и /test в проде через 404.html).
const path = window.location.pathname.replace(/\/+$/, '');
const isPreview = path === '/test' || path.endsWith('/test');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPreview ? <Preview /> : <App />}
  </StrictMode>,
);
