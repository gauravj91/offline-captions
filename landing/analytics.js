/* Google Analytics 4 for offlinecaptions.com and app.offlinecaptions.com (one GA4 web stream).
   - GA_ID comes from site-config.js. Empty GA_ID = no analytics at all.
   - Consent Mode v2: analytics cookies stay off until the visitor accepts. Until then GA only
     gets cookieless pings. Ads signals are always denied (we run no ads).
   - The visitor's choice is saved in a cookie on .offlinecaptions.com, so the site and the
     web app share it and the banner shows only once.
   - window.ocTrack(name, params) sends a product event (a no-op when GA is off).
   Never send file names, transcripts or emails to GA: only counts, buckets and settings. */
(function () {
  var c = window.SITE_CONFIG || {};
  window.ocTrack = function () {};
  if (!c.GA_ID || window.__ocAnalytics) return;
  window.__ocAnalytics = true;

  var KEY = "oc_consent";
  function getChoice() {
    var m = document.cookie.match(/(?:^|; )oc_consent=(granted|denied)/);
    if (m) return m[1];
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function saveChoice(v) {
    var host = location.hostname, dom = /offlinecaptions\.com$/.test(host) ? "; domain=.offlinecaptions.com" : "";
    document.cookie = KEY + "=" + v + "; max-age=" + 60 * 60 * 24 * 365 + "; path=/; SameSite=Lax" + dom + (location.protocol === "https:" ? "; Secure" : "");
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  var choice = getChoice();
  gtag("consent", "default", {
    ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied",
    analytics_storage: choice === "granted" ? "granted" : "denied",
    wait_for_update: 500
  });
  gtag("set", "ads_data_redaction", true);
  gtag("js", new Date());
  gtag("config", c.GA_ID, {
    cookie_domain: "auto",
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    site_area: /^app\./.test(location.hostname) ? "web_app" : "site"
  });

  var s = document.createElement("script");
  s.async = true;
  s.crossOrigin = "anonymous"; // the web app runs cross-origin isolated (COEP); Google serves CORS + CORP
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(c.GA_ID);
  document.head.appendChild(s);

  window.ocTrack = function (name, params) {
    try { gtag("event", name, params || {}); } catch (e) {}
  };

  // ---- consent banner ----
  function banner() {
    if (getChoice()) return;
    var b = document.createElement("div");
    b.setAttribute("role", "dialog");
    b.setAttribute("aria-label", "Analytics choice");
    var small = window.matchMedia && window.matchMedia("(max-width: 600px)").matches;
    // Phones: compact strip at the TOP so it never covers Export / bottom controls.
    b.style.cssText = (small
      ? "position:fixed;left:8px;right:8px;top:8px;padding:8px 10px;gap:8px;font:13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;flex-wrap:nowrap;"
      : "position:fixed;left:12px;right:12px;bottom:12px;padding:12px 14px;gap:12px;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;flex-wrap:wrap;") +
      "z-index:2147483000;max-width:560px;margin:0 auto;background:#15161a;color:#f2f2f2;border:1px solid #2c2e35;border-radius:12px;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.35);display:flex;align-items:center";
    var privacy = (c.SITE_URL || "https://offlinecaptions.com").replace(/\/$/, "") + "/privacy/";
    var txt = small
      ? 'Analytics cookies? Videos never leave your device. <a href="' + privacy + '" style="color:#9ecbff">Privacy</a>'
      : 'We use Google Analytics to see which features people use. No ads, and your videos never leave your device. <a href="' + privacy + '" style="color:#9ecbff">Privacy</a>';
    var bh = 'min-height:44px;min-width:44px;';
    b.innerHTML = '<span style="flex:1 1 ' + (small ? '0' : '260px') + ';min-width:0">' + txt + '</span>' +
      '<span style="display:flex;gap:6px;flex:0 0 auto"><button data-v="denied" style="' + bh + 'background:transparent;color:#f2f2f2;border:1px solid #444;border-radius:8px;padding:7px 12px;cursor:pointer;font:inherit">Decline</button>' +
      '<button data-v="granted" style="' + bh + 'background:#f2f2f2;color:#111;border:0;border-radius:8px;padding:7px 14px;cursor:pointer;font:inherit;font-weight:600">Accept</button></span>';
    b.addEventListener("click", function (e) {
      var v = e.target && e.target.getAttribute && e.target.getAttribute("data-v");
      if (!v) return;
      saveChoice(v);
      gtag("consent", "update", { analytics_storage: v });
      ocTrack("consent_choice", { choice: v });
      b.remove();
    });
    document.body.appendChild(b);
  }
  if (document.body) banner(); else document.addEventListener("DOMContentLoaded", banner);

  // ---- marketing-site events (cheap, delegated; the web app sends its own) ----
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (f && f.matches && f.matches("[data-waitlist]")) {
      var seg = (f.querySelector('[name="segment"]') || {}).value || "launch";
      ocTrack("waitlist_signup", { segment: seg, page: location.pathname });
    }
  }, true);
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest && e.target.closest("a,button");
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (a.hasAttribute("data-checkout") || a.hasAttribute("data-checkout-inr")) ocTrack("launch_price_click", { page: location.pathname, inr: a.hasAttribute("data-checkout-inr") });
    else if (/^https:\/\/app\.offlinecaptions\.com/.test(href)) ocTrack("try_web_app_click", { page: location.pathname });
  }, true);
})();
