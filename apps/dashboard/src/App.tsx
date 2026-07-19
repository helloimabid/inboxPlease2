import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Command,
  Clock3,
  CreditCard,
  ExternalLink,
  Facebook,
  FileDown,
  Filter,
  Headphones,
  HelpCircle,
  Image,
  ImagePlus,
  Info,
  Inbox,
  LayoutDashboard,
  Link2,
  Loader2,
  LockKeyhole,
  LogOut,
  Menu,
  MessageCircle,
  Mic2,
  MoreHorizontal,
  Package,
  PackageCheck,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Store,
  Tag,
  TrendingUp,
  Trash2,
  Truck,
  Users,
  WandSparkles,
  Wifi,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { ApiError, clearDashboardSession, getDashboardData, mediaAssetUrl } from './api';
import {
  createLiveProduct,
  deleteLiveProduct,
  liveOrderStatus,
  liveRecordCurrency,
  loadLiveDashboardData,
  updateLiveProduct,
  type LiveProductInput,
} from './dashboard-runtime';
import {
  approveFacebookPage,
  beginFacebookConnection,
  disconnectFacebookPage,
  getFacebookConnection,
  setFacebookAiMessaging,
  type FacebookConnectionState,
  type FacebookPageCandidate,
} from './facebook-api';
import type {
  Conversation,
  ConversationStatus,
  DashboardData,
  Order,
  OrderStatus,
  Product,
  ProductStatus,
  ViewId,
} from './types';

const NAVIGATION: Array<{ id: ViewId; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'orders', label: 'Orders', icon: ShoppingBag },
  { id: 'catalog', label: 'Catalog', icon: Boxes },
  { id: 'usage', label: 'Usage & plan', icon: Activity },
  { id: 'facebook', label: 'Facebook pages', icon: Facebook },
];

const VIEW_META: Record<ViewId, { title: string; subtitle: string }> = {
  overview: { title: 'Overview', subtitle: 'Your store at a glance' },
  inbox: { title: 'Inbox', subtitle: 'AI and human conversations together' },
  orders: { title: 'Orders', subtitle: 'Track every Messenger order' },
  catalog: { title: 'Catalog', subtitle: 'Products your AI can sell' },
  usage: { title: 'Usage & plan', subtitle: 'Monitor limits and AI activity' },
  facebook: { title: 'Facebook pages', subtitle: 'Connection and messaging health' },
  settings: { title: 'Settings', subtitle: 'Customize InboxPlease for your store' },
};

function initialDashboardView(): ViewId {
  return new URLSearchParams(window.location.search).get('view') === 'facebook'
    ? 'facebook'
    : 'overview';
}

const ORDER_LABELS: Record<OrderStatus, string> = {
  new: 'New',
  confirmed: 'Confirmed',
  processing: 'Processing',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const PRODUCT_LABELS: Record<ProductStatus, string> = {
  active: 'Active',
  'low-stock': 'Low stock',
  draft: 'Draft',
  'out-of-stock': 'Out of stock',
};

function money(value: number) {
  return `৳${new Intl.NumberFormat('en-BD').format(value)}`;
}

function recordMoney(value: number, currency: string) {
  if (currency === 'BDT') return money(value);
  return new Intl.NumberFormat('en-BD', { style: 'currency', currency }).format(value);
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

const FOCUSABLE_ELEMENTS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function containDialogFocus(event: KeyboardEvent, container: HTMLElement | null) {
  if (event.key !== 'Tab' || !container) return;
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_ELEMENTS))
    .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
  if (!focusable.length) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!container.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

function initialsFor(value: string) {
  const initials = value.trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join('');
  return initials.toUpperCase() || 'IP';
}

function greetingForNow() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function formattedToday() {
  return new Intl.DateTimeFormat('en-BD', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
}

function connectedPageCount(data: DashboardData) {
  return data.pages.filter((page) => page.status === 'connected').length;
}

function hasConnectedPage(data: DashboardData) {
  return connectedPageCount(data) > 0;
}

async function signOut() {
  await clearDashboardSession();
  window.location.assign('/signin');
}

function Avatar({ initials, color, size = 'md' }: { initials: string; color: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={cx('avatar', `avatar-${size}`)} style={{ '--avatar-color': color } as CSSProperties} aria-hidden="true">
      {initials}
    </span>
  );
}

function SectionTitle({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="section-title-row">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

function Progress({ value, tone = 'violet', label }: { value: number; tone?: 'violet' | 'green' | 'amber'; label: string }) {
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
      <span className={cx('progress-bar', `progress-${tone}`)} style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

function allowancePercent(used: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(100, (used / limit) * 100);
}

function allowanceLabel(limit: number): string {
  return Number.isFinite(limit) ? limit.toLocaleString('en-BD') : 'Custom';
}

function StatusBadge({ status }: { status: OrderStatus | ProductStatus | ConversationStatus }) {
  const labels: Record<string, string> = {
    ...ORDER_LABELS,
    ...PRODUCT_LABELS,
    ai: 'AI replying',
    human: 'Human active',
    waiting: 'Needs you',
  };
  return <span className={cx('status-badge', `status-${status}`)}><span />{labels[status]}</span>;
}

function EmptyState({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Icon size={21} /></div>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

function GuidedEmptyState({ icon: Icon, eyebrow, title, detail, action, secondaryAction }: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  detail: string;
  action?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
}) {
  return (
    <section className="guided-empty panel">
      <div className="guided-empty-visual" aria-hidden="true"><span><Icon size={27} /></span><i /><i /><i /></div>
      <div className="guided-empty-copy"><p>{eyebrow}</p><h2>{title}</h2><span>{detail}</span></div>
      {(action || secondaryAction) && <div className="guided-empty-actions">
        {action && <button className="button button-primary" onClick={action.onClick}>{action.label} <ArrowRight size={15} /></button>}
        {secondaryAction && <button className="button button-secondary" onClick={secondaryAction.onClick}>{secondaryAction.label}</button>}
      </div>}
    </section>
  );
}

function Sidebar({ view, onChange, mobileOpen, onClose, data }: {
  view: ViewId;
  onChange: (view: ViewId) => void;
  mobileOpen: boolean;
  onClose: () => void;
  data: DashboardData;
}) {
  const mobileNavigation = useMediaQuery('(max-width: 1020px)');
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarReturnFocus = useRef<HTMLElement | null>(null);
  const navigate = (next: ViewId) => {
    onChange(next);
    onClose();
  };
  const unreadCount = data.conversations.reduce((total, conversation) => total + conversation.unread, 0);
  const openOrders = data.orders.filter((order) => ['new', 'confirmed', 'processing'].includes(order.status)).length;
  const navCounts: Partial<Record<ViewId, number>> = { inbox: unreadCount, orders: openOrders };
  const usagePercent = allowancePercent(data.usage.messagesUsed, data.usage.messagesLimit);
  const customMessageAllowance = !Number.isFinite(data.usage.messagesLimit);
  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    if (mobileNavigation && !mobileOpen) sidebar.setAttribute('inert', '');
    else sidebar.removeAttribute('inert');
  }, [mobileNavigation, mobileOpen]);
  useEffect(() => {
    if (!mobileNavigation || !mobileOpen) return undefined;
    sidebarReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      sidebarRef.current?.querySelector<HTMLElement>('.sidebar-close')?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else containDialogFocus(event, sidebarRef.current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKeyDown);
      sidebarReturnFocus.current?.focus();
    };
  }, [mobileNavigation, mobileOpen]);

  return (
    <>
      <button className={cx('sidebar-scrim', mobileOpen && 'visible')} type="button" onClick={onClose} aria-label="Close navigation" aria-hidden={!mobileOpen} disabled={!mobileOpen} tabIndex={mobileOpen ? 0 : -1} />
      <aside ref={sidebarRef} className={cx('sidebar', mobileOpen && 'sidebar-open')} aria-label="Main navigation" aria-hidden={mobileNavigation && !mobileOpen}>
        <div className="brand-row">
          <button className="brand" onClick={() => navigate('overview')} aria-label="InboxPlease home">
            <span className="brand-mark"><MessageCircle size={20} strokeWidth={2.6} /><span /></span>
            <span>Inbox<span>Please</span></span>
          </button>
          <button className="icon-button sidebar-close" onClick={onClose} aria-label="Close menu"><X size={19} /></button>
        </div>

        <button className="store-switcher" type="button" onClick={() => navigate('settings')} aria-label={`Open settings for ${data.merchant.storeName}`}>
          <span className="store-avatar"><Store size={18} /></span>
          <span className="store-switcher-copy"><strong>{data.merchant.storeName}</strong><small>Seller workspace</small></span>
          <ChevronDown size={16} />
        </button>

        <nav className="nav-list">
          <p className="nav-label">Workspace</p>
          {NAVIGATION.slice(0, 4).map(({ id, label, icon: Icon }) => (
            <button key={id} className={cx('nav-item', view === id && 'active')} onClick={() => navigate(id)} aria-current={view === id ? 'page' : undefined}>
              <Icon size={19} />
              <span>{label}</span>
              {navCounts[id] ? <em>{navCounts[id]}</em> : null}
            </button>
          ))}
          <p className="nav-label nav-label-spaced">Manage</p>
          {NAVIGATION.slice(4).map(({ id, label, icon: Icon }) => (
            <button key={id} className={cx('nav-item', view === id && 'active')} onClick={() => navigate(id)} aria-current={view === id ? 'page' : undefined}>
              <Icon size={19} />
              <span>{label}</span>
            </button>
          ))}
          <button className={cx('nav-item', view === 'settings' && 'active')} onClick={() => navigate('settings')} aria-current={view === 'settings' ? 'page' : undefined}>
            <Settings size={19} /><span>Settings</span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="plan-mini">
            <div className="plan-mini-title"><span><Zap size={14} /> {data.merchant.plan} plan</span><strong>{customMessageAllowance ? 'Custom' : `${Math.round(usagePercent)}%`}</strong></div>
            <Progress value={usagePercent} label="Monthly AI messages used" />
            <button onClick={() => navigate('usage')}>View usage <ArrowRight size={13} /></button>
          </div>
          <button className="profile-chip" type="button" onClick={signOut} title="Sign out">
            <Avatar initials={initialsFor(data.merchant.name)} color="#4f46e5" size="sm" />
            <span><strong>{data.merchant.name}</strong><small>Signed-in account</small></span>
            <LogOut size={16} aria-hidden="true" />
          </button>
        </div>
      </aside>
    </>
  );
}

function AppHeader({ view, onMenu, onCommand, onToast }: {
  view: ViewId;
  onMenu: () => void;
  onCommand: () => void;
  onToast: (message: string) => void;
}) {
  const meta = VIEW_META[view];
  return (
    <header className="topbar">
      <div className="title-group">
        <button className="icon-button menu-button" onClick={onMenu} aria-label="Open navigation"><Menu size={21} /></button>
        <div><h1>{meta.title}</h1><p>{meta.subtitle}</p></div>
      </div>
      <div className="topbar-actions">
        <button className="global-search command-trigger" type="button" onClick={onCommand} aria-label="Open search and command menu">
          <Search size={17} />
          <span>Search pages and actions</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button className="icon-button notification-button" aria-label="Notifications" onClick={() => onToast('Notifications will appear here when your workspace has activity.')}>
          <Bell size={19} />
        </button>
        <button className="help-button" onClick={() => onToast('The setup guide is available from Overview.')}><HelpCircle size={18} /><span>Help</span></button>
      </div>
    </header>
  );
}

function CommandMenu({ open, onClose, onNavigate, onSearch }: {
  open: boolean;
  onClose: () => void;
  onNavigate: (view: ViewId) => void;
  onSearch: (query: string) => void;
}) {
  const [query, setQuery] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else containDialogFocus(event, dialogRef.current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKeyDown);
      returnFocus.current?.focus();
    };
  }, [open]);
  if (!open) return null;

  const commands = [
    ...NAVIGATION,
    { id: 'settings' as const, label: 'Settings', icon: Settings },
  ].filter((item) => `${item.label} ${VIEW_META[item.id].subtitle}`.toLowerCase().includes(query.toLowerCase()));
  const choose = (next: ViewId, search = '') => {
    onNavigate(next);
    onSearch(search);
    onClose();
  };

  return (
    <div className="command-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="command-menu" role="dialog" aria-modal="true" aria-labelledby="command-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <h2 id="command-title" className="sr-only">Search InboxPlease</h2>
        <label className="command-input"><Search size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Where would you like to go?" /><kbd>Esc</kbd></label>
        <div className="command-results">
          <p>Navigate</p>
          {commands.length ? commands.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => choose(id)}><span><Icon size={17} /></span><div><strong>{label}</strong><small>{VIEW_META[id].subtitle}</small></div><em>Open</em></button>) : <div className="command-no-results"><Command size={21} /><span>No page matches “{query}”.</span></div>}
          {query.trim() && <><p>Search records</p><button onClick={() => choose('catalog', query.trim())}><span><Boxes size={17} /></span><div><strong>Search catalog for “{query.trim()}”</strong><small>Find matching names, SKUs, and descriptions</small></div><em>Search</em></button><button onClick={() => choose('orders', query.trim())}><span><ShoppingBag size={17} /></span><div><strong>Search orders for “{query.trim()}”</strong><small>Filter the loaded order list</small></div><em>Search</em></button></>}
        </div>
        <footer><span><Search size={12} /> Type to filter</span><span><kbd>Esc</kbd> Close</span></footer>
      </section>
    </div>
  );
}

function MetricIcon({ id }: { id: string }) {
  const icons: Record<string, LucideIcon> = { revenue: CircleDollarSign, orders: ShoppingBag, conversations: MessageCircle, response: Clock3, pages: Facebook };
  const Icon = icons[id] ?? Activity;
  return <Icon size={20} />;
}

