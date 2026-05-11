const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== PLATFORM DATABASE (in-memory) =====
const db = {
  users: [
    { id: 1, type: 'customer', company: 'TechBuild Electronics', email: 'buyer@techbuild.com', password: 'demo123' },
    { id: 2, type: 'supplier', company: 'Nexwah Components', email: 'supplier@nexwah.com', password: 'demo123' }
  ],
  inventory: {
    2: [
      { part: 'ESP32-WROOM-32E', price: 2.80, stock: 2500, moq: 10, lead: '3-5 days' },
      { part: 'STM32F103C8T6', price: 2.90, stock: 3000, moq: 50, lead: '3-5 days' },
      { part: 'ATMEGA328P-PU', price: 2.10, stock: 4000, moq: 50, lead: '3-5 days' },
      { part: 'Raspberry Pi 4B 2GB', price: 50.00, stock: 3, moq: 1, lead: '7-10 days' },
      { part: 'DHT22', price: 1.50, stock: 2000, moq: 10, lead: '3-5 days' }
    ]
  },
  orders: [],
  requests: []
};

// OpenClaw gateway URL - set via environment variable
const OPENCLAW_GATEWAY = process.env.OPENCLAW_GATEWAY_URL || 'https://your-openclaw-gateway.com';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';

// ===== AUTH =====
app.post('/api/auth/login', (req, res) => {
  const { email, password, type } = req.body;
  const user = db.users.find(u => u.email === email && u.password === password && u.type === type);
  if (user) res.json({ success: true, user: { id: user.id, company: user.company, email: user.email, type: user.type } });
  else res.status(401).json({ success: false, error: 'Invalid credentials' });
});

app.post('/api/auth/signup', (req, res) => {
  const { email, password, company, type } = req.body;
  if (db.users.find(u => u.email === email)) { res.status(400).json({ success: false, error: 'Email already exists' }); return; }
  const user = { id: Date.now(), type, company, email, password };
  db.users.push(user);
  if (type === 'supplier') db.inventory[user.id] = [];
  res.json({ success: true, user: { id: user.id, company: user.company, email: user.email, type: user.type } });
});

// ===== SUPPLIER INVENTORY =====
app.get('/api/inventory/:userId', (req, res) => {
  res.json(db.inventory[req.params.userId] || []);
});

app.post('/api/inventory/:userId', (req, res) => {
  const { action, part, price, stock, moq, lead } = req.body;
  if (!db.inventory[req.params.userId]) db.inventory[req.params.userId] = [];
  const inv = db.inventory[req.params.userId];

  if (action === 'add_or_update') {
    const idx = inv.findIndex(i => i.part.toLowerCase() === part.toLowerCase());
    if (idx >= 0) inv[idx] = { part, price, stock, moq: moq || 10, lead: lead || '3-5 days' };
    else inv.push({ part, price, stock, moq: moq || 10, lead: lead || '3-5 days' });
  } else if (action === 'out_of_stock') {
    const idx = inv.findIndex(i => i.part.toLowerCase().includes(part.toLowerCase()));
    if (idx >= 0) inv[idx].stock = 0;
  } else if (action === 'price_update') {
    const idx = inv.findIndex(i => i.part.toLowerCase().includes(part.toLowerCase()));
    if (idx >= 0) inv[idx].price = price;
  } else if (action === 'remove') {
    const idx = inv.findIndex(i => i.part.toLowerCase().includes(part.toLowerCase()));
    if (idx >= 0) inv.splice(idx, 1);
  }
  res.json({ success: true, inventory: inv });
});

// ===== OPENCLAW AGENT COMMUNICATION =====
app.post('/api/agent/message', async (req, res) => {
  const { message, agentType, userId } = req.body;

  // Build context from platform inventory
  const suppContext = db.users
    .filter(u => u.type === 'supplier')
    .map(s => {
      const inv = db.inventory[s.id] || [];
      if (!inv.length) return null;
      return `Supplier: ${s.company}\n${inv.map(i => `  - ${i.part}: $${i.price}/unit, ${i.stock} units, MOQ ${i.moq}, lead time ${i.lead}${i.stock === 0 ? ' (OUT OF STOCK)' : ''}`).join('\n')}`;
    })
    .filter(Boolean)
    .join('\n\n');

  try {
    // Call OpenClaw gateway
    const openclawMessage = agentType === 'buyer'
      ? `BUYER REQUEST: ${message}\n\nAVAILABLE SUPPLIER INVENTORY:\n${suppContext}\n\nPlease provide pricing comparison and recommendation.`
      : message;

    const response = await fetch(`${OPENCLAW_GATEWAY}/api/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_TOKEN}`
      },
      body: JSON.stringify({ message: openclawMessage }),
      timeout: 120000
    });

    if (!response.ok) throw new Error('OpenClaw gateway error');
    const data = await response.json();
    const reply = data.result?.payloads?.[0]?.text || data.reply || data.message;

    // Log request
    if (agentType === 'buyer') {
      db.requests.push({ id: Date.now(), customer: 'Buyer', part: message.substring(0, 50), qty: 0, sid: 2, status: 'replied', time: new Date().toLocaleTimeString() });
      db.orders.push({ id: Date.now(), userId, message, reply, time: new Date().toISOString(), status: 'Quote Received' });
    }

    res.json({ reply, source: 'openclaw' });
  } catch(e) {
    console.error('OpenClaw error:', e.message);
    // Fallback to Claude API if OpenClaw unavailable
    res.json({ reply: 'OpenClaw gateway is not reachable. Please check the gateway configuration.', source: 'error', error: e.message });
  }
});

// ===== SUPPLIERS LIST =====
app.get('/api/suppliers', (req, res) => {
  const suppliers = db.users.filter(u => u.type === 'supplier').map(s => ({
    id: s.id, company: s.company,
    parts: (db.inventory[s.id] || []).length,
    totalStock: (db.inventory[s.id] || []).reduce((sum, i) => sum + i.stock, 0),
    preview: (db.inventory[s.id] || []).slice(0, 3).map(i => i.part)
  }));
  res.json(suppliers);
});

// ===== ORDERS & REQUESTS =====
app.get('/api/orders/:userId', (req, res) => res.json(db.orders.filter(o => o.userId == req.params.userId)));
app.get('/api/requests/:userId', (req, res) => res.json(db.requests.filter(r => r.sid == req.params.userId)));

// ===== HEALTH CHECK =====
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', openclaw: OPENCLAW_GATEWAY, timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Aixinchips Platform running on port ${PORT}`);
  console.log(`OpenClaw Gateway: ${OPENCLAW_GATEWAY}`);
});
