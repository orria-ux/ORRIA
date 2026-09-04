const RAZORPAY_BASE = 'https://api.razorpay.com/v1';

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
}

function requiredEnv() {
  const names = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  return names.filter((n) => !process.env[n]);
}

function authHeader() {
  return 'Basic ' + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
}

async function supabase(path, options = {}) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!r.ok) throw new Error(data?.message || data?.error || `Supabase ${r.status}`);
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const missing = requiredEnv();
  if (missing.length) return json(res, 500, { error: `Server payment configuration missing: ${missing.join(', ')}` });

  try {
    const body = req.body || {};
    const orderNumber = String(body.orderNumber || '').trim();
    const pin = String(body.pin || '').trim();
    const customer = body.customer || {};
    const items = Array.isArray(body.items) ? body.items : [];
    const couponCode = String(body.couponCode || '').trim().toUpperCase();
    const address = String(body.address || '').trim();

    if (!/^ORR-?\d{7,10}$/i.test(orderNumber)) return json(res, 400, { error: 'Invalid ORRIA order number' });
    if (!/^\d{6}$/.test(pin)) return json(res, 400, { error: 'Invalid PIN' });
    if (!/^\d{10}$/.test(String(customer.phone || ''))) return json(res, 400, { error: 'Invalid mobile number' });
    if (!String(customer.name || '').trim() || !address || !items.length) return json(res, 400, { error: 'Incomplete order details' });

    const ids = [...new Set(items.map((x) => String(x.id || '')).filter(Boolean))];
    if (!ids.length || ids.length > 50) return json(res, 400, { error: 'Invalid cart' });
    const inList = '(' + ids.map((id) => `"${id.replace(/"/g, '')}"`).join(',') + ')';
    const products = await supabase(`products?select=id,name,price,stock,active&id=in.${encodeURIComponent(inList)}&active=eq.true`);
    const byId = new Map(products.map((p) => [String(p.id), p]));

    let subtotal = 0;
    const normalized = [];
    for (const item of items) {
      const p = byId.get(String(item.id));
      const qty = Math.floor(Number(item.qty));
      if (!p || !Number.isFinite(qty) || qty < 1 || qty > 100) return json(res, 400, { error: 'One or more cart items are invalid or unavailable' });
      if (Number(p.stock) < qty) return json(res, 409, { error: `${p.name} has only ${Number(p.stock)} available` });
      subtotal += Number(p.price) * qty;
      normalized.push({ id: p.id, name: p.name, price: Number(p.price), qty, variant: String(item.variant || 'Standard'), personal: String(item.personal || '') });
    }

    const discount = couponCode === 'ORRIA150' && subtotal >= 2999 ? 150 : 0;
    const discounted = Math.max(0, subtotal - discount);
    const shipping = discounted >= 1999 ? 0 : 99;
    const total = discounted + shipping;
    const requestedAmount = Number(body.amount);
    if (!Number.isInteger(requestedAmount) || requestedAmount !== total) return json(res, 409, { error: 'Order total changed. Please refresh checkout and try again.' });

    const razorpayOrderResponse = await fetch(`${RAZORPAY_BASE}/orders`, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: total * 100,
        currency: 'INR',
        receipt: orderNumber,
        notes: { order_number: orderNumber, customer_phone: String(customer.phone) }
      })
    });
    const razorpayOrder = await razorpayOrderResponse.json();
    if (!razorpayOrderResponse.ok) return json(res, 502, { error: razorpayOrder?.error?.description || 'Razorpay order creation failed' });

    const deliveryAddress = address;
    const existing = await supabase(`orders?select=order_number&order_number=eq.${encodeURIComponent(orderNumber)}&limit=1`);
    if (existing.length) return json(res, 409, { error: 'This order number already exists. Please retry checkout.' });

    await supabase('orders', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ order_number: orderNumber, customer_name: String(customer.name).trim(), phone: String(customer.phone), delivery_address: deliveryAddress, total, status: 'Pending' })
    });

    return json(res, 200, {
      keyId: process.env.RAZORPAY_KEY_ID,
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      orderNumber,
      breakdown: { subtotal, discount, shipping, total },
      items: normalized
    });
  } catch (e) {
    console.error('create-order error', e);
    return json(res, 500, { error: 'Unable to create payment order' });
  }
};
