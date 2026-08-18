import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  Facebook,
  Headphones,
  Image as ImageIcon,
  Inbox,
  Menu,
  MessageCircle,
  Mic2,
  PackageCheck,
  Search,
  Send,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Store,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Brand } from './Brand';
import './marketing.css';

interface Feature {
  title: string;
  description: string;
  icon: LucideIcon;
  tone: 'indigo' | 'emerald' | 'amber' | 'rose' | 'cyan' | 'violet';
  size?: 'wide' | 'tall';
}

const FEATURES: Feature[] = [
  {
    title: 'One focused Messenger inbox',
    description: 'Keep customer conversations, AI replies, and human follow-ups together in a workspace built for selling.',
    icon: Inbox,
    tone: 'indigo',
    size: 'wide',
  },
  {
    title: 'Catalog-grounded answers',
    description: 'Give shoppers accurate product, price, and availability answers from the catalog you control.',
    icon: Boxes,
    tone: 'emerald',
    size: 'tall',
  },
  {
    title: 'Bangla, Banglish, English',
    description: 'Reply naturally in the language your customer uses.',
    icon: MessageCircle,
    tone: 'violet',
  },
  {
    title: 'Voice and image context',
    description: 'Understand voice notes and product photos when a text message is not enough.',
    icon: Mic2,
    tone: 'rose',
  },
  {
    title: 'Human handoff stays human',
    description: 'Pause automated replies and give your team a clear path to take over sensitive conversations.',
    icon: Headphones,
    tone: 'amber',
    size: 'wide',
  },
  {
    title: 'Orders and payment links',
    description: 'Turn a conversation into a tracked order and offer SSLCommerz checkout where it fits.',
    icon: PackageCheck,
    tone: 'cyan',
  },
];

const STEPS = [
  ['01', 'Continue with Facebook', 'Use the account that manages your business Page.'],
  ['02', 'Connect Messenger', 'Link the Facebook Page your customers already use.'],
  ['03', 'Review and refine', 'Let AI handle routine questions while your team stays in control.'],
  ['04', 'Confirm the order', 'Capture the order, payment state, and next action in one place.'],
];

function usePageMetadata() {
  useEffect(() => {
    document.title = 'InboxPlease — Turn Messenger conversations into orders';
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previous = description?.content;
    if (description) {
      description.content = 'InboxPlease helps Bangladeshi Facebook sellers manage Messenger conversations, AI replies, catalogs, and orders in one workspace.';
    }
    return () => {
      if (description && previous !== undefined) description.content = previous;
    };
  }, []);
}

