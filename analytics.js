/* ==========================================================================
   SpeakPower — Google Analytics 4, with consent
   Loaded on every page, straight after site-config.js. No dependencies.

   Consent Mode v2, advanced:
   - Until the visitor chooses, and after "Decline", Google Analytics stores
     nothing on the device. Google receives only cookieless pings (no client
     id), which it uses to model totals.
   - "Accept" grants analytics storage only. Advertising storage, ad user
     data and ad personalisation stay denied, always; Google signals and ad
     personalisation are switched off in the tag too.
   - The choice is kept in this browser (localStorage "sp_consent") and can be
     changed any time from "Cookie settings" at the foot of each page.

   Privacy rules this file enforces:
   - Addresses are scrubbed before they leave: the query string and the hash
     are dropped, except ?product= and ?service= (which page a visitor is on).
     Payment references, sign-in returns, audit ids and "next" links never go.
   - A referrer from another site is reduced to its origin.
   - Event parameters are filtered: short strings, numbers and true/false only;
     anything that looks like an email address or a phone number is dropped.
     No user id, name, email, question text or answer is ever sent.

   Off entirely while SP_CONFIG.gaMeasurementId is empty: no banner, no tag.

   Public API (window.SPAnalytics), safe to call whether or not GA is on:
     track(name, params, { beforeLeave })  → Promise<boolean>
     ids()        → Promise<{ clientId, sessionId } | null>, granted only
     consent()    → "granted" | "denied" | null
     openSettings()
   ========================================================================== */

