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
    if (userError || !userData.user) return json({ error: "Invalid session." }, 401, origin);

    const payload = await req.json().catch(() => ({}));
    const action = payload.action || "usage";

    if (action === "usage") {
      const { data, error } = await supabase.rpc("studio_usage", {
        p_user_id: userData.user.id,
      }).schema("studio_private");

      if (error) throw error;
      return json(data, 200, origin);
    }

    if (action === "reserve") {
      const productKey = String(payload.product_key || "").trim();
      if (!productKey) return json({ error: "product_key is required." }, 400, origin);

      const { data, error } = await supabase.rpc("reserve_run", {
        p_user_id: userData.user.id,
        p_product_key: productKey,
      }).schema("studio_private");

      if (error) throw error;
      return json(data, 200, origin);
    }

    if (action === "finish") {
      const runId = String(payload.run_id || "").trim();
      const status = String(payload.status || "").trim();
      if (!runId || !["completed", "failed"].includes(status)) {
        return json({ error: "run_id and a valid status are required." }, 400, origin);
      }

      const { data, error } = await supabase.rpc("finish_run", {
        p_user_id: userData.user.id,
        p_run_id: runId,
        p_status: status,
      }).schema("studio_private");

      if (error) throw error;
      return json({ ok: Boolean(data) }, 200, origin);
    }

    return json({ error: "Unknown action." }, 400, origin);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Studio access request failed." }, 500, origin);
  }
});