function RevenueChart({ values }: { values: number[] }) {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 620;
    const y = 154 - ((value - min) / Math.max(1, max - min)) * 115;
    return `${x},${y}`;
  }).join(' ');
  const area = `0,170 ${points} 620,170`;

  return (
    <div className="chart-wrap" aria-label="Revenue rose from approximately 8 thousand to 27 thousand taka over the last 14 days" role="img">
      <div className="chart-y-axis"><span>৳30k</span><span>৳20k</span><span>৳10k</span><span>৳0</span></div>
      <svg className="line-chart" viewBox="0 0 620 170" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="revenue-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#7065e8" stopOpacity=".24" />
            <stop offset="100%" stopColor="#7065e8" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" x2="620" y1="40" y2="40" /><line x1="0" x2="620" y1="82" y2="82" /><line x1="0" x2="620" y1="124" y2="124" /><line x1="0" x2="620" y1="166" y2="166" />
        <polygon points={area} fill="url(#revenue-fill)" />
        <polyline points={points} fill="none" stroke="#6659df" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <circle cx="620" cy={points.split(' ').at(-1)?.split(',')[1]} r="5" fill="#fff" stroke="#6659df" strokeWidth="3" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="chart-x-axis"><span>Jul 6</span><span>Jul 9</span><span>Jul 12</span><span>Jul 15</span><span>Today</span></div>
    </div>
  );
}

function DemoOverviewView({ data, onNavigate }: { data: DashboardData; onNavigate: (view: ViewId) => void }) {
  return (
    <div className="page-stack">
      <section className="welcome-row">
        <div><p className="eyebrow"><Sparkles size={15} /> Sunday, 19 July</p><h2>শুভ বিকাল, {data.merchant.name}! <span>👋</span></h2><p>Your AI sold <strong>৳18,540</strong> while you were away.</p></div>
        <div className="welcome-actions">
          <button className="button button-secondary"><FileDown size={17} /> Export report</button>
          <button className="button button-primary" onClick={() => onNavigate('inbox')}><Inbox size={17} /> Open inbox <span className="button-count">3</span></button>
        </div>
      </section>

      <section className="metric-grid" aria-label="Store performance metrics">
        {data.metrics.map((metric) => (
          <article className="metric-card" key={metric.id}>
            <div className={cx('metric-icon', `metric-${metric.id}`)}><MetricIcon id={metric.id} /></div>
            <div className="metric-copy"><p>{metric.label}</p><strong>{metric.value}</strong></div>
            <div className={cx('metric-delta', metric.delta < 0 ? 'delta-good' : 'delta-up')}>
              {metric.delta < 0 ? <ArrowDownRight size={14} /> : <ArrowUpRight size={14} />}{Math.abs(metric.delta)}%
            </div>
            <small>{metric.helper}</small>
          </article>
        ))}
      </section>

      <section className="overview-main-grid">
        <article className="panel revenue-panel">
          <SectionTitle title="Revenue overview" subtitle="Orders attributed to Messenger" action={<button className="period-select">Last 14 days <ChevronDown size={14} /></button>} />
          <div className="revenue-summary"><strong>৳2,14,630</strong><span><TrendingUp size={14} /> 16.8%</span><small>vs previous 14 days</small></div>
          <RevenueChart values={data.revenue} />
        </article>

        <article className="panel ai-summary-panel">
          <SectionTitle title="AI assistant" subtitle="This month" action={<span className="live-pill"><span /> Live</span>} />
          <div className="ai-orbit"><div><Bot size={27} /><span className="ai-spark"><Sparkles size={12} /></span></div></div>
          <strong className="ai-big">92%</strong><p className="ai-caption">conversations resolved automatically</p>
          <div className="ai-split"><div><strong>164</strong><span>Chats today</span></div><div><strong>12</strong><span>Orders closed</span></div><div><strong>3</strong><span>Need you</span></div></div>
          <button className="text-link" onClick={() => onNavigate('usage')}>View AI performance <ArrowRight size={14} /></button>
        </article>
      </section>

      <section className="overview-secondary-grid">
        <article className="panel conversation-preview">
          <SectionTitle title="Recent conversations" subtitle="3 unread messages" action={<button className="text-link" onClick={() => onNavigate('inbox')}>View all <ArrowRight size={14} /></button>} />
          <div className="preview-list">
            {data.conversations.slice(0, 4).map((conversation) => (
              <button className="preview-conversation" key={conversation.id} onClick={() => onNavigate('inbox')}>
                <Avatar initials={conversation.initials} color={conversation.color} />
                <span className="preview-copy"><span><strong>{conversation.customer}</strong><time>{conversation.updatedAt}</time></span><small>{conversation.lastMessage}</small><em>{conversation.language}</em></span>
                {conversation.unread > 0 && <b>{conversation.unread}</b>}
              </button>
            ))}
          </div>
        </article>

        <article className="panel activity-panel">
          <SectionTitle title="Live activity" subtitle="What’s happening right now" />
          <div className="activity-list">
            {data.activities.map((item) => {
              const icons: Record<string, LucideIcon> = { order: ShoppingBag, handoff: Headphones, message: Bot, catalog: Package };
              const Icon = icons[item.type];
              return <div className="activity-item" key={item.id}><span className={cx('activity-icon', `activity-${item.type}`)}><Icon size={16} /></span><div><strong>{item.title}</strong><p>{item.detail}</p></div><time>{item.time}</time></div>;
            })}
          </div>
        </article>
      </section>

      <section className="overview-footer-grid">
        <article className="panel quota-strip">
          <span className="quota-icon"><Zap size={19} /></span>
          <div className="quota-copy"><span><strong>2,148</strong> of 3,000 AI messages used</span><Progress value={(2148 / 3000) * 100} label="AI message allowance used" /><small>Resets August 1 · 852 messages remaining</small></div>
          <button className="button button-soft" onClick={() => onNavigate('usage')}>Manage plan</button>
        </article>
        <article className="panel page-health">
          <span className="facebook-icon"><Facebook size={20} /></span><div><strong>{data.pages.length ? 'Facebook page connected' : 'Connect your Facebook page'}</strong><p>{data.pages[0]?.name ?? data.merchant.storeName} · {data.pages.length ? 'connection available' : 'setup required'}</p></div><span className="connected-pill"><CheckCircle2 size={14} /> {data.pages.length ? 'Healthy' : 'Get started'}</span>
        </article>
      </section>
    </div>
  );
}

function LiveMetricGrid({ data }: { data: DashboardData }) {
  return (
    <section className="metric-grid" aria-label="Workspace metrics">
      {data.metrics.map((metric) => <article className="metric-card live-metric" key={metric.id}>
        <div className={cx('metric-icon', `metric-${metric.id}`)}><MetricIcon id={metric.id} /></div>
        <div className="metric-copy"><p>{metric.label}</p><strong>{metric.value}</strong></div>
        <small>{metric.helper}</small>
      </article>)}
    </section>
  );
}

function SetupChecklist({ data, onNavigate, prominent = false }: { data: DashboardData; onNavigate: (view: ViewId) => void; prominent?: boolean }) {
  const steps = [
    { label: 'Workspace created', detail: data.merchant.storeName, complete: true, view: 'settings' as ViewId },
    { label: 'Connect a Facebook Page', detail: 'Prepare Messenger delivery', complete: hasConnectedPage(data), view: 'facebook' as ViewId },
    { label: 'Add your first product', detail: 'Give AI accurate catalog context', complete: data.usage.productsUsed > 0, view: 'catalog' as ViewId },
    { label: 'Receive your first AI message', detail: 'See activity and usage here', complete: data.usage.messagesUsed > 0, view: 'inbox' as ViewId },
  ];
  const completeCount = steps.filter((step) => step.complete).length;
  return (
    <section className={cx('setup-checklist panel', prominent && 'setup-checklist-prominent')}>
      <header><div><span>Workspace setup</span><h2>{completeCount} of {steps.length} steps complete</h2></div><strong>{Math.round((completeCount / steps.length) * 100)}%</strong></header>
      <Progress value={(completeCount / steps.length) * 100} label={`${completeCount} of ${steps.length} setup steps complete`} />
      <div className="setup-steps">
        {steps.map((step, index) => <button key={step.label} className={step.complete ? 'complete' : ''} onClick={() => onNavigate(step.view)}>
          <span>{step.complete ? <Check size={15} /> : index + 1}</span>
          <div><strong>{step.label}</strong><small>{step.detail}</small></div>
          <ArrowRight size={15} />
        </button>)}
      </div>
    </section>
  );
}

function NewWorkspaceOverview({ data, onNavigate }: { data: DashboardData; onNavigate: (view: ViewId) => void }) {
  const nextView: ViewId = !hasConnectedPage(data) ? 'facebook' : data.usage.productsUsed === 0 ? 'catalog' : 'inbox';
  const nextLabel = nextView === 'facebook' ? 'Review Facebook setup' : nextView === 'catalog' ? 'Add your first product' : 'Open your inbox';
  return (
    <div className="page-stack onboarding-page">
      <section className="onboarding-hero">
        <div className="onboarding-grid" aria-hidden="true" /><span className="onboarding-orb one" /><span className="onboarding-orb two" />
        <div className="onboarding-copy"><p><Sparkles size={14} /> Your workspace is ready</p><h1>{greetingForNow()}, {data.merchant.name.split(' ')[0]}.</h1><span>Let’s prepare <strong>{data.merchant.storeName}</strong> for its first Messenger conversation and order.</span><div><button className="button button-white" onClick={() => onNavigate(nextView)}>{nextLabel} <ArrowRight size={16} /></button><button className="button onboarding-secondary" onClick={() => onNavigate('catalog')}>Explore the dashboard</button></div></div>
        <div className="onboarding-preview" aria-hidden="true"><div className="onboarding-preview-head"><span><MessageCircle size={15} /></span><p><strong>A future customer</strong><small>Messenger conversation</small></p><em>New</em></div><div className="onboarding-bubble">Is this product available?</div><div className="onboarding-bubble reply"><Bot size={13} /> InboxPlease will answer from your catalog.</div><div className="onboarding-order"><ShoppingBag size={15} /><span><small>Next step</small><strong>Confirm an order</strong></span><CheckCircle2 size={15} /></div></div>
      </section>
      <div className="onboarding-layout">
        <SetupChecklist data={data} onNavigate={onNavigate} prominent />
        <aside className="onboarding-help panel"><span><ShieldCheck size={21} /></span><div><p>Start with control</p><h2>You decide when AI can reply.</h2><small>Connect a page, add accurate products, and review your assistant settings before customer messages arrive.</small></div><button className="text-link" onClick={() => onNavigate('settings')}>Review assistant settings <ArrowRight size={14} /></button></aside>
      </div>
      <LiveMetricGrid data={data} />
    </div>
  );
}

function LiveOverviewView({ data, onNavigate }: { data: DashboardData; onNavigate: (view: ViewId) => void }) {
  const totalOrders = Number(data.metrics.find((metric) => metric.id === 'orders')?.value ?? 0);
  const connectedPages = connectedPageCount(data);
  const newWorkspace = connectedPages === 0 && data.usage.productsUsed === 0 && data.usage.messagesUsed === 0 && totalOrders === 0;
  if (newWorkspace) return <NewWorkspaceOverview data={data} onNavigate={onNavigate} />;
  const usagePercent = allowancePercent(data.usage.messagesUsed, data.usage.messagesLimit);
  const customMessageAllowance = !Number.isFinite(data.usage.messagesLimit);
  const nextAction = connectedPages === 0
    ? { title: 'Prepare Facebook Messenger', detail: 'Review what is required before connecting a Page.', label: 'Review setup', view: 'facebook' as ViewId, icon: Facebook }
    : data.usage.productsUsed === 0
      ? { title: 'Build your catalog', detail: 'Add product facts so replies stay grounded.', label: 'Open catalog', view: 'catalog' as ViewId, icon: Boxes }
      : { title: 'Keep an eye on the inbox', detail: 'Human handoffs and new customer questions belong here.', label: 'Open inbox', view: 'inbox' as ViewId, icon: Inbox };
  const NextIcon = nextAction.icon;
  return (
    <div className="page-stack live-overview">
      <section className="welcome-row">
        <div><p className="eyebrow"><Sparkles size={15} /> {formattedToday()}</p><h2>{greetingForNow()}, {data.merchant.name.split(' ')[0]}.</h2><p>Here’s the latest recorded activity for <strong>{data.merchant.storeName}</strong>.</p></div>
        <div className="welcome-actions"><button className="button button-secondary" onClick={() => onNavigate('usage')}><Activity size={17} /> View usage</button><button className="button button-primary" onClick={() => onNavigate('inbox')}><Inbox size={17} /> Open inbox</button></div>
      </section>
      <LiveMetricGrid data={data} />
      <section className="live-overview-main">
        <article className="workspace-pulse panel"><SectionTitle title="Workspace pulse" subtitle="Live totals recorded by InboxPlease" /><div className="pulse-list"><button onClick={() => onNavigate('facebook')}><span className="pulse-icon facebook"><Facebook size={18} /></span><div><strong>Facebook Pages</strong><small>{connectedPages ? `${connectedPages} connected to this workspace` : data.pages.length ? 'Page record needs attention' : 'No Page connected yet'}</small></div><em>{connectedPages ? 'Connected' : 'Setup'}</em></button><button onClick={() => onNavigate('catalog')}><span className="pulse-icon catalog"><Boxes size={18} /></span><div><strong>Product catalog</strong><small>{data.usage.productsUsed} products available for grounding</small></div><em>{data.usage.productsUsed ? 'Ready' : 'Empty'}</em></button><button onClick={() => onNavigate('usage')}><span className="pulse-icon assistant"><Bot size={18} /></span><div><strong>AI usage</strong><small>{data.usage.messagesUsed.toLocaleString('en-BD')}{customMessageAllowance ? ' messages this month · custom allowance' : ` of ${allowanceLabel(data.usage.messagesLimit)} messages this month`}</small></div><em>{customMessageAllowance ? 'Custom' : `${Math.round(usagePercent)}%`}</em></button></div></article>
        <article className="next-action-card"><span className="next-action-icon"><NextIcon size={23} /></span><p>Recommended next step</p><h2>{nextAction.title}</h2><small>{nextAction.detail}</small><button className="button button-primary" onClick={() => onNavigate(nextAction.view)}>{nextAction.label} <ArrowRight size={15} /></button><i className="next-action-orb" /></article>
      </section>
      <section className="overview-secondary-grid">
        <article className="panel conversation-preview"><SectionTitle title="Recent conversations" subtitle="Messenger history" action={<button className="text-link" onClick={() => onNavigate('inbox')}>Open inbox <ArrowRight size={14} /></button>} /><EmptyState icon={MessageCircle} title="No conversation preview yet" detail="Conversation history will appear here when inbox sync is enabled." /></article>
        <SetupChecklist data={data} onNavigate={onNavigate} />
      </section>
      <section className="overview-footer-grid">
        <article className="panel quota-strip"><span className="quota-icon"><Zap size={19} /></span><div className="quota-copy"><span><strong>{data.usage.messagesUsed.toLocaleString('en-BD')}</strong>{customMessageAllowance ? ' AI messages used · custom allowance' : ` of ${allowanceLabel(data.usage.messagesLimit)} AI messages used`}</span><Progress value={usagePercent} label="AI message allowance used" /><small>Resets {data.usage.resetDate}</small></div><button className="button button-soft" onClick={() => onNavigate('usage')}>View usage</button></article>
        <button className="panel page-health page-health-button" onClick={() => onNavigate('facebook')}><span className="facebook-icon"><Facebook size={20} /></span><div><strong>{connectedPages ? 'Facebook Page connected' : data.pages.length ? 'Facebook Page needs attention' : 'Facebook setup is incomplete'}</strong><p>{data.pages[0]?.name ?? data.merchant.storeName}</p></div><span className={cx('connected-pill', !connectedPages && 'attention-pill')}>{connectedPages ? <><CheckCircle2 size={14} /> Connected</> : <>Review <ArrowRight size={14} /></>}</span></button>
      </section>
    </div>
  );
}

