import { createClient } from "npm:@supabase/supabase-js@2";

const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": Deno.env.get("SPEAKPOWER_SITE_URL") || origin || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
});

function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), { status, headers: cors(origin) });
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

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });

  try {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return json({ error: "Authentication required." }, 401, origin);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceKey(),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    const user = userData.user;
    if (userError || !user) return json({ error: "Invalid session." }, 401, origin);

    const body = await req.json().catch(() => ({}));
    const txRef = String(body.tx_ref || "").trim();
    if (!txRef) return json({ error: "tx_ref is required." }, 400, origin);

    const { data: order, error: orderError } = await supabase
      .from("studio_orders")
      .select("id,product_key,amount_ugx,currency,tx_ref,status,paid_at,flutterwave_transaction_id")
      .eq("user_id", user.id)
      .eq("tx_ref", txRef)
      .maybeSingle();

    if (orderError) throw orderError;
    if (!order) return json({ error: "Payment reference not found." }, 404, origin);

    return json({
      status: order.status,
      paid: order.status === "paid",
      product_key: order.product_key,
      amount_ugx: order.amount_ugx,
      currency: order.currency,
      paid_at: order.paid_at,
      flutterwave_transaction_id: order.flutterwave_transaction_id,
    }, 200, origin);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Payment status check failed." }, 500, origin);
  }
});
