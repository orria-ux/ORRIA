# ORRIA + Razorpay Web Standard Checkout

This package adds Razorpay Web Standard Checkout to the existing ORRIA V5 website without exposing the Razorpay secret key in the browser.

## Vercel Environment Variables
Add these to the Vercel project:

- `RAZORPAY_KEY_ID` — Razorpay Test Mode Key ID for testing.
- `RAZORPAY_KEY_SECRET` — matching Razorpay Test Mode Key Secret.
- `SUPABASE_URL` — `https://kuvaxkdhfxzznzidaugv.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service-role key. Never put this in HTML or share it in chat.

## Test flow
1. Deploy this folder to the ORRIA Vercel project.
2. Keep Razorpay in Test Mode and use Test API keys.
3. Open `https://orriahomedecor.com` and add an item.
4. Select `UPI / Online Payment` at checkout.
5. Complete the Razorpay test payment using the credentials shown by Razorpay.
6. The browser sends the payment IDs/signature to `/api/razorpay/verify-payment`.
7. The server verifies the signature and captured payment before changing the ORRIA order from Pending to Confirmed.

The frontend also retains the existing COD and WhatsApp order paths.
