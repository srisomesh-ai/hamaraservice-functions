const { onValueWritten } = require("firebase-functions/v2/database");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getMessaging } = require("firebase-admin/messaging");
const https = require("https");

initializeApp({
  databaseURL: "https://hamaraservice-s009-default-rtdb.asia-southeast1.firebasedatabase.app"
});

// Razorpay keys live in Secret Manager — set them with:
//   firebase functions:secrets:set RAZORPAY_KEY_ID
//   firebase functions:secrets:set RAZORPAY_KEY_SECRET
const RAZORPAY_KEY_ID     = defineSecret("RAZORPAY_KEY_ID");
const RAZORPAY_KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET");

const REGION = "asia-southeast1";
const DB_INSTANCE = "hamaraservice-s009-default-rtdb";

// ═══════════════════════════════════════════════════════════
// 1. CREATE RAZORPAY ORDER (replaces create-order.php)
// ═══════════════════════════════════════════════════════════
exports.createOrder = onRequest(
  { region: REGION, cors: true, secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

    const { bookingId, amount, service, customerId, providerId } = req.body;
    if (!amount || !bookingId) {
      res.status(400).json({ error: "amount and bookingId required" });
      return;
    }

    const amountPaise = Math.round(Number(amount) * 100); // Razorpay uses paise
    if (!Number.isFinite(amountPaise) || amountPaise < 100) {
      res.status(400).json({ error: "invalid amount" });
      return;
    }
    const keyId     = RAZORPAY_KEY_ID.value();
    const keySecret = RAZORPAY_KEY_SECRET.value();

    const orderData = JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt: `hs_${bookingId}`.substring(0, 40),
      notes: { bookingId, service: service || "", customerId: customerId || "", providerId: providerId || "" }
    });

    try {
      const order = await razorpayRequest("POST", "/v1/orders", orderData, keyId, keySecret);
      res.json({
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        key_id: keyId,
      });
    } catch (err) {
      console.error("Razorpay order error:", err);
      res.status(500).json({ error: err.message || "Failed to create order" });
    }
  }
);

// ═══════════════════════════════════════════════════════════
// 2. VERIFY RAZORPAY PAYMENT (replaces verify-payment.php)
// ═══════════════════════════════════════════════════════════
exports.verifyPayment = onRequest(
  { region: REGION, cors: true, secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature,
            booking_id, amount, provider_id, customer_id } = req.body;

    const crypto = require("crypto");
    const keyId     = RAZORPAY_KEY_ID.value();
    const keySecret = RAZORPAY_KEY_SECRET.value();
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !booking_id ||
        !/^[A-Za-z0-9_-]+$/.test(String(booking_id))) {
      res.status(400).json({ verified: false, error: "missing or invalid fields" });
      return;
    }
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSig = crypto.createHmac("sha256", keySecret).update(body).digest("hex");
    const sigOk = typeof razorpay_signature === "string" &&
      razorpay_signature.length === expectedSig.length &&
      crypto.timingSafeEqual(Buffer.from(razorpay_signature), Buffer.from(expectedSig));

    if (!sigOk) {
      console.log("Signature mismatch for booking:", booking_id);
      res.status(400).json({ verified: false, error: "Signature mismatch" });
      return;
    }

    try {
      // The order must have been created for this booking and actually be paid
      const order = await razorpayRequest("GET", `/v1/orders/${encodeURIComponent(razorpay_order_id)}`, "", keyId, keySecret);
      if (String(order.notes?.bookingId || "") !== String(booking_id)) {
        res.status(400).json({ verified: false, error: "Order does not belong to this booking" });
        return;
      }
      const payment = await razorpayRequest("GET", `/v1/payments/${encodeURIComponent(razorpay_payment_id)}`, "", keyId, keySecret);
      if (payment.order_id !== razorpay_order_id ||
          !["authorized", "captured"].includes(payment.status) ||
          payment.amount !== order.amount) {
        res.status(400).json({ verified: false, error: "Payment not valid for this order" });
        return;
      }

      const db = getDatabase();
      const updates = {
        [`bookings/${booking_id}/paymentVerified`]: true,
        [`bookings/${booking_id}/razorpayPaymentId`]: razorpay_payment_id,
        [`bookings/${booking_id}/razorpayOrderId`]: razorpay_order_id,
        [`bookings/${booking_id}/amountPaid`]: payment.amount / 100,
      };
      await db.ref().update(updates);
      console.log(`Payment verified for booking: ${booking_id}`);
      res.json({ verified: true, booking_id, amount: payment.amount / 100 });
    } catch (err) {
      console.error("Payment verification error:", err);
      res.status(500).json({ verified: false, error: "Verification failed" });
    }
  }
);

