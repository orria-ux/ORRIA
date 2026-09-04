const crypto = require('crypto');
const RAZORPAY_BASE = 'https://api.razorpay.com/v1';

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
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
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(res, 500, { error: 'Server payment configuration is incomplete' });
  }
  try {
    const { orderNumber, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!orderNumber || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return json(res, 400, { error: 'Missing payment verification fields' });

    const orders = await supabase(`orders?select=order_number,total,status&order_number=eq.${encodeURIComponent(String(orderNumber))}&limit=1`);
    const localOrder = orders[0];
    if (!localOrder) return json(res, 404, { error: 'ORRIA order not found' });

    const orderResponse = await fetch(`${RAZORPAY_BASE}/orders/${encodeURIComponent(razorpay_order_id)}`, { headers: { Authorization: authHeader() } });
    const rpOrder = await orderResponse.json();
    if (!orderResponse.ok) return json(res, 502, { error: 'Could not verify Razorpay order' });
    if (String(rpOrder.receipt || '') !== String(orderNumber)) return json(res, 400, { error: 'Payment/order mismatch' });
    if (Number(rpOrder.amount) !== Number(localOrder.total) * 100) return json(res, 400, { error: 'Payment amount mismatch' });

    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${rpOrder.id}|${razorpay_payment_id}`).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(razorpay_signature), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(res, 400, { error: 'Invalid payment signature' });

    const paymentResponse = await fetch(`${RAZORPAY_BASE}/payments/${encodeURIComponent(razorpay_payment_id)}`, { headers: { Authorization: authHeader() } });
    const payment = await paymentResponse.json();
    if (!paymentResponse.ok || payment.order_id !== rpOrder.id) return json(res, 502, { error: 'Could not verify payment record' });
    if (payment.status !== 'captured') return json(res, 409, { error: `Payment status is ${payment.status || 'unknown'}` });

    await supabase(`orders?order_number=eq.${encodeURIComponent(String(orderNumber))}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'Confirmed' })
    });

    return json(res, 200, { verified: true, orderNumber, paymentId: razorpay_payment_id, status: 'captured' });
  } catch (e) {
    console.error('verify-payment error', e);
    return json(res, 500, { error: 'Payment verification failed' });
  }
};
