function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
}
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  if (required.some((name) => !process.env[name])) return json(res, 500, { error: 'Coupon service is not configured' });
  try {
    const code = String(req.body?.code || '').trim().toUpperCase().slice(0, 40);
    const subtotal = Number(req.body?.subtotal);
    if (!/^[A-Z0-9_-]{3,40}$/.test(code) || !Number.isFinite(subtotal) || subtotal < 0) {
      return json(res, 400, { valid: false, error: 'Enter a valid coupon code.' });
    }
    const url = new URL('/rest/v1/coupons', process.env.SUPABASE_URL);
    url.searchParams.set('select', 'code,discount_amount,minimum_order,active,starts_at,ends_at');
    url.searchParams.set('code', `eq.${code}`);
    url.searchParams.set('active', 'eq.true');
    url.searchParams.set('limit', '1');
    const response = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    if (!response.ok) throw new Error('Coupon lookup failed');
    const rows = await response.json();
    const coupon = rows[0];
    if (!coupon) return json(res, 200, { valid: false, error: 'This coupon is invalid or inactive.' });
    const now = Date.now();
    if (coupon.starts_at && new Date(coupon.starts_at).getTime() > now) return json(res, 200, { valid: false, error: 'This coupon is not active yet.' });
    if (coupon.ends_at && new Date(coupon.ends_at).getTime() < now) return json(res, 200, { valid: false, error: 'This coupon has expired.' });
    if (subtotal < Number(coupon.minimum_order)) return json(res, 200, { valid: false, error: `Minimum order is ₹${Number(coupon.minimum_order).toLocaleString('en-IN')}.` });
    const discountAmount = Math.min(Number(coupon.discount_amount), subtotal);
    if (!Number.isFinite(discountAmount) || discountAmount <= 0) return json(res, 200, { valid: false, error: 'Coupon discount is not configured correctly.' });
    return json(res, 200, { valid: true, code: coupon.code, discountAmount, minimumOrder: Number(coupon.minimum_order) });
  } catch (error) {
    console.error('validate-coupon error', error);
    return json(res, 500, { valid: false, error: 'Unable to validate this coupon right now.' });
  }
};