// ═══════════════════════════════════════════════════════════
// 3. SEND NOTIFICATION (replaces notify_booking.php)
// ═══════════════════════════════════════════════════════════
exports.notifyBooking = onRequest(
  { region: REGION, cors: true },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

    const { event, fcmToken, data = {} } = req.body;
    if (!fcmToken || typeof fcmToken !== "string") {
      res.status(400).json({ error: "fcmToken is required" });
      return;
    }
    // This endpoint is unauthenticated, so only fixed templates are allowed —
    // free-form title/body (and admin_broadcast) would make it an open spam relay.
    if (!event || event === "admin_broadcast" || !NOTIFICATION_EVENTS.has(event)) {
      res.status(400).json({ error: "unknown event" });
      return;
    }
    const safeData = Object.fromEntries(
      Object.entries(data && typeof data === "object" ? data : {})
        .slice(0, 20)
        .map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 80)])
    );
    const notification = getNotificationContent(event, safeData);
    const message = {
      token: fcmToken,
      notification: { title: notification.title, body: notification.body },
      data: { ...safeData, event },
      android: {
        priority: "high",
        notification: {
          channelId: "hamaraservice_high_priority",
          sound: "default",
          defaultSound: true,
          defaultVibrateTimings: true,
          notificationPriority: "PRIORITY_MAX",
          visibility: "PUBLIC",
        },
      },
      apns: {
        headers: { "apns-priority": "10" },
        payload: { aps: { sound: "default", badge: 1, "content-available": 1 } },
      },
    };

    try {
      const result = await getMessaging().send(message);
      console.log(`Notification sent [${event}]: ${result}`);
      res.json({ sent: true, messageId: result });
    } catch (err) {
      console.error(`Notification failed [${event}]:`, err.message);
      res.status(500).json({ sent: false, error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════
// 4. AUTO-NOTIFY ON BOOKING STATUS CHANGE (existing, improved)
// ═══════════════════════════════════════════════════════════
exports.onBookingChange = onValueWritten(
  { ref: "/active_bookings/{bookingId}", region: REGION, instance: DB_INSTANCE },
  async (event) => {
    const bookingId = event.params.bookingId;
    const after  = event.data.after.val();
    const before = event.data.before.val();
    if (!after) return null;

    const db = getDatabase();

    // New booking searching → notify nearby providers
    if (after.status === "searching" && !after.acceptedBy &&
        (!before || before.status !== "searching")) {
      await notifyNearbyProviders(bookingId, after);
    }

    // Provider accepted → notify customer
    if (after.status === "accepted" && (!before || before.status !== "accepted")) {
      await notifyCustomerAccepted(bookingId, after);
    }

    // OTP sent → notify customer
    if (after.status === "otp_sent" && (!before || before.status !== "otp_sent")) {
      const otpSnap = await db.ref(`job_otp/${bookingId}`).once("value");
      const otp = otpSnap.val()?.otp || "";
      if (otp) await notifyCustomerOTP(bookingId, after, otp);
    }

    // Payment completed → notify provider
    if (after.status === "completed" && (!before || before.status !== "completed")) {
      await notifyProviderPayment(bookingId, after);
    }

    return null;
  }
);

// ═══════════════════════════════════════════════════════════
// NOTIFICATION HELPERS
// ═══════════════════════════════════════════════════════════
async function notifyNearbyProviders(bookingId, booking) {
  const db = getDatabase();
  const svcId   = booking.svcId   || "";   // e.g. "SVC001"
  const svcName = (booking.service || "").toLowerCase();
  const bookingLat = booking.lat || 0;
  const bookingLng = booking.lng || 0;
  const range = booking.range || 50; // increased to 50km default

  const snap = await db.ref("providers").once("value");
  if (!snap.exists()) {
    console.log("No providers found in database");
    return;
  }

  const sends = [];
  let skipped = 0;

  for (const [pid, provider] of Object.entries(snap.val())) {
    // Must be available, approved, and have FCM token
    if (!provider.available) { skipped++; continue; }
    if (provider.status !== "approved") { skipped++; continue; }
    if (!provider.fcmToken) { skipped++; continue; }

    // Check if provider offers this service.
    // Supports ALL storage formats from provider app:
    // Format A: Array of objects  [{ name:"House Maid", id:"SVC001", ... }]  ← current provider app format
    // Format B: Simple array      ["SVC001", "House Maid"]
    // Format C: Object map        { "SVC001": true }
    // Format D: null/undefined    → provider offers all services
    const services = provider.services;
    if (services) {
      let hasService = false;
      if (Array.isArray(services)) {
        hasService = services.some(s => {
          if (s === null || s === undefined) return false;
          if (typeof s === "string") {
            // Format B — check by svcId or name
            return (svcId && s === svcId) || s.toLowerCase() === svcName;
          }
          if (typeof s === "object") {
            // Format A — array of {name, id, price, subRates}
            const nameMatch = (s.name || "").toLowerCase() === svcName;
            const idMatch   = svcId ? (s.id === svcId) : false;
            return nameMatch || idMatch;
          }
          return false;
        });
      } else if (typeof services === "object") {
        // Format C — { "SVC001": true }
        if (svcId && services[svcId] !== undefined) {
          hasService = services[svcId] === true;
        } else {
          hasService = Object.entries(services).some(([k, v]) =>
            v === true && (k === svcId || k.toLowerCase() === svcName)
          );
        }
      }
      if (!hasService) { skipped++; continue; }
    }
    // null/undefined services → provider offers all, always notify

    // Distance check — skip if too far
    if (bookingLat && bookingLng && provider.lat && provider.lng) {
      const dist = haversine(bookingLat, bookingLng, provider.lat, provider.lng);
      if (dist > range) { skipped++; continue; }
    }

    const amount = booking.priceVal || booking.price || 0;
    sends.push(sendFCM(provider.fcmToken, {
      title: "🔔 New Job Alert!",
      body: `${booking.service || "New booking"} · ₹${amount} · ${booking.address || ""}`,
    }, {
      bookingId,
      type: "new_booking",
      amount: String(amount),
      service: booking.service || "",
      svcId: svcId,
    }));
  }

  if (sends.length) await Promise.allSettled(sends);
  console.log(`Booking ${bookingId}: notified ${sends.length} providers, skipped ${skipped}`);
}

async function notifyCustomerAccepted(bookingId, booking) {
  const db = getDatabase();
  const custSnap = await db.ref(`customers/${booking.customerId}/fcmToken`).once("value");
  const token = custSnap.val();
  if (!token) return;
  const name = booking.providerName || booking.acceptedBy?.name || "Your provider";
  await sendFCM(token, {
    title: "✅ Provider Accepted!",
    body: `${name} accepted your ${booking.service || "service"} booking. They're on the way!`,
  }, { bookingId, type: "booking_accepted", providerName: name });
}

async function notifyCustomerOTP(bookingId, booking, otp) {
  const db = getDatabase();
  const custSnap = await db.ref(`customers/${booking.customerId}/fcmToken`).once("value");
  const token = custSnap.val();
  if (!token) return;
  await sendFCM(token, {
    title: "🔐 Share OTP to Complete",
    body: `Your OTP is ${otp}. Share with provider to complete ${booking.service || "service"}.`,
  }, { bookingId, type: "otp_requested", otp });
}

async function notifyProviderPayment(bookingId, booking) {
  const db = getDatabase();
  if (!booking.providerId) return;
  const provSnap = await db.ref(`providers/${booking.providerId}/fcmToken`).once("value");
  const token = provSnap.val();
  if (!token) return;
  const amount = booking.amountPaid || booking.priceVal || booking.price || 0;
  await sendFCM(token, {
    title: "💰 Payment Received!",
    body: `₹${amount} received for ${booking.service || "service"}. Great work!`,
  }, { bookingId, type: "payment_received", amount: String(amount) });
}

async function sendFCM(token, notification, data = {}) {
  // DATA-ONLY message — no notification block
  // This ensures Flutter's background handler fires even when app is KILLED
  // Flutter shows the notification itself via flutter_local_notifications
  const allData = {
    ...Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])),
    title: notification.title || "HamaraService",
    body:  notification.body  || "You have a new update.",
    click_action: "FLUTTER_NOTIFICATION_CLICK",
    channel_id:   "hamaraservice_high_priority",
  };

  return getMessaging().send({
    token,
    // NO notification block — data only so Flutter handles it in background
    data: allData,
    android: {
      priority: "high",
      ttl: 60 * 60 * 1000, // 1 hour TTL
      restrictedPackageName: undefined,
    },
    apns: {
      headers: {
        "apns-priority": "10",
        "apns-push-type": "background",
      },
      payload: {
        aps: {
          "content-available": 1,
          sound: "default",
          badge: 1,
        },
      },
    },
  });
}