function OverviewView({ data, onNavigate, isDemo }: { data: DashboardData; onNavigate: (view: ViewId) => void; isDemo: boolean }) {
  return isDemo ? <DemoOverviewView data={data} onNavigate={onNavigate} /> : <LiveOverviewView data={data} onNavigate={onNavigate} />;
}

function ConversationRow({ conversation, selected, onClick }: { conversation: Conversation; selected: boolean; onClick: () => void }) {
  return (
    <button className={cx('conversation-row', selected && 'selected')} onClick={onClick}>
      <Avatar initials={conversation.initials} color={conversation.color} />
      <span className="conversation-row-copy">
        <span><strong>{conversation.customer}</strong><time>{conversation.updatedAt}</time></span>
        <small>{conversation.lastMessage}</small>
        <span className="conversation-meta"><em>{conversation.language}</em>{conversation.status === 'human' && <em className="human-tag">Human</em>}</span>
      </span>
      {conversation.unread > 0 && <b>{conversation.unread}</b>}
    </button>
  );
}

function InboxView({ data, onToast, onNavigate, isDemo }: { data: DashboardData; onToast: (message: string) => void; onNavigate: (view: ViewId) => void; isDemo: boolean }) {
  const [selectedId, setSelectedId] = useState(data.conversations[0]?.id ?? '');
  const [filter, setFilter] = useState<'all' | 'unread' | 'human'>('all');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [humanMode, setHumanMode] = useState(false);
  const [localMessages, setLocalMessages] = useState<Record<string, Array<{ id: string; text: string; time: string }>>>({});

  const conversations = data.conversations.filter((conversation) => {
    const matchesQuery = `${conversation.customer} ${conversation.lastMessage}`.toLowerCase().includes(query.toLowerCase());
    const matchesFilter = filter === 'all' || (filter === 'unread' && conversation.unread > 0) || (filter === 'human' && conversation.status === 'human');
    return matchesQuery && matchesFilter;
  });
  const selected = data.conversations.find((conversation) => conversation.id === selectedId) ?? conversations[0];
  const pageConnected = hasConnectedPage(data);

  const submitMessage = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || !selected) return;
    setLocalMessages((current) => ({ ...current, [selected.id]: [...(current[selected.id] ?? []), { id: crypto.randomUUID(), text: draft.trim(), time: 'Now' }] }));
    setDraft('');
  };

  if (!selected && !isDemo) return <GuidedEmptyState icon={Inbox} eyebrow="Messenger inbox" title="Your first customer conversation will land here." detail={pageConnected ? 'Your Page is connected. Once inbox synchronization is active, new messages and human handoffs will appear in this workspace.' : 'Review Facebook setup first, then add products so InboxPlease has accurate information when messages arrive.'} action={{ label: pageConnected ? 'Review catalog' : 'Review Facebook setup', onClick: () => onNavigate(pageConnected ? 'catalog' : 'facebook') }} secondaryAction={{ label: 'View setup progress', onClick: () => onNavigate('overview') }} />;
  if (!selected) return <EmptyState icon={Inbox} title="No conversations found" detail="Try a different search or filter." />;

  return (
    <div className="inbox-shell panel">
      <section className="inbox-list-pane">
        <div className="inbox-pane-head"><div><h2>Conversations</h2><span>{data.conversations.filter((conversation) => conversation.status === 'waiting').length} waiting</span></div><button className="icon-button" aria-label="Conversation options"><MoreHorizontal size={18} /></button></div>
        <label className="field-search"><Search size={16} /><span className="sr-only">Search conversations</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search messages" /></label>
        <div className="filter-tabs" role="tablist" aria-label="Conversation filters">
          {(['all', 'unread', 'human'] as const).map((value) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)} role="tab" aria-selected={filter === value}>{value === 'all' ? 'All' : value === 'unread' ? 'Unread' : 'Human'}</button>)}
        </div>
        <div className="conversation-list">
          {conversations.length ? conversations.map((conversation) => <ConversationRow key={conversation.id} conversation={conversation} selected={selected.id === conversation.id} onClick={() => setSelectedId(conversation.id)} />) : <EmptyState icon={Search} title="Nothing here" detail="No conversations match this filter." />}
        </div>
      </section>

      <section className="chat-pane">
        <header className="chat-head">
          <div className="chat-person"><Avatar initials={selected.initials} color={selected.color} /><div><strong>{selected.customer}</strong><span><Facebook size={12} /> Messenger · Active now</span></div></div>
          <div className="chat-head-actions"><StatusBadge status={humanMode ? 'human' : selected.status} /><button className="icon-button" aria-label="More conversation actions"><MoreHorizontal size={18} /></button></div>
        </header>
        <div className="chat-context"><span><Sparkles size={14} /> AI summary</span><p>Interested in ordering. Asked about availability and delivery timing. Sentiment is positive.</p></div>
        <div className="message-scroll" aria-live="polite">
          <div className="chat-date"><span>Today</span></div>
          {selected.messages.map((message) => (
            <div className={cx('message-wrap', `message-${message.sender}`)} key={message.id}>
              {message.sender === 'assistant' && <span className="message-avatar"><Bot size={14} /></span>}
              <div><div className="message-bubble">{message.kind === 'image' && <span className="message-attachment"><Image size={18} /> Product photo</span>}{message.kind === 'voice' && <span className="voice-wave"><Mic2 size={16} /><i /><i /><i /><i /><i /></span>}<p>{message.text}</p></div><time>{message.time}{message.sender === 'assistant' && ' · AI'}</time></div>
            </div>
          ))}
          {(localMessages[selected.id] ?? []).map((message) => <div className="message-wrap message-human" key={message.id}><div><div className="message-bubble"><p>{message.text}</p></div><time>{message.time} · You</time></div></div>)}
          {!humanMode && selected.status !== 'human' && <div className="ai-composing"><span><Bot size={14} /></span><p>AI is ready to reply in {selected.language}</p><button onClick={() => setHumanMode(true)}>Take over</button></div>}
        </div>
        <form className="composer" onSubmit={submitMessage}>
          {!humanMode && selected.status !== 'human' ? <button type="button" className="takeover-banner" onClick={() => setHumanMode(true)}><Headphones size={16} /><span>Take over this conversation</span><ArrowRight size={15} /></button> : null}
          <div className="composer-box"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Write a reply" placeholder={humanMode || selected.status === 'human' ? 'Write a reply…' : 'Take over to write a reply…'} disabled={!humanMode && selected.status !== 'human'} rows={2} /><div className="composer-tools"><span><button type="button" aria-label="Attach image"><Image size={17} /></button><button type="button" aria-label="Send saved reply" onClick={() => onToast('Saved replies opened')}><Zap size={17} /></button></span><button className="send-button" aria-label="Send message" disabled={!draft.trim()}><Send size={16} /></button></div></div>
        </form>
      </section>

      <aside className="customer-pane">
        <div className="customer-identity"><Avatar initials={selected.initials} color={selected.color} size="lg" /><h3>{selected.customer}</h3><p>Messenger customer</p><div><button aria-label="Open Facebook profile"><Facebook size={16} /></button><button aria-label="Customer options"><MoreHorizontal size={16} /></button></div></div>
        <div className="detail-block"><h4>Customer details</h4><dl><div><dt>Language</dt><dd>{selected.language}</dd></div><div><dt>Orders</dt><dd>3 orders</dd></div><div><dt>Total spent</dt><dd>{money(selected.orderValue ?? 5470)}</dd></div><div><dt>Last seen</dt><dd>Active now</dd></div></dl></div>
        <div className="detail-block"><h4>Tags <button aria-label="Add tag"><Plus size={14} /></button></h4><div className="tag-list">{selected.tags.map((tag) => <span key={tag}><Tag size={11} />{tag}</span>)}</div></div>
        {selected.orderValue && <div className="linked-order"><span><ShoppingBag size={16} /></span><div><small>Open cart</small><strong>{money(selected.orderValue)}</strong><p>1 item · Delivery pending</p></div><ArrowRight size={15} /></div>}
      </aside>
    </div>
  );
}

function DemoOrdersView({ data, globalQuery, onToast }: { data: DashboardData; globalQuery: string; onToast: (message: string) => void }) {
  const [status, setStatus] = useState<'all' | OrderStatus>('all');
  const [query, setQuery] = useState(globalQuery);
  const [page, setPage] = useState(1);
  useEffect(() => setQuery(globalQuery), [globalQuery]);
  const filtered = data.orders.filter((order) => {
    const needle = `${order.id} ${order.customer} ${order.items}`.toLowerCase();
    return (status === 'all' || order.status === status) && needle.includes(query.toLowerCase());
  });
  const counts = data.orders.reduce<Record<string, number>>((acc, order) => ({ ...acc, [order.status]: (acc[order.status] ?? 0) + 1 }), {});

  return (
    <div className="page-stack">
      <section className="orders-summary-grid">
        <article><span className="summary-icon summary-new"><ShoppingBag size={19} /></span><div><p>Orders today</p><strong>38</strong><small><ArrowUpRight size={13} /> 12.5% from yesterday</small></div></article>
        <article><span className="summary-icon summary-process"><PackageCheck size={19} /></span><div><p>To process</p><strong>11</strong><small>6 are newly placed</small></div></article>
        <article><span className="summary-icon summary-ship"><Truck size={19} /></span><div><p>Shipped</p><strong>19</strong><small>On the way to customers</small></div></article>
        <article><span className="summary-icon summary-value"><CircleDollarSign size={19} /></span><div><p>Order value</p><strong>৳64.2K</strong><small>Average ৳1,689</small></div></article>
      </section>

      <section className="panel table-panel">
        <div className="table-toolbar">
          <div className="order-tabs" role="tablist" aria-label="Order status">
            <button className={status === 'all' ? 'active' : ''} onClick={() => setStatus('all')}>All <span>{data.orders.length}</span></button>
            {(['new', 'confirmed', 'processing', 'shipped'] as OrderStatus[]).map((item) => <button key={item} className={status === item ? 'active' : ''} onClick={() => setStatus(item)}>{ORDER_LABELS[item]} <span>{counts[item] ?? 0}</span></button>)}
          </div>
          <div className="toolbar-actions"><label className="field-search compact"><Search size={15} /><span className="sr-only">Search orders</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search orders" /></label><button className="button button-secondary"><Filter size={16} /> Filter</button><button className="button button-secondary" onClick={() => onToast('Order CSV prepared for export')}><FileDown size={16} /> Export</button></div>
        </div>
        {filtered.length ? <>
          <div className="table-scroll"><table className="data-table"><thead><tr><th><input type="checkbox" aria-label="Select all orders" /></th><th>Order</th><th>Customer</th><th>Products</th><th>Total</th><th>Status</th><th>Payment</th><th>Date</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
            {filtered.map((order) => <DemoOrderRow key={order.id} order={order} />)}
          </tbody></table></div>
          <footer className="table-footer"><p>Showing <strong>{filtered.length}</strong> of 2,048 orders</p><div><button aria-label="Previous page" disabled={page === 1} onClick={() => setPage(Math.max(1, page - 1))}>‹</button><button className="active">{page}</button><button onClick={() => setPage(2)}>2</button><button onClick={() => setPage(3)}>3</button><span>…</span><button onClick={() => setPage(128)}>128</button><button aria-label="Next page" onClick={() => setPage(page + 1)}>›</button></div></footer>
        </> : <EmptyState icon={ShoppingBag} title="No orders found" detail="Try changing your status filter or search." />}
      </section>
    </div>
  );
}

function DemoOrderRow({ order }: { order: Order }) {
  return <tr><td><input type="checkbox" aria-label={`Select order ${order.id}`} /></td><td><button className="order-id">#{order.id}</button><span className="source-tag"><Bot size={11} />{order.source}</span></td><td><span className="table-customer"><Avatar initials={order.initials} color="#7471c6" size="sm" /><strong>{order.customer}</strong></span></td><td><strong className="product-cell">{order.items}</strong><small>{order.itemCount} {order.itemCount === 1 ? 'item' : 'items'}</small></td><td><strong>{money(order.total)}</strong></td><td><StatusBadge status={order.status} /></td><td><span className={cx('payment-badge', `payment-${order.payment.toLowerCase()}`)}>{order.payment}</span></td><td><span className="date-cell">{order.createdAt.split(', ')[0]}<small>{order.createdAt.split(', ').slice(1).join(', ')}</small></span></td><td><button className="icon-button" aria-label={`Actions for ${order.id}`}><MoreHorizontal size={17} /></button></td></tr>;
}

