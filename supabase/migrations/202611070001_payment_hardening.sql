-- ORRIA payment hardening migration
-- Apply only after exporting a backup of the Free-tier production database.
-- This migration intentionally fails if legacy duplicate payment IDs exist.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS razorpay_order_id text;

-- payment_status already exists in production and is constrained to
-- Pending / Paid / Failed / Refunded. Do not recreate or change its values.

CREATE UNIQUE INDEX IF NOT EXISTS orders_razorpay_order_id_uidx
  ON public.orders (razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_payment_id_uidx
  ON public.payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

-- Only the trusted server role may finalize a Razorpay payment.
CREATE OR REPLACE FUNCTION public.finalize_razorpay_payment(
  p_order_number text,
  p_razorpay_order_id text,
  p_payment_id text,
  p_amount_paise bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_existing public.payments%ROWTYPE;
  v_item record;
BEGIN
  IF p_order_number IS NULL OR p_razorpay_order_id IS NULL
     OR p_payment_id IS NULL OR p_amount_paise IS NULL OR p_amount_paise <= 0 THEN
    RAISE EXCEPTION 'Invalid payment confirmation input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE order_number = p_order_number
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_order.razorpay_order_id IS DISTINCT FROM p_razorpay_order_id THEN
    RAISE EXCEPTION 'Razorpay order does not match local order' USING ERRCODE = '23514';
  END IF;

  IF round(v_order.total * 100)::bigint <> p_amount_paise THEN
    RAISE EXCEPTION 'Payment amount does not match order total' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_existing
  FROM public.payments
  WHERE provider = 'razorpay' AND provider_payment_id = p_payment_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.order_id <> v_order.id OR v_existing.amount <> v_order.total
       OR v_existing.status <> 'captured' THEN
      RAISE EXCEPTION 'Payment ID is already associated with another or invalid payment' USING ERRCODE = '23514';
    END IF;
    IF v_order.status = 'Confirmed' AND v_order.payment_status = 'Paid' THEN
      RETURN jsonb_build_object('verified', true, 'already_processed', true, 'order_number', p_order_number);
    END IF;
    RAISE EXCEPTION 'Payment record exists but order is not finalized; manual review required' USING ERRCODE = '23514';
  END IF;

  IF v_order.status = 'Confirmed' AND v_order.payment_status = 'Paid' THEN
    RAISE EXCEPTION 'Order is already confirmed with a different payment' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.order_items WHERE order_id = v_order.id) THEN
    RAISE EXCEPTION 'Order has no stored items' USING ERRCODE = '23514';
  END IF;

  -- Lock and decrement stock exactly once, in the same transaction as payment confirmation.
  FOR v_item IN
    SELECT product_id, sum(quantity)::integer AS quantity
    FROM public.order_items
    WHERE order_id = v_order.id
    GROUP BY product_id
    ORDER BY product_id
  LOOP
    IF v_item.product_id IS NULL THEN
      RAISE EXCEPTION 'Order item has no product reference' USING ERRCODE = '23514';
    END IF;

    UPDATE public.products
       SET stock = stock - v_item.quantity,
           updated_at = now()
     WHERE id = v_item.product_id
       AND active = true
       AND stock >= v_item.quantity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Insufficient stock for one or more order items' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  INSERT INTO public.payments (order_id, provider, provider_payment_id, amount, status)
  VALUES (v_order.id, 'razorpay', p_payment_id, v_order.total, 'captured');

  UPDATE public.orders
     SET status = 'Confirmed',
         payment_status = 'Paid',
         updated_at = now()
   WHERE id = v_order.id;

  RETURN jsonb_build_object('verified', true, 'already_processed', false, 'order_number', p_order_number);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_razorpay_payment(text, text, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_razorpay_payment(text, text, text, bigint)
  TO service_role;

-- Keep the legacy RPC closed to browser roles. It is no longer used by the payment API.
REVOKE EXECUTE ON FUNCTION public.confirm_paid_order(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_paid_order(text, jsonb)
  TO service_role;
