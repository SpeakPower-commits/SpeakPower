(function () {
  "use strict";

  var config = window.SPEAKPOWER_SUPABASE_CONFIG || {};
  var supabaseClient = null;
  var productKey = new URLSearchParams(window.location.search).get("product") || "brand-story";
  var state = { user: null, usage: null };

  var $ = function (id) { return document.getElementById(id); };

  var gate = $("authGate");
  var accountBar = $("accountBar");
  var authForm = $("authForm");
  var emailInput = $("studioEmail");
  var authSubmit = $("studioAuthSubmit");
  var authStatus = $("studioAuthStatus");
  var accountEmail = $("studioAccountEmail");
  var signOut = $("studioSignOut");
  var trialCount = $("studioTrialCount");
  var trialText = $("studioTrialText");
  var paymentPanel = $("paymentPanel");
  var paymentText = $("paymentText");
  var payButton = $("studioPayButton");
  var paymentStatus = $("studioPaymentStatus");

  var productPrices = {
    "brand-story": 100000,
    "seo-audit": 75000,
    "market-plan": 125000,
    "content-seo": 75000,
    "data-story": 100000,
    "speaker-ready": 75000
  };

  function money(n) {
    return "UGX " + Number(n || 0).toLocaleString("en-UG");
  }

  function setStatus(el, message, type) {
    if (!el) return;
    el.textContent = message || "";
    el.dataset.state = type || "";
  }

  function configured() {
    return !!(
      window.supabase &&
      config.url &&
      config.publishableKey &&
      !/YOUR_PROJECT_REF|REPLACE_ME/.test(config.url + config.publishableKey)
    );
  }

  function setBuilderEnabled(enabled) {
    var btn = $("generateBtn");
    if (btn) btn.disabled = !enabled;
    if (formDisabledState(enabled)) return;
    Array.prototype.forEach.call(document.querySelectorAll("#builderForm input, #builderForm textarea"), function (el) {
      el.disabled = !enabled;
    });
  }

  function formDisabledState() {
    return !gate || gate.hidden !== true;
  }

  function showAuthed() {
    if (gate) gate.hidden = true;
    if (accountBar) accountBar.hidden = false;
    setBuilderEnabled(true);
  }

  function showGate() {
    if (gate) gate.hidden = false;
    if (accountBar) accountBar.hidden = true;
    setBuilderEnabled(false);
  }

  async function callAccess(action, payload) {
    if (!supabaseClient) throw new Error("Studio sign-in is not configured yet.");
    var body = Object.assign({ action: action }, payload || {});
    var result = await supabaseClient.functions.invoke("studio-access", { body: body });
    if (result.error) throw result.error;
    if (result.data && result.data.error) throw new Error(result.data.error);
    return result.data;
  }

  async function refreshUsage() {
    if (!state.user) return null;
    var usage = await callAccess("usage");
    state.usage = usage || {};
    var remaining = Number(state.usage.trials_remaining || 0);
    if (trialCount) trialCount.textContent = String(remaining);
    if (trialText) {
      trialText.textContent = remaining > 0
        ? remaining + " free Studio generation" + (remaining === 1 ? "" : "s") + " remaining."
        : "Your 3 free Studio generations are used. Pay for the next generation.";
    }
    if (paymentPanel) paymentPanel.hidden = remaining > 0;
    return usage;
  }

  async function initAuth() {
    if (!configured()) {
      showGate();
      setStatus(authStatus, "Studio sign-in is not configured yet. The Supabase project details still need to be added to assets/supabase-config.js.", "error");
      if (authSubmit) authSubmit.disabled = true;
      return;
    }

    supabaseClient = window.supabase.createClient(config.url, config.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });

    window.SpeakPowerStudioSupabase = supabaseClient;

    supabaseClient.auth.onAuthStateChange(function (_event, session) {
      state.user = session && session.user ? session.user : null;

      if (state.user) {
        showAuthed();
        if (accountEmail) accountEmail.textContent = state.user.email || "Signed in";
        setStatus(authStatus, "", "");
        refreshUsage().catch(function (err) {
          setStatus(authStatus, err.message || "Could not load Studio usage.", "error");
        });
      } else {
        showGate();
      }
    });

    var current = await supabaseClient.auth.getSession();
    state.user = current.data && current.data.session ? current.data.session.user : null;

    if (state.user) {
      showAuthed();
      if (accountEmail) accountEmail.textContent = state.user.email || "Signed in";
      await refreshUsage();
      await checkPaymentReturn();
    } else {
      showGate();
    }
  }

  if (authForm) {
    authForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (!supabaseClient || !configured()) return;

      var email = String(emailInput && emailInput.value || "").trim();
      if (!email) {
        setStatus(authStatus, "Enter your email address first.", "error");
        return;
      }

      authSubmit.disabled = true;
      setStatus(authStatus, "Sending your secure sign-in link…", "working");

      try {
        var result = await supabaseClient.auth.signInWithOtp({
          email: email,
          options: { emailRedirectTo: window.location.href }
        });
        if (result.error) throw result.error;
        setStatus(authStatus, "Check your email. Open the SpeakPower sign-in link, then return here.", "success");
      } catch (err) {
        setStatus(authStatus, err.message || "We could not send the sign-in link.", "error");
      } finally {
        authSubmit.disabled = false;
      }
    });
  }

  if (signOut) {
    signOut.addEventListener("click", async function () {
      if (!supabaseClient) return;
      await supabaseClient.auth.signOut();
      window.location.reload();
    });
  }

  async function reserveRun() {
    if (!state.user) {
      showGate();
      throw new Error("Please sign in with your email before generating a Studio product.");
    }

    var data = await callAccess("reserve", { product_key: productKey });

    if (!data.allowed && data.run_type === "payment_required") {
      if (paymentPanel) paymentPanel.hidden = false;
      if (paymentText) {
        paymentText.textContent = data.title + " requires payment after the three free Studio generations. Price: " + money(data.amount_ugx || productPrices[productKey]) + ".";
      }
      throw new Error("payment_required");
    }

    return data;
  }

  async function finishRun(runId, status) {
    if (!runId) return;
    try {
      await callAccess("finish", { run_id: runId, status: status });
    } finally {
      refreshUsage().catch(function () {});
    }
  }

  async function startPayment() {
    if (!supabaseClient || !state.user) {
      showGate();
      return;
    }

    if (payButton) payButton.disabled = true;
    setStatus(paymentStatus, "Opening secure checkout…", "working");

    try {
      var result = await supabaseClient.functions.invoke("studio-create-payment", {
        body: { product_key: productKey }
      });
      if (result.error) throw result.error;
      if (!result.data || !result.data.payment_url) throw new Error((result.data && result.data.error) || "Payment checkout is not configured yet.");

      window.location.href = result.data.payment_url;
    } catch (err) {
      setStatus(paymentStatus, err.message || "Could not start the payment.", "error");
      if (payButton) payButton.disabled = false;
    }
  }

  async function checkPaymentReturn() {
    var params = new URLSearchParams(window.location.search);
    if (params.get("payment") !== "return") return;

    var txRef = params.get("tx_ref");
    if (!txRef || !supabaseClient || !state.user) return;

    try {
      var result = await supabaseClient.functions.invoke("studio-payment-status", {
        body: { tx_ref: txRef }
      });
      if (result.error) throw result.error;

      if (result.data && result.data.paid) {
        setStatus(paymentStatus, "Payment confirmed. Your " + result.data.product_key + " Studio credit is ready.", "success");
        await refreshUsage();
      } else {
        setStatus(paymentStatus, "Payment is still being confirmed. Refresh this page in a moment.", "working");
      }
    } catch (err) {
      setStatus(paymentStatus, err.message || "We could not verify the payment return.", "error");
    }
  }

  window.SpeakPowerStudioAccess = {
    reserveRun: reserveRun,
    finishRun: finishRun,
    refreshUsage: refreshUsage,
    startPayment: startPayment,
    getUser: function () { return state.user; }
  };

  if (payButton) payButton.addEventListener("click", startPayment);

  window.SpeakPowerStudioReady = initAuth();

})();