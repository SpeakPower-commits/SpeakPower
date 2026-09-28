/* ==========================================================================
   SpeakPower — site configuration
   The only file to edit when the Cloudflare side is set up. Nothing here is
   secret: every value is safe to publish (see worker/README.md).
   ========================================================================== */

window.SP_CONFIG = {
  // URL of the deployed Worker, no trailing slash, e.g.
  // "https://speakpower-api.<your-subdomain>.workers.dev"
  // While empty, the contact form falls back to email and Studio shows a
  // "launching shortly" notice instead of generating.
  apiBase: "",

  // Turnstile site key (public). Cloudflare dashboard → Turnstile → your widget.
  turnstileSiteKey: "",

  // Cloudflare Web Analytics token (public).
  // Cloudflare dashboard → Analytics & Logs → Web Analytics → your site.
  webAnalyticsToken: "",

  // Optional: where the "Continue with a paid run" button sends people when
  // their free runs are used up. The Worker's CHECKOUT_URL wins if both are set.
  checkoutUrl: ""
};
