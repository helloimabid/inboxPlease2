import type { DashboardData } from './types';

export const demoData: DashboardData = {
  merchant: { name: 'Nishat', storeName: 'Rongdhonu Lifestyle', plan: 'Pro' },
  metrics: [
    { id: 'revenue', label: 'Today’s revenue', value: '৳24,850', delta: 18.2, helper: 'vs. গতকাল' },
    { id: 'orders', label: 'New orders', value: '38', delta: 12.5, helper: '6 need attention' },
    { id: 'conversations', label: 'AI conversations', value: '164', delta: 8.4, helper: '92% auto-resolved' },
    { id: 'response', label: 'Avg. response time', value: '1.8s', delta: -23.1, helper: 'faster this week' },
  ],
  conversations: [
    {
      id: 'conv-1', customer: 'তাসনিম আক্তার', initials: 'তা', color: '#5b5bd6', language: 'বাংলা',
      lastMessage: 'আপু, কালকের মধ্যে ডেলিভারি হবে তো?', updatedAt: '2m', unread: 2, status: 'waiting', orderValue: 1850,
      tags: ['Delivery', 'Repeat buyer'],
      messages: [
        { id: 'm1', sender: 'customer', text: 'এই লিনেন কুর্তাটা কি নেভি ব্লুতে আছে?', time: '10:28 AM' },
        { id: 'm2', sender: 'assistant', text: 'জি আপু, নেভি ব্লুতে M, L আর XL সাইজ available আছে 💙 কোন সাইজটা লাগবে?', time: '10:28 AM' },
        { id: 'm3', sender: 'customer', text: 'L সাইজ। কালকের মধ্যে ডেলিভারি হবে তো?', time: '10:31 AM' },
      ],
    },
    {
      id: 'conv-2', customer: 'Sabbir Hossain', initials: 'SH', color: '#e17a45', language: 'Banglish',
      lastMessage: 'Okay tahole order ta confirm kore den', updatedAt: '7m', unread: 1, status: 'ai', orderValue: 2490,
      tags: ['High intent'],
      messages: [
        { id: 'm1', sender: 'customer', text: 'Black sneaker ta 42 size available?', time: '10:04 AM' },
        { id: 'm2', sender: 'assistant', text: 'Yes bhai, 42 size stock-e ache. Dhakar moddhe delivery charge ৳70.', time: '10:04 AM' },
        { id: 'm3', sender: 'customer', text: 'Okay tahole order ta confirm kore den', time: '10:08 AM' },
      ],
    },
    {
      id: 'conv-3', customer: 'মেহজাবিন নূর', initials: 'মে', color: '#2c9984', language: 'বাংলা',
      lastMessage: 'ছবিটার মতো একই কালার হবে?', updatedAt: '12m', unread: 0, status: 'ai',
      tags: ['Image match'],
      messages: [
        { id: 'm1', sender: 'customer', text: 'ছবিটার মতো একই কালার হবে?', time: '9:58 AM', kind: 'image' },
        { id: 'm2', sender: 'assistant', text: 'জি, ছবির সাথে সবচেয়ে কাছের রঙটা “Dusty Rose”। আলোতে সামান্য হালকা দেখাতে পারে।', time: '9:58 AM' },
      ],
    },
    {
      id: 'conv-4', customer: 'Fahim Rahman', initials: 'FR', color: '#b25d82', language: 'English',
      lastMessage: 'I need to change the delivery address.', updatedAt: '19m', unread: 0, status: 'human', orderValue: 3200,
      tags: ['Human handoff'],
      messages: [
        { id: 'm1', sender: 'customer', text: 'I need to change the delivery address.', time: '9:44 AM' },
        { id: 'm2', sender: 'human', text: 'Of course — I can update that before dispatch. Please send the new address.', time: '9:46 AM' },
      ],
    },
    {
      id: 'conv-5', customer: 'নাবিলা ইসলাম', initials: 'না', color: '#4e86c5', language: 'বাংলা',
      lastMessage: 'ভয়েস মেসেজ পাঠিয়েছেন', updatedAt: '31m', unread: 0, status: 'ai',
      tags: ['Voice note'],
      messages: [
        { id: 'm1', sender: 'customer', text: 'ভয়েস মেসেজ · 0:18', time: '9:31 AM', kind: 'voice' },
        { id: 'm2', sender: 'assistant', text: 'জি আপু, বুঝেছি। আপনি দুইটা নিলে মোট ৳২,৯০০ হবে এবং ডেলিভারি ফ্রি।', time: '9:32 AM' },
      ],
    },
  ],
  orders: [
    { id: 'IP-2048', customer: 'তাসনিম আক্তার', initials: 'তা', items: 'Navy Linen Kurti', itemCount: 1, total: 1850, status: 'new', payment: 'COD', createdAt: 'Today, 10:34 AM', source: 'AI' },
    { id: 'IP-2047', customer: 'Sabbir Hossain', initials: 'SH', items: 'Urban Runner Sneaker', itemCount: 1, total: 2490, status: 'confirmed', payment: 'Paid', createdAt: 'Today, 10:09 AM', source: 'AI' },
    { id: 'IP-2046', customer: 'মেহজাবিন নূর', initials: 'মে', items: 'Dusty Rose Co-ord Set', itemCount: 1, total: 2750, status: 'processing', payment: 'COD', createdAt: 'Today, 9:54 AM', source: 'AI' },
    { id: 'IP-2045', customer: 'Fahim Rahman', initials: 'FR', items: 'Classic Polo + 1 more', itemCount: 2, total: 3200, status: 'shipped', payment: 'Paid', createdAt: 'Today, 9:21 AM', source: 'Human' },
    { id: 'IP-2044', customer: 'নাবিলা ইসলাম', initials: 'না', items: 'Handloom Scarf × 2', itemCount: 2, total: 2900, status: 'delivered', payment: 'Paid', createdAt: 'Yesterday, 8:42 PM', source: 'AI' },
    { id: 'IP-2043', customer: 'Arif Chowdhury', initials: 'AC', items: 'Everyday Backpack', itemCount: 1, total: 1950, status: 'cancelled', payment: 'Pending', createdAt: 'Yesterday, 7:16 PM', source: 'AI' },
  ],
  products: [
    { id: 'p1', name: 'Navy Linen Kurti', banglaName: 'নেভি লিনেন কুর্তি', sku: 'RL-KRT-018', category: 'Women', price: 1850, stock: 24, sales: 86, status: 'active', accent: '#dce8f6', glyph: 'ক' },
    { id: 'p2', name: 'Urban Runner Sneaker', banglaName: 'আরবান রানার স্নিকার', sku: 'RL-SNK-042', category: 'Footwear', price: 2490, stock: 8, sales: 54, status: 'low-stock', accent: '#eee7df', glyph: 'S' },
    { id: 'p3', name: 'Dusty Rose Co-ord Set', banglaName: 'ডাস্টি রোজ কো-অর্ড', sku: 'RL-CRD-011', category: 'Women', price: 2750, stock: 17, sales: 41, status: 'active', accent: '#f2e1e5', glyph: 'R' },
    { id: 'p4', name: 'Classic Cotton Polo', banglaName: 'ক্লাসিক কটন পোলো', sku: 'RL-PLO-025', category: 'Men', price: 1600, stock: 32, sales: 73, status: 'active', accent: '#e2ece7', glyph: 'P' },
    { id: 'p5', name: 'Handloom Scarf', banglaName: 'হ্যান্ডলুম স্কার্ফ', sku: 'RL-SCF-008', category: 'Accessories', price: 1450, stock: 4, sales: 92, status: 'low-stock', accent: '#eee2d7', glyph: 'H' },
    { id: 'p6', name: 'Everyday Backpack', banglaName: 'এভরিডে ব্যাকপ্যাক', sku: 'RL-BAG-016', category: 'Bags', price: 1950, stock: 0, sales: 36, status: 'out-of-stock', accent: '#e5e3ed', glyph: 'B' },
  ],
  usage: {
    messagesUsed: 2148, messagesLimit: 3000, productsUsed: 68, productsLimit: 100, pagesUsed: 1, pagesLimit: 3,
    period: 'July 2026', resetDate: 'August 1, 2026', qwenShare: 94.6, frontierShare: 5.4, voiceNotes: 187, imageMatches: 0,
    daily: [42, 67, 51, 89, 72, 104, 96, 131, 118, 152, 143, 174, 162, 194],
  },
  pages: [
    { id: 'pg1', name: 'Rongdhonu Lifestyle', handle: '@rongdhonulifestyle', status: 'connected', followers: '48.2K', responseRate: '98%', lastSynced: 'Just now' },
  ],
  activities: [
    { id: 'a1', type: 'order', title: 'New order IP-2048', detail: '৳1,850 · COD · AI assisted', time: '2 min ago' },
    { id: 'a2', type: 'handoff', title: 'Conversation needs you', detail: 'তাসনিম asked about urgent delivery', time: '4 min ago' },
    { id: 'a3', type: 'message', title: 'AI closed a sale', detail: 'Sabbir ordered Urban Runner Sneaker', time: '8 min ago' },
    { id: 'a4', type: 'catalog', title: 'Stock running low', detail: 'Handloom Scarf has only 4 left', time: '24 min ago' },
  ],
  revenue: [8, 11, 9, 15, 13, 18, 17, 22, 20, 25, 23, 28, 31, 27],
};
