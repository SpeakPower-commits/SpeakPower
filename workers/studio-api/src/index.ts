import { createClerkClient, verifyToken } from "@clerk/backend";
import { runPagespeedAudit } from "./pagespeed";

interface Env {
  DB: D1Database;
  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY: string;
  SITE_ORIGIN: string;
  SITE_URL: string;
  FLW_SECRET_KEY: string;
  FLW_SECRET_HASH: string;
  /** Google Cloud API key with the PageSpeed Insights API enabled. Optional:
   *  without it the SEO audit still returns SpeakPower's own technical checks,
   *  just no Lighthouse scores. */
  PAGESPEED_API_KEY?: string;
}

const PRODUCTS: Record<string, { title: string; amount: number }> = {
  "brand-story": { title: "Brand Story Builder", amount: 100000 },
  "seo-audit": { title: "Website SEO & Visibility Audit", amount: 75000 },
  "market-plan": { title: "Market Development Planner", amount: 125000 },
  "content-seo": { title: "SEO Content Starter", amount: 75000 },
  "data-story": { title: "Data Story Builder", amount: 100000 },
  "speaker-ready": { title: "Speaker Ready Pack", amount: 75000 }
};

function corsHeaders(env: Env) {
  return {
    "Access-Control-Allow-Origin": env.SITE_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin"
  };
}

function json(env: Env, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(env),
      "Content-Type": "application/json"
    }
  });
}

function noContent(env: Env) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(env)
  });
}

async function requireUser(request: Request, env: Env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) {
    throw new Response("Authentication required.", {
      status: 401,
      headers: corsHeaders(env)
    });
  }

  const token = header.slice(7).trim();
  if (!token) {
    throw new Response("Authentication required.", {
      status: 401,
      headers: corsHeaders(env)
    });
  }

  try {
    const verified = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
      authorizedParties: [env.SITE_ORIGIN]
    });

    if (!verified.sub) throw new Error("Missing Clerk user id.");

    await env.DB.prepare(
      "INSERT OR IGNORE INTO studio_users (clerk_user_id) VALUES (?)"
    ).bind(verified.sub).run();

    await env.DB.prepare(
      "UPDATE studio_users SET last_seen_at = CURRENT_TIMESTAMP WHERE clerk_user_id = ?"
    ).bind(verified.sub).run();

    return { userId: verified.sub };
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Invalid or expired session.", {
      status: 401,
      headers: corsHeaders(env)
    });
  }
}

function productFor(key: unknown) {
  const productKey = String(key || "").trim();
  const product = PRODUCTS[productKey];
  if (!product) return null;
  return { productKey, ...product };
}

async function usage(env: Env, userId: string) {
  const row = await env.DB.prepare(
    `
    SELECT
      (
        SELECT COUNT(*)
        FROM studio_runs
        WHERE clerk_user_id = ?
          AND run_type = 'trial'
          AND (
            status = 'completed'
            OR (status = 'reserved' AND reserved_until > CURRENT_TIMESTAMP)
          )
      ) AS trial_count,
      (
        SELECT COUNT(*)
        FROM studio_orders o
        WHERE o.clerk_user_id = ?
          AND o.status = 'paid'
          AND NOT EXISTS (
            SELECT 1
            FROM studio_runs r
            WHERE r.order_id = o.id
              AND r.status IN ('reserved','completed')
          )
      ) AS paid_credits
    `
  ).bind(userId, userId).first<{ trial_count: number; paid_credits: number }>();

  const trialCount = Number(row?.trial_count || 0);
  return {
    trial_count: trialCount,
    trials_remaining: Math.max(0, 3 - trialCount),
    paid_credits: Number(row?.paid_credits || 0)
  };
}

