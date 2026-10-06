/* ==========================================================================
   SpeakPower — site configuration
   The only file to edit once the Cloudflare side is set up. Nothing here is
   secret: every value is safe to publish. The GRIOT key and the session
   secret live in the Worker, never in this file (see worker/README.md).
   ========================================================================== */

window.SP_CONFIG = {
  // URL of the deployed Worker, no trailing slash, e.g.
  // "https://speakpower-api.<your-subdomain>.workers.dev"
  // While empty, the GRIOT app says it is being connected instead of failing.
  apiBase: "",

  // Google OAuth client ID (public). Google Cloud → APIs & Services →
  // Credentials → OAuth client ID → Web application, with
  // https://speakpower-commits.github.io as an authorised JavaScript origin.
  // Set the same value as GOOGLE_CLIENT_ID on the Worker. This is the
  // recommended sign-in: it needs no email sending and no domain.
  googleClientId: "",

  // Email-code sign-in. Leave false until the Worker can send email, which on
  // Cloudflare needs your own domain and the Workers Paid plan. While false
  // the email form is hidden, so nobody types an address that cannot be sent to.
  emailCodes: false,

  // Turnstile site key (public), used by email-code sign-in only.
  // Cloudflare dashboard → Turnstile → your widget.
  turnstileSiteKey: "",

  // Optional: where "Top up" sends people once their free messages are used.
  // The Worker's CHECKOUT_URL wins if both are set.
  checkoutUrl: ""
};
