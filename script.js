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

  // Read once and share: both the slider and the scroll reveal branch on it.
  var prefersReducedMotion =
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
      // The header logo falls back to the text wordmark, not a grey panel.
      var brand = img.closest(".logo");
      if (brand) {
        brand.classList.add("logo--fallback");
        return;
      }

      // Narrowest container first. Without this, one failed slide in the hero
      // slideshow would put .img-fallback on .hero-photo and blank every other
      // slide with it, because .img-fallback hides the images it contains.
      var holder = img.closest(".slide-frame, .media-frame")
                || img.closest(".hero-photo, .about-photo")
                || img.parentNode;
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
      var organization = (document.getElementById("c-organization") || {}).value || "";
      var email = (document.getElementById("c-email") || {}).value || "";
      var service = (document.getElementById("c-service") || {}).value || "";
      var message = (document.getElementById("c-message") || {}).value || "";

      if (!name.trim() || !email.trim() || !service || !message.trim()) {
        setStatus(contactStatus, "error", "Please complete the required fields before continuing.");
        return;
      }

      var subject = "SpeakPower discovery request — " + name.trim();
      var body = [
        "Name: " + name.trim(),
        "Organization: " + (organization.trim() || "Not provided"),
        "Email: " + email.trim(),
        "Area of help: " + service,
        "",
        "Context:",
        message.trim()
      ].join("\n");

      setStatus(
        contactStatus,
        "success",
        "Opening your email client with the enquiry ready to send. If nothing opens, email " + CONTACT_EMAIL + " directly."
      );
      openMail(subject, body);
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
     6. Sliders
     Progressive enhancement over a scroll-snap track: without this the track
     is still swipeable and keyboard-scrollable, so nothing is trapped. The
     arrows and dots are added here rather than sitting in the markup, because
     controls that do nothing when JS fails are worse than no controls.

     No autoplay, deliberately. Movement the visitor did not ask for is what
     makes most carousels hostile.
     ---------------------------------------------------------------------- */

  Array.prototype.forEach.call(document.querySelectorAll("[data-slider]"), function (slider, sIndex) {
    var track = slider.querySelector(".slider-track");
    if (!track) return;

    var slides = Array.prototype.slice.call(track.children);
    if (slides.length < 2) return; // one slide is not a slider

    slider.setAttribute("role", "region");
    slider.setAttribute("aria-roledescription", "carousel");

    // Make the track a keyboard stop so arrow keys reach the handler below.
    // Browsers vary on whether a scroll container is focusable by default.
    track.setAttribute("tabindex", "0");

    slides.forEach(function (slide, i) {
      slide.setAttribute("role", "group");
      slide.setAttribute("aria-roledescription", "slide");
      slide.setAttribute("aria-label", (i + 1) + " of " + slides.length);
    });

    // --- Build the controls ---
    var controls = document.createElement("div");
    controls.className = "slider-controls";

    function arrow(dir, label) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "slider-btn";
      b.setAttribute("aria-label", label);
      b.innerHTML = dir === "prev"
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
      return b;
    }

    var prev = arrow("prev", "Previous slide");
    var next = arrow("next", "Next slide");

    var dots = document.createElement("div");
    dots.className = "slider-dots";
    dots.setAttribute("role", "tablist");
    dots.setAttribute("aria-label", "Choose slide");

    var dotList = slides.map(function (slide, i) {
      var d = document.createElement("button");
      d.type = "button";
      d.className = "slider-dot";
      d.setAttribute("role", "tab");
      d.setAttribute("aria-label", "Slide " + (i + 1));
      d.addEventListener("click", function () { scrollToIndex(i); });
      dots.appendChild(d);
      return d;
    });

    controls.appendChild(prev);
    controls.appendChild(next);
    controls.appendChild(dots);
    slider.appendChild(controls);

    // --- Movement ---
    var current = 0;
    // Autoplay wraps past the last slide, so the arrows must wrap too — an
    // arrow that says "no further" while the slideshow keeps going is a lie.
    var wraps = false;

    function scrollToIndex(i) {
      var target = slides[Math.max(0, Math.min(i, slides.length - 1))];
      if (!target) return;
      track.scrollTo({
        left: target.offsetLeft - track.offsetLeft,
        behavior: prefersReducedMotion ? "auto" : "smooth"
      });
    }

    function step(delta) {
      var i = current + delta;
      if (wraps) {
        if (i < 0) i = slides.length - 1;
        else if (i > slides.length - 1) i = 0;
      }
      scrollToIndex(i);
    }

    function syncState() {
      // Nearest slide to the track's current scroll position wins.
      var mid = track.scrollLeft + track.clientWidth / 2;
      var best = 0;
      var bestGap = Infinity;

      slides.forEach(function (slide, i) {
        var centre = (slide.offsetLeft - track.offsetLeft) + slide.offsetWidth / 2;
        var gap = Math.abs(centre - mid);
        if (gap < bestGap) { bestGap = gap; best = i; }
      });

      current = best;
      dotList.forEach(function (d, i) {
        if (i === current) d.setAttribute("aria-current", "true");
        else d.removeAttribute("aria-current");
      });
      if (wraps) {
        prev.disabled = false;
        next.disabled = false;
      } else {
        prev.disabled = track.scrollLeft <= 1;
        next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 1;
      }
    }

    // --- Autoplay, opt-in per slider ---------------------------------------
    // Off unless the markup asks for it, so every other slider keeps the
    // no-autoplay default. WCAG 2.2.2 Pause, Stop, Hide requires a control for
    // anything that moves by itself for more than five seconds, so the pause
    // button below is not optional decoration — it is the reason this is
    // allowed to exist at all.
    var autoplayMs = parseInt(slider.getAttribute("data-slider-autoplay"), 10);
    var wantsAutoplay = autoplayMs > 0 && !prefersReducedMotion;

    // Declared out here because the control handlers below call it. The file is
    // in strict mode, where a function declared inside the if-block would be
    // scoped to that block and invisible to them.
    var surrender = function () {};

    if (wantsAutoplay) {
      wraps = true;

      var timer = null;
      var stoppedByUser = false;
      var hovered = false;
      var focused = false;

      var play = document.createElement("button");
      play.type = "button";
      play.className = "slider-btn slider-play";
      // Stroke-only icons: .slider-btn svg sets fill:none, so a solid triangle
      // would render as nothing.
      var ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>';
      var ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" stroke-linejoin="round"/></svg>';

      // The label names the action the button performs, and changes with the
      // state. No aria-pressed — a button whose label already flips does not
      // need one, and carrying both invites them to disagree.
      function paint() {
        var running = !!timer;
        play.innerHTML = running ? ICON_PAUSE : ICON_PLAY;
        play.setAttribute("aria-label", running ? "Pause slideshow" : "Play slideshow");
      }

      function shouldRun() {
        return !stoppedByUser && !hovered && !focused && !document.hidden;
      }

      function retime() {
        if (timer) { window.clearInterval(timer); timer = null; }
        if (shouldRun()) {
          timer = window.setInterval(function () { step(1); }, autoplayMs);
        }
        paint();
      }

      // Any deliberate move is a takeover: the visitor is reading on their own
      // schedule now and the slideshow does not get to interrupt again.
      surrender = function () {
        stoppedByUser = true;
        retime();
      };

      play.addEventListener("click", function () {
        stoppedByUser = !stoppedByUser;
        retime();
      });

      slider.addEventListener("mouseenter", function () { hovered = true; retime(); });
      slider.addEventListener("mouseleave", function () { hovered = false; retime(); });
      slider.addEventListener("focusin", function () { focused = true; retime(); });
      slider.addEventListener("focusout", function () { focused = false; retime(); });

      // Nothing should advance in a tab nobody is looking at — that is somebody
      // else's mobile data being spent.
      document.addEventListener("visibilitychange", retime);

      controls.insertBefore(play, dots);
      retime();
    }

    // surrender() is a no-op unless autoplay is running, so these need no guard.
    // Wrapped in closures rather than passed directly, because the variable is
    // reassigned above and a direct reference would capture the no-op.
    prev.addEventListener("click", function () { step(-1); surrender(); });
    next.addEventListener("click", function () { step(1); surrender(); });

    dotList.forEach(function (d) {
      d.addEventListener("click", function () { surrender(); });
    });

    track.addEventListener("keydown", function (event) {
      if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); surrender(); }
      else if (event.key === "ArrowRight") { event.preventDefault(); step(1); surrender(); }
    });

    var scrollTick = false;
    track.addEventListener("scroll", function () {
      if (scrollTick) return;
      scrollTick = true;
      window.requestAnimationFrame(function () { syncState(); scrollTick = false; });
    }, { passive: true });

    window.addEventListener("resize", syncState);
    syncState();
  });

  /* ------------------------------------------------------------------------
     7. Scroll reveal
     ---------------------------------------------------------------------- */

  var revealTargets = document.querySelectorAll("[data-reveal]");

  if (!revealTargets.length) return;

  if (prefersReducedMotion || !("IntersectionObserver" in window)) {
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