const NOTIFICATION_EVENTS = new Set([
  "booking_accepted", "payment_received", "otp_requested", "new_booking", "booking_cancelled",
  "payout_approved", "new_review", "price_quoted", "price_negotiation", "negotiation_final",
  "price_confirmed", "provider_declined", "otp_verified",
]);

function getNotificationContent(event, data) {
  const templates = {
    admin_broadcast:           { title: data.title || "HamaraService", body: data.body || data.message || "You have a new message." },
    booking_accepted:          { title: "✅ Provider Accepted!", body: `${data.providerName || "Provider"} accepted your ${data.service || "booking"}.` },
    payment_received:          { title: "💰 Payment Received!", body: `₹${data.amount || 0} received for ${data.service || "service"}. Great work!` },
    otp_requested:             { title: "🔐 OTP Required", body: `Your OTP is ${data.otp || "----"}. Share with provider to complete service.` },
    new_booking:               { title: "🔔 New Job Alert!", body: `New ${data.service || "service"} booking nearby. ₹${data.amount || 0}.` },
    booking_cancelled:         { title: "❌ Booking Cancelled", body: `Your ${data.service || "booking"} was cancelled.` },
    payout_approved:           { title: "✅ Payout Approved!", body: `Your withdrawal of ₹${data.amount || 0} has been approved.` },
    new_review:                { title: "⭐ New Review!", body: `You got a ${data.rating || 5}★ review for ${data.service || "service"}.` },
    // Negotiation events
    price_quoted:              { title: "💰 Provider Sent a Price!", body: `${data.providerName || "Provider"} quoted ₹${data.quotedPrice || 0} for your booking. Tap to view.` },
    price_negotiation:         { title: "💬 Customer is Negotiating", body: data.counterPrice && data.counterPrice !== "0" ? `Customer countered with ₹${data.counterPrice}. Send your final offer.` : "Customer wants to negotiate. Respond now." },
    negotiation_final:         { title: "💰 Final Price Offer!", body: `Provider's final price: ₹${data.finalPrice || 0}. Accept or search another provider.` },
    price_confirmed:           { title: "✅ Price Confirmed!", body: `Booking confirmed at ₹${data.confirmedPrice || 0}. Proceed to service.` },
    provider_declined:         { title: "🔍 Searching Another Provider", body: "Provider declined. We are searching for another provider for you." },
    otp_verified:              { title: "✅ Job Completed!", body: `OTP verified. Please complete payment of ₹${data.amount || 0}.` },
  };
  return templates[event] || { title: "HamaraService", body: data.message || "You have a new update." };
}

// ── Razorpay HTTPS helper ─────────────────────────────────
function razorpayRequest(method, path, body, keyId, keySecret) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const options = {
      hostname: "api.razorpay.com",
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${auth}`,
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error?.description || parsed.error || JSON.stringify(parsed)));
          }
        } catch(e) { reject(new Error("Invalid JSON: " + data)); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Haversine distance ────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
