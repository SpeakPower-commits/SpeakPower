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

const PRODUCTS: Record<string, { title: string; amount: number }> = {
  "brand-story": { title: "Brand Story Builder", amount: 100000 },
  "seo-audit": { title: "Website SEO & Visibility Audit", amount: 75000 },
  "market-plan": { title: "Market Development Planner", amount: 125000 },
  "content-seo": { title: "SEO Content Starter", amount: 75000 },
  "data-story": { title: "Data Story Builder", amount: 100000 },
  "speaker-ready": { title: "Speaker Ready Pack", amount: 75000 },
};

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });

  try {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return json({ error: "Authentication required." }, 401, origin);

    const flwSecret = Deno.env.get("FLW_SECRET_KEY");
    const siteUrl = Deno.env.get("SPEAKPOWER_SITE_URL");
    if (!flwSecret || !siteUrl) {
      return json({ error: "Payment service is not configured yet." }, 503, origin);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceKey(),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    const user = userData.user;
    if (userError || !user) return json({ error: "Invalid session." }, 401, origin);

    const body = await req.json().catch(() => ({}));
    const productKey = String(body.product_key || "").trim();
    const product = PRODUCTS[productKey];
    if (!product) return json({ error: "Unknown Studio product." }, 400, origin);

    const txRef = "SP-" + crypto.randomUUID();

    const { data: order, error: orderError } = await supabase
      .from("studio_orders")
      .insert({
        user_id: user.id,
        product_key: productKey,
        amount_ugx: product.amount,
        currency: "UGX",
        tx_ref: txRef,
        status: "pending",
      })
      .select("id,tx_ref,amount_ugx")
      .single();

    if (orderError) throw orderError;

    const paymentPayload = {
      tx_ref: txRef,
      amount: product.amount,
      currency: "UGX",
      redirect_url: siteUrl + "/studio-product.html?product=" + encodeURIComponent(productKey) + "&payment=return&tx_ref=" + encodeURIComponent(txRef),
      customer: {
        email: user.email,
        name: user.user_metadata?.full_name || user.email?.split("@")[0] || "SpeakPower customer",
      },
      customizations: {
        title: "SpeakPower Studio",
        description: product.title + " — one Studio generation",
        logo: siteUrl + "/assets/logo-mark.png",
      },
      meta: {
        product_key: productKey,
        user_id: user.id,
        order_id: order.id,
      },
    };

    const flwResponse = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + flwSecret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(paymentPayload),
    });

    const flw = await flwResponse.json().catch(() => ({}));

    if (!flwResponse.ok || flw?.status !== "success" || !flw?.data?.link) {
      await supabase.from("studio_orders").update({
        status: "failed",
        provider_payload: flw,
      }).eq("id", order.id);
      return json({ error: "Flutterwave could not start the payment.", details: flw?.message || null }, 502, origin);
    }

    return json({
      payment_url: flw.data.link,
      tx_ref: txRef,
      order_id: order.id,
    }, 200, origin);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Payment creation failed." }, 500, origin);
  }
});
