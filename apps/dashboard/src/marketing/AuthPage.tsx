import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Facebook,
  Loader2,
  MessageCircle,
  ShieldCheck,
  Store,
} from 'lucide-react';
import { Brand } from './Brand';
import { AuthenticationError, continueWithFacebook } from './auth-api';
import './marketing.css';

interface AuthPageProps {
  mode: 'signin' | 'signup';
}

function AuthAside({ mode }: AuthPageProps) {
  return (
    <aside className="auth-aside">
      <div className="auth-aside-grid" aria-hidden="true" />
      <span className="auth-aside-glow glow-one" aria-hidden="true" /><span className="auth-aside-glow glow-two" aria-hidden="true" />
      <div className="auth-aside-content">
        <Brand inverse />
        <div className="auth-aside-copy">
          <span className="auth-aside-kicker"><ShieldCheck size={14} /> A workspace your team controls</span>
          <h2>{mode === 'signup' ? 'Turn busy Messenger days into a clear sales workflow.' : 'Welcome back to your conversation-to-order workspace.'}</h2>
          <p>Keep product context, customer messages, order details, and human handoff close together.</p>
          <div className="auth-benefits"><span><Check size={15} /> Catalog-aware replies</span><span><Check size={15} /> Bangla and Banglish conversations</span><span><Check size={15} /> Human control when it matters</span></div>
        </div>
        <div className="auth-aside-preview" aria-hidden="true">
          <div><span className="auth-preview-avatar">AR</span><p><strong>Ayesha Rahman</strong><small>Is Maroon XL in stock?</small></p><em>Now</em></div>
          <div className="auth-preview-answer"><span><MessageCircle size={14} /></span><p><small>InboxPlease AI</small><strong>Yes — Maroon XL is available.</strong></p></div>
          <div className="auth-preview-order"><span><Store size={14} /></span><p><small>Order draft</small><strong>৳1,250</strong></p><em><Check size={12} /> Ready</em></div>
        </div>
        <p className="auth-aside-foot">Built for Bangladeshi Facebook sellers.</p>
      </div>
    </aside>
  );
}

export default function AuthPage({ mode }: AuthPageProps) {
  const isSignUp = mode === 'signup';
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    document.title = `${isSignUp ? 'Create your workspace' : 'Sign in'} — InboxPlease`;
  }, [isSignUp]);

  const startFacebookAuth = async () => {
    if (submitting) return;
    setFormError('');
    setSubmitting(true);
    try {
      await continueWithFacebook();
    } catch (error) {
      setSubmitting(false);
      setFormError(error instanceof AuthenticationError
        ? error.message
        : 'Facebook sign-in could not start. Please try again.');
    }
  };

  return (
    <div className="auth-page">
      <a className="marketing-skip" href="#auth-form">Skip to form</a>
      <AuthAside mode={mode} />
      <main className="auth-main">
        <header className="auth-mobile-header"><Brand /><a href="/"><ArrowLeft size={15} /> Home</a></header>
        <div className="auth-panel">
          <a className="auth-back" href="/"><ArrowLeft size={15} /> Back to home</a>
          <div className="auth-heading">
            <span className="auth-heading-icon"><Facebook size={20} /></span>
            <h1>{isSignUp ? 'Start with Facebook' : 'Continue with Facebook'}</h1>
            <p>{isSignUp ? 'Use the Facebook account that manages your business Page.' : 'Use the Facebook account connected to your InboxPlease workspace.'}</p>
          </div>

          <div id="auth-form" className="auth-facebook-flow">
            {formError && <div className="auth-alert" role="alert"><span>!</span><p><strong>We couldn’t complete that</strong>{formError}</p></div>}
            <button className="auth-facebook-button" type="button" onClick={startFacebookAuth} disabled={submitting}>
              {submitting ? <><Loader2 className="auth-spinner" size={18} /> Opening Facebook…</> : <><Facebook size={19} /> Continue with Facebook <ArrowRight size={17} /></>}
            </button>
            <div className="auth-facebook-note"><ShieldCheck size={16} /><p><strong>Your AI stays off until you approve it.</strong><span>After signing in, you’ll choose a Page and review the Messenger permissions InboxPlease needs.</span></p></div>
          </div>

          <p className="auth-security"><ShieldCheck size={14} /> OAuth credentials and Page tokens never enter this form.</p>
        </div>
      </main>
    </div>
  );
}