function DashboardPreview() {
  return (
    <div className="landing-preview-shell" aria-label="InboxPlease inbox and order workspace preview" role="img">
      <div className="preview-browser-bar">
        <span className="preview-dots"><i /><i /><i /></span>
        <span className="preview-address"><ShieldCheck size={12} /> app.inboxplease.com</span>
        <span className="preview-live"><i /> Live</span>
      </div>
      <div className="preview-workspace">
        <aside className="preview-rail">
          <span className="preview-mini-logo"><MessageCircle size={15} /></span>
          <span className="preview-rail-active"><Inbox size={15} /></span>
          <span><ShoppingBag size={15} /></span>
          <span><Boxes size={15} /></span>
        </aside>
        <section className="preview-conversations">
          <header><strong>Inbox</strong><em>3</em></header>
          <div className="preview-search"><Search size={13} /> Search conversations</div>
          <div className="preview-person active"><span className="avatar-indigo">AR</span><p><strong>Ayesha Rahman</strong><small>Is the maroon color available?</small></p><time>2m</time></div>
          <div className="preview-person"><span className="avatar-green">TH</span><p><strong>Tarik Hasan</strong><small>Please share the order status.</small></p><time>1h</time></div>
          <div className="preview-person"><span className="avatar-rose">FN</span><p><strong>Farhana Nina</strong><small>Can I pay online?</small></p><time>3h</time></div>
        </section>
        <section className="preview-thread">
          <header><div><strong>Ayesha Rahman</strong><span><Facebook size={11} /> Messenger</span></div><em><Bot size={12} /> AI active</em></header>
          <div className="preview-messages">
            <div className="preview-bubble customer">Hi! Is the Jamdani Kurti available in maroon, size XL?</div>
            <div className="preview-bubble assistant">Yes — Maroon XL is currently in stock. Would you like me to prepare an order?</div>
            <span className="preview-grounded"><Sparkles size={11} /> Answered from catalog</span>
          </div>
          <footer><span>Write a reply…</span><i><Send size={13} /></i></footer>
        </section>
        <aside className="preview-order">
          <header><strong>Order draft</strong><span>New</span></header>
          <div className="preview-order-customer"><span>AR</span><p><small>Customer</small><strong>Ayesha Rahman</strong></p></div>
          <p className="preview-label">Product</p>
          <div className="preview-product"><span><Store size={16} /></span><p><strong>Jamdani Motif Kurti</strong><small>Maroon · XL · Qty 1</small></p><b>৳1,250</b></div>
          <div className="preview-total"><span>Total</span><strong>৳1,250</strong></div>
          <button type="button"><Check size={14} /> Confirm order</button>
        </aside>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  usePageMetadata();

  return (
    <div className="marketing-page">
      <a className="marketing-skip" href="#landing-main">Skip to content</a>
      <header className="marketing-header">
        <div className="marketing-container marketing-nav">
          <Brand />
          <nav id="marketing-menu" className={`marketing-nav-links${menuOpen ? ' open' : ''}`} aria-label="Marketing navigation">
            <a href="#features" onClick={() => setMenuOpen(false)}>Features</a>
            <a href="#workflow" onClick={() => setMenuOpen(false)}>How it works</a>
            <a href="#pricing" onClick={() => setMenuOpen(false)}>Pricing</a>
            <span className="mobile-nav-actions">
              <a href="/signin">Sign in</a>
              <a className="marketing-button dark small" href="/signup">Start with Facebook <ArrowRight size={14} /></a>
            </span>
          </nav>
          <div className="marketing-nav-actions">
            <a className="marketing-signin-link" href="/signin">Sign in</a>
            <a className="marketing-button dark small" href="/signup">Start with Facebook <ArrowRight size={14} /></a>
            <button className="marketing-menu-button" type="button" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-controls="marketing-menu" aria-label={menuOpen ? 'Close menu' : 'Open menu'}>
              {menuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>
      </header>

      <main id="landing-main">
        <section className="landing-hero">
          <div className="landing-grid" aria-hidden="true" />
          <div className="landing-glow landing-glow-one" aria-hidden="true" />
          <div className="landing-glow landing-glow-two" aria-hidden="true" />
          <div className="marketing-container landing-hero-inner">
            <div className="landing-eyebrow"><span><Facebook size={13} /></span> Built for Bangladeshi Facebook sellers</div>
            <h1>Turn Messenger conversations into <span>confirmed orders.</span></h1>
            <p>InboxPlease brings customer chats, catalog-aware AI, human handoff, and order tracking into one calm workspace.</p>
            <div className="landing-hero-actions">
              <a className="marketing-button dark" href="/signup">Continue with Facebook <ArrowRight size={17} /></a>
              <a className="marketing-button light" href="#preview"><span className="button-play"><ChevronRight size={15} /></span> See the workspace</a>
            </div>
            <div className="landing-proof" aria-label="Product capabilities">
              <span><CheckCircle2 size={15} /> No credit card to start</span>
              <span><CheckCircle2 size={15} /> Bangla and Banglish ready</span>
              <span><CheckCircle2 size={15} /> Your team stays in control</span>
            </div>
            <div id="preview" className="landing-preview-wrap"><DashboardPreview /></div>
          </div>
        </section>

        <section className="landing-capability-strip" aria-label="InboxPlease capabilities">
          <div className="marketing-container">
            <p>One workspace for the full conversation-to-order flow</p>
            <div><span><Facebook /> Messenger</span><i /><span><Bot /> AI replies</span><i /><span><ImageIcon /> Image context</span><i /><span><ShoppingBag /> Orders</span><i /><span><ShieldCheck /> Human control</span></div>
          </div>
        </section>

        <section className="landing-section landing-features" id="features">
          <div className="marketing-container">
            <div className="landing-section-heading">
              <span className="landing-kicker"><Sparkles size={14} /> Everything in context</span>
              <h2>Fewer tabs. Better conversations. More confident orders.</h2>
              <p>Each InboxPlease tool is designed around the questions and workflows Facebook sellers handle every day.</p>
            </div>
            <div className="feature-bento">
              {FEATURES.map(({ title, description, icon: Icon, tone, size }) => (
                <article className={`landing-feature-card tone-${tone}${size ? ` feature-${size}` : ''}`} key={title}>
                  <span className="feature-card-icon"><Icon size={22} /></span>
                  <div><h3>{title}</h3><p>{description}</p></div>
                  {title === 'One focused Messenger inbox' && <div className="feature-mini-inbox" aria-hidden="true"><span>AR</span><p><strong>New customer question</strong><small>Maroon XL কি available?</small></p><em>Now</em></div>}
                  {title === 'Catalog-grounded answers' && <div className="feature-stock-pill"><span /> Live stock context</div>}
                  {title === 'Voice and image context' && <div className="feature-media-icons" aria-hidden="true"><span><Mic2 /></span><span><ImageIcon /></span></div>}
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-section landing-workflow" id="workflow">
          <div className="marketing-container">
            <div className="landing-section-heading compact">
              <span className="landing-kicker"><Zap size={14} /> A clearer workflow</span>
              <h2>From first message to next action.</h2>
              <p>Start with a simple workspace, then add automation at the pace your team trusts.</p>
            </div>
            <div className="workflow-grid">
              {STEPS.map(([number, title, description], index) => (
                <article key={number}>
                  <div className="workflow-number"><span>{number}</span>{index < STEPS.length - 1 && <i />}</div>
                  <h3>{title}</h3>
                  <p>{description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-section landing-pricing" id="pricing">
          <div className="marketing-container pricing-layout">
            <div className="pricing-copy">
              <span className="landing-kicker"><ShoppingBag size={14} /> Start small</span>
              <h2>Explore InboxPlease before choosing a paid plan.</h2>
              <p>Create a workspace, shape your catalog, and see how the dashboard fits your selling workflow. Upgrade options can grow with your store.</p>
              <a className="marketing-text-link" href="/signup">Start with Facebook <ArrowRight size={15} /></a>
            </div>
            <article className="pricing-card">
              <header><span>Free</span><em>Start here</em></header>
              <div className="pricing-amount"><strong>৳0</strong><span>/ month</span></div>
              <p>A straightforward way to explore the core InboxPlease workspace.</p>
              <ul>
                <li><Check size={15} /> Seller dashboard</li>
                <li><Check size={15} /> Product catalog workspace</li>
                <li><Check size={15} /> Order tracking workflow</li>
                <li><Check size={15} /> Upgrade when your store is ready</li>
              </ul>
              <a className="marketing-button dark full" href="/signup">Continue with Facebook <ArrowRight size={16} /></a>
              <small>No credit card required to create your workspace.</small>
            </article>
          </div>
        </section>

        <section className="landing-final-cta">
          <div className="final-cta-glow one" aria-hidden="true" /><div className="final-cta-glow two" aria-hidden="true" />
          <div className="marketing-container">
            <span><Sparkles size={14} /> Your next order may begin with a message</span>
            <h2>Give every conversation a clear next step.</h2>
            <p>Bring Messenger, product context, and order work into one focused place.</p>
            <div><a className="marketing-button white" href="/signup">Continue with Facebook <ArrowRight size={16} /></a><a className="marketing-button ghost" href="/signin">Sign in to your workspace</a></div>
          </div>
        </section>
      </main>

      <footer className="marketing-footer">
        <div className="marketing-container marketing-footer-main">
          <div><Brand /><p>A calmer operating workspace for Bangladeshi Facebook sellers.</p></div>
          <nav aria-label="Footer navigation"><div><strong>Product</strong><a href="#features">Features</a><a href="#workflow">How it works</a><a href="#pricing">Pricing</a></div><div><strong>Account</strong><a href="/signup">Start with Facebook</a><a href="/signin">Sign in</a></div></nav>
        </div>
        <div className="marketing-container marketing-footer-bottom"><span>© {new Date().getFullYear()} InboxPlease.</span><span>Built for conversations that become orders.</span></div>
      </footer>
    </div>
  );
}