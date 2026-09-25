/* SpeakPower — site behaviour
   Lightweight progressive enhancement. No dependencies or build step. */

(function () {
  "use strict";

  var CONTACT_EMAIL = "thomasotieno583@gmail.com";
  var prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
    navLinks.addEventListener("click", function (event) {
      if (event.target.closest("a")) setNav(false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && navToggle.getAttribute("aria-expanded") === "true") {
        setNav(false);
        navToggle.focus();
      }
    });
    document.addEventListener("click", function (event) {
      if (navToggle.getAttribute("aria-expanded") !== "true") return;
      if (navLinks.contains(event.target) || navToggle.contains(event.target)) return;
      setNav(false);
    });
  }

  var accordion = document.getElementById("polsseAccordion");
  if (accordion) {
    var items = Array.prototype.slice.call(accordion.querySelectorAll(".polsse-item"));
    items.forEach(function (item, index) {
      var trigger = item.querySelector(".polsse-trigger");
      var body = item.querySelector(".polsse-body");
      if (!trigger || !body) return;

      var panelId = "polsse-panel-" + (index + 1);
      var labelId = "polsse-label-" + (index + 1);
      var title = item.querySelector(".polsse-title");

      body.id = panelId;
      body.setAttribute("role", "region");
      trigger.setAttribute("aria-controls", panelId);
      if (title) {
        title.id = labelId;
        body.setAttribute("aria-labelledby", labelId);
      }

      var open = index === 0;
      item.setAttribute("data-open", String(open));
      trigger.setAttribute("aria-expanded", String(open));

      trigger.addEventListener("click", function () {
        var willOpen = trigger.getAttribute("aria-expanded") !== "true";
        items.forEach(function (other) {
          other.setAttribute("data-open", "false");
          var otherTrigger = other.querySelector(".polsse-trigger");
          if (otherTrigger) otherTrigger.setAttribute("aria-expanded", "false");
        });
        item.setAttribute("data-open", String(willOpen));
        trigger.setAttribute("aria-expanded", String(willOpen));
      });
    });

    accordion.addEventListener("keydown", function (event) {
      var trigger = event.target.closest(".polsse-trigger");
      if (!trigger) return;
      var triggers = Array.prototype.slice.call(accordion.querySelectorAll(".polsse-trigger"));
      var index = triggers.indexOf(trigger);
      var next = null;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") next = triggers[index + 1];
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = triggers[index - 1];
      if (event.key === "Home") next = triggers[0];
      if (event.key === "End") next = triggers[triggers.length - 1];
      if (next) {
        event.preventDefault();
        next.focus();
      }
    });
  }

  Array.prototype.forEach.call(document.images, function (img) {
    var degrade = function () {
      var brand = img.closest(".logo");
      if (brand) {
        brand.classList.add("logo--fallback");
        return;
      }
      var holder = img.closest(".hero-photo, .about-photo") || img.parentNode;
      if (!holder || holder.classList.contains("img-fallback")) return;
      holder.classList.add("img-fallback");
      holder.setAttribute("data-fallback", img.getAttribute("alt") || "Image unavailable");
    };
    img.addEventListener("error", degrade);
    if (img.complete && img.naturalWidth === 0) degrade();
  });

  function setStatus(el, state, message) {
    if (!el) return;
    el.setAttribute("data-state", state);
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.textContent = message;
  }

  function openMail(subject, body) {
    var href = "mailto:" + CONTACT_EMAIL
      + "?subject=" + encodeURIComponent(subject)
      + "&body=" + encodeURIComponent(body);
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

  Array.prototype.forEach.call(document.querySelectorAll("[data-slider]"), function (slider) {
    var track = slider.querySelector(".slider-track");
    if (!track) return;

    var slides = Array.prototype.slice.call(track.children);
    if (slides.length < 2) return;

    slider.setAttribute("role", "region");
    slider.setAttribute("aria-roledescription", "carousel");
    track.setAttribute("tabindex", "0");

    slides.forEach(function (slide, index) {
      slide.setAttribute("role", "group");
      slide.setAttribute("aria-roledescription", "slide");
      slide.setAttribute("aria-label", (index + 1) + " of " + slides.length);
    });

    var controls = document.createElement("div");
    controls.className = "slider-controls";

    function makeArrow(direction, label) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "slider-btn";
      button.setAttribute("aria-label", label);

      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", direction === "prev" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7");
      svg.appendChild(path);
      button.appendChild(svg);
      return button;
    }

    var prev = makeArrow("prev", "Previous slide");
    var next = makeArrow("next", "Next slide");
    var dots = document.createElement("div");
    dots.className = "slider-dots";
    dots.setAttribute("role", "tablist");
    dots.setAttribute("aria-label", "Choose slide");

    var current = 0;
    var dotList = slides.map(function (slide, index) {
      var dot = document.createElement("button");
      dot.type = "button";
      dot.className = "slider-dot";
      dot.setAttribute("role", "tab");
      dot.setAttribute("aria-label", "Slide " + (index + 1));
      dot.addEventListener("click", function () { scrollToIndex(index); });
      dots.appendChild(dot);
      return dot;
    });

    controls.appendChild(prev);
    controls.appendChild(next);
    controls.appendChild(dots);
    slider.appendChild(controls);

    function scrollToIndex(index) {
      var target = slides[Math.max(0, Math.min(index, slides.length - 1))];
      if (!target) return;
      track.scrollTo({
        left: target.offsetLeft - track.offsetLeft,
        behavior: prefersReducedMotion ? "auto" : "smooth"
      });
    }

    function syncState() {
      var midpoint = track.scrollLeft + track.clientWidth / 2;
      var best = 0;
      var bestGap = Infinity;
      slides.forEach(function (slide, index) {
        var center = (slide.offsetLeft - track.offsetLeft) + slide.offsetWidth / 2;
        var gap = Math.abs(center - midpoint);
        if (gap < bestGap) {
          bestGap = gap;
          best = index;
        }
      });
      current = best;
      dotList.forEach(function (dot, index) {
        if (index === current) dot.setAttribute("aria-current", "true");
        else dot.removeAttribute("aria-current");
      });
      prev.disabled = track.scrollLeft <= 1;
      next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 1;
    }

    prev.addEventListener("click", function () { scrollToIndex(current - 1); });
    next.addEventListener("click", function () { scrollToIndex(current + 1); });
    track.addEventListener("keydown", function (event) {
      if (event.key === "ArrowLeft") { event.preventDefault(); scrollToIndex(current - 1); }
      if (event.key === "ArrowRight") { event.preventDefault(); scrollToIndex(current + 1); }
    });
    var scrollTick = false;
    track.addEventListener("scroll", function () {
      if (scrollTick) return;
      scrollTick = true;
      window.requestAnimationFrame(function () {
        syncState();
        scrollTick = false;
      });
    }, { passive: true });
    window.addEventListener("resize", syncState);
    syncState();
  });

  var revealTargets = document.querySelectorAll("[data-reveal]");
  if (!revealTargets.length) return;

  if (prefersReducedMotion || !("IntersectionObserver" in window)) {
    Array.prototype.forEach.call(revealTargets, function (el) { el.classList.add("is-visible"); });
    return;
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.06 });

  Array.prototype.forEach.call(revealTargets, function (el) { observer.observe(el); });
})();