function LiveOrderRow({ order }: { order: Order }) {
  const rawStatus = liveOrderStatus(order);
  return <tr><td><span className="table-customer"><Avatar initials={order.initials} color="#6366f1" size="sm" /><strong>{order.customer}</strong></span></td><td><strong className="order-id-static">#{order.id.slice(0, 12)}</strong><small className="order-subline">Messenger order</small></td><td><strong>{recordMoney(order.total, liveRecordCurrency(order))}</strong><small className="order-subline">Recorded total</small></td><td>{rawStatus === 'refunded' ? <span className="status-badge status-cancelled"><span />Refunded</span> : <StatusBadge status={order.status} />}</td><td><span className={cx('payment-badge', `payment-${order.payment.toLowerCase()}`)}>{order.payment}</span></td><td><span className="date-cell live-order-date">{order.createdAt}</span></td></tr>;
}

function LiveOrdersView({ data, globalQuery, onNavigate, onRefresh }: { data: DashboardData; globalQuery: string; onNavigate: (view: ViewId) => void; onRefresh: () => void }) {
  const [status, setStatus] = useState<'all' | OrderStatus>('all');
  const [query, setQuery] = useState(globalQuery);
  useEffect(() => setQuery(globalQuery), [globalQuery]);
  const filtered = data.orders.filter((order) => {
    const needle = `${order.id} ${order.customer} ${order.items}`.toLowerCase();
    return (status === 'all' || order.status === status) && needle.includes(query.toLowerCase());
  });
  const counts = data.orders.reduce<Record<string, number>>((acc, order) => ({ ...acc, [order.status]: (acc[order.status] ?? 0) + 1 }), {});
  const paid = data.orders.filter((order) => order.payment === 'Paid').length;
  const recordedTotal = data.metrics.find((metric) => metric.id === 'orders')?.value ?? String(data.orders.length);

  const pageConnected = hasConnectedPage(data);
  if (!data.orders.length) return <div className="page-stack"><GuidedEmptyState icon={ShoppingBag} eyebrow="Order workspace" title="Orders will stay organized here." detail={pageConnected ? 'No orders have been recorded yet. When a Messenger conversation becomes an order, its status and payment state will appear here.' : 'Complete Facebook setup and add products before taking your first Messenger order.'} action={{ label: pageConnected ? 'Open inbox' : 'Review Facebook setup', onClick: () => onNavigate(pageConnected ? 'inbox' : 'facebook') }} secondaryAction={{ label: 'View catalog', onClick: () => onNavigate('catalog') }} /></div>;

  return <div className="page-stack">
    <section className="orders-summary-grid live-order-summary"><article><span className="summary-icon summary-new"><ShoppingBag size={19} /></span><div><p>Recorded orders</p><strong>{recordedTotal}</strong><small>All statuses</small></div></article><article><span className="summary-icon summary-process"><PackageCheck size={19} /></span><div><p>Open in loaded list</p><strong>{(counts.new ?? 0) + (counts.confirmed ?? 0) + (counts.processing ?? 0)}</strong><small>Needs workflow action</small></div></article><article><span className="summary-icon summary-ship"><CreditCard size={19} /></span><div><p>Paid in loaded list</p><strong>{paid}</strong><small>Provider-confirmed state</small></div></article><article><span className="summary-icon summary-value"><Activity size={19} /></span><div><p>Recent records loaded</p><strong>{data.orders.length}</strong><small>Up to 50 recent orders</small></div></article></section>
    <section className="panel table-panel"><div className="table-toolbar"><div className="order-tabs" role="tablist" aria-label="Order status"><button className={status === 'all' ? 'active' : ''} onClick={() => setStatus('all')}>All <span>{data.orders.length}</span></button>{(['new', 'confirmed', 'processing', 'shipped'] as OrderStatus[]).map((item) => <button key={item} className={status === item ? 'active' : ''} onClick={() => setStatus(item)}>{ORDER_LABELS[item]} <span>{counts[item] ?? 0}</span></button>)}</div><div className="toolbar-actions"><label className="field-search compact"><Search size={15} /><span className="sr-only">Search orders</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search order IDs" /></label><button className="button button-secondary" onClick={onRefresh}><RefreshCw size={16} /> Refresh</button></div></div>{filtered.length ? <><div className="table-scroll"><table className="data-table live-orders-table"><thead><tr><th>Customer</th><th>Order</th><th>Total</th><th>Status</th><th>Payment</th><th>Created</th></tr></thead><tbody>{filtered.map((order) => <LiveOrderRow key={order.id} order={order} />)}</tbody></table></div><footer className="table-footer live-table-footer"><p>Showing <strong>{filtered.length}</strong> recently loaded orders</p><span>Refresh to check for new records</span></footer></> : <EmptyState icon={Search} title="No matching orders" detail="Try a different order ID or status filter." />}</section>
  </div>;
}

function OrdersView({ data, globalQuery, onToast, onNavigate, onRefresh, isDemo }: { data: DashboardData; globalQuery: string; onToast: (message: string) => void; onNavigate: (view: ViewId) => void; onRefresh: () => void; isDemo: boolean }) {
  return isDemo ? <DemoOrdersView data={data} globalQuery={globalQuery} onToast={onToast} /> : <LiveOrdersView data={data} globalQuery={globalQuery} onNavigate={onNavigate} onRefresh={onRefresh} />;
}