async function reserveRun(env: Env, userId: string, productKey: string) {
  const product = productFor(productKey);
  if (!product || !(await env.DB.prepare(
    "SELECT 1 FROM studio_products WHERE product_key = ? AND active = 1"
  ).bind(productKey).first())) {
    throw new Response("Studio product is not available.", {
      status: 400,
      headers: corsHeaders(env)
    });
  }

  const runId = crypto.randomUUID();

  const trial = await env.DB.prepare(
    `
    INSERT INTO studio_runs
      (id, clerk_user_id, product_key, run_type, status, created_at, reserved_until)
    SELECT ?, ?, ?, 'trial', 'reserved', CURRENT_TIMESTAMP, datetime('now', '+15 minutes')
    WHERE (
      SELECT COUNT(*)
      FROM studio_runs
      WHERE clerk_user_id = ?
        AND run_type = 'trial'
        AND (
          status = 'completed'
          OR (status = 'reserved' AND reserved_until > CURRENT_TIMESTAMP)
        )
    ) < 3
    RETURNING id
    `
  ).bind(runId, userId, productKey, userId).first<{ id: string }>();

  if (trial?.id) {
    const current = await usage(env, userId);
    return {
      allowed: true,
      run_id: trial.id,
      run_type: "trial",
      trials_remaining: current.trials_remaining
    };
  }

  const paidRunId = crypto.randomUUID();
  const paid = await env.DB.prepare(
    `
    INSERT INTO studio_runs
      (id, clerk_user_id, product_key, run_type, status, order_id, created_at, reserved_until)
    SELECT ?, ?, ?, 'paid', 'reserved', o.id, CURRENT_TIMESTAMP, datetime('now', '+15 minutes')
    FROM studio_orders o
    WHERE o.clerk_user_id = ?
      AND o.product_key = ?
      AND o.status = 'paid'
      AND NOT EXISTS (
        SELECT 1
        FROM studio_runs existing
        WHERE existing.order_id = o.id
          AND (
            existing.status = 'completed'
            OR (existing.status = 'reserved' AND existing.reserved_until > CURRENT_TIMESTAMP)
          )
      )
    ORDER BY o.paid_at ASC, o.created_at ASC
    LIMIT 1
    RETURNING id, order_id
    `
  ).bind(paidRunId, userId, productKey, userId, productKey)
    .first<{ id: string; order_id: string }>();

  if (paid?.id) {
    return {
      allowed: true,
      run_id: paid.id,
      run_type: "paid",
      trials_remaining: 0
    };
  }

  return {
    allowed: false,
    run_type: "payment_required",
    product_key: productKey,
    title: product.title,
    amount_ugx: product.amount
  };
}

async function finishRun(env: Env, userId: string, runId: string, status: "completed" | "failed") {
  const result = await env.DB.prepare(
    `
    UPDATE studio_runs
    SET status = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND clerk_user_id = ?
      AND status = 'reserved'
    `
  ).bind(status, runId, userId).run();

  return { ok: Number(result.meta.changes || 0) === 1 };
}

async function createPayment(env: Env, request: Request, userId: string, productKey: string) {
  const product = productFor(productKey);
  if (!product) return json(env, { error: "Unknown Studio product." }, 400);

  const clerk = createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY
  });
  const user = await clerk.users.getUser(userId);
  const email = user.primaryEmailAddress?.emailAddress;

  if (!email) return json(env, { error: "Your Clerk account has no email address." }, 400);

  const existing = await env.DB.prepare(
    `
    SELECT id, tx_ref, checkout_url
    FROM studio_orders
    WHERE clerk_user_id = ?
      AND product_key = ?
      AND status = 'pending'
      AND created_at >= datetime('now', '-20 minutes')
    ORDER BY created_at DESC
    LIMIT 1
    `
  ).bind(userId, productKey).first<{ id: string; tx_ref: string; checkout_url: string | null }>();

  if (existing?.checkout_url) {
    return json(env, {
      payment_url: existing.checkout_url,
      tx_ref: existing.tx_ref,
      order_id: existing.id
    });
  }

  const orderId = crypto.randomUUID();
  const txRef = "SP-" + crypto.randomUUID();

  await env.DB.prepare(
    `
    INSERT INTO studio_orders
      (id, clerk_user_id, product_key, amount_ugx, currency, tx_ref, status)
    VALUES (?, ?, ?, ?, 'UGX', ?, 'pending')
    `
  ).bind(orderId, userId, productKey, product.amount, txRef).run();

  const checkout = await fetch("https://api.flutterwave.com/v3/payments", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.FLW_SECRET_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      tx_ref: txRef,
      amount: product.amount,
      currency: "UGX",
      redirect_url: `${env.SITE_URL}/studio-product.html?product=${encodeURIComponent(productKey)}&payment=return&tx_ref=${encodeURIComponent(txRef)}`,
      customer: {
        email,
        name: user.fullName || user.firstName || email.split("@")[0]
      },
      customizations: {
        title: "SpeakPower Studio",
        description: `${product.title} — one Studio generation`,
        logo: `${env.SITE_URL}/assets/logo-mark.png`
      },
      meta: {
        product_key: productKey,
        clerk_user_id: userId,
        order_id: orderId
      }
    })
  });

  const data = await checkout.json().catch(() => ({})) as any;

  if (!checkout.ok || data?.status !== "success" || !data?.data?.link) {
    await env.DB.prepare(
      "UPDATE studio_orders SET status = 'failed', provider_payload = ? WHERE id = ?"
    ).bind(JSON.stringify(data), orderId).run();

    return json(env, {
      error: "Flutterwave could not start the payment."
    }, 502);
  }

  await env.DB.prepare(
    "UPDATE studio_orders SET checkout_url = ? WHERE id = ?"
  ).bind(data.data.link, orderId).run();

  return json(env, {
    payment_url: data.data.link,
    tx_ref: txRef,
    order_id: orderId
  });
}

