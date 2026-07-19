export type ViewId = 'overview' | 'inbox' | 'orders' | 'catalog' | 'usage' | 'facebook' | 'settings';

export type ConversationStatus = 'ai' | 'human' | 'waiting';
export type OrderStatus = 'new' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
export type ProductStatus = 'active' | 'low-stock' | 'draft' | 'out-of-stock';
export type PaymentStatus = 'Paid' | 'Pending' | 'Failed' | 'Refunded' | 'Unpaid' | 'COD';

export interface Metric {
  id: string;
  label: string;
  value: string;
  delta: number;
  helper: string;
}

export interface ChatMessage {
  id: string;
  sender: 'customer' | 'assistant' | 'human';
  text: string;
  time: string;
  kind?: 'text' | 'voice' | 'image';
}

export interface Conversation {
  id: string;
  customer: string;
  initials: string;
  color: string;
  language: 'বাংলা' | 'Banglish' | 'English';
  lastMessage: string;
  updatedAt: string;
  unread: number;
  status: ConversationStatus;
  orderValue?: number;
  tags: string[];
  messages: ChatMessage[];
}

export interface Order {
  id: string;
  customer: string;
  initials: string;
  items: string;
  itemCount?: number;
  total: number;
  status: OrderStatus;
  payment: PaymentStatus;
  createdAt: string;
  source?: 'AI' | 'Human';
}

export interface Product {
  id: string;
  pageId?: string;
  name: string;
  banglaName: string;
  sku: string;
  category: string;
  price: number;
  stock: number;
  sales: number;
  status: ProductStatus;
  accent: string;
  glyph: string;
  description?: string;
  imageId?: string;
  variants?: ProductVariant[];
  rawStatus?: 'active' | 'draft' | 'archived';
  rawCurrency?: string;
}

export interface ProductVariant {
  id: string;
  name: string;
  sku: string;
  price: number;
  stock: number;
  imageId?: string;
}

export interface UsageData {
  messagesUsed: number;
  messagesLimit: number;
  productsUsed: number;
  productsLimit: number;
  pagesUsed: number;
  pagesLimit: number;
  period: string;
  resetDate: string;
  qwenShare: number;
  frontierShare: number;
  voiceNotes: number;
  imageMatches: number;
  daily: number[];
  catalogLoaded?: number;
  catalogTruncated?: boolean;
}

export interface PageConnection {
  id: string;
  name: string;
  handle: string;
  status: 'connected' | 'attention';
  followers: string;
  responseRate: string;
  lastSynced: string;
  messagingReady?: boolean;
  aiMessagingEnabled?: boolean;
  aiMessagingEffective?: boolean;
}

export interface Activity {
  id: string;
  type: 'order' | 'message' | 'catalog' | 'handoff';
  title: string;
  detail: string;
  time: string;
}

export interface DashboardData {
  merchant: {
    name: string;
    storeName: string;
    plan: 'Free' | 'Pro' | 'Business' | 'Enterprise';
    role?: 'owner' | 'admin' | 'staff' | 'service';
  };
  metrics: Metric[];
  conversations: Conversation[];
  orders: Order[];
  products: Product[];
  usage: UsageData;
  pages: PageConnection[];
  activities: Activity[];
  revenue: number[];
}