export function LegacyCatalogView({ data, globalQuery, onToast, onNavigate, onRefresh, isDemo }: { data: DashboardData; globalQuery: string; onToast: (message: string) => void; onNavigate: (view: ViewId) => void; onRefresh: () => void; isDemo: boolean }) {
  const [query, setQuery] = useState(globalQuery);
  const [category, setCategory] = useState('All products');
  const [pageFilter, setPageFilter] = useState('all');
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const productDialogRef = useRef<HTMLElement>(null);
  const productReturnFocus = useRef<HTMLElement | null>(null);
  const savingRef = useRef(saving);
  const canManageCatalog = isDemo || data.merchant.role === 'owner' || data.merchant.role === 'admin';
  useEffect(() => setQuery(globalQuery), [globalQuery]);
  useEffect(() => { savingRef.current = saving; }, [saving]);
  useEffect(() => {
    if (!showAdd) return undefined;
    const frame = window.requestAnimationFrame(() => {
      productDialogRef.current?.querySelector<HTMLElement>('select, input, textarea, button')?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingRef.current) setShowAdd(false);
      else containDialogFocus(event, productDialogRef.current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKeyDown);
      productReturnFocus.current?.focus();
    };
  }, [showAdd]);
  const categories = ['All products', ...Array.from(new Set(data.products.map((product) => product.category)))];
  const pageNames = new Map(data.pages.map((page) => [page.id, page.name]));
  const filtered = data.products.filter((product) => (
    (category === 'All products' || product.category === category) &&
    (pageFilter === 'all' || product.pageId === pageFilter) &&
    `${product.name} ${product.banglaName} ${product.sku}`.toLowerCase().includes(query.toLowerCase())
  ));
  const unlimitedProducts = !Number.isFinite(data.usage.productsLimit);
  const submitProduct = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isDemo) {
      setShowAdd(false);
      onToast('Demo product saved as a draft.');
      return;
    }
    if (!canManageCatalog) {
      setSaveError('Only workspace owners and admins can add catalog products.');
      return;
    }
    const values = new FormData(event.currentTarget);
    const pageId = String(values.get('pageId') ?? '');
    if (!pageId || !data.pages.some((page) => page.id === pageId)) {
      setSaveError('Choose the Facebook Page that owns this product.');
      return;
    }
    const price = Number(String(values.get('price') ?? '').replace(/,/g, ''));
    const stock = Number(values.get('stock') ?? 0);
    if (!Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) {
      setSaveError('Enter a valid price and whole-number stock quantity.');
      return;
    }
    setSaveError('');
    setSaving(true);
    try {
      await createLiveProduct({ pageId, name: String(values.get('name') ?? '').trim(), sku: String(values.get('sku') ?? '').trim(), description: String(values.get('description') ?? '').trim(), priceMinor: Math.round(price * 100), stock, variants: [] });
      setShowAdd(false);
      onToast('Product added to your live catalog.');
      onRefresh();
    } catch (error) {
      setSaveError(error instanceof ApiError && error.code
        ? `${error.message} (Error code: ${error.code})`
        : error instanceof Error ? error.message : 'The product could not be added.');
    } finally {
      setSaving(false);
    }
  };
  const openAddProduct = () => {
    if (!canManageCatalog) {
      onToast('Only workspace owners and admins can add catalog products.');
      return;
    }
    if (!isDemo && !data.pages.length) {
      onToast('Review Facebook setup before adding a Page catalog product.');
      onNavigate('facebook');
      return;
    }
    productReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSaveError('');
    setShowAdd(true);
  };

  return (
    <div className="page-stack">
      <section className="catalog-hero panel">
        <div className="catalog-hero-copy"><span className="catalog-spark"><WandSparkles size={20} /></span><div><h2>Your catalog teaches the AI what to sell</h2><p>Keep product names, prices and stock updated for more accurate replies.</p></div></div>
        <div className="catalog-limit"><div><span><strong>{data.usage.productsUsed}</strong> / {unlimitedProducts ? 'Unlimited' : data.usage.productsLimit} products</span><small>{data.merchant.plan} plan allowance</small></div><Progress value={unlimitedProducts ? 0 : (data.usage.productsUsed / data.usage.productsLimit) * 100} label="Product catalog limit used" /><button className="text-link" onClick={() => onNavigate('usage')}>View plan <ArrowRight size={14} /></button></div>
      </section>
      <section className="catalog-toolbar">
        <div className="catalog-tabs" role="tablist">{categories.map((item) => <button className={category === item ? 'active' : ''} onClick={() => setCategory(item)} key={item}>{item}{item === 'All products' && <span>{data.products.length}</span>}</button>)}</div>
        <div className="toolbar-actions">{!isDemo && data.pages.length > 1 && <label className="catalog-page-filter"><span className="sr-only">Filter products by Facebook Page</span><select value={pageFilter} onChange={(event) => setPageFilter(event.target.value)}><option value="all">All Pages</option>{data.pages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}</select></label>}<label className="field-search compact"><Search size={15} /><span className="sr-only">Search catalog</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search products" /></label><button className="button button-secondary" onClick={onRefresh}><RefreshCw size={16} /> Refresh</button><button className="button button-primary" onClick={openAddProduct} disabled={!canManageCatalog} title={!canManageCatalog ? 'Owner or admin access is required' : undefined}>{canManageCatalog ? <Plus size={16} /> : <LockKeyhole size={15} />} {canManageCatalog ? 'Add product' : 'Admin access required'}</button></div>
      </section>
      {!isDemo && data.usage.catalogTruncated && <div className="catalog-truncation" role="status"><Info size={17} /><div><strong>Catalog view capped at 100 records</strong><span>Showing {data.usage.catalogLoaded ?? data.products.length} loaded products. The plan total above reflects the full workspace.</span></div></div>}
      {filtered.length ? <section className="product-grid">{filtered.map((product) => <LegacyProductCard key={product.id} product={product} pageName={product.pageId ? pageNames.get(product.pageId) : undefined} onToast={onToast} isDemo={isDemo} />)}</section> : !isDemo && !query && pageFilter === 'all' ? <GuidedEmptyState icon={Boxes} eyebrow="Catalog setup" title="Add product facts before AI starts selling." detail={data.pages.length ? canManageCatalog ? 'Start with one product: name, SKU, price, stock, and a useful description. InboxPlease uses this context to keep replies accurate.' : 'No products are loaded yet. Ask a workspace owner or admin to add the first catalog product.' : 'A catalog product belongs to a Facebook Page. Review Page setup first, then return here to add inventory.'} action={canManageCatalog ? { label: data.pages.length ? 'Add first product' : 'Review Facebook setup', onClick: data.pages.length ? openAddProduct : () => onNavigate('facebook') } : undefined} secondaryAction={{ label: 'View setup progress', onClick: () => onNavigate('overview') }} /> : <EmptyState icon={Search} title="No products found" detail="Try another Page, category, or search term." />}

      {showAdd && <div className="modal-backdrop" role="presentation" onMouseDown={() => !saving && setShowAdd(false)}><section ref={productDialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="add-product-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}><header><div><h2 id="add-product-title">Add a product</h2><p>Give your AI accurate facts it can use in customer replies.</p></div><button className="icon-button" onClick={() => setShowAdd(false)} aria-label="Close" disabled={saving}><X size={19} /></button></header><form onSubmit={submitProduct}>{!isDemo && <label>Facebook Page<select name="pageId" required defaultValue={data.pages[0]?.id}>{data.pages.map((page) => <option key={page.id} value={page.id}>{page.name}{page.status === 'attention' ? ' — needs attention' : ''}</option>)}</select></label>}<label>Product name<input name="name" required maxLength={200} placeholder="e.g. Jamdani Cotton Saree" /></label><div className="form-row"><label>SKU<input name="sku" required maxLength={100} placeholder="JCS-001" /></label><label>Stock<input name="stock" required type="number" min="0" step="1" placeholder="10" /></label></div><label>Price (৳)<input name="price" required inputMode="decimal" placeholder="2,500" /></label><label>Product description<textarea name="description" rows={3} maxLength={10000} placeholder="Material, available variants, fit, and other useful details" /></label>{saveError && <p className="modal-error" role="alert">{saveError}</p>}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setShowAdd(false)} disabled={saving}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? <><Loader2 className="spin" size={16} /> Adding product…</> : 'Add product'}</button></div></form></section></div>}
    </div>
  );
}

function LegacyProductCard({ product, pageName, onToast, isDemo }: { product: Product; pageName?: string; onToast: (message: string) => void; isDemo: boolean }) {
  return <article className="product-card panel"><div className="product-visual" style={{ background: product.accent }}><span>{product.glyph}</span><div><StatusBadge status={product.status} /></div>{isDemo && <button className="icon-button" aria-label={`Options for ${product.name}`}><MoreHorizontal size={18} /></button>}</div><div className="product-body"><div className="product-name"><div><h3>{product.name}</h3><p>{product.banglaName || 'No description added yet'}</p></div><strong>{recordMoney(product.price, liveRecordCurrency(product))}</strong></div><div className="product-details"><span><Boxes size={14} /> {product.stock} in stock</span>{isDemo && <span><TrendingUp size={14} /> {product.sales} sold</span>}{!isDemo && pageName && <span><Facebook size={14} /> {pageName}</span>}<span>SKU {product.sku}</span></div><footer><span><CheckCircle2 size={14} /> {product.status === 'draft' ? 'Draft' : 'Catalog ready'}</span>{isDemo ? <button onClick={() => onToast(`${product.name} opened for editing`)}>Edit product</button> : <small>Live catalog record</small>}</footer></div></article>;
}

function CatalogView({ data, globalQuery, onToast, onNavigate, onRefresh, isDemo }: { data: DashboardData; globalQuery: string; onToast: (message: string) => void; onNavigate: (view: ViewId) => void; onRefresh: () => void; isDemo: boolean }) {
  const [query, setQuery] = useState(globalQuery);
  const [pageFilter, setPageFilter] = useState('all');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product>();
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string>();
  const [saveError, setSaveError] = useState('');
  const canManage = isDemo || data.merchant.role === 'owner' || data.merchant.role === 'admin';
  useEffect(() => setQuery(globalQuery), [globalQuery]);
  const pageNames = new Map(data.pages.map((page) => [page.id, page.name]));
  const normalizedQuery = query.trim().toLowerCase();
  const products = data.products.filter((product) => (
    (pageFilter === 'all' || product.pageId === pageFilter) &&
    (!normalizedQuery || `${product.name} ${product.banglaName} ${product.sku} ${(product.variants ?? []).map((variant) => `${variant.name} ${variant.sku}`).join(' ')}`.toLowerCase().includes(normalizedQuery))
  ));
  const unlimitedProducts = !Number.isFinite(data.usage.productsLimit);
  const openEditor = (product?: Product) => {
    if (!canManage) return onToast('Only workspace owners and admins can manage products.');
    if (!product && !isDemo && data.pages.length === 0) {
      onToast('Connect a Facebook Page before adding a catalog product.');
      onNavigate('facebook');
      return;
    }
    setEditingProduct(product);
    setSaveError('');
    setEditorOpen(true);
  };
  const saveProduct = async (input: LiveProductInput) => {
    if (isDemo) {
      setEditorOpen(false);
      onToast(editingProduct ? 'Demo product updated.' : 'Demo product added.');
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      if (editingProduct) await updateLiveProduct(editingProduct.id, input);
      else await createLiveProduct(input);
      setEditorOpen(false);
      onToast(editingProduct ? 'Product updated.' : 'Product added to your live catalog.');
      onRefresh();
    } catch (error) {
      setSaveError(error instanceof ApiError && error.code
        ? `${error.message} (Error code: ${error.code})`
        : error instanceof Error ? error.message : 'The product could not be saved.');
    } finally {
      setSaving(false);
    }
  };
  const removeProduct = async (product: Product) => {
    if (!window.confirm(`Delete “${product.name}” from the live catalog?`)) return;
    if (isDemo) return onToast('Demo product deleted.');
    setDeletingId(product.id);
    try {
      await deleteLiveProduct(product.id);
      onToast('Product deleted from the live catalog.');
      onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The product could not be deleted.');
    } finally {
      setDeletingId(undefined);
    }
  };
  return <div className="page-stack">
    <section className="catalog-hero panel">
      <div className="catalog-hero-copy"><span className="catalog-spark"><WandSparkles size={20} /></span><div><h2>Your catalog teaches the AI what to sell</h2><p>Keep product images, variants, prices, and stock accurate for better replies.</p></div></div>
      <div className="catalog-limit"><div><span><strong>{data.usage.productsUsed}</strong> / {unlimitedProducts ? 'Unlimited' : data.usage.productsLimit} products</span><small>{data.merchant.plan} plan allowance</small></div><Progress value={unlimitedProducts ? 0 : (data.usage.productsUsed / data.usage.productsLimit) * 100} label="Product catalog limit used" /><button className="text-link" onClick={() => onNavigate('usage')}>View plan <ArrowRight size={14} /></button></div>
    </section>
    <section className="catalog-toolbar">
      <div className="catalog-tabs"><button className="active">All products <span>{data.products.length}</span></button></div>
      <div className="toolbar-actions">{data.pages.length > 1 && <label className="catalog-page-filter"><span className="sr-only">Filter by Page</span><select value={pageFilter} onChange={(event) => setPageFilter(event.target.value)}><option value="all">All Pages</option>{data.pages.map((page) => <option value={page.id} key={page.id}>{page.name}</option>)}</select></label>}<label className="field-search compact"><Search size={15} /><span className="sr-only">Search catalog</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search products and variants" /></label><button className="button button-secondary" onClick={onRefresh}><RefreshCw size={16} /> Refresh</button><button className="button button-primary" onClick={() => openEditor()} disabled={!canManage}>{canManage ? <Plus size={16} /> : <LockKeyhole size={15} />} Add product</button></div>
    </section>
    {!isDemo && data.usage.catalogTruncated && <div className="catalog-truncation"><Info size={17} /><div><strong>Catalog view capped at 100 records</strong><span>Showing {data.usage.catalogLoaded ?? data.products.length} loaded products.</span></div></div>}
    {products.length ? <section className="product-grid">{products.map((product) => <CatalogProductCard key={product.id} product={product} pageName={product.pageId ? pageNames.get(product.pageId) : undefined} canManage={canManage} busy={deletingId === product.id} onEdit={() => openEditor(product)} onDelete={() => removeProduct(product)} />)}</section> : <GuidedEmptyState icon={Boxes} eyebrow="Catalog setup" title={normalizedQuery ? 'No products found.' : 'Add product facts before AI starts selling.'} detail={normalizedQuery ? 'Try another product, SKU, or variant.' : 'Add a product image, price, inventory, description, and optional variants.'} action={!normalizedQuery && canManage ? { label: data.pages.length || isDemo ? 'Add first product' : 'Review Facebook setup', onClick: data.pages.length || isDemo ? () => openEditor() : () => onNavigate('facebook') } : undefined} />}
    {editorOpen && <ProductEditorModal product={editingProduct} pages={data.pages} isDemo={isDemo} saving={saving} error={saveError} onClose={() => !saving && setEditorOpen(false)} onSubmit={saveProduct} />}
  </div>;
}

interface VariantDraft {
  key: string;
  id?: string;
  name: string;
  sku: string;
  price: string;
  stock: string;
  imageId?: string;
  imageFile?: File;
}

function ProductEditorModal({ product, pages, isDemo, saving, error, onClose, onSubmit }: { product?: Product; pages: DashboardData['pages']; isDemo: boolean; saving: boolean; error: string; onClose: () => void; onSubmit: (input: LiveProductInput) => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const [imageFile, setImageFile] = useState<File>();
  const [clientError, setClientError] = useState('');
  const [variants, setVariants] = useState<VariantDraft[]>(() => (product?.variants ?? []).map((variant) => ({ key: variant.id, id: variant.id, name: variant.name, sku: variant.sku, price: String(variant.price), stock: String(variant.stock), imageId: variant.imageId })));
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
      else containDialogFocus(event, dialogRef.current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, saving]);
  const updateVariant = (key: string, values: Partial<VariantDraft>) => setVariants((current) => current.map((variant) => variant.key === key ? { ...variant, ...values } : variant));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const price = Number(String(values.get('price') ?? '').replace(/,/g, ''));
    const baseStock = Number(values.get('stock') ?? 0);
    const parsed = variants.map((variant) => ({ ...variant, parsedPrice: Number(variant.price.replace(/,/g, '')), parsedStock: Number(variant.stock) }));
    if (!Number.isFinite(price) || price < 0 || !Number.isInteger(baseStock) || baseStock < 0 || parsed.some((variant) => !variant.name.trim() || !variant.sku.trim() || !Number.isFinite(variant.parsedPrice) || variant.parsedPrice < 0 || !Number.isInteger(variant.parsedStock) || variant.parsedStock < 0)) {
      setClientError('Enter valid non-negative prices and whole-number stock for the product and every variant.');
      return;
    }
    setClientError('');
    onSubmit({
      pageId: product?.pageId ?? String(values.get('pageId') ?? ''),
      name: String(values.get('name') ?? '').trim(),
      sku: String(values.get('sku') ?? '').trim(),
      description: String(values.get('description') ?? '').trim(),
      priceMinor: Math.round(price * 100),
      stock: variants.length ? parsed.reduce((total, variant) => total + variant.parsedStock, 0) : baseStock,
      imageFile,
      variants: parsed.map((variant) => ({ id: variant.id, name: variant.name.trim(), sku: variant.sku.trim(), priceMinor: Math.round(variant.parsedPrice * 100), stock: variant.parsedStock, imageFile: variant.imageFile })),
    });
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section ref={dialogRef} className="modal product-editor-modal" role="dialog" aria-modal="true" aria-labelledby="product-editor-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id="product-editor-title">{product ? 'Edit product' : 'Add a product'}</h2><p>Add accurate product facts, inventory, images, and optional variants.</p></div><button className="icon-button" onClick={onClose} aria-label="Close" disabled={saving}><X size={19} /></button></header>
      <form onSubmit={submit}>
        {!isDemo && !product && <label>Facebook Page<select name="pageId" required defaultValue={pages[0]?.id}>{pages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}</select></label>}
        <label>Product name<input name="name" required maxLength={200} defaultValue={product?.name} placeholder="e.g. Jamdani Cotton Saree" /></label>
        <div className="form-row"><label>SKU<input name="sku" required maxLength={100} defaultValue={product?.sku} placeholder="JCS-001" /></label><label>Base stock<input name="stock" required type="number" min="0" step="1" defaultValue={product?.stock ?? 0} disabled={variants.length > 0} /><small>{variants.length ? 'Calculated from variant stock.' : 'Available units without variants.'}</small></label></div>
        <label>Base price (৳)<input name="price" required inputMode="decimal" defaultValue={product?.price} placeholder="2,500" /></label>
        <label>Product description<textarea name="description" rows={3} maxLength={10000} defaultValue={product?.description ?? product?.banglaName} placeholder="Material, fit, delivery details, and useful facts" /></label>
        <label className="media-picker"><span>Product image</span><span className="media-picker-box">{product?.imageId && !imageFile ? <img src={mediaAssetUrl(product.imageId)} alt="Current product" /> : <ImagePlus size={22} />}<b>{imageFile?.name ?? (product?.imageId ? 'Replace current image' : 'Choose product image')}</b><small>JPEG, PNG, WebP, or GIF · up to 10 MiB</small><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => setImageFile(event.target.files?.[0])} /></span></label>
        <section className="variant-editor">
          <div className="variant-editor-head"><div><strong>Variants</strong><small>Add sizes, colors, or other options with their own price, image, and stock.</small></div><button type="button" className="button button-secondary" onClick={() => setVariants((current) => [...current, { key: crypto.randomUUID(), name: '', sku: '', price: String(product?.price ?? ''), stock: '0' }])}><Plus size={15} /> Add variant</button></div>
          {variants.map((variant, index) => <article className="variant-row" key={variant.key}>
            <div className="variant-row-head"><strong>Variant {index + 1}</strong><button type="button" onClick={() => setVariants((current) => current.filter(({ key }) => key !== variant.key))} aria-label={`Remove variant ${index + 1}`}><Trash2 size={15} /></button></div>
            <div className="form-row"><label>Name<input required value={variant.name} maxLength={160} onChange={(event) => updateVariant(variant.key, { name: event.target.value })} placeholder="Navy / Large" /></label><label>SKU<input required value={variant.sku} maxLength={100} onChange={(event) => updateVariant(variant.key, { sku: event.target.value })} placeholder="JCS-NV-L" /></label></div>
            <div className="form-row"><label>Price (৳)<input required inputMode="decimal" value={variant.price} onChange={(event) => updateVariant(variant.key, { price: event.target.value })} /></label><label>Stock<input required type="number" min="0" step="1" value={variant.stock} onChange={(event) => updateVariant(variant.key, { stock: event.target.value })} /></label></div>
            <label className="variant-image"><span>{variant.imageId && !variant.imageFile ? <img src={mediaAssetUrl(variant.imageId)} alt="Current variant" /> : <ImagePlus size={18} />}</span><b>{variant.imageFile?.name ?? (variant.imageId ? 'Replace variant image' : 'Add variant image')}</b><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => updateVariant(variant.key, { imageFile: event.target.files?.[0] })} /></label>
          </article>)}
        </section>
        {(clientError || error) && <p className="modal-error" role="alert">{clientError || error}</p>}
        <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? <><Loader2 className="spin" size={16} /> Saving…</> : product ? 'Save changes' : 'Add product'}</button></div>
      </form>
    </section>
  </div>;
}

function CatalogProductCard({ product, pageName, canManage, busy, onEdit, onDelete }: { product: Product; pageName?: string; canManage: boolean; busy: boolean; onEdit: () => void; onDelete: () => void }) {
  const variants = product.variants ?? [];
  return <article className="product-card panel">
    <div className="product-visual" style={{ background: product.accent }}>{product.imageId ? <img src={mediaAssetUrl(product.imageId)} alt={product.name} /> : <span>{product.glyph}</span>}<div><StatusBadge status={product.status} /></div></div>
    <div className="product-body"><div className="product-name"><div><h3>{product.name}</h3><p>{product.description || product.banglaName || 'No description added yet'}</p></div><strong>{recordMoney(product.price, liveRecordCurrency(product))}</strong></div><div className="product-details"><span><Boxes size={14} /> {product.stock} in stock</span>{pageName && <span><Facebook size={14} /> {pageName}</span>}<span>SKU {product.sku}</span>{variants.length > 0 && <span><Tag size={14} /> {variants.length} variant{variants.length === 1 ? '' : 's'}</span>}</div>{variants.length > 0 && <div className="variant-chips">{variants.slice(0, 3).map((variant) => <span key={variant.id}>{variant.imageId && <img src={mediaAssetUrl(variant.imageId)} alt="" />}{variant.name} · {variant.stock}</span>)}{variants.length > 3 && <span>+{variants.length - 3} more</span>}</div>}<footer><span><CheckCircle2 size={14} /> {product.status === 'draft' ? 'Draft' : 'Catalog ready'}</span>{canManage && <div className="product-card-actions"><button onClick={onEdit}>Edit</button><button className="danger" onClick={onDelete} disabled={busy}>{busy ? <Loader2 className="spin" size={13} /> : <Trash2 size={13} />} Delete</button></div>}</footer></div>
  </article>;
}

