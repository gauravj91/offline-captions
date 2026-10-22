/* Dodo Payments hosted checkout + local prices + license key hand-off (since 22 Oct 2026; Paddle before).
   Config lives in site-config.js (DODO_*, LICENSE_API). Dodo is the merchant of record: it charges the
   localized price for the buyer's currency (INR, EUR, GBP, ...), adds VAT/GST and sends the receipt.
   Buy buttons open Dodo's static checkout link; after payment Dodo redirects back here with
   ?payment_id=…&status=…&email=…, our license server gets the webhook and issues the key, and we show it. */
(function () {
  var c = window.SITE_CONFIG || {};
  // Analytics (GA4 + consent banner) rides on this file because every page already loads it.
  if (c.GA_ID && !window.__ocAnalytics) { var ga = document.createElement("script"); ga.src = "/analytics.js"; ga.async = true; document.head.appendChild(ga); }
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }
  var api = (c.LICENSE_API || "").replace(/\/$/, "");

  // Returning from Dodo checkout (handled even while sales are closed, so test purchases work).
  var q = new URLSearchParams(location.search);
  if (q.get("payment_id")) {
    var pid = q.get("payment_id"), st = q.get("status"), em = q.get("email") || "";
    history.replaceState(null, "", location.pathname + location.hash);
    var go = function () {
      if (st === "succeeded" || st === "processing") {
        if (window.ocTrack) ocTrack("purchase", { transaction_id: pid });
        showThanks(em); pollKey(pid, em, 0);
      } else showFailed();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
  }

  if (!c.SALES_OPEN) { prelaunch(); return; }
  if (!c.DODO_PRODUCT_ID) return;

  // Before sales open: every Pre-order button sends people to the launch waitlist,
  // and the free web app is offered next to it. Flip SALES_OPEN to undo all of this.
  function prelaunch() {
    var form = document.querySelector("#checkout [data-waitlist]"), onHome = !!form;
    each("[data-checkout],[data-checkout-inr]", function (el) {
      var small = el.classList.contains("btn-sm");
      el.textContent = small ? "Get launch price" : "Get the launch price";
      el.setAttribute("href", onHome ? "#checkout" : "/#waitlist");
      if (onHome) el.addEventListener("click", function (e) {
        e.preventDefault();
        form.scrollIntoView({ behavior: "smooth", block: "center" });
        var i = form.querySelector('[type="email"]'); if (i) setTimeout(function () { i.focus({ preventScroll: true }); }, 400);
      });
    });
    var w = document.getElementById("waitlist");
    if (w) w.innerHTML = "Launching soon. Join the list to lock in the founding price of <strong>" + (c.PRICE_PREORDER || "$29") + "</strong>. We'll send one email when it's ready." +
      (c.WEB_APP_URL ? ' Want to try it now? <a href="' + c.WEB_APP_URL + '">Use the free web version</a>.' : "");
    if (form) { var b = form.querySelector("button"); if (b) b.textContent = "Notify me at launch"; }
    each("[data-prelaunch-hide]", function (el) { el.style.display = "none"; });
  }

  var local = null; // {currency, founding, full, founding_currency} from /api/price
  function checkoutUrl() {
    var host = c.DODO_ENV === "live" ? "https://checkout.dodopayments.com" : "https://test.checkout.dodopayments.com";
    var tier = c.DODO_TIER || "founding";
    var u = host + "/buy/" + encodeURIComponent(tier === "full" ? c.DODO_PRODUCT_ID_FULL : c.DODO_PRODUCT_ID) + "?quantity=1" +
      "&redirect_url=" + encodeURIComponent(location.origin + "/") +
      "&metadata_tier=" + tier + "&metadata_source=" + encodeURIComponent(location.pathname);
    var cur = local && (tier === "founding" ? local.founding_currency : local.currency);
    if (cur) u += "&paymentCurrency=" + cur;
    return u;
  }
  each("[data-checkout],[data-checkout-inr]", function (el) {
    el.addEventListener("click", function (e) {
      e.preventDefault();
      if (window.ocTrack) ocTrack("begin_checkout", { currency: (local && local.currency) || "USD", page: location.pathname });
      location.href = checkoutUrl();
    });
  });
  // Show the visitor's local price (the license server reads the country from Cloudflare geo).
  if (api) fetch(api + "/api/price").then(function (r) { return r.json(); }).then(function (p) {
    local = p;
    each('[data-cfg="PRICE_PREORDER"]', function (el) { el.textContent = p.founding; });
    each('[data-cfg="PRICE_FULL"]', function (el) { el.textContent = p.full; });
  }).catch(function () {});

  function showFailed() {
    var d = document.createElement("dialog");
    d.style.cssText = "max-width:480px;width:92vw;border:1px solid #333;border-radius:18px;background:#141417;color:#f2f2f2;padding:24px;font:16px/1.5 system-ui,sans-serif";
    d.innerHTML = '<h2 style="margin:0 0 8px">Payment didn\u2019t go through</h2><p style="margin:0;color:#aaa">You weren\u2019t charged. You can try again, or use another card or payment method.</p>' +
      '<div style="text-align:right;margin-top:16px"><button style="padding:10px 16px;border-radius:10px;border:1px solid #444;background:transparent;color:#eee;cursor:pointer">Close</button></div>';
    document.body.appendChild(d); d.querySelector("button").onclick = function () { d.close(); }; d.showModal();
  }

  // ---------- thank-you dialog ----------
  var dlg;
  function showThanks(email) {
    dlg = document.createElement("dialog");
    dlg.setAttribute("aria-labelledby", "oc-thx-h");
    dlg.style.cssText = "max-width:560px;width:92vw;border:1px solid #333;border-radius:18px;background:#141417;color:#f2f2f2;padding:28px;font:16px/1.5 system-ui,sans-serif";
    dlg.innerHTML =
      '<h2 id="oc-thx-h" style="margin:0 0 8px">Thank you! You\u2019re in.</h2>' +
      '<p style="margin:0 0 14px;color:#aaa">We\u2019ve emailed your receipt and key' + (email ? " to <b>" + esc(email) + "</b>" : "") + ". Here\u2019s your license key:</p>" +
      '<div id="oc-key" style="background:#0b0b0d;border:1px solid #333;border-radius:12px;padding:12px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;word-break:break-all;min-height:48px">Generating your key\u2026</div>' +
      '<p style="margin:14px 0 0;color:#aaa;font-size:14px">Open Offline Captions, click <b>Activate</b>, and paste it. Lost it later? <a href="/find-my-key/" style="color:#ffd60a">Find my key</a>.</p>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">' +
      '<button id="oc-copy" disabled style="padding:10px 16px;border-radius:10px;border:0;background:#ffd400;color:#111;font-weight:700;cursor:pointer">Copy key</button>' +
      '<button id="oc-close" style="padding:10px 16px;border-radius:10px;border:1px solid #444;background:transparent;color:#eee;cursor:pointer">Close</button></div>';
    document.body.appendChild(dlg);
    dlg.querySelector("#oc-close").onclick = function () { dlg.close(); };
    dlg.showModal();
  }
  function setKey(key, note) {
    if (!dlg) return;
    var box = dlg.querySelector("#oc-key");
    box.textContent = key || note;
    var b = dlg.querySelector("#oc-copy");
    if (key) {
      b.disabled = false;
      b.onclick = function () { navigator.clipboard.writeText(key).then(function () { b.textContent = "Copied"; }); };
    }
  }
  function pollKey(txn, email, n) {
    if (!api || !txn) return setKey(null, "Your key will arrive by email within a few minutes.");
    fetch(api + "/api/license?txn=" + encodeURIComponent(txn) + "&email=" + encodeURIComponent(email))
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (r) {
        if (r.status === 200 && r.j.key) return setKey(r.j.key);
        if (n < 60) return setTimeout(function () { pollKey(txn, email, n + 1); }, 2000);
        setKey(null, "Payment received. Your key is taking longer than usual and will arrive by email. Order ID: " + txn);
      })
      .catch(function () { if (n < 60) setTimeout(function () { pollKey(txn, email, n + 1); }, 2000); });
  }
  function esc(t) { return String(t).replace(/[&<>"]/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]; }); }
})();