async function paymentStatus(env: Env, userId: string, txRef: string) {
  const order = await env.DB.prepare(
    `
    SELECT status, product_key, amount_ugx, currency, paid_at, flutterwave_transaction_id
    FROM studio_orders
    WHERE clerk_user_id = ?
      AND tx_ref = ?
    LIMIT 1
    `
  ).bind(userId, txRef).first<{
    status: string;
    product_key: string;
    amount_ugx: number;
    currency: string;
    paid_at: string | null;
    flutterwave_transaction_id: string | null;
  }>();

  if (!order) return json(env, { error: "Payment reference not found." }, 404);

  return json(env, {
    status: order.status,
    paid: order.status === "paid",
    product_key: order.product_key,
    amount_ugx: order.amount_ugx,
    currency: order.currency,
    paid_at: order.paid_at,
    flutterwave_transaction_id: order.flutterwave_transaction_id
  });
}

async function handleWebhook(env: Env, request: Request) {
  if (request.method !== "POST") return new Response("ok", { status: 200 });

  const signature = request.headers.get("verif-hash");
  if (!signature || signature !== env.FLW_SECRET_HASH) {
    return new Response("Invalid signature.", { status: 401 });
  }

  const payload = await request.json().catch(() => null) as any;
  const data = payload?.data || {};
  const txRef = String(data.tx_ref || "").trim();
  const transactionId = String(data.id || "").trim();

  if (!txRef || !transactionId) {
    return new Response("Incomplete payment event.", { status: 400 });
  }

  const order = await env.DB.prepare(
    "SELECT * FROM studio_orders WHERE tx_ref = ? LIMIT 1"
  ).bind(txRef).first<any>();

  if (!order) return new Response("ok", { status: 200 });
  if (order.status === "paid") return new Response("ok", { status: 200 });

  const verification = await fetch(
    `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`,
    {
      headers: {
        "Authorization": `Bearer ${env.FLW_SECRET_KEY}`
      }
    }
  );

  const result = await verification.json().catch(() => ({})) as any;
  const payment = result?.data;

  const valid =
    verification.ok &&
    result?.status === "success" &&
    payment?.status === "successful" &&
    String(payment?.tx_ref || "") === txRef &&
    String(payment?.currency || "") === "UGX" &&
    Number(payment?.amount || 0) >= Number(order.amount_ugx || 0);

  if (!valid) return new Response("ok", { status: 200 });

  await env.DB.prepare(
    `
    UPDATE studio_orders
    SET status = 'paid',
        flutterwave_transaction_id = ?,
        provider_payload = ?,
        paid_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status <> 'paid'
    `
  ).bind(transactionId, JSON.stringify(result), order.id).run();

  return new Response("ok", { status: 200 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return noContent(env);

    try {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return json(env, { ok: true, service: "speakpower-studio-api" });
      }

      if (url.pathname === "/webhooks/flutterwave") {
        return handleWebhook(env, request);
      }

      const { userId } = await requireUser(request, env);

      if (request.method === "GET" && url.pathname === "/usage") {
        return json(env, await usage(env, userId));
      }

      if (request.method === "POST" && url.pathname === "/reserve") {
        const body = await request.json().catch(() => ({})) as any;
        const result = await reserveRun(env, userId, body.product_key);
        return json(env, result);
      }

      if (request.method === "POST" && url.pathname === "/finish") {
        const body = await request.json().catch(() => ({})) as any;
        const runId = String(body.run_id || "");
        const status = body.status === "completed" || body.status === "failed"
          ? body.status
          : null;

        if (!runId || !status) {
          return json(env, { error: "run_id and valid status are required." }, 400);
        }

        return json(env, await finishRun(env, userId, runId, status));
      }

      if (request.method === "POST" && url.pathname === "/create-payment") {
        const body = await request.json().catch(() => ({})) as any;
        return createPayment(env, request, userId, String(body.product_key || ""));
      }

      if (request.method === "POST" && url.pathname === "/pagespeed") {
        const body = await request.json().catch(() => ({})) as any;
        try {
          const result = await runPagespeedAudit(env, body.url);
          return json(env, result);
        } catch (error) {
          // A bad address or an unreachable page is the customer's problem to
          // correct, not a server fault — 400 so the client shows the message
          // and marks the run failed rather than consuming it.
          return json(env, {
            error: error instanceof Error ? error.message : "The audit could not run."
          }, 400);
        }
      }

      if (request.method === "POST" && url.pathname === "/payment-status") {
        const body = await request.json().catch(() => ({})) as any;
        const txRef = String(body.tx_ref || "").trim();
        if (!txRef) return json(env, { error: "tx_ref is required." }, 400);
        return paymentStatus(env, userId, txRef);
      }

      return json(env, { error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof Response) return error;
      console.error(error);
      return json(env, {
        error: error instanceof Error ? error.message : "Studio API request failed."
      }, 500);
    }
  }
};