function DemoUsageView({ data, onToast }: { data: DashboardData; onToast: (message: string) => void }) {
  const usagePercent = (data.usage.messagesUsed / data.usage.messagesLimit) * 100;
  const maxDaily = Math.max(...data.usage.daily);
  return (
    <div className="page-stack">
      <section className="plan-hero">
        <div><span className="plan-badge"><Zap size={15} /> {data.merchant.plan} plan</span><h2>Built for growing Messenger stores.</h2><p>{data.merchant.plan === 'Free' ? '৳0 / month · No credit card required.' : 'Your current paid workspace plan.'}</p></div><div className="plan-hero-actions"><button className="button button-light" onClick={() => onToast('Billing portal opened')}>Manage billing</button><button className="button button-white">Compare plans <ArrowRight size={15} /></button></div><span className="hero-orb hero-orb-one" /><span className="hero-orb hero-orb-two" /></section>
      <section className="usage-grid">
        <article className="panel usage-primary"><SectionTitle title="AI messages" subtitle={data.usage.period} action={<span className={cx('usage-health', usagePercent > 85 && 'warning')}>{Math.round(100 - usagePercent)}% remaining</span>} /><div className="usage-number"><strong>{new Intl.NumberFormat('en-BD').format(data.usage.messagesUsed)}</strong><span>/ {new Intl.NumberFormat('en-BD').format(data.usage.messagesLimit)}</span></div><Progress value={usagePercent} label="Monthly AI messages used" /><div className="usage-foot"><p><Clock3 size={14} /> Resets {data.usage.resetDate}</p><p>Need more? <button>Buy 1,000 for ৳300</button></p></div></article>
        <article className="panel mini-usage"><span className="mini-usage-icon products"><Package size={19} /></span><div><p>Catalog products</p><strong>{data.usage.productsUsed} <small>/ {data.usage.productsLimit}</small></strong></div><Progress value={(data.usage.productsUsed / data.usage.productsLimit) * 100} label="Products used" /></article>
        <article className="panel mini-usage"><span className="mini-usage-icon pages"><Facebook size={19} /></span><div><p>Facebook pages</p><strong>{data.usage.pagesUsed} <small>/ {data.usage.pagesLimit}</small></strong></div><Progress value={(data.usage.pagesUsed / data.usage.pagesLimit) * 100} tone="green" label="Pages connected" /></article>
      </section>
      <section className="usage-detail-grid">
        <article className="panel usage-chart-panel"><SectionTitle title="Message activity" subtitle="AI replies over the last 14 days" action={<button className="period-select">Last 14 days <ChevronDown size={14} /></button>} /><div className="bar-chart" aria-label="Daily AI reply volume increasing over 14 days" role="img">{data.usage.daily.map((value, index) => <span key={index} className={index === data.usage.daily.length - 1 ? 'today' : ''} style={{ height: `${(value / maxDaily) * 100}%` }}><i>{value}</i></span>)}</div><div className="bar-labels"><span>Jul 6</span><span>Jul 9</span><span>Jul 12</span><span>Jul 15</span><span>Today</span></div></article>
        <article className="panel model-card"><SectionTitle title="Model routing" subtitle="How replies were generated" /><div className="donut-wrap"><div className="donut" style={{ '--qwen': `${data.usage.qwenShare * 3.6}deg` } as CSSProperties}><span><strong>{data.usage.qwenShare}%</strong><small>Edge AI</small></span></div><div className="model-legend"><div><span className="legend-dot qwen" /><p><strong>Qwen3</strong><small>Default replies</small></p><b>{data.usage.qwenShare}%</b></div><div><span className="legend-dot frontier" /><p><strong>Frontier AI</strong><small>Complex escalations</small></p><b>{data.usage.frontierShare}%</b></div></div></div><div className="model-note"><ShieldCheck size={17} /><p>Smart routing kept <strong>94.6%</strong> of replies fast and cost-efficient this month.</p></div></article>
      </section>
      <section className="panel feature-usage"><SectionTitle title="Feature activity" subtitle="Special capabilities used this month" /><div><article><span><Mic2 size={19} /></span><div><strong>{data.usage.voiceNotes}</strong><p>Voice notes transcribed</p></div><small>Bangla + English</small></article><article><span><Image size={19} /></span><div><strong>{data.usage.imageMatches}</strong><p>Image matches</p></div><button>Business only <LockKeyhole size={12} /></button></article><article><span><Headphones size={19} /></span><div><strong>46</strong><p>Human handoffs</p></div><small>2.1% of chats</small></article><article><span><ShoppingBag size={19} /></span><div><strong>312</strong><p>Orders assisted</p></div><small>৳4.8L revenue</small></article></div></section>
    </div>
  );
}

function LiveUsageView({ data, onNavigate }: { data: DashboardData; onNavigate: (view: ViewId) => void }) {
  const usagePercent = allowancePercent(data.usage.messagesUsed, data.usage.messagesLimit);
  const customMessageAllowance = !Number.isFinite(data.usage.messagesLimit);
  const customPageAllowance = !Number.isFinite(data.usage.pagesLimit);
  const productUnlimited = !Number.isFinite(data.usage.productsLimit);
  return <div className="page-stack live-usage-page">
    <section className="plan-hero"><div><span className="plan-badge"><Zap size={15} /> {data.merchant.plan} plan</span><h2>Your workspace allowance at a glance.</h2><p>{data.merchant.plan === 'Free' ? '৳0 / month · Start with the core workspace.' : 'Current plan recorded for this merchant workspace.'}</p></div><div className="plan-hero-actions"><button className="button button-white" onClick={() => onNavigate('overview')}>View setup <ArrowRight size={15} /></button></div><span className="hero-orb hero-orb-one" /><span className="hero-orb hero-orb-two" /></section>
    <section className="usage-grid"><article className="panel usage-primary"><SectionTitle title="AI messages" subtitle={data.usage.period} action={<span className={cx('usage-health', usagePercent > 85 && 'warning')}>{customMessageAllowance ? 'Custom allowance' : `${Math.max(0, Math.round(100 - usagePercent))}% remaining`}</span>} /><div className="usage-number"><strong>{data.usage.messagesUsed.toLocaleString('en-BD')}</strong><span>/ {allowanceLabel(data.usage.messagesLimit)}</span></div><Progress value={usagePercent} label="Monthly AI messages used" /><div className="usage-foot"><p><Clock3 size={14} /> Resets {data.usage.resetDate}</p><p>Monthly metered total</p></div></article><article className="panel mini-usage"><span className="mini-usage-icon products"><Package size={19} /></span><div><p>Catalog products</p><strong>{data.usage.productsUsed} <small>/ {productUnlimited ? 'Unlimited' : data.usage.productsLimit}</small></strong></div><Progress value={productUnlimited ? 0 : (data.usage.productsUsed / data.usage.productsLimit) * 100} label="Products used" /></article><article className="panel mini-usage"><span className="mini-usage-icon pages"><Facebook size={19} /></span><div><p>Facebook Pages</p><strong>{data.usage.pagesUsed} <small>/ {allowanceLabel(data.usage.pagesLimit)}</small></strong></div><Progress value={customPageAllowance ? 0 : (data.usage.pagesUsed / data.usage.pagesLimit) * 100} tone="green" label="Pages connected" /></article></section>
    <section className="live-usage-details"><article className="panel usage-reporting-empty"><span><Activity size={23} /></span><div><p>Reporting</p><h2>Monthly totals are ready.</h2><small>Daily activity and model-routing breakdowns will appear here when detailed reporting is enabled for this workspace.</small></div></article><article className="panel live-feature-metrics"><SectionTitle title="Recorded capabilities" subtitle="Counters available from the live workspace" /><div><span><Bot size={18} /></span><p><strong>{data.usage.messagesUsed.toLocaleString('en-BD')}</strong><small>AI messages</small></p><span><Image size={18} /></span><p><strong>{data.usage.imageMatches.toLocaleString('en-BD')}</strong><small>Vision messages</small></p></div></article></section>
  </div>;
}

function UsageView({ data, onToast, onNavigate, isDemo }: { data: DashboardData; onToast: (message: string) => void; onNavigate: (view: ViewId) => void; isDemo: boolean }) {
  return isDemo ? <DemoUsageView data={data} onToast={onToast} /> : <LiveUsageView data={data} onNavigate={onNavigate} />;
}

function DemoFacebookView({ data, onToast }: { data: DashboardData; onToast: (message: string) => void }) {
  const [syncing, setSyncing] = useState(false);
  const sync = () => {
    setSyncing(true);
    window.setTimeout(() => { setSyncing(false); onToast('Page data synced successfully'); }, 800);
  };
  return (
    <div className="page-stack">
      <section className="page-connect-head"><div><h2>Connected pages</h2><p>{data.pages.length} of {data.usage.pagesLimit} pages used on your {data.merchant.plan} plan.</p></div><button className="button button-primary" onClick={() => onToast('Facebook connection flow started')}><Plus size={17} /> Connect another page</button></section>
      {data.pages.map((page) => <article className="panel facebook-card" key={page.id}><div className="fb-cover"><div className="fb-page-logo"><span>R</span><i><Facebook size={12} /></i></div></div><div className="fb-card-content"><div className="fb-main-info"><div><h3>{page.name}</h3><p>{page.handle}</p></div><span className="connected-pill"><span /> Connected</span></div><div className="fb-stats"><div><small>Followers</small><strong>{page.followers}</strong></div><div><small>Response rate</small><strong>{page.responseRate}</strong></div><div><small>Messages today</small><strong>164</strong></div><div><small>Last synced</small><strong>{page.lastSynced}</strong></div></div><div className="fb-actions"><span><CheckCircle2 size={16} /> Messaging is working normally</span><div><button className="button button-secondary" onClick={sync} disabled={syncing}>{syncing ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />} Sync now</button><button className="button button-secondary"><ExternalLink size={16} /> View page</button><button className="icon-button" aria-label="Page options"><MoreHorizontal size={18} /></button></div></div></div></article>)}
      <section className="facebook-grid">
        <article className="panel connection-health"><SectionTitle title="Connection health" subtitle="Live status for Messenger services" /><div><div><span className="health-icon"><Wifi size={17} /></span><p><strong>Messenger webhook</strong><small>Receiving messages normally</small></p><em>Operational</em></div><div><span className="health-icon"><Send size={17} /></span><p><strong>Send API</strong><small>Replies delivered in ~1.8 seconds</small></p><em>Operational</em></div><div><span className="health-icon"><Link2 size={17} /></span><p><strong>Page access token</strong><small>Valid, refreshed 12 days ago</small></p><em>Healthy</em></div></div></article>
        <article className="panel page-checklist"><SectionTitle title="Page setup" subtitle="Everything is ready to sell" /><div><p><span><Check size={14} /></span>Facebook page connected</p><p><span><Check size={14} /></span>Messenger permissions approved</p><p><span><Check size={14} /></span>AI assistant switched on</p><p><span><Check size={14} /></span>Catalog has 68 products</p></div><button className="text-link">Review setup guide <ArrowRight size={14} /></button></article>
      </section>
      <section className="security-note"><ShieldCheck size={20} /><div><strong>Your Facebook access is secure</strong><p>InboxPlease only uses permissions needed to reply to customers and manage orders. You can disconnect anytime.</p></div><button>Learn more</button></section>
    </div>
  );
}

const FACEBOOK_PERMISSION_LABELS: Record<string, string> = {
  public_profile: 'Your Facebook profile',
  pages_show_list: 'Pages you manage',
  pages_manage_metadata: 'Page connection and webhooks',
  pages_messaging: 'Receive and reply to Page messages',
};

function facebookPermissionLabel(permission: string): string {
  return FACEBOOK_PERMISSION_LABELS[permission] ?? permission.replaceAll('_', ' ');
}