(function () {
  "use strict";

  var CONFIG = window.SP_CONFIG || {};
  var ID = String(CONFIG.gaMeasurementId || "").trim();
  var ENABLED = /^G-[A-Z0-9]{4,20}$/.test(ID);
  var STORE_KEY = "sp_consent";
  var CONSENT_VERSION = 1;
  // URL parameters that only say which page a visitor is on.
  var KEEP_PARAMS = ["product", "service"];

  function readChoice() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(STORE_KEY) || "null");
      if (saved && saved.v === CONSENT_VERSION && (saved.choice === "granted" || saved.choice === "denied")) {
        return saved.choice;
      }
    } catch (e) { /* storage blocked or unreadable: ask again */ }
    return null;
  }
  var choice = readChoice();

  function saveChoice(value) {
    choice = value;
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ v: CONSENT_VERSION, choice: value, at: new Date().toISOString().slice(0, 10) }));
    } catch (e) { /* kept for this page only */ }
  }

  /* ---------------------------------------------------------- addresses */

  function scrubUrl(href) {
    var u;
    try { u = new URL(href, window.location.href); } catch (e) { return ""; }
    var kept = [];
    KEEP_PARAMS.forEach(function (name) {
      var value = (u.searchParams.get(name) || "").trim().toLowerCase();
      if (/^[a-z0-9-]{1,40}$/.test(value)) kept.push(name + "=" + value);
    });
    return u.origin + u.pathname + (kept.length ? "?" + kept.join("&") : "");
  }

  function scrubReferrer(ref) {
    if (!ref) return "";
    var u;
    try { u = new URL(ref); } catch (e) { return ""; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    // Our own pages: scrubbed like page addresses. Anyone else's: the site
    // only, which is all that source attribution needs (a payment page's
    // address, for one, carries its reference in the path).
    return u.origin === window.location.origin ? scrubUrl(ref) : u.origin + "/";
  }

  /* ------------------------------------------------------------- params */

  var KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
  var EMAIL_RE = /@/;
  var PHONE_RE = /\d[\d\s-]{6,}\d/;

  function cleanValue(value) {
    if (typeof value === "number") return isFinite(value) ? value : undefined;
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return undefined;
    var text = value.replace(/\s+/g, " ").trim().slice(0, 100);
    if (!text || EMAIL_RE.test(text) || PHONE_RE.test(text)) return undefined;
    return text;
  }

  function cleanFlat(obj) {
    var out = {};
    if (!obj || typeof obj !== "object") return out;
    Object.keys(obj).forEach(function (key) {
      if (!KEY_RE.test(key)) return;
      var v = cleanValue(obj[key]);
      if (v !== undefined) out[key] = v;
    });
    return out;
  }

  function cleanParams(params) {
    var out = cleanFlat(params);
    if (params && Array.isArray(params.items)) {
      out.items = params.items.slice(0, 10).map(cleanFlat).filter(function (item) {
        return item.item_id || item.item_name;
      });
      if (!out.items.length) delete out.items;
    }
    return out;
  }

  /* ---------------------------------------------------------------- tag */

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }

  function setLocation() {
    gtag("set", { page_location: scrubUrl(window.location.href) });
  }

  if (ENABLED) {
    window.gtag = window.gtag || gtag;
    // Before anything else reaches Google: the defaults, from the saved choice.
    gtag("consent", "default", {
      analytics_storage: choice === "granted" ? "granted" : "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      functionality_storage: "denied",
      personalization_storage: "denied",
      security_storage: "granted"
    });
    gtag("set", "ads_data_redaction", true);
    gtag("set", "url_passthrough", false);
    gtag("js", new Date());
    gtag("set", { page_location: scrubUrl(window.location.href), page_referrer: scrubReferrer(document.referrer) });
    gtag("config", ID, {
      page_location: scrubUrl(window.location.href),
      page_referrer: scrubReferrer(document.referrer),
      allow_google_signals: false,
      allow_ad_personalization_signals: false
    });

    // Pages that rewrite their own address (a payment return, a reopened
    // audit) keep Google's copy scrubbed too.
    ["pushState", "replaceState"].forEach(function (method) {
      var original = window.history && window.history[method];
      if (typeof original !== "function") return;
      window.history[method] = function () {
        var result = original.apply(this, arguments);
        setLocation();
        return result;
      };
    });
    window.addEventListener("popstate", setLocation);
    window.addEventListener("hashchange", setLocation);

    var tag = document.createElement("script");
    tag.async = true;
    tag.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(ID);
    document.head.appendChild(tag);
  }

  function track(name, params, opts) {
    if (!ENABLED || typeof name !== "string" || !KEY_RE.test(name)) return Promise.resolve(false);
    var clean = cleanParams(params);
    if (!(opts && opts.beforeLeave)) {
      gtag("event", name, clean);
      return Promise.resolve(true);
    }
    // The page is about to leave (a checkout): wait until Google has the
    // event, or give up quickly, whichever comes first.
    return new Promise(function (resolve) {
      var settled = false;
      function done(sent) { if (!settled) { settled = true; resolve(sent); } }
      var timer = window.setTimeout(function () { done(false); }, 800);
      clean.event_callback = function () { window.clearTimeout(timer); done(true); };
      clean.event_timeout = 800;
      gtag("event", name, clean);
    });
  }

  // GA's own anonymous ids, for the Worker to report a settled payment.
  // Only after "Accept"; null when declined, undecided, blocked or slow.
  function ids() {
    if (!ENABLED || choice !== "granted") return Promise.resolve(null);
    return new Promise(function (resolve) {
      var out = {};
      var waiting = 2;
      var settled = false;
      function done() {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(out.clientId ? out : null);
      }
      var timer = window.setTimeout(done, 1500);
      gtag("get", ID, "client_id", function (value) {
        if (typeof value === "string" && /^\d{1,20}\.\d{1,20}$/.test(value)) out.clientId = value;
        if (--waiting === 0) done();
      });
      gtag("get", ID, "session_id", function (value) {
        if (value != null && /^\d{1,20}$/.test(String(value))) out.sessionId = String(value);
        if (--waiting === 0) done();
      });
    });
  }

  /* ------------------------------------------------------------- banner */

  var banner = null;
  var returnFocus = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function injectStyles() {
    if (document.getElementById("sp-consent-style")) return;
    var style = document.createElement("style");
    style.id = "sp-consent-style";
    style.textContent = [
      ".sp-consent{position:fixed;z-index:2147483000;left:50%;bottom:calc(16px + env(safe-area-inset-bottom, 0px));transform:translateX(-50%);",
      "width:min(720px,calc(100% - 32px));box-sizing:border-box;margin:0;padding:18px 20px;",
      "background:#0a1020;color:#faf7f0;border:1px solid rgba(201,162,39,.45);border-radius:16px;",
      "box-shadow:0 18px 44px -18px rgba(10,16,32,.6);font:15px/1.55 \"Work Sans\",-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,Arial,sans-serif;",
      "display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center}",
      ".sp-consent[hidden]{display:none}",
      ".sp-consent-text{flex:1 1 320px;margin:0;color:#d9dce4}",
      ".sp-consent-text strong{display:block;color:#f1d47a;font-family:Fraunces,Georgia,serif;font-weight:600;font-size:1.05rem;margin-bottom:2px}",
      ".sp-consent-actions{display:flex;gap:10px;flex:0 0 auto}",
      ".sp-consent-btn{min-height:44px;min-width:108px;padding:10px 18px;border-radius:999px;cursor:pointer;",
      "border:1px solid #c9a227;font-family:inherit;font-size:.95rem;font-weight:600;line-height:1}",
      ".sp-consent-accept{background:linear-gradient(180deg,#f1d47a,#c9a227 70%);color:#0a1020}",
      ".sp-consent-decline{background:transparent;color:#faf7f0}",
      ".sp-consent-btn:focus-visible{outline:3px solid #f1d47a;outline-offset:3px}",
      ".sp-consent-btn[aria-pressed=true]::before{content:\"\\2713\\00a0\"}",
      "@media (max-width:520px){.sp-consent{padding:16px}.sp-consent-actions{width:100%}.sp-consent-btn{flex:1}}",
      ".sp-cookie-link{background:none;border:0;padding:0;margin:0 0 0 .75em;font:inherit;color:inherit;",
      "text-decoration:underline;text-underline-offset:3px;cursor:pointer;opacity:.85}",
      ".sp-cookie-link:hover,.sp-cookie-link:focus-visible{opacity:1}",
      "@media (forced-colors:active){.sp-consent{border:2px solid CanvasText}.sp-consent-btn{border:2px solid ButtonText}}"
    ].join("");
    document.head.appendChild(style);
  }

  function buildBanner() {
    injectStyles();
    banner = el("section", "sp-consent");
    banner.setAttribute("aria-label", "Cookie choice");
    banner.id = "spConsent";
    var text = el("p", "sp-consent-text");
    text.appendChild(el("strong", null, "Analytics cookies?"));
    text.appendChild(document.createTextNode(
      "SpeakPower uses Google Analytics to see which pages and services help people. " +
      "Nothing is stored on your device unless you accept, and none of it is used for advertising. " +
      "Change this any time under “Cookie settings”."));
    var actions = el("div", "sp-consent-actions");
    var accept = el("button", "sp-consent-btn sp-consent-accept", "Accept");
    accept.type = "button";
    accept.setAttribute("data-consent", "granted");
    var decline = el("button", "sp-consent-btn sp-consent-decline", "Decline");
    decline.type = "button";
    decline.setAttribute("data-consent", "denied");
    actions.appendChild(accept);
    actions.appendChild(decline);
    banner.appendChild(text);
    banner.appendChild(actions);
    banner.addEventListener("click", function (event) {
      var button = event.target.closest && event.target.closest("[data-consent]");
      if (button) decide(button.getAttribute("data-consent"));
    });
    banner.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && choice) closeBanner();
    });
    // First in reading order, shown at the foot of the screen.
    document.body.insertBefore(banner, document.body.firstChild);
  }

  function markChoice() {
    if (!banner) return;
    var buttons = banner.querySelectorAll("[data-consent]");
    for (var i = 0; i < buttons.length; i++) {
      if (choice) buttons[i].setAttribute("aria-pressed", String(buttons[i].getAttribute("data-consent") === choice));
      else buttons[i].removeAttribute("aria-pressed");
    }
  }

  function showBanner(focus) {
    if (!banner) buildBanner();
    markChoice();
    banner.hidden = false;
    if (focus) {
      var first = banner.querySelector("[aria-pressed=true]") || banner.querySelector("[data-consent]");
      if (first) first.focus();
    }
  }

  function closeBanner() {
    if (banner) banner.hidden = true;
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
    returnFocus = null;
  }

  // GA's own cookies, removed when someone withdraws consent.
  function clearGaCookies() {
    var host = window.location.hostname;
    document.cookie.split(";").forEach(function (part) {
      var name = part.split("=")[0].trim();
      if (name !== "_ga" && name.indexOf("_ga_") !== 0 && name !== "_gid") return;
      var expire = name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
      document.cookie = expire;
      document.cookie = expire + "; domain=" + host;
      document.cookie = expire + "; domain=." + host;
    });
  }

  function decide(value) {
    if (value !== "granted" && value !== "denied") return;
    var was = choice;
    saveChoice(value);
    if (ENABLED) {
      gtag("consent", "update", { analytics_storage: value });
      if (value === "denied" && was === "granted") clearGaCookies();
    }
    closeBanner();
  }

  function openSettings(event) {
    if (!ENABLED) return;
    returnFocus = (event && event.currentTarget) || document.activeElement;
    showBanner(true);
  }

  /* ----------------------------------------------- clicks worth counting */

  function linkLocation(node) {
    if (node.closest("header, .site-header, .gx-topbar")) return "header";
    if (node.closest("footer, .site-footer, .gx-side-foot")) return "footer";
    return "page";
  }

  var SERVICE_PAGES = {
    "griot-app.html": "griot",
    "rehearse.html": "rehearsal",
    "audit.html": "clarity_audit",
    "plans.html": "plans"
  };

  function onClick(event) {
    var link = event.target.closest && event.target.closest("a[href], [data-venture]");
    if (!link) return;
    var where = linkLocation(link);
    var venture = link.getAttribute("data-venture");
    if (venture) {
      track("venture_click", { venture: venture, link_location: where });
      return;
    }
    var href = link.getAttribute("href") || "";
    if (/^tel:/i.test(href)) { track("contact_click", { channel: "phone", link_location: where }); return; }
    if (/^mailto:/i.test(href)) { track("contact_click", { channel: "email", link_location: where }); return; }
    var url;
    try { url = new URL(link.href, window.location.href); } catch (e) { return; }
    if (/(^|\.)wa\.me$|(^|\.)whatsapp\.com$/i.test(url.hostname)) {
      track("contact_click", { channel: "whatsapp", link_location: where });
      return;
    }
    if (url.origin !== window.location.origin) return;
    var page = url.pathname.split("/").pop();
    var service = (url.searchParams.get("service") || "").toLowerCase();
    if (page === "contact.html" && /^[a-z0-9-]{1,40}$/.test(service)) {
      track("discuss_click", { service: service, link_location: where });
      return;
    }
    var product = (url.searchParams.get("product") || "").toLowerCase();
    if (page === "studio-product.html" && /^[a-z0-9-]{1,40}$/.test(product)) {
      track("select_content", { content_type: "studio_pack", content_id: product, link_location: where });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(SERVICE_PAGES, page) && page !== window.location.pathname.split("/").pop()) {
      track("select_content", { content_type: "service", content_id: SERVICE_PAGES[page], link_location: where });
    }
  }

  /* -------------------------------------------------------------- start */

  function wireSettingsLinks() {
    var holders = document.querySelectorAll(".footer-bottom");
    for (var i = 0; i < holders.length; i++) {
      if (holders[i].querySelector("[data-cookie-settings]")) continue;
      var button = el("button", "sp-cookie-link", "Cookie settings");
      button.type = "button";
      button.setAttribute("data-cookie-settings", "");
      holders[i].appendChild(button);
    }
    var triggers = document.querySelectorAll("[data-cookie-settings]");
    for (var j = 0; j < triggers.length; j++) {
      triggers[j].hidden = false;
      triggers[j].addEventListener("click", openSettings);
    }
  }

  function start() {
    if (!ENABLED) return;
    injectStyles();
    wireSettingsLinks();
    if (!choice) showBanner(false);
    document.addEventListener("click", onClick, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.SPAnalytics = {
    enabled: ENABLED,
    track: track,
    ids: ids,
    consent: function () { return choice; },
    openSettings: function () { openSettings(null); },
    // Exposed for tests: what an address looks like by the time it is sent.
    scrubUrl: scrubUrl
  };
})();
