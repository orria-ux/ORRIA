-- ORRIA production payment hardening.
-- Additive migration; existing order, payment and customer data is retained.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS razorpay_order_id text;

CREATE UNIQUE INDEX IF NOT EXISTS orders_razorpay_order_id_uidx
  ON public.orders (razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_payment_id_uidx
  ON public.payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

-- Insert a pending order and every line item in one database transaction.
CREATE OR REPLACE FUNCTION public.create_razorpay_pending_order(
  p_order jsonb,
  p_items jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_order_id uuid;
  v_item_count integer;
  v_items_subtotal numeric;
BEGIN
  IF p_order IS NULL OR jsonb_typeof(p_order) <> 'object'
     OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Invalid order payload' USING ERRCODE = '22023';
  END IF;

  v_item_count := jsonb_array_length(p_items);
  IF v_item_count < 1 OR v_item_count > 50 THEN
    RAISE EXCEPTION 'Order must contain between 1 and 50 items' USING ERRCODE = '22023';
  END IF;

  IF nullif(p_order->>'order_number', '') IS NULL
     OR nullif(p_order->>'customer_name', '') IS NULL
     OR nullif(p_order->>'phone', '') IS NULL
     OR nullif(p_order->>'delivery_address', '') IS NULL
     OR jsonb_typeof(p_order->'address_snapshot') <> 'object'
     OR nullif(p_order->>'razorpay_order_id', '') IS NULL THEN
    RAISE EXCEPTION 'Required order fields are missing' USING ERRCODE = '22023';
  END IF;

  IF p_order->>'subtotal' IS NULL
     OR p_order->>'discount' IS NULL
     OR p_order->>'shipping' IS NULL
     OR p_order->>'total' IS NULL
     OR (p_order->>'subtotal')::numeric < 0
     OR (p_order->>'discount')::numeric < 0
     OR (p_order->>'shipping')::numeric < 0
     OR (p_order->>'total')::numeric <= 0
     OR round((p_order->>'subtotal')::numeric - (p_order->>'discount')::numeric + (p_order->>'shipping')::numeric, 2)
        <> round((p_order->>'total')::numeric, 2) THEN
    RAISE EXCEPTION 'Invalid order totals' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items) AS i(
      product_id uuid,
      product_name text,
      price numeric,
      quantity integer,
      line_total numeric
    )
    WHERE i.product_id IS NULL
       OR nullif(trim(i.product_name), '') IS NULL
       OR i.price IS NULL OR i.price < 0
       OR i.quantity IS NULL OR i.quantity < 1 OR i.quantity > 100
       OR i.line_total IS NULL
       OR round(i.line_total, 2) <> round(i.price * i.quantity, 2)
  ) THEN
    RAISE EXCEPTION 'Invalid order item data' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(sum(i.line_total), 0)
    INTO v_items_subtotal
  FROM jsonb_to_recordset(p_items) AS i(
    product_id uuid,
    product_name text,
    price numeric,
    quantity integer,
    line_total numeric
  );

  IF round(v_items_subtotal, 2) <> round((p_order->>'subtotal')::numeric, 2) THEN
    RAISE EXCEPTION 'Order items do not match subtotal' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.orders (
    order_number, customer_name, phone, email, delivery_address, address_snapshot,
    subtotal, discount, shipping, total, status, payment_status, razorpay_order_id
  )
  VALUES (
    p_order->>'order_number',
    p_order->>'customer_name',
    p_order->>'phone',
    nullif(p_order->>'email', ''),
    p_order->>'delivery_address',
    p_order->'address_snapshot',
    (p_order->>'subtotal')::numeric,
    (p_order->>'discount')::numeric,
    (p_order->>'shipping')::numeric,
    (p_order->>'total')::numeric,
    'Pending',
    'Pending',
    p_order->>'razorpay_order_id'
  )
  RETURNING id INTO v_order_id;

  INSERT INTO public.order_items (
    order_id, product_id, product_name, price, quantity, line_total
  )
  SELECT v_order_id, i.product_id, i.product_name, i.price, i.quantity, i.line_total
  FROM jsonb_to_recordset(p_items) AS i(
    product_id uuid,
    product_name text,
    price numeric,
    quantity integer,
    line_total numeric
  );

  RETURN v_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_razorpay_pending_order(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_razorpay_pending_order(jsonb, jsonb)
  TO service_role;

-- Finalize captured payment and decrement stock exactly once in one transaction.
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

  IF v_order.status <> 'Pending' OR v_order.payment_status <> 'Pending' THEN
    RAISE EXCEPTION 'Only pending orders can be finalized' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.order_items WHERE order_id = v_order.id) THEN
    RAISE EXCEPTION 'Order has no stored items' USING ERRCODE = '23514';
  END IF;

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

-- Retire the old browser-callable finalizer from anon/authenticated users.
REVOKE EXECUTE ON FUNCTION public.confirm_paid_order(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_paid_order(text, jsonb)
  TO service_role;