function FacebookPermissionSetup({ onRefresh, canManage }: { onRefresh: () => void; canManage: boolean }) {
  const [connection, setConnection] = useState<FacebookConnectionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedPage, setSelectedPage] = useState<FacebookPageCandidate | null>(null);
  const [approved, setApproved] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [callbackResult, setCallbackResult] = useState(() => new URLSearchParams(window.location.search).get('facebook'));

  const dismissCallbackResult = () => {
    setCallbackResult(null);
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.delete('facebook');
    currentUrl.searchParams.delete('view');
    window.history.replaceState({}, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    getFacebookConnection().then((state) => {
      if (!active) return;
      setConnection(state);
      setAction(null);
    }).catch((requestError: unknown) => {
      if (!active) return;
      setError(requestError instanceof Error
        ? requestError.message
        : 'Facebook setup could not be loaded. Try refreshing this page.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [loadVersion]);

  const startConnection = async () => {
    setAction('connect');
    setError('');
    try {
      await beginFacebookConnection();
    } catch (requestError) {
      setAction(null);
      setError(requestError instanceof Error
        ? requestError.message
        : 'Facebook authorization could not start. Please try again.');
    }
  };

  const approvePage = async () => {
    if (!selectedPage || !approved) return;
    setAction(`approve:${selectedPage.id}`);
    setError('');
    try {
      await approveFacebookPage(selectedPage.id);
      setSelectedPage(null);
      setApproved(false);
      setLoadVersion((current) => current + 1);
      onRefresh();
    } catch (requestError) {
      setAction(null);
      setError(requestError instanceof Error
        ? requestError.message
        : 'That Page could not be approved. Confirm your Page role and try again.');
    }
  };

  const updateAi = async (pageId: string, enabled: boolean) => {
    setAction(`ai:${pageId}`);
    setError('');
    try {
      await setFacebookAiMessaging(pageId, enabled);
      setLoadVersion((current) => current + 1);
      onRefresh();
    } catch (requestError) {
      setAction(null);
      setError(requestError instanceof Error
        ? requestError.message
        : `AI messaging could not be turned ${enabled ? 'on' : 'off'}. Please try again.`);
    }
  };

  const disconnectPage = async (pageId: string, pageName: string) => {
    if (!window.confirm(`Disconnect ${pageName}? InboxPlease will disable AI messaging first and remove its Page access.`)) return;
    setAction(`disconnect:${pageId}`);
    setError('');
    try {
      await disconnectFacebookPage(pageId);
      setLoadVersion((current) => current + 1);
      onRefresh();
    } catch (requestError) {
      setAction(null);
      setError(requestError instanceof Error
        ? requestError.message
        : 'The Page could not be disconnected. AI messaging has been disabled; retry the Facebook cleanup.');
    }
  };

  if (loading && !connection) {
    return <section className="panel facebook-permission-panel facebook-permission-loading" aria-busy="true"><Loader2 className="spin" size={19} /><p><strong>Checking Facebook access…</strong><span>Confirming Page and messaging approval status.</span></p></section>;
  }

  const missingPermissions = connection?.requiredPermissions.filter((permission) => !connection.grantedPermissions.includes(permission)) ?? [];
  const enabledPages = connection?.pages.filter((page) => page.aiMessagingEnabled) ?? [];
  const effectivePages = connection?.pages.filter((page) => page.aiMessagingEffective) ?? [];
  const availableCandidates = connection?.candidates ?? [];

  return <section className="panel facebook-permission-panel">
    <header className="facebook-permission-head">
      <div><span><Facebook size={20} /></span><p><small>Seller approval</small><strong>Facebook Page & AI messaging</strong></p></div>
      <em className={effectivePages.length ? 'enabled' : enabledPages.length ? 'paused' : ''}><i />{effectivePages.length ? 'AI messaging ON' : enabledPages.length ? 'Approved · platform paused' : 'AI messaging OFF'}</em>
    </header>

    {error && <div className="facebook-setup-error" role="alert"><AlertTriangle size={17} /><p><strong>Facebook setup needs attention</strong><span>{error}</span></p><button type="button" onClick={() => setLoadVersion((current) => current + 1)}>Try again</button></div>}
    {!canManage && <div className="facebook-role-notice"><LockKeyhole size={17} /><p><strong>Owner or admin approval required</strong><span>You can review status, but only an owner or admin can connect a Page or change AI messaging.</span></p></div>}

    {callbackResult && <div className={cx('facebook-callback-notice', callbackResult === 'pages-ready' && 'success')} role="status"><span>{callbackResult === 'pages-ready' ? <CheckCircle2 size={18} /> : <Info size={18} />}</span><p><strong>{callbackResult === 'pages-ready' ? 'Facebook access approved' : callbackResult === 'permission-denied' ? 'Permission was not approved' : callbackResult === 'no-pages' ? 'No eligible Page was found' : callbackResult === 'cancelled' ? 'Facebook setup was cancelled' : callbackResult === 'invalid-state' ? 'That approval link expired' : 'Facebook setup did not finish'}</strong><small>{callbackResult === 'pages-ready' ? 'Choose a Page below, then give final approval before AI messaging turns on.' : callbackResult === 'permission-denied' ? 'Review the requested Page and messaging access, then try again.' : callbackResult === 'no-pages' ? 'Confirm this account has Page access in Meta Business settings, then try again.' : callbackResult === 'cancelled' ? 'Nothing was connected and AI messaging remains off.' : callbackResult === 'invalid-state' ? 'Start again here to create a new secure approval request.' : 'Try the connection again. AI messaging remains off.'}</small></p><button className="icon-button" type="button" onClick={dismissCallbackResult} aria-label="Dismiss Facebook setup result"><X size={16} /></button></div>}

    {!connection && !loading && !error && <div className="facebook-connect-state"><p><strong>Connect your Facebook account again</strong><span>InboxPlease could not find a current Page authorization for this workspace.</span></p><button className="button facebook-button" type="button" onClick={startConnection} disabled={!canManage || action === 'connect'}>{action === 'connect' ? <Loader2 className="spin" size={16} /> : <Facebook size={16} />} Continue with Facebook</button></div>}

    {connection && <>
      <div className="facebook-permission-intro"><div><ShieldCheck size={19} /></div><p><strong>You stay in control of every reply.</strong><span>Choose a Page, review the access below, then explicitly approve AI messaging. InboxPlease never shows or stores a Page token in this browser.</span></p></div>
      {!connection.platform.aiMessagingAvailable && <div className="facebook-platform-pause"><Info size={17} /><p><strong>Customer sending is paused at platform level</strong><span>Your Page approval can be saved, but InboxPlease will not send AI replies until both AI and messaging services are enabled by the platform operator.</span></p></div>}

      {missingPermissions.length > 0 && <div className="facebook-connect-state"><p><strong>Approve the required Facebook access</strong><span>{missingPermissions.map(facebookPermissionLabel).join(', ')}. Facebook will show the final permission screen.</span></p><button className="button facebook-button" type="button" onClick={startConnection} disabled={!canManage || action === 'connect'}>{action === 'connect' ? <Loader2 className="spin" size={16} /> : <Facebook size={16} />} Review on Facebook</button></div>}

      {availableCandidates.length > 0 && <div className="facebook-page-candidates">
        <div className="facebook-section-label"><p><strong>Choose a business Page</strong><span>Only Pages available to your Facebook account are listed.</span></p><small>{availableCandidates.length} available</small></div>
        <div>{availableCandidates.map((page) => <button key={page.id} type="button" className={cx('facebook-candidate', selectedPage?.id === page.id && 'selected')} onClick={() => { setSelectedPage(page); setApproved(false); }} disabled={!canManage || !page.eligible}><span>{page.name.charAt(0).toUpperCase()}</span><p><strong>{page.name}</strong><small>{page.eligible ? page.tasks.length ? `${page.tasks.length} Facebook Page roles confirmed` : 'Page access available' : 'Messaging role is missing for this Page'}</small></p>{selectedPage?.id === page.id ? <CheckCircle2 size={18} /> : page.eligible && canManage ? <ArrowRight size={17} /> : <LockKeyhole size={17} />}</button>)}</div>
      </div>}

      {selectedPage && <div className="facebook-approval-box">
        <div className="facebook-approval-title"><span><Bot size={19} /></span><p><small>Final approval</small><strong>Allow AI replies for {selectedPage.name}?</strong></p></div>
        <ul><li><Check size={14} /> Receive customer messages through the configured webhook</li><li><Check size={14} /> Use your approved catalog context to prepare replies</li><li><Check size={14} /> Send replies as your Page, with human handoff controls</li></ul>
        <label><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} disabled={!canManage} /><span><strong>I approve InboxPlease to send AI-assisted Messenger replies for this Page.</strong><small>I can switch AI messaging off later without disconnecting the Page.</small></span></label>
        <div><button className="button button-secondary" type="button" onClick={() => { setSelectedPage(null); setApproved(false); }} disabled={Boolean(action)}>Cancel</button><button className="button button-primary" type="button" onClick={approvePage} disabled={!approved || Boolean(action)}>{action === `approve:${selectedPage.id}` ? <><Loader2 className="spin" size={16} /> Approving…</> : <><ShieldCheck size={16} /> {connection.platform.aiMessagingAvailable ? 'Approve Page & turn on AI' : 'Save Page approval'}</>}</button></div>
      </div>}

      {connection.pages.length > 0 && <div className="facebook-approved-pages">
        <div className="facebook-section-label"><p><strong>Approved Pages</strong><span>Messaging can only run when setup is ready and the switch is on.</span></p></div>
        {connection.pages.map((page) => <article key={page.id}><span className="facebook-approved-avatar">{page.name.charAt(0).toUpperCase()}</span><p><strong>{page.name}</strong><small>{!page.aiMessagingReady ? 'Facebook connection needs attention — AI stays off' : page.aiMessagingEnabled && !page.aiMessagingEffective ? 'Seller approved · platform messaging is currently paused' : 'Messenger permission and webhook ready'}</small></p><em className={page.aiMessagingEffective ? 'enabled' : page.aiMessagingEnabled ? 'paused' : ''}>{page.aiMessagingEffective ? 'AI ON' : page.aiMessagingEnabled ? 'APPROVED · PAUSED' : 'AI OFF'}</em><div className="facebook-page-actions"><button className={cx('button', page.aiMessagingEnabled ? 'button-secondary' : 'button-primary')} type="button" onClick={() => page.aiMessagingReady ? updateAi(page.id, !page.aiMessagingEnabled) : startConnection()} disabled={!canManage || Boolean(action)}>{action === `ai:${page.id}` || (!page.aiMessagingReady && action === 'connect') ? <Loader2 className="spin" size={15} /> : !page.aiMessagingReady ? 'Reconnect Page' : page.aiMessagingEnabled ? 'Turn off approval' : 'Approve AI messaging'}</button><button className="facebook-disconnect-button" type="button" onClick={() => disconnectPage(page.id, page.name)} disabled={!canManage || Boolean(action)}>{action === `disconnect:${page.id}` ? 'Disconnecting…' : 'Disconnect Page'}</button></div></article>)}
      </div>}

      {!availableCandidates.length && !connection.pages.length && !missingPermissions.length && <div className="facebook-connect-state"><p><strong>No eligible Page was found</strong><span>Make sure this Facebook account has full or task access to the business Page, then authorize again.</span></p><button className="button facebook-button" type="button" onClick={startConnection} disabled={!canManage || action === 'connect'}><Facebook size={16} /> Check Facebook again</button></div>}
    </>}
  </section>;
}

function LiveFacebookView({ data, onNavigate, onRefresh }: { data: DashboardData; onNavigate: (view: ViewId) => void; onRefresh: () => void }) {
  const canManage = data.merchant.role === 'owner' || data.merchant.role === 'admin';
  if (!data.pages.length) return <div className="page-stack facebook-onboarding-page"><FacebookPermissionSetup onRefresh={onRefresh} canManage={canManage} /><section className="facebook-readiness panel"><header><span><ShieldCheck size={21} /></span><div><p>Safe activation</p><h2>Identity, Page access, then seller approval</h2></div></header><div><article><span>1</span><p><strong>Facebook login</strong><small>Sign in with the account that manages the business.</small></p></article><article><span>2</span><p><strong>Choose a Page</strong><small>InboxPlease lists only Pages returned for that account.</small></p></article><article><span>3</span><p><strong>Approve messaging</strong><small>Review the permissions and explicitly approve AI replies.</small></p></article><article><span>4</span><p><strong>Stay in control</strong><small>Turn AI messaging off anytime from this screen.</small></p></article></div><footer><ShieldCheck size={16} /><p>AI messaging remains off unless Page approval and Facebook setup both succeed.</p></footer></section></div>;

  return <div className="page-stack live-facebook-page">
    <section className="page-connect-head"><div><h2>Connected Page records</h2><p>{data.pages.length} of {allowanceLabel(data.usage.pagesLimit)} Pages recorded on your {data.merchant.plan} plan.</p></div><button className="button button-secondary" onClick={onRefresh}><RefreshCw size={16} /> Refresh status</button></section>
    <FacebookPermissionSetup onRefresh={onRefresh} canManage={canManage} />
    {data.pages.map((page) => <article className="panel live-page-card" key={page.id}><div className="live-page-logo"><span>{page.name.charAt(0).toUpperCase()}</span><i><Facebook size={13} /></i></div><div className="live-page-main"><div><p>Facebook Page</p><h3>{page.name}</h3><small>{page.handle}</small></div><span className={cx('connected-pill', page.status === 'attention' && 'attention-pill')}>{page.status === 'connected' ? <><CheckCircle2 size={14} /> Connected</> : <><Clock3 size={14} /> Needs attention</>}</span></div><dl><div><dt>Connection record</dt><dd>{page.status === 'connected' ? 'Provisioned' : 'Incomplete'}</dd></div><div><dt>Catalog products</dt><dd>{data.usage.productsUsed}</dd></div><div><dt>AI messages this month</dt><dd>{data.usage.messagesUsed}</dd></div><div><dt>Last known state</dt><dd>{page.lastSynced}</dd></div></dl><footer><span><ShieldCheck size={16} /> Connection metadata is available. Confirm delivery health with real webhook activity.</span><button className="button button-secondary" onClick={() => onNavigate('catalog')}>Open catalog <ArrowRight size={14} /></button></footer></article>)}
    <section className="facebook-grid"><article className="panel connection-boundary"><SectionTitle title="What this status means" subtitle="A precise view of connection health" /><div><span><CheckCircle2 size={17} /></span><p><strong>Page record found</strong><small>InboxPlease can associate catalog and order data with this Page.</small></p></div><div><span><Activity size={17} /></span><p><strong>Delivery health is event-based</strong><small>Webhook and Send API health should be confirmed with actual message traffic.</small></p></div></article><SetupChecklist data={data} onNavigate={onNavigate} /></section>
  </div>;
}

function FacebookView({ data, onToast, onNavigate, onRefresh, isDemo }: { data: DashboardData; onToast: (message: string) => void; onNavigate: (view: ViewId) => void; onRefresh: () => void; isDemo: boolean }) {
  return isDemo ? <DemoFacebookView data={data} onToast={onToast} /> : <LiveFacebookView data={data} onNavigate={onNavigate} onRefresh={onRefresh} />;
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={cx('toggle', checked && 'on')} onClick={() => onChange(!checked)}><span /></button>;
}

function DemoSettingsView({ data, onToast }: { data: DashboardData; onToast: (message: string) => void }) {
  const [language, setLanguage] = useState('Match customer');
  const [tone, setTone] = useState('Warm & friendly');
  const [notifications, setNotifications] = useState({ handoff: true, orders: true, lowStock: true, summary: false });
  const [autoReply, setAutoReply] = useState(true);
  return (
    <div className="settings-layout">
      <aside className="settings-nav panel"><p>Settings</p>{['Store profile', 'AI assistant', 'Notifications', 'Order rules', 'Team & access', 'Billing'].map((item, index) => <button className={index === 1 ? 'active' : ''} key={item}>{index === 0 ? <Store size={17} /> : index === 1 ? <Bot size={17} /> : index === 2 ? <Bell size={17} /> : index === 3 ? <ShoppingBag size={17} /> : index === 4 ? <Users size={17} /> : <CreditCard size={17} />}{item}</button>)}<span /><button className="danger-link" onClick={signOut}><LogOut size={17} /> Sign out</button></aside>
      <div className="settings-content">
        <section className="panel settings-section"><div className="settings-section-head"><span className="settings-icon"><Bot size={19} /></span><div><h2>AI assistant</h2><p>Choose how your assistant talks and when it asks for help.</p></div><Toggle checked={autoReply} onChange={setAutoReply} label="Enable AI assistant" /></div><div className="settings-fields"><label>Assistant name<input defaultValue={`${data.merchant.storeName} Assistant`} /><small>Customers won’t see this internal name.</small></label><label>Reply language<select value={language} onChange={(event) => setLanguage(event.target.value)}><option>Match customer</option><option>বাংলা</option><option>Banglish</option><option>English</option></select><small>“Match customer” mirrors বাংলা, English or Banglish naturally.</small></label><fieldset><legend>Conversation tone</legend><div className="tone-options">{['Warm & friendly', 'Short & direct', 'Polished & formal'].map((item) => <button type="button" key={item} className={tone === item ? 'selected' : ''} onClick={() => setTone(item)}><span>{item === 'Warm & friendly' ? '😊' : item === 'Short & direct' ? '⚡' : '✨'}</span><strong>{item}</strong><small>{item === 'Warm & friendly' ? 'আপনার ব্র্যান্ডের মতো আপন করে' : item === 'Short & direct' ? 'Fast, concise answers' : 'Professional and refined'}</small><i>{tone === item && <Check size={13} />}</i></button>)}</div></fieldset></div></section>
        <section className="panel settings-section"><div className="settings-section-head"><span className="settings-icon amber"><Headphones size={19} /></span><div><h2>Human handoff</h2><p>InboxPlease pauses AI and alerts your team in these situations.</p></div></div><div className="handoff-rules"><label><span><strong>Customer sounds upset</strong><small>Complaints, refunds, or strongly negative sentiment</small></span><Toggle checked onChange={() => undefined} label="Handoff upset customers" /></label><label><span><strong>High-value cart</strong><small>Hand off when the cart reaches this value</small></span><span className="money-input">৳ <input aria-label="High-value cart amount" defaultValue="5,000" /></span></label><label><span><strong>AI confidence is low</strong><small>After two uncertain answers in the same conversation</small></span><Toggle checked onChange={() => undefined} label="Handoff low-confidence conversations" /></label></div></section>
        <section className="panel settings-section"><div className="settings-section-head"><span className="settings-icon green"><Bell size={19} /></span><div><h2>Notifications</h2><p>Decide what deserves your attention.</p></div></div><div className="notification-rules">{([['handoff', 'Conversations needing you', 'Instant alert for every human handoff'], ['orders', 'New orders', 'Notify when AI creates a confirmed order'], ['lowStock', 'Low stock', 'Alert when stock reaches 5 units'], ['summary', 'Daily summary', 'Store performance email at 9:00 PM']] as const).map(([key, title, copy]) => <label key={key}><span><strong>{title}</strong><small>{copy}</small></span><Toggle checked={notifications[key]} onChange={(checked) => setNotifications((current) => ({ ...current, [key]: checked }))} label={title} /></label>)}</div></section>
        <div className="settings-save"><p>Changes apply to <strong>{data.merchant.storeName}</strong></p><button className="button button-secondary">Discard</button><button className="button button-primary" onClick={() => onToast('Settings saved successfully')}><Check size={16} /> Save changes</button></div>
      </div>
    </div>
  );
}

function LiveSettingsView({ data, onNavigate }: { data: DashboardData; onNavigate: (view: ViewId) => void }) {
  const pageConnected = hasConnectedPage(data);
  const assistantReady = pageConnected && data.usage.productsUsed > 0;
  const accessLevel = data.merchant.role
    ? `${data.merchant.role.charAt(0).toUpperCase()}${data.merchant.role.slice(1)}`
    : 'Not provided';
  return <div className="page-stack live-settings-page">
    <section className="settings-profile-hero panel"><div className="settings-profile-mark"><Store size={24} /></div><div><p>Current workspace</p><h2>{data.merchant.storeName}</h2><span>Signed in as {data.merchant.name}</span></div><em>{data.merchant.plan} plan</em></section>
    <section className="live-settings-grid"><article className="panel settings-overview-card"><header><span><Store size={19} /></span><div><h2>Workspace profile</h2><p>The account currently loaded from InboxPlease.</p></div></header><dl><div><dt>Business name</dt><dd>{data.merchant.storeName}</dd></div><div><dt>Signed-in user</dt><dd>{data.merchant.name}</dd></div><div><dt>Access level</dt><dd>{accessLevel}</dd></div><div><dt>Plan</dt><dd>{data.merchant.plan}</dd></div></dl><footer><ShieldCheck size={15} /> Account identity and access are loaded from your authenticated session.</footer></article><article className="panel settings-overview-card"><header><span className="assistant"><Bot size={19} /></span><div><h2>Assistant readiness</h2><p>Core context required before customer replies.</p></div></header><div className="readiness-status"><strong>{assistantReady ? 'Ready for review' : 'Setup incomplete'}</strong><span className={assistantReady ? 'ready' : ''}><i />{assistantReady ? 'Context available' : 'Needs attention'}</span></div><ul><li className={pageConnected ? 'done' : ''}><span>{pageConnected ? <Check size={13} /> : '1'}</span>Connected Facebook Page</li><li className={data.usage.productsUsed ? 'done' : ''}><span>{data.usage.productsUsed ? <Check size={13} /> : '2'}</span>Product catalog context</li></ul><button className="button button-secondary" onClick={() => onNavigate(assistantReady ? 'overview' : pageConnected ? 'catalog' : 'facebook')}>{assistantReady ? 'Review overview' : 'Continue setup'} <ArrowRight size={14} /></button></article></section>
    <section className="panel settings-editing-note"><span><PanelLeftOpen size={20} /></span><div><h2>Configuration controls are intentionally read-only here.</h2><p>This dashboard does not yet load the persisted assistant-settings record, so it will not present demo defaults as your live configuration.</p></div></section>
    <section className="panel live-account-actions"><div><h2>Account session</h2><p>Signing out removes the session token from this browser tab.</p></div><button className="button button-secondary danger-button" onClick={signOut}><LogOut size={16} /> Sign out</button></section>
  </div>;
}

function SettingsView({ data, onToast, onNavigate, isDemo }: { data: DashboardData; onToast: (message: string) => void; onNavigate: (view: ViewId) => void; isDemo: boolean }) {
  return isDemo ? <DemoSettingsView data={data} onToast={onToast} /> : <LiveSettingsView data={data} onNavigate={onNavigate} />;
}

function LoadingScreen() {
  return <div className="loading-screen"><div className="loading-brand"><span className="brand-mark"><MessageCircle size={20} /><span /></span><strong>Inbox<span>Please</span></strong></div><div className="loading-bar"><span /></div><p>Preparing your store…</p></div>;
}

function LoadErrorScreen({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403);
  const Icon = isAuthError ? LockKeyhole : Wifi;
  const clearAndReload = async () => {
    await clearDashboardSession();
    window.location.assign('/signin');
  };

  return (
    <div className="error-screen" role="alert">
      <section className="error-card">
        <div className="error-brand"><span className="brand-mark"><MessageCircle size={20} /><span /></span><strong>Inbox<span>Please</span></strong></div>
        <span className="error-icon"><Icon size={24} /></span>
        <h1>{isAuthError ? 'Your session needs attention' : 'Dashboard unavailable'}</h1>
        <p>{isAuthError ? 'Sign in again to securely access this workspace.' : error.message || 'We could not reach the InboxPlease API. Check your connection and try again.'}</p>
        {error instanceof ApiError && error.code && <code className="error-code">Error code: {error.code}</code>}
        <div className="error-actions">
          <button className="button button-primary" onClick={onRetry}><RefreshCw size={15} /> Try again</button>
          {isAuthError && <button className="button button-secondary" onClick={clearAndReload}><LogOut size={15} /> Clear session</button>}
        </div>
      </section>
    </div>
  );
}

function RefreshErrorBanner({ error, onRetry, onDismiss }: { error: Error; onRetry: () => void; onDismiss: () => void }) {
  const code = error instanceof ApiError ? error.code : undefined;
  return (
    <div className="refresh-error-banner" role="alert">
      <span className="refresh-error-icon"><AlertTriangle size={18} /></span>
      <div>
        <strong>Workspace refresh failed</strong>
        <p>{error.message || 'The latest workspace data could not be loaded.'} Your previously loaded view is still shown.</p>
        {code && <code>Error code: {code}</code>}
      </div>
      <button className="button button-secondary" type="button" onClick={onRetry}><RefreshCw size={15} /> Try again</button>
      <button className="icon-button" type="button" onClick={onDismiss} aria-label="Dismiss refresh error"><X size={17} /></button>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const dataRef = useRef<DashboardData | null>(null);
  const [view, setView] = useState<ViewId>(initialDashboardView);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState('');
  const [toast, setToast] = useState('');
  const [demoMode, setDemoMode] = useState(false);
  const [demoNoticeVisible, setDemoNoticeVisible] = useState(true);
  const [commandOpen, setCommandOpen] = useState(false);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [refreshError, setRefreshError] = useState<Error | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    setRefreshError(null);
    getDashboardData().then(async (result) => {
      const nextData = result.source === 'api'
        ? await loadLiveDashboardData(result.data)
        : result.data;
      if (!active) return;
      dataRef.current = nextData;
      setData(nextData);
      setDemoMode(result.source === 'demo');
      setDemoNoticeVisible(result.source === 'demo');
    }).catch((error: unknown) => {
      if (!active) return;
      const nextError = error instanceof Error ? error : new Error('Dashboard request failed');
      if (dataRef.current) setRefreshError(nextError);
      else setLoadError(nextError);
    });
    return () => { active = false; };
  }, [loadAttempt]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [view]);

  useEffect(() => {
    const openCommands = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener('keydown', openCommands);
    return () => window.removeEventListener('keydown', openCommands);
  }, []);

  const navigate = (next: ViewId) => {
    setView(next);
    setGlobalQuery('');
  };

  const content = useMemo(() => {
    if (!data) return null;
    if (view === 'overview') return <OverviewView data={data} onNavigate={navigate} isDemo={demoMode} />;
    if (view === 'inbox') return <InboxView data={data} onToast={setToast} onNavigate={navigate} isDemo={demoMode} />;
    if (view === 'orders') return <OrdersView data={data} globalQuery={globalQuery} onToast={setToast} onNavigate={navigate} onRefresh={() => setLoadAttempt((current) => current + 1)} isDemo={demoMode} />;
    if (view === 'catalog') return <CatalogView data={data} globalQuery={globalQuery} onToast={setToast} onNavigate={navigate} onRefresh={() => setLoadAttempt((current) => current + 1)} isDemo={demoMode} />;
    if (view === 'usage') return <UsageView data={data} onToast={setToast} onNavigate={navigate} isDemo={demoMode} />;
    if (view === 'facebook') return <FacebookView data={data} onToast={setToast} onNavigate={navigate} onRefresh={() => setLoadAttempt((current) => current + 1)} isDemo={demoMode} />;
    return <SettingsView data={data} onToast={setToast} onNavigate={navigate} isDemo={demoMode} />;
  }, [data, demoMode, globalQuery, view]);

  if (!data && loadError) {
    return <LoadErrorScreen error={loadError} onRetry={() => setLoadAttempt((current) => current + 1)} />;
  }
  if (!data) return <LoadingScreen />;

  return (
    <div className={cx('app-shell', !demoMode && 'live-workspace')}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Sidebar view={view} onChange={navigate} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} data={data} />
      <div className="app-main">
        <AppHeader view={view} onMenu={() => setMobileOpen(true)} onCommand={() => setCommandOpen(true)} onToast={setToast} />
        {demoMode && demoNoticeVisible && <div className="demo-banner"><span><Sparkles size={14} /> Demo workspace</span><p>Preview data is shown while the API is unavailable.</p><button onClick={() => setDemoNoticeVisible(false)} aria-label="Dismiss demo notice"><X size={14} /></button></div>}
        {refreshError && <RefreshErrorBanner error={refreshError} onRetry={() => setLoadAttempt((current) => current + 1)} onDismiss={() => setRefreshError(null)} />}
        <main id="main-content" className={cx('page-content', view === 'inbox' && 'inbox-page')}>{content}</main>
      </div>
      <nav className="mobile-tabbar" aria-label="Mobile navigation">
        {NAVIGATION.slice(0, 4).map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'active' : ''} onClick={() => navigate(id)}><Icon size={19} /><span>{label}</span>{id === 'inbox' && data.conversations.some((conversation) => conversation.unread > 0) && <i>{data.conversations.reduce((total, conversation) => total + conversation.unread, 0)}</i>}</button>)}
        <button className={view === 'settings' ? 'active' : ''} onClick={() => setMobileOpen(true)}><Menu size={19} /><span>More</span></button>
      </nav>
      <CommandMenu open={commandOpen} onClose={() => setCommandOpen(false)} onNavigate={navigate} onSearch={setGlobalQuery} />
      <div className={cx('toast', toast && 'toast-visible')} role="status"><CheckCircle2 size={17} /><span>{toast}</span></div>
    </div>
  );
}
