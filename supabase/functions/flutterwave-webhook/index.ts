import { createClient } from "npm:@supabase/supabase-js@2";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function serviceKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.default) return parsed.default;
    } catch (_) {}
  }
  throw new Error("Supabase server key is not configured.");
}

async function validSignature(req: Request, rawBody: string) {
  const secretHash = Deno.env.get("FLW_SECRET_HASH");
  if (!secretHash) return false;

  const legacy = req.headers.get("verif-hash");
  if (legacy && legacy === secretHash) return true;

  const current = req.headers.get("flutterwave-signature");
  if (!current) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretHash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const encoded = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return encoded === current;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: true });

  try {
    const rawBody = await req.text();
    if (!(await validSignature(req, rawBody))) {
      return json({ error: "Invalid webhook signature." }, 401);
    }

    const flwSecret = Deno.env.get("FLW_SECRET_KEY");
    if (!flwSecret) return json({ error: "Flutterwave secret is not configured." }, 503);

    const payload = JSON.parse(rawBody);
    const data = payload?.data || {};
    const txRef = String(data.tx_ref || "").trim();
    const transactionId = data.id;

    if (!txRef || !transactionId) return json({ error: "Incomplete payment event." }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceKey(),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { data: order, error: orderError } = await supabase
      .from("studio_orders")
      .select("*")
      .eq("tx_ref", txRef)
      .maybeSingle();

    if (orderError) throw orderError;
    if (!order) return json({ error: "Order not found." }, 404);
    if (order.status === "paid") return json({ ok: true });

    const verifyResponse = await fetch("https://api.flutterwave.com/v3/transactions/" + encodeURIComponent(String(transactionId)) + "/verify", {
      headers: { "Authorization": "Bearer " + flwSecret },
    });
    const verified = await verifyResponse.json().catch(() => ({}));
    const payment = verified?.data;

    const valid =
      verifyResponse.ok &&
      verified?.status === "success" &&
      payment?.status === "successful" &&
      String(payment?.tx_ref || "") === txRef &&
      String(payment?.currency || "") === "UGX" &&
      Number(payment?.amount || 0) >= Number(order.amount_ugx);

    if (!valid) {
      await supabase.from("studio_orders").update({
        status: "failed",
        flutterwave_transaction_id: String(transactionId),
        provider_payload: verified,
      }).eq("id", order.id).neq("status", "paid");

      return json({ ok: true, accepted: false });
    }

    const { error: paidError } = await supabase
      .from("studio_orders")
      .update({
        status: "paid",
        flutterwave_transaction_id: String(transactionId),
        provider_payload: verified,
        paid_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .neq("status", "paid");

    if (paidError) throw paidError;

    const { error: entitlementError } = await supabase
      .from("studio_entitlements")
      .upsert({
        user_id: order.user_id,
        product_key: order.product_key,
        order_id: order.id,
        remaining_uses: 1,
      }, { onConflict: "order_id", ignoreDuplicates: true });

    if (entitlementError) throw entitlementError;

    return json({ ok: true, accepted: true });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Webhook processing failed." }, 500);
  }
});
