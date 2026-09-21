import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ShellUpdate from './pwa';
import './styles.css';
import './theme.css';
import { initializeTheme } from './theme';
import { initializeAuth } from './auth';

initializeTheme();
void initializeAuth().then(() =>
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
      <ShellUpdate />
    </React.StrictMode>,
  ),
);
