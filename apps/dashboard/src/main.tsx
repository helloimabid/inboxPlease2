import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { getSessionToken } from './api';
import AuthPage from './marketing/AuthPage';
import LandingPage from './marketing/LandingPage';
import './styles.css';
import './dashboard-theme.css';

function Redirect({ to }: { to: '/app' | '/signin' }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return <div className="loading-screen" role="status"><p>Taking you to InboxPlease…</p></div>;
}

function Site() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const hasSession = Boolean(getSessionToken());
  if (path === '/signin') return hasSession ? <Redirect to="/app" /> : <AuthPage mode="signin" />;
  if (path === '/signup') return hasSession ? <Redirect to="/app" /> : <AuthPage mode="signup" />;
  // Auth.js sessions are HttpOnly cookies and cannot be detected here. The
  // dashboard request itself performs the authoritative bearer-or-cookie check.
  if (path === '/app') return <App />;
  return <LandingPage />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Site />
  </StrictMode>,
);
