/* Paddle overlay checkout + local prices + license key hand-off.
   Config lives in site-config.js (PADDLE_*, LICENSE_API). Paddle is the merchant of record:
   it picks the buyer's currency and country price (INR in India, EUR in the eurozone, ...),
   adds VAT/GST, and sends the receipt. Our license server gets a webhook and issues the key,
   which we show here right after payment (and which is emailed too, once email is wired up). */
(function () {
  var c = window.SITE_CONFIG || {};
  // Analytics (GA4 + consent banner) rides on this file because every page already loads it.
  if (c.GA_ID && !window.__ocAnalytics) { var ga = document.createElement("script"); ga.src = "/analytics.js"; ga.async = true; document.head.appendChild(ga); }
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }
  if (!c.SALES_OPEN) { prelaunch(); return; }
  if (!c.PADDLE_CLIENT_TOKEN || !c.PADDLE_PRICE_ID) return;

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

  var s = document.createElement("script");
  s.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
  s.onload = init;
  document.head.appendChild(s);

  function init() {
    var P = window.Paddle;
    if (c.PADDLE_ENV === "sandbox") P.Environment.set("sandbox");
    P.Initialize({ token: c.PADDLE_CLIENT_TOKEN, eventCallback: onEvent });

    each("[data-checkout],[data-checkout-inr]", function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        P.Checkout.open({
          items: [{ priceId: c.PADDLE_PRICE_ID, quantity: 1 }],
          settings: { displayMode: "overlay", theme: "dark", variant: "one-page", allowLogout: true },
          customData: { source: location.pathname }
        });
        if (window.ocTrack) ocTrack("begin_checkout", { currency: "USD", value: 29, page: location.pathname });
      });
    });

    // Show the visitor's local price (Paddle detects the country from the IP).
    localPrice(P, c.PADDLE_PRICE_ID, "PRICE_PREORDER");
    if (c.PADDLE_PRICE_ID_FULL) localPrice(P, c.PADDLE_PRICE_ID_FULL, "PRICE_FULL");
  }

  function localPrice(P, priceId, cfgKey) {
    P.PricePreview({ items: [{ priceId: priceId, quantity: 1 }] }).then(function (r) {
      var li = r && r.data && r.data.details && r.data.details.lineItems && r.data.details.lineItems[0];
      var total = li && li.formattedTotals && li.formattedTotals.total;
      if (!total) return;
      total = total.replace(/[.,]00(?=\D*$)/, ""); // "₹1,499.00" -> "₹1,499"
      each('[data-cfg="' + cfgKey + '"]', function (el) { el.textContent = total; });
    }).catch(function () {});
  }

  function onEvent(ev) {
    if (!ev || ev.name !== "checkout.completed") return;
    var d = ev.data || {};
    var txn = d.transaction_id, email = (d.customer && d.customer.email) || "";
    setTimeout(function () { if (window.Paddle && window.Paddle.Checkout) window.Paddle.Checkout.close(); }, 1500);
    var tot = (d.totals && d.totals.total) || null, cur = d.currency_code || "USD";
    if (window.ocTrack) ocTrack("purchase", { transaction_id: txn, currency: cur, value: tot != null ? Number(tot) : undefined });
    showThanks(email);
    pollKey(txn, email, 0);
  }

  // ---------- thank-you dialog ----------
  var dlg;
  function showThanks(email) {
    dlg = document.createElement("dialog");
    dlg.setAttribute("aria-labelledby", "oc-thx-h");
    dlg.style.cssText = "max-width:560px;width:92vw;border:1px solid #333;border-radius:18px;background:#141417;color:#f2f2f2;padding:28px;font:16px/1.5 system-ui,sans-serif";
    dlg.innerHTML =
      '<h2 id="oc-thx-h" style="margin:0 0 8px">Thank you! You\u2019re in.</h2>' +
      '<p style="margin:0 0 14px;color:#aaa">Your receipt is on its way' + (email ? " to <b>" + esc(email) + "</b>" : "") + ". Here\u2019s your license key:</p>" +
      '<div id="oc-key" style="background:#0b0b0d;border:1px solid #333;border-radius:12px;padding:12px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;word-break:break-all;min-height:48px">Generating your key\u2026</div>' +
      '<p style="margin:14px 0 0;color:#aaa;font-size:14px">Open Offline Captions, click <b>Activate</b>, and paste it. Keep it somewhere safe.</p>' +
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
    if (!c.LICENSE_API || !txn) return setKey(null, "Your key will arrive by email within a few minutes.");
    fetch(c.LICENSE_API.replace(/\/$/, "") + "/api/license?txn=" + encodeURIComponent(txn) + "&email=" + encodeURIComponent(email))
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
