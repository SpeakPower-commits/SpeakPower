/* ==========================================================================
   SpeakPower — welcome: two short steps after signing up
   1. About you: name, role, organisation, expertise; sector, place and a
      WhatsApp number are optional (the number only with a yes to use it).
   2. Your challenge: the problem, the goal and by when, why now, focus.
      "Brief GRIOT" is the yes that lets GRIOT remember it; "Save without
      telling GRIOT" keeps it here only.
   Then the Ready screen lists exactly what GRIOT was told and goes on to the
   service the visitor came for (?next=, checked by SPAccount.safeNext).

   Step 1 is needed before any service, step 2 before GRIOT. The Worker
   enforces both; this page only asks. ?edit=1 reopens the answers, and
   ?step=2 starts at the challenge.

   Security: dynamic text goes through textContent, never innerHTML.
   ========================================================================== */

(function () {
  "use strict";

  var SP = window.SP;
  var A = window.SPAccount;
  if (!SP || !A) return;

  function $(id) { return document.getElementById(id); }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  var params = new URLSearchParams(window.location.search);
  var rawNext = params.get("next");
  var next = A.safeNext(rawNext) || "account.html";
  var editing = params.get("edit") === "1";
  var forGriot = next === "griot-app.html";
  var profile = null;

  // A first place to start, from the first focus area chosen. Fixed: no
  // model is asked.
  var START = {
    pitching: ["rehearse.html", "Rehearse your pitch in the Rehearsal Room", "Record it, get a Speak Score, then tighten the story."],
    marketing: ["studio-product.html?product=market-plan", "Market Development Planner", "Turn your goal into a plan for reaching the right people."],
    brand: ["studio-product.html?product=brand-story", "Brand Story Builder", "Put who you are and why it matters on one clear page."],
    data: ["studio-product.html?product=data-story", "Data Story Builder", "Turn your numbers into a story people remember."],
    speaking: ["rehearse.html", "The Rehearsal Room", "Speak for up to three minutes and see your Speak Score."],
    strategy: ["griot-app.html", "Ask GRIOT", "Start with the decision in front of you."],
    digital: ["studio-product.html?product=seo-audit", "Website SEO & Visibility Audit", "See what stops people finding you online."]
  };

  if (!SP.connected || !A.signInAvailable()) { window.location.replace("account.html"); return; }
  if (!A.session()) {
    window.location.replace(next === "account.html" ? "account.html" : "account.html?next=" + encodeURIComponent(next));
    return;
  }

  /* ------------------------------------------------------------- screens */

  var HERO = {
    1: ["Step 1 of 2", "Tell us who you are.", "Two short steps, about a minute. Your answers let GRIOT advise you from the very first question."],
    2: ["Step 2 of 2", "What are you working on?", forGriot
      ? "GRIOT reads this before your first question, so its first answer is already about you."
      : "This briefs GRIOT, SpeakPower's strategy advisor. You can skip it for now and add it before you first ask GRIOT."],
    3: ["Ready", "You're set.", ""]
  };

  function show(step) {
    $("wLoading").hidden = true;
    $("wStep1").hidden = step !== 1;
    $("wStep2").hidden = step !== 2;
    $("wDone").hidden = step !== 3;
    [1, 2, 3].forEach(function (n) {
      var li = $("wProg" + n);
      li.className = n < step ? "is-done" : n === step ? "is-current" : "";
      if (n === step) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
    $("wEyebrow").textContent = HERO[step][0];
    $("wTitle").textContent = HERO[step][1];
    $("wLead").textContent = HERO[step][2];
    $("wLead").hidden = !HERO[step][2];
    var heading = document.querySelector(step === 3 ? "#wDoneTitle" : "#wStep" + step + " h2");
    if (heading && window.scrollY > 200) window.scrollTo({ top: 0 });
    if (heading && step !== 1) heading.focus({ preventScroll: true });
  }

  function notice(text) {
    $("wNotice").textContent = text || "";
    $("wNotice").hidden = !text;
  }

  /* -------------------------------------------------------------- fields */

  function fillChoices(data) {
    var sel = $("wSector");
    (data.sectors || []).forEach(function (s) {
      var o = el("option", null, s.name);
      o.value = s.key;
      sel.appendChild(o);
    });
    var host = $("wFocus");
    (data.focusAreas || []).forEach(function (f) {
      var label = el("label", "welcome-chip");
      var box = el("input");
      box.type = "checkbox";
      box.name = "focus";
      box.value = f.key;
      label.appendChild(box);
      label.appendChild(el("span", null, f.name));
      host.appendChild(label);
    });
  }

  function prefill(data) {
    var p = data.profile;
    $("wName").value = (p && p.name) || data.googleName || "";
    // What to greet them by: theirs if they said, else a first guess they can change.
    $("wCallMe").value = (p && p.callMe) || String($("wName").value).trim().split(/\s+/)[0] || "";
    if (!p) return;
    $("wExpertise").value = p.expertise;
    $("wPosition").value = p.position;
    $("wCompany").value = p.company;
    $("wSector").value = p.sector;
    $("wLocation").value = p.location;
    $("wWaConsent").checked = p.consentWhatsapp;
    $("wWhatsapp").value = p.whatsapp;
    $("wWaField").hidden = !p.consentWhatsapp;
    $("wProblem").value = p.problem;
    $("wGoal").value = p.goal;
    $("wGoalBy").value = p.goalBy;
    $("wWhyNow").value = p.whyNow;
    var boxes = $("wFocus").querySelectorAll("input");
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = p.focus.indexOf(boxes[i].value) !== -1;
  }

  function val(id) { return $(id).value.trim(); }

  function clearErrors(form, errorId) {
    var flagged = form.querySelectorAll(".builder-field--invalid");
    for (var i = 0; i < flagged.length; i++) flagged[i].classList.remove("builder-field--invalid");
    $(errorId).hidden = true;
  }

  // The field the Worker (or the browser) named, marked and focused, with
  // the reason said once, above the buttons.
  var FIELD_IDS = { name: "wName", callMe: "wCallMe", expertise: "wExpertise", position: "wPosition", company: "wCompany",
    sector: "wSector", location: "wLocation", whatsapp: "wWhatsapp", problem: "wProblem", goal: "wGoal",
    goalBy: "wGoalBy", whyNow: "wWhyNow", focus: "wFocusSet" };
  function fail(errorId, message, field) {
    var input = field && FIELD_IDS[field] ? $(FIELD_IDS[field]) : null;
    var wrap = input && input.closest ? input.closest(".builder-field") : null;
    if (wrap) wrap.classList.add("builder-field--invalid");
    $(errorId).textContent = message;
    $(errorId).hidden = false;
    if (input && input.focus) input.focus();
  }

  function firstMissing(form) {
    var required = form.querySelectorAll("[required]");
    for (var i = 0; i < required.length; i++) {
      if (!required[i].value.trim()) return required[i];
    }
    return null;
  }

  var MISSING = { wName: "Add your name.", wExpertise: "Add your area of expertise.", wPosition: "Add your position or role.",
    wCompany: "Add your company or organisation.", wProblem: "Say what problem you are facing.", wGoal: "Say what you want to achieve." };

  function busy(form, on) {
    var buttons = form.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = on;
    form.setAttribute("aria-busy", on ? "true" : "false");
  }

  function failed(form, errorId, e) {
    if (e.status === 401) { window.location.replace("account.html?next=" + encodeURIComponent(next)); return; }
    if (e.code === "profile_required") { show(1); return; }
    var field = e.data && e.data.field;
    fail(errorId, e.message, FIELD_IDS[field] ? field : null);
  }

  // The header and the service pages read the stored account's sign-up
  // flags, so they are brought up to date after every save.
  function refreshAccount() { return A.refresh().then(null, function () { /* the next page refreshes too */ }); }

  /* --------------------------------------------------------------- step 1 */

  $("wWaConsent").addEventListener("change", function () {
    $("wWaField").hidden = !this.checked;
    if (this.checked) $("wWhatsapp").focus();
  });

  $("wStep1").addEventListener("submit", function (event) {
    event.preventDefault();
    var form = this;
    clearErrors(form, "wError1");
    var missing = firstMissing(form);
    if (missing) { fail("wError1", MISSING[missing.id] || "Fill this in.", missing.name); return; }
    if ($("wWaConsent").checked && !val("wWhatsapp")) {
      fail("wError1", "Add your WhatsApp number, or untick the box.", "whatsapp");
      return;
    }
    busy(form, true);
    A.call("/profile", {
      step: 1, name: val("wName"), callMe: val("wCallMe"), expertise: val("wExpertise"), position: val("wPosition"), company: val("wCompany"),
      sector: $("wSector").value, location: val("wLocation"),
      consentWhatsapp: $("wWaConsent").checked, whatsapp: $("wWaConsent").checked ? val("wWhatsapp") : "",
      anonId: SP.anonId, page: location.pathname
    }).then(function (data) {
      profile = data.profile;
      return refreshAccount().then(function () { show(2); });
    }, function (e) { failed(form, "wError1", e); }).then(function () { busy(form, false); });
  });

  /* --------------------------------------------------------------- step 2 */

  var briefChoice = true;
  $("wBrief").addEventListener("click", function () { briefChoice = true; });
  $("wKeep").addEventListener("click", function () { briefChoice = false; });
  $("wBack").addEventListener("click", function () { show(1); $("wName").focus(); });

  $("wStep2").addEventListener("submit", function (event) {
    event.preventDefault();
    var form = this;
    // Enter in a field means the main button: brief GRIOT.
    var brief = event.submitter ? event.submitter.id !== "wKeep" : briefChoice;
    briefChoice = true;
    clearErrors(form, "wError2");
    var missing = firstMissing(form);
    if (missing) { fail("wError2", MISSING[missing.id] || "Fill this in.", missing.name); return; }
    var focus = [];
    var boxes = $("wFocus").querySelectorAll("input:checked");
    for (var i = 0; i < boxes.length; i++) focus.push(boxes[i].value);
    busy(form, true);
    A.call("/profile", {
      step: 2, problem: val("wProblem"), goal: val("wGoal"), goalBy: val("wGoalBy"), whyNow: val("wWhyNow"),
      focus: focus, briefGriot: brief, anonId: SP.anonId, page: location.pathname
    }).then(function (data) {
      profile = data.profile;
      return refreshAccount().then(function () { drawDone(); show(3); });
    }, function (e) { failed(form, "wError2", e); }).then(function () { busy(form, false); });
  });

  /* ---------------------------------------------------------------- ready */

  var STEP_OF = { Profile: 1 };

  function drawDone() {
    var p = profile;
    var told = (p && p.told) || [];
    var list = $("wTold");
    list.textContent = "";
    $("wMark").hidden = !(p && p.briefGriot);
    if (p && p.briefGriot) {
      $("wDoneTitle").textContent = "GRIOT now knows you.";
      $("wDoneLead").textContent = p.griot && p.griot.state === "sent"
        ? "This is exactly what GRIOT was told. It keeps it in mind in every answer."
        : "This is what GRIOT will be told. It is being switched on, so it will be told before your first question.";
      told.forEach(function (item) {
        var li = el("li");
        li.appendChild(el("strong", null, item.title));
        li.appendChild(el("span", null, item.content));
        var change = el("a", "welcome-change", "Change");
        change.href = "welcome.html?edit=1" + (STEP_OF[item.title] === 1 ? "" : "&step=2") + "&next=" + encodeURIComponent(next);
        change.setAttribute("aria-label", "Change " + item.title.toLowerCase());
        li.appendChild(change);
        list.appendChild(li);
      });
    } else {
      $("wDoneTitle").textContent = "You're set.";
      $("wDoneLead").textContent = "GRIOT has been told nothing. You can brief it any time by changing your answers.";
    }
    list.hidden = !list.children.length;

    var keys = (p && p.focus) || [];
    var pick = keys.filter(function (k) { return START[k] && START[k][0] !== next; })[0] || keys.filter(function (k) { return START[k]; })[0];
    $("wRec").hidden = !pick;
    if (pick) {
      $("wRecLink").href = START[pick][0];
      $("wRecLink").textContent = START[pick][1];
      $("wRecWhy").textContent = " " + START[pick][2];
    }

    var name = A.nextServiceName(next);
    $("wContinue").href = next;
    $("wContinue").textContent = next === "account.html" ? "Go to my account" : "Continue to " + name;
    $("wEdit").href = "welcome.html?edit=1&next=" + encodeURIComponent(next);
  }

  /* --------------------------------------------------------------- start */

  // The skip is for the Studio and the Rehearsal Room only: GRIOT needs
  // step 2 before its first question.
  $("wSkip").href = next;
  $("wSkip").hidden = forGriot || editing;

  A.call("/profile").then(function (data) {
    fillChoices(data);
    prefill(data);
    profile = data.profile;
    var p = profile;
    var done1 = !!(p && p.step1);
    var done2 = !!(p && p.step2);
    if (!editing && done1 && (done2 || !forGriot) && !params.get("step")) {
      // Nothing left to ask: straight on.
      window.location.replace(next);
      return;
    }
    show(done1 && (params.get("step") === "2" || (!editing && !done2)) ? 2 : 1);
  }, function (e) {
    if (e.status === 401) { window.location.replace("account.html?next=" + encodeURIComponent(next)); return; }
    $("wLoading").hidden = true;
    notice(e.message + " Reload the page to try again.");
  });
})();
