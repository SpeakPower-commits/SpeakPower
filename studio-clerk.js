(function () {
  "use strict";

  var clerkConfig = window.SPEAKPOWER_CLERK_CONFIG || {};
  var apiConfig = window.SPEAKPOWER_STUDIO_API || {};
  var clerk = null;
  var initialized = false;
  var productKey = new URLSearchParams(window.location.search).get("product") || "brand-story";

  var $ = function (id) { return document.getElementById(id); };
  var gate = $("authGate");
  var accountBar = $("accountBar");
  var accountEmail = $("studioAccountEmail");
  var trialCount = $("studioTrialCount");
  var trialText = $("studioTrialText");
  var authStatus = $("studioAuthStatus");
  var paymentPanel = $("paymentPanel");
  var paymentText = $("paymentText");
  var paymentStatus = $("studioPaymentStatus");
  var payButton = $("studioPayButton");
  var signOut = $("studioSignOut");
  var clerkSignIn = $("clerkSignIn");

  function setStatus(node, message, state) {
    if (!node) return;
    node.textContent = message || "";
    node.dataset.state = state || "";
  }

  function configured() {
    return !!(
      clerkConfig.publishableKey &&
      apiConfig.baseUrl &&
      !/REPLACE_ME|YOUR-/.test(clerkConfig.publishableKey + apiConfig.baseUrl)
    );
  }

  function setBuilderEnabled(enabled) {
    var button = $("generateBtn");
    if (button) button.disabled = !enabled;
    Array.prototype.forEach.call(
      document.querySelectorAll("#builderForm input, #builderForm textarea"),
      function (el) { el.disabled = !enabled; }
    );
  }

  function showSignedOut() {
    if (gate) gate.hidden = false;
    if (accountBar) accountBar.hidden = true;
    if (paymentPanel) paymentPanel.hidden = true;
    setBuilderEnabled(false);
  }

  function showSignedIn() {
    if (gate) gate.hidden = true;
    if (accountBar) accountBar.hidden = false;
    setBuilderEnabled(true);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.onload = resolve;
      script.onerror = function () { reject(new Error("Failed to load Clerk.")); };
      document.head.appendChild(script);
    });
  }

  async function loadClerk() {
    if (window.Clerk) return;

    var encoded = String(clerkConfig.publishableKey || "").split("_")[2];
    if (!encoded) throw new Error("Clerk Publishable Key is not configured.");
    var clerkDomain = atob(encoded).replace(/\$/, "");
    await loadScript("https://" + clerkDomain + "/npm/@clerk/ui@1/dist/ui.browser.js");
    await loadScript("https://" + clerkDomain + "/npm/@clerk/clerk-js@6/dist/clerk.browser.js");
  }

  async function api(path, options) {
    if (!clerk || !clerk.session) throw new Error("Please sign in first.");

    var token = await clerk.session.getToken();
    if (!token) throw new Error("Your sign-in session is not ready.");

    var opts = options || {};
    var headers = Object.assign({
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    }, opts.headers || {});

    var response = await fetch(String(apiConfig.baseUrl).replace(/\/$/, "") + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });

    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      throw new Error(data && data.error ? data.error : "Studio API request failed.");
    }
    return data;
  }

  async function refreshUsage() {
    if (!clerk || !clerk.user) return null;

    var usage = await api("/usage");
    var remaining = Number(usage.trials_remaining || 0);

    if (trialCount) trialCount.textContent = String(remaining);

    if (trialText) {
      trialText.textContent = remaining > 0
        ? remaining + " free Studio generation" + (remaining === 1 ? "" : "s") + " remaining."
        : "Your 3 free Studio generations are used. Pay for the next generation.";
    }

    if (paymentPanel) paymentPanel.hidden = remaining > 0;

    if (paymentText && remaining === 0) {
      paymentText.textContent = "Your three free generations are complete. Pay once for " +
        (document.getElementById("builderTitle")?.textContent || "this product") +
        " to unlock one generation.";
    }

    return usage;
  }

  async function reserveRun() {
    if (!clerk || !clerk.user) {
      showSignedOut();
      throw new Error("Please sign in with your email before generating.");
    }

    var result = await api("/reserve", {
      method: "POST",
      body: { product_key: productKey }
    });

    if (!result.allowed && result.run_type === "payment_required") {
      if (paymentPanel) paymentPanel.hidden = false;
      if (paymentText) {
        paymentText.textContent =
          result.title + " requires payment after the three free Studio generations. Price: UGX " +
          Number(result.amount_ugx || 0).toLocaleString("en-UG") + ".";
      }
      throw new Error("payment_required");
    }

    return result;
  }

  async function finishRun(runId, status) {
    if (!runId) return;
    try {
      await api("/finish", {
        method: "POST",
        body: { run_id: runId, status: status }
      });
    } finally {
      refreshUsage().catch(function () {});
    }
  }

  async function startPayment() {
    if (!clerk || !clerk.user) {
      showSignedOut();
      return;
    }

    if (payButton) payButton.disabled = true;
    setStatus(paymentStatus, "Opening secure Flutterwave checkout…", "working");

    try {
      var result = await api("/create-payment", {
        method: "POST",
        body: { product_key: productKey }
      });

      if (!result.payment_url) {
        throw new Error(result.error || "Payment checkout is not configured yet.");
      }

      window.location.href = result.payment_url;
    } catch (error) {
      setStatus(paymentStatus, error.message || "Could not start payment.", "error");
      if (payButton) payButton.disabled = false;
    }
  }

  async function checkPaymentReturn() {
    var params = new URLSearchParams(window.location.search);
    if (params.get("payment") !== "return") return;

    var txRef = params.get("tx_ref");
    if (!txRef || !clerk || !clerk.user) return;

    try {
      var result = await api("/payment-status", {
        method: "POST",
        body: { tx_ref: txRef }
      });

      if (result.paid) {
        setStatus(paymentStatus, "Payment confirmed. Your Studio credit is ready.", "success");
        await refreshUsage();
      } else {
        setStatus(paymentStatus, "Payment is still being confirmed. Refresh this page in a moment.", "working");
      }
    } catch (error) {
      setStatus(paymentStatus, error.message || "Payment verification failed.", "error");
    }
  }

  function syncUser(user) {
    if (user) {
      showSignedIn();
      if (accountEmail) {
        accountEmail.textContent =
          (user.primaryEmailAddress && user.primaryEmailAddress.emailAddress) ||
          user.username ||
          "Signed in";
      }
      setStatus(authStatus, "", "");
      refreshUsage()
        .then(checkPaymentReturn)
        .catch(function (error) {
          setStatus(authStatus, error.message || "Could not load Studio access.", "error");
        });
    } else {
      showSignedOut();
    }
  }

  async function init() {
    if (!configured()) {
      showSignedOut();
      setStatus(
        authStatus,
        "Clerk and the Cloudflare Studio API are not configured yet. Add the values in assets/clerk-config.js and assets/studio-api-config.js.",
        "error"
      );
      return;
    }

    try {
      await loadClerk();

      clerk = new window.Clerk(clerkConfig.publishableKey);
      await clerk.load({
        ui: { ClerkUI: window.__internal_ClerkUICtor },
        afterSignInUrl: window.location.href,
        afterSignUpUrl: window.location.href
      });

      initialized = true;

      if (clerk.addListener) {
        clerk.addListener(function (emission) {
          syncUser(emission && emission.user);
        });
      }

      if (clerk.isSignedIn && clerk.user) {
        syncUser(clerk.user);
      } else {
        showSignedOut();
      }

      if (!clerk.user && clerkSignIn) {
        clerk.mountSignIn(clerkSignIn, {
          routing: "hash"
        });
      }
    } catch (error) {
      showSignedOut();
      setStatus(authStatus, error.message || "Clerk could not initialize.", "error");
    }
  }

  if (signOut) {
    signOut.addEventListener("click", async function () {
      if (!clerk) return;
      await clerk.signOut();
      window.location.reload();
    });
  }

  if (payButton) payButton.addEventListener("click", startPayment);

  window.SpeakPowerStudioAccess = {
    reserveRun: reserveRun,
    finishRun: finishRun,
    refreshUsage: refreshUsage,
    startPayment: startPayment,
    getUser: function () { return clerk && clerk.user ? clerk.user : null; }
  };

  window.SpeakPowerStudioReady = init().then(function () {
    return initialized;
  });
})();
