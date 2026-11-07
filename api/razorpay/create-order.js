const RAZORPAY_BASE = 'https://api.razorpay.com/v1';

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
}
function requiredEnv() {
  return ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter((name) => !process.env[name]);
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
  const raw = await r.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }
  if (!r.ok) throw new Error(data?.message || data?.error || `Supabase ${r.status}`);
  return data;
}
function safeText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const missing = requiredEnv();
  if (missing.length) return json(res, 500, { error: 'Server payment configuration is incomplete' });

  let razorpayOrderId = null;
  try {
    const body = req.body || {};
    const orderNumber = safeText(body.orderNumber, 32);
    const pin = safeText(body.pin, 6);
    const customer = body.customer || {};
    const items = Array.isArray(body.items) ? body.items : [];
    const couponCode = safeText(body.couponCode, 40).toUpperCase();
    const address = safeText(body.address, 1000);

    if (!/^ORR-?\d{7,10}$/i.test(orderNumber)) return json(res, 400, { error: 'Invalid ORRIA order number' });
    if (!/^\d{6}$/.test(pin)) return json(res, 400, { error: 'Invalid PIN' });
    if (!/^\d{10}$/.test(String(customer.phone || ''))) return json(res, 400, { error: 'Invalid mobile number' });
    if (!safeText(customer.name, 120) || !address || !items.length || items.length > 50) return json(res, 400, { error: 'Incomplete order details' });

    const existing = await supabase(`orders?select=id&order_number=eq.${encodeURIComponent(orderNumber)}&limit=1`);
    if (existing.length) return json(res, 409, { error: 'This order number already exists. Please retry checkout.' });

    const ids = [...new Set(items.map((item) => safeText(item.id, 64)).filter(Boolean))];
    if (!ids.length || ids.length > 50 || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
      return json(res, 400, { error: 'Invalid cart product identifiers' });
    }
    const inList = '(' + ids.map((id) => `"${id}"`).join(',') + ')';
    const products = await supabase(`products?select=id,name,price,stock,active&id=in.${encodeURIComponent(inList)}&active=eq.true`);
    const byId = new Map(products.map((product) => [String(product.id), product]));

    let subtotal = 0;
    const normalized = [];
    for (const item of items) {
      const product = byId.get(String(item.id));
      const quantity = Number(item.qty);
      if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
        return json(res, 400, { error: 'One or more cart items are invalid or unavailable' });
      }
      if (Number(product.stock) < quantity) return json(res, 409, { error: `${product.name} has only ${Number(product.stock)} available` });
      const price = Number(product.price);
      if (!Number.isFinite(price) || price < 0) return json(res, 409, { error: 'Invalid product price configuration' });
      subtotal += price * quantity;
      normalized.push({
        id: product.id,
        name: safeText(product.name, 180),
        price,
        qty: quantity,
        variant: safeText(item.variant || 'Standard', 80),
        personal: safeText(item.personal, 160)
      });
    }

    const discount = couponCode === 'ORRIA150' && subtotal >= 2999 ? 150 : 0;
    const discounted = Math.max(0, subtotal - discount);
    const shipping = discounted >= 1999 ? 0 : 99;
    const total = Math.round((discounted + shipping) * 100) / 100;
    if (!Number.isInteger(Number(body.amount)) || Number(body.amount) !== total) {
      return json(res, 409, { error: 'Order total changed. Please refresh checkout and try again.' });
    }

    const orderResponse = await fetch(`${RAZORPAY_BASE}/orders`, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: Math.round(total * 100),
        currency: 'INR',
        receipt: orderNumber,
        notes: { order_number: orderNumber }
      })
    });
    const razorpayOrder = await orderResponse.json();
    if (!orderResponse.ok || !razorpayOrder.id) {
      return json(res, 502, { error: razorpayOrder?.error?.description || 'Razorpay order creation failed' });
    }
    razorpayOrderId = razorpayOrder.id;

    const orderRows = await supabase('orders', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        order_number: orderNumber,
        customer_name: safeText(customer.name, 120),
        phone: String(customer.phone),
        email: safeText(customer.email, 254) || null,
        delivery_address: address,
        address_snapshot: { address, pin },
        subtotal,
        discount,
        shipping,
        total,
        status: 'Pending',
        payment_status: 'Pending',
        razorpay_order_id: razorpayOrderId
      })
    });
    const localOrder = orderRows?.[0];
    if (!localOrder?.id) throw new Error('Order record was not created');

    await supabase('order_items', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(normalized.map((item) => ({
        order_id: localOrder.id,
        product_id: item.id,
        product_name: item.name,
        price: item.price,
        quantity: item.qty,
        line_total: Math.round(item.price * item.qty * 100) / 100
      })))
    });

    return json(res, 200, {
      keyId: process.env.RAZORPAY_KEY_ID,
      razorpayOrderId,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      orderNumber,
      breakdown: { subtotal, discount, shipping, total },
      items: normalized
    });
  } catch (error) {
    console.error('create-order error', error);
    return json(res, 500, { error: 'Unable to create payment order. Please contact ORRIA if a payment attempt was started.' });
  }
};
