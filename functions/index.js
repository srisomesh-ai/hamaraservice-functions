// ═══════════════════════════════════════════════════════════
// HamaraService Cloud Functions
//
// Only one function remains: notifyBooking — an FCM relay used by the
// PHP backend (api/db.php → sendPush). It is protected by a shared key
// (header X-HS-Key) so it is no longer an open push relay.
//
// Removed (now handled server-side in PHP / MySQL):
//   createOrder, verifyPayment  → bookings.php?action=create_order / razorpay_confirm
//   onBookingChange (RTDB)      → bookings are no longer stored in Firebase
//
// Setup once:
//   firebase functions:secrets:set HS_PUSH_KEY   (same value as PUSH_KEY in ~/hs-secrets.php)
// ═══════════════════════════════════════════════════════════
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const crypto = require("crypto");

initializeApp();

const REGION = "asia-southeast1";
const HS_PUSH_KEY = defineSecret("HS_PUSH_KEY");

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

exports.notifyBooking = onRequest(
  { region: REGION, secrets: [HS_PUSH_KEY], cors: false },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
    if (!safeEqual(req.get("X-HS-Key"), HS_PUSH_KEY.value())) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { event, fcmToken, data = {} } = req.body || {};
    if (!fcmToken) { res.status(400).json({ error: "fcmToken is required" }); return; }

    const tpl = getNotificationContent(event || "admin_broadcast", data);
    const title = String(req.body.title || data.title || tpl.title).slice(0, 200);
    const body  = String(req.body.body  || data.body  || tpl.body).slice(0, 1000);

    try {
      const id = await sendFCM(fcmToken, { title, body }, { ...data, event: event || "notification" });
      res.json({ sent: true, messageId: id });
    } catch (err) {
      console.error(`Notification failed [${event}]:`, err.message);
      res.status(500).json({ sent: false, error: err.message });
    }
  }
);

// DATA-ONLY message: the Flutter apps display it themselves (foreground and
// background handlers), which avoids duplicate system + local notifications.
function sendFCM(token, notification, data = {}) {
  const allData = {
    ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    title: notification.title || "HamaraService",
    body:  notification.body  || "You have a new update.",
    click_action: "FLUTTER_NOTIFICATION_CLICK",
    channel_id:   "hamaraservice_high_priority",
  };
  return getMessaging().send({
    token,
    data: allData,
    android: { priority: "high", ttl: 60 * 60 * 1000 },
    apns: {
      headers: { "apns-priority": "10", "apns-push-type": "background" },
      payload: { aps: { "content-available": 1, sound: "default", badge: 1 } },
    },
  });
}

function getNotificationContent(event, data) {
  const templates = {
    admin_broadcast:    { title: "HamaraService", body: data.message || "You have a new message." },
    new_booking:        { title: "🔔 New Job Alert!", body: "New service request near you. Open the app to quote." },
    price_quoted:       { title: "💰 Provider Sent a Price!", body: `Quote: ₹${data.quotedPrice || 0}. Tap to view.` },
    price_negotiation:  { title: "💬 Customer is Negotiating", body: `Customer countered with ₹${data.counterPrice || 0}.` },
    negotiation_final:  { title: "💰 Final Price Offer!", body: `Provider's final price: ₹${data.finalPrice || 0}.` },
    price_confirmed:    { title: "✅ Price Confirmed!", body: `Booking confirmed at ₹${data.confirmedPrice || 0}.` },
    booking_confirmed:  { title: "✅ Job Confirmed", body: "Customer confirmed. Head to the location." },
    provider_declined:  { title: "🔍 Searching Another Provider", body: "We are finding another provider for you." },
    booking_released:   { title: "Booking Released", body: "Customer chose another provider." },
    service_started:    { title: "✅ Service Started", body: "Your service has started." },
    completion_otp_ready: { title: "🔑 Completion OTP", body: "Your provider has finished. Share the completion OTP if satisfied." },
    completed:          { title: "🎉 Service Completed", body: `Please pay ₹${data.amount || 0}.` },
    payment_done:       { title: "✅ Payment Recorded", body: "Thank you! Please rate your provider." },
    payment_received:   { title: "💰 Payment Received!", body: `₹${data.amount || 0} added to your wallet.` },
    booking_cancelled:  { title: "❌ Booking Cancelled", body: "A booking was cancelled." },
    new_review:         { title: "⭐ New Review!", body: `You got a ${data.rating || 5}★ review.` },
    review_requested:   { title: "⭐ Review Request", body: "Your provider is asking for a review." },
    payout_approved:    { title: "✅ Payout Approved!", body: `₹${data.amount || 0} has been transferred.` },
    account_approved:   { title: "✅ Account Approved", body: "You can now go online and receive jobs." },
  };
  return templates[event] || { title: "HamaraService", body: "You have a new update." };
}
