const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://kdreucrxnjyvojayrfmh.supabase.co').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || 'sb_publishable_qX8hazONOVQvuWurUIWFwg_SHTomBzm').trim();
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const TOKEN_SECRET = process.env.TOKEN_SECRET || '';

function verifyPassword(pw) {
  const [salt, hash] = PASSWORD_HASH.split(':');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
}

function signToken() {
  const exp = Date.now() + 3600000 * 24 * 7;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET || 'secret').update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifyToken(t) {
  const parts = (t || '').split('.');
  if (parts.length !== 2) return false;
  const sig = crypto.createHmac('sha256', TOKEN_SECRET || 'secret').update(parts[0]).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(parts[1]))) return false;
  try { const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); return p.exp > Date.now(); } catch(e){ return false; }
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!verifyToken(t)) return res.status(401).send('Unauthorized');
  next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === 'alikebab' && verifyPassword(password)) {
    return res.json({ token: signToken() });
  }
  res.status(401).send('Unauthorized');
});

app.post('/api/logout', (req, res) => { res.json({ ok: true }); });

app.get('/api/orders', auth, async (req, res) => {
  const { data, error } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/orders/lookup/:number', async (req, res) => {
  const { data, error } = await supabase.from('orders').select('order_number,status,customer_name,created_at').eq('order_number', req.params.number).single();
  if (error) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

app.post('/api/orders', async (req, res) => {
  const o = req.body || {};
  const { data, error } = await supabase.from('orders').insert([{
    order_number: o.order_number,
    customer_name: o.customer_name,
    customer_phone: o.customer_phone || null,
    order_type: o.order_type,
    delivery_address: o.delivery_address || null,
    items: o.items,
    subtotal: o.subtotal || null,
    total: o.total || o.total_price || 0,
    status: o.status || 'new',
    notes: o.notes || null,
    delivery_fee: o.delivery_fee || 0,
    delivery_timing: o.delivery_timing || null,
    delivery_time: o.delivery_time || null,
    pickup_time: o.pickup_time || null
  }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ success: true, order: (data || [])[0] });
});

app.patch('/api/orders/:id', auth, async (req, res) => {
  const { status } = req.body || {};
  if (!['new','accepted','preparing','ready','out_for_delivery','completed','rejected'].includes(status)) return res.status(400).send('Invalid status');
  const { data, error } = await supabase.from('orders').update({ status }).eq('id', req.params.id).select();
  if (error) return res.status(400).json({ error: error.message });
  const order = (data || [])[0];
  if (status === 'completed' && order) {
    const day = new Date(order.created_at).toISOString().slice(0,10);
    const { data: existing } = await supabase.from('daily_earnings').select('revenue,order_count').eq('day', day).single();
    const newRevenue = (existing ? Number(existing.revenue) : 0) + (Number(order.total) || 0);
    const newCount = (existing ? existing.order_count : 0) + 1;
    await supabase.from('daily_earnings').upsert({ day, revenue: newRevenue, order_count: newCount, updated_at: new Date().toISOString() });
  }
  res.json(order || { ok: true });
});

app.get('/api/earnings', auth, async (req, res) => {
  const { data, error } = await supabase.from('daily_earnings').select('*').order('day', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/settings', async (req, res) => {
  const { data } = await supabase.from('settings').select('*');
  const obj = {};
  (data || []).forEach(r => obj[r.key] = r.value);
  // auto close outside opening hours (11:00-23:55)
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
  const mins = now.getHours()*60 + now.getMinutes();
  const open = mins >= 11*60 && mins <= 23*60+55;
  obj.accepting_orders = open ? 'true' : 'false';
  res.json(obj);
});

app.patch('/api/settings', auth, async (req, res) => {
  const { key, value } = req.body || {};
  await supabase.from('settings').upsert({ key, value });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
