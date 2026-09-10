import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {DarkModeProvider} from './contexts/DarkModeContext';
import './index.css';

createRoot(document.getElementById('root')!).render(
 <StrictMode>
 <DarkModeProvider>
 <App />
 </DarkModeProvider>
 </StrictMode>,
);
