const { onValueWritten } = require("firebase-functions/v2/database");
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getMessaging } = require("firebase-admin/messaging");
const https = require("https");

initializeApp({
  databaseURL: "https://hamaraservice-s009-default-rtdb.asia-southeast1.firebasedatabase.app"
});

// Razorpay keys — switch to live keys when going live
const RAZORPAY_KEY_ID     = { value: () => "rzp_test_Sp87HrFA8UHblM" };
const RAZORPAY_KEY_SECRET = { value: () => "FGo78kZC0992nb0Ug6nxNFB1" };

const REGION = "asia-southeast1";
const DB_INSTANCE = "hamaraservice-s009-default-rtdb";

// ═══════════════════════════════════════════════════════════
// 1. CREATE RAZORPAY ORDER (replaces create-order.php)
// ═══════════════════════════════════════════════════════════
exports.createOrder = onRequest(
  { region: REGION, cors: true },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

    const { bookingId, amount, service, customerId, providerId } = req.body;
    if (!amount || !bookingId) {
      res.status(400).json({ error: "amount and bookingId required" });
      return;
    }

    const amountPaise = Math.round(Number(amount) * 100); // Razorpay uses paise
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
  { region: REGION, cors: true },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature,
            booking_id, amount, provider_id, customer_id } = req.body;

    const crypto = require("crypto");
    const keySecret = RAZORPAY_KEY_SECRET.value();
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSig = crypto.createHmac("sha256", keySecret).update(body).digest("hex");

    if (expectedSig !== razorpay_signature) {
      console.log("Signature mismatch for booking:", booking_id);
      res.status(400).json({ verified: false, error: "Signature mismatch" });
      return;
    }

    // Signature valid — update Firebase
    const db = getDatabase();
    try {
      const updates = {
        [`bookings/${booking_id}/paymentVerified`]: true,
        [`bookings/${booking_id}/razorpayPaymentId`]: razorpay_payment_id,
        [`bookings/${booking_id}/razorpayOrderId`]: razorpay_order_id,
      };
      await db.ref().update(updates);
      console.log(`Payment verified for booking: ${booking_id}`);
      res.json({ verified: true, booking_id });
    } catch (err) {
      res.status(500).json({ verified: false, error: err.message });
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

    const { event, fcmToken, title: directTitle, body: directBody, data = {} } = req.body;
    if (!fcmToken) {
      res.status(400).json({ error: "fcmToken is required" });
      return;
    }
    // Support direct title+body OR event-based
    const notification = (directTitle && directBody)
      ? { title: directTitle, body: directBody }
      : getNotificationContent(event || "admin_broadcast", { ...data, title: directTitle, body: directBody });
    const message = {
      token: fcmToken,
      notification: { title: notification.title, body: notification.body },
      data: Object.fromEntries(Object.entries({ ...data, event }).map(([k,v]) => [k, String(v)])),
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
  const svcName = (booking.service || "").toLowerCase();
  const bookingLat = booking.lat || 0;
  const bookingLng = booking.lng || 0;
  const range = booking.range || 20;

  const snap = await db.ref("providers").once("value");
  if (!snap.exists()) return;

  const sends = [];
  for (const [pid, provider] of Object.entries(snap.val())) {
    if (!provider.available || provider.status !== "approved" || !provider.fcmToken) continue;
    const services = provider.services || [];
    const hasService = Array.isArray(services) &&
      services.some(s => ((s && s.name) || s || "").toLowerCase() === svcName);
    if (!hasService) continue;
    if (bookingLat && bookingLng && provider.lat && provider.lng) {
      if (haversine(bookingLat, bookingLng, provider.lat, provider.lng) > range) continue;
    }
    const amount = booking.priceVal || booking.price || 0;
    sends.push(sendFCM(provider.fcmToken, {
      title: "🔔 New Job Alert!",
      body: `${booking.service} · ₹${amount} · ${booking.address || ""}`,
    }, { bookingId, type: "new_booking", amount: String(amount), service: booking.service || "" }));
  }
  if (sends.length) await Promise.allSettled(sends);
  console.log(`Notified ${sends.length} providers for booking ${bookingId}`);
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
  return getMessaging().send({
    token,
    notification,
    data: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])),
    android: {
      priority: "high",
      notification: {
        channelId: "hamaraservice_high_priority",
        sound: "default",
        defaultVibrateTimings: true,
        notificationPriority: "PRIORITY_MAX",
        visibility: "PUBLIC",
      },
    },
    apns: {
      headers: { "apns-priority": "10" },
      payload: { aps: { sound: "default", badge: 1, "content-available": 1 } },
    },
  });
}

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
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Invalid JSON: " + data)); }
      });
    });
    req.on("error", reject);
    req.write(body);
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
