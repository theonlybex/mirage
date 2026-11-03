// SPDX-License-Identifier: AGPL-3.0-or-later
import './theme/fonts.css';
import './theme/tokens.css';
import './theme/base.css';
import './components/components.css';
import './shell/shell.css';
import './edit/edit.css';
import './review/review.css';
import './versions/versions.css';
import './report/report.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { installMotion } from './theme/motion.js';
import { applyTheme, savedTheme } from './shell/theme.js';

applyTheme(savedTheme());
installMotion();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
