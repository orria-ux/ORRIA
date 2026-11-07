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
  const raw = await r.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }
  if (!r.ok) throw new Error(data?.message || data?.error || `Supabase ${r.status}`);
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const required = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  if (required.some((name) => !process.env[name])) return json(res, 500, { error: 'Server payment configuration is incomplete' });

  try {
    const { orderNumber, razorpay_order_id: razorpayOrderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
    if (![orderNumber, razorpayOrderId, paymentId, signature].every((value) => typeof value === 'string' && value.length > 0)) {
      return json(res, 400, { error: 'Missing payment verification fields' });
    }
    if (orderNumber.length > 32 || razorpayOrderId.length > 64 || paymentId.length > 64 || signature.length !== 64) {
      return json(res, 400, { error: 'Invalid payment verification fields' });
    }

    const orders = await supabase(
      `orders?select=id,order_number,total,status,payment_status,razorpay_order_id&order_number=eq.${encodeURIComponent(orderNumber)}&limit=1`
    );
    const localOrder = orders[0];
    if (!localOrder) return json(res, 404, { error: 'ORRIA order not found' });
    if (localOrder.razorpay_order_id !== razorpayOrderId) return json(res, 400, { error: 'Razorpay order does not match ORRIA order' });

    const orderResponse = await fetch(`${RAZORPAY_BASE}/orders/${encodeURIComponent(razorpayOrderId)}`, {
      headers: { Authorization: authHeader() }
    });
    const razorpayOrder = await orderResponse.json();
    if (!orderResponse.ok) return json(res, 502, { error: 'Could not verify Razorpay order' });
    if (String(razorpayOrder.receipt || '') !== orderNumber) return json(res, 400, { error: 'Payment/order mismatch' });
    if (Number(razorpayOrder.amount) !== Math.round(Number(localOrder.total) * 100)) return json(res, 400, { error: 'Payment amount mismatch' });

    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${paymentId}`).digest('hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    const receivedBuffer = Buffer.from(signature, 'hex');
    if (receivedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
      return json(res, 400, { error: 'Invalid payment signature' });
    }

    const paymentResponse = await fetch(`${RAZORPAY_BASE}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: authHeader() }
    });
    const payment = await paymentResponse.json();
    if (!paymentResponse.ok || payment.order_id !== razorpayOrderId) return json(res, 502, { error: 'Could not verify payment record' });
    if (payment.status !== 'captured' || Number(payment.amount) !== Number(razorpayOrder.amount)) {
      return json(res, 409, { error: 'Payment is not captured for the exact order amount' });
    }

    const result = await supabase('rpc/finalize_razorpay_payment', {
      method: 'POST',
      body: JSON.stringify({
        p_order_number: orderNumber,
        p_razorpay_order_id: razorpayOrderId,
        p_payment_id: paymentId,
        p_amount_paise: Number(payment.amount)
      })
    });
    return json(res, 200, { verified: true, orderNumber, paymentId, status: 'captured', alreadyProcessed: Boolean(result?.already_processed) });
  } catch (error) {
    console.error('verify-payment error', error);
    return json(res, 500, { error: 'Payment verification failed. Please contact ORRIA with your payment ID if your account was charged.' });
  }
};
