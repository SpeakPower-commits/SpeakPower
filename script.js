/* ==========================================================================
   SpeakPower — site behaviour
   No dependencies, no build step. Loaded on every page.

   Everything here is progressive enhancement. With JS disabled the pages are
   readable and navigable; the POLSSE panels render open (see the no-js rule
   applied below) rather than becoming unreachable.

   Security note: all text written into the DOM goes through textContent, never
   innerHTML, so user input can never be interpreted as markup.
   ========================================================================== */

(function () {
  "use strict";

  var CONTACT_EMAIL = "thomasotieno583@gmail.com";

  /* ------------------------------------------------------------------------
     1. Header scroll state
     rAF-throttled: scroll fires far more often than the browser paints.
     ---------------------------------------------------------------------- */

  var header = document.querySelector(".site-header");

  if (header) {
    var ticking = false;

    var applyScrollState = function () {
      header.setAttribute("data-scrolled", window.scrollY > 8 ? "true" : "false");
      ticking = false;
    };

    window.addEventListener("scroll", function () {
      if (!ticking) {
        window.requestAnimationFrame(applyScrollState);
        ticking = true;
      }
    }, { passive: true });

    applyScrollState();
  }

  /* ------------------------------------------------------------------------
     2. Mobile navigation
     ---------------------------------------------------------------------- */

  var navToggle = document.getElementById("navToggle");
  var navLinks = document.getElementById("navLinks");

  if (navToggle && navLinks) {
    var setNav = function (open) {
      navToggle.setAttribute("aria-expanded", String(open));
      navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      navLinks.setAttribute("data-open", String(open));
    };

    setNav(false);

    navToggle.addEventListener("click", function () {
      setNav(navToggle.getAttribute("aria-expanded") !== "true");
    });

    // Following a link closes the panel.
    navLinks.addEventListener("click", function (event) {
      if (event.target.closest("a")) setNav(false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && navToggle.getAttribute("aria-expanded") === "true") {
        setNav(false);
        navToggle.focus();
      }
    });

    // Clicking outside an open panel closes it.
    document.addEventListener("click", function (event) {
      if (navToggle.getAttribute("aria-expanded") !== "true") return;
      if (navLinks.contains(event.target) || navToggle.contains(event.target)) return;
      setNav(false);
    });

    // Returning to desktop width must not leave a hidden panel marked open.
    var desktop = window.matchMedia("(min-width: 881px)");
    var onBreakpoint = function (e) { if (e.matches) setNav(false); };
    if (desktop.addEventListener) desktop.addEventListener("change", onBreakpoint);
    else desktop.addListener(onBreakpoint); // Safari < 14
  }

  /* ------------------------------------------------------------------------
     3. POLSSE accordion
     One panel open at a time. State lives on the item (data-open) for CSS and
     on the trigger (aria-expanded) for assistive tech.
     ---------------------------------------------------------------------- */

  var accordion = document.getElementById("polsseAccordion");

  if (accordion) {
    var items = Array.prototype.slice.call(
      accordion.querySelectorAll(".polsse-item")
    );

    items.forEach(function (item, index) {
      var trigger = item.querySelector(".polsse-trigger");
      var body = item.querySelector(".polsse-body");
      if (!trigger || !body) return;

      // Wire up the trigger/panel relationship for screen readers.
      var panelId = "polsse-panel-" + (index + 1);
      body.id = panelId;
      body.setAttribute("role", "region");
      trigger.setAttribute("type", "button");
      trigger.setAttribute("aria-controls", panelId);

      var labelId = "polsse-label-" + (index + 1);
      var title = item.querySelector(".polsse-title");
      if (title) {
        title.id = labelId;
        body.setAttribute("aria-labelledby", labelId);
      }

      var open = index === 0; // first lens open, so the section reads as content
      item.setAttribute("data-open", String(open));
      trigger.setAttribute("aria-expanded", String(open));

      trigger.addEventListener("click", function () {
        var willOpen = trigger.getAttribute("aria-expanded") !== "true";

        items.forEach(function (other) {
          var otherTrigger = other.querySelector(".polsse-trigger");
          other.setAttribute("data-open", "false");
          if (otherTrigger) otherTrigger.setAttribute("aria-expanded", "false");
        });

        item.setAttribute("data-open", String(willOpen));
        trigger.setAttribute("aria-expanded", String(willOpen));
      });
    });

    // Left/right/home/end arrow support across the trigger set.
    accordion.addEventListener("keydown", function (event) {
      var trigger = event.target.closest(".polsse-trigger");
      if (!trigger) return;

      var triggers = Array.prototype.slice.call(
        accordion.querySelectorAll(".polsse-trigger")
      );
      var i = triggers.indexOf(trigger);
      var next = null;

      if (event.key === "ArrowDown" || event.key === "ArrowRight") next = triggers[i + 1];
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = triggers[i - 1];
      else if (event.key === "Home") next = triggers[0];
      else if (event.key === "End") next = triggers[triggers.length - 1];

      if (next) {
        event.preventDefault();
        next.focus();
      }
    });
  }

  /* ------------------------------------------------------------------------
     4. Image fallback
     A missing photo becomes a branded panel rather than a broken-image icon.
     ---------------------------------------------------------------------- */

  Array.prototype.forEach.call(document.images, function (img) {
    var degrade = function () {
      var holder = img.closest(".hero-photo, .about-photo") || img.parentNode;
      if (!holder || holder.classList.contains("img-fallback")) return;
      holder.classList.add("img-fallback");
      holder.setAttribute("data-fallback", img.getAttribute("alt") || "Image unavailable");
    };

    img.addEventListener("error", degrade);
    // Covers images that already failed before this script ran.
    if (img.complete && img.naturalWidth === 0) degrade();
  });

  /* ------------------------------------------------------------------------
     5. Forms
     There is no server behind this site, so both forms compose an email in the
     visitor's own mail client. The status line reports exactly that — it never
     claims a submission was received, because nothing here can receive one.
     ---------------------------------------------------------------------- */

  function setStatus(el, state, message) {
    if (!el) return;
    el.setAttribute("data-state", state);
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.textContent = message; // textContent, never innerHTML
  }

  function openMail(subject, body) {
    var href = "mailto:" + CONTACT_EMAIL
      + "?subject=" + encodeURIComponent(subject)
      + "&body=" + encodeURIComponent(body);

    // Assigning location is more reliable across browsers than window.open
    // for the mailto: scheme, and avoids a blocked-popup false negative.
    window.location.href = href;
  }

  var contactForm = document.getElementById("contactForm");

  if (contactForm) {
    var contactStatus = document.getElementById("contactStatus");

    contactForm.addEventListener("submit", function (event) {
      event.preventDefault();

      var name = (document.getElementById("c-name") || {}).value || "";
      var email = (document.getElementById("c-email") || {}).value || "";
      var message = (document.getElementById("c-message") || {}).value || "";

      openMail(
        "Discovery call request — " + name.trim(),
        "Name: " + name.trim() + "\n"
          + "Email: " + email.trim() + "\n\n"
          + "What I'm working on:\n" + message.trim() + "\n"
      );

      setStatus(
        contactStatus,
        "success",
        "Opening your email client with this message ready to send. "
          + "If nothing opened, email " + CONTACT_EMAIL + " directly."
      );
    });
  }

  var masterclassForm = document.getElementById("masterclassForm");

  if (masterclassForm) {
    var mcStatus = document.getElementById("mcStatus");

    masterclassForm.addEventListener("submit", function (event) {
      event.preventDefault();

      var name = (document.getElementById("mc-name") || {}).value || "";
      var email = (document.getElementById("mc-email") || {}).value || "";

      openMail(
        "Masterclass seat request — " + name.trim(),
        "Name: " + name.trim() + "\n"
          + "Email: " + email.trim() + "\n\n"
          + "Please hold me a seat on the next SpeakPower Masterclass cohort.\n"
      );

      setStatus(
        mcStatus,
        "success",
        "Opening your email client to send the request. Your seat is confirmed "
          + "once you send it and get a reply with the cohort date."
      );
    });
  }

  /* ------------------------------------------------------------------------
     6. Scroll reveal
     ---------------------------------------------------------------------- */

  var revealTargets = document.querySelectorAll("[data-reveal]");

  if (!revealTargets.length) return;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reduceMotion || !("IntersectionObserver" in window)) {
    Array.prototype.forEach.call(revealTargets, function (el) {
      el.classList.add("is-visible");
    });
    return;
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target); // reveal once, then stop watching
    });
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.06 });

  Array.prototype.forEach.call(revealTargets, function (el) { observer.observe(el); });
})();
