const {onValueWritten} = require("firebase-functions/v2/database");
const {initializeApp} = require("firebase-admin/app");
const {getDatabase} = require("firebase-admin/database");
const {getMessaging} = require("firebase-admin/messaging");

initializeApp({
  databaseURL: "https://hamaraservice-s009-default-rtdb.asia-southeast1.firebasedatabase.app"
});

// ── Notify providers when new booking is searching ─────────────
exports.notifyProviders = onValueWritten(
  {
    ref: "/active_bookings/{bookingId}",
    region: "asia-southeast1",
    instance: "hamaraservice-s009-default-rtdb",
  },
  async (event) => {
    const bookingId = event.params.bookingId;
    const booking = event.data.after.val();

    console.log(`Triggered for booking: ${bookingId}`);

    if (!booking) return null;

    // ── Notify providers when searching ──────────────────────
    if (booking.status === "searching" && !booking.acceptedBy) {
      console.log(`Notifying providers for: ${bookingId}`);
      await notifyNearbyProviders(bookingId, booking);
    }

    // ── Notify customer when provider accepts ─────────────────
    const prevBooking = event.data.before.val();
    const justAccepted = booking.status === "accepted" &&
      (!prevBooking || prevBooking.status !== "accepted");

    if (justAccepted && booking.customerId) {
      console.log(`Provider accepted booking: ${bookingId}, notifying customer`);
      await notifyCustomer(bookingId, booking);
    }

    return null;
  }
);

async function notifyNearbyProviders(bookingId, booking) {
  const svcName = (booking.service || "").toLowerCase();
  const bookingLat = booking.lat || 0;
  const bookingLng = booking.lng || 0;
  const range = booking.range || 20;

  const db = getDatabase();
  const providersSnap = await db.ref("providers").once("value");
  if (!providersSnap.exists()) return;

  const providers = providersSnap.val();
  const notifications = [];

  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider.available) continue;
    if (provider.status !== "approved") continue;
    if (!provider.fcmToken) continue;

    const services = provider.services || [];
    const hasService = Array.isArray(services) && services.some((s) => {
      const name = ((s && s.name) || s || "").toLowerCase();
      return name === svcName;
    });
    if (!hasService) continue;

    if (bookingLat && bookingLng && provider.lat && provider.lng) {
      const dist = haversine(bookingLat, bookingLng, provider.lat, provider.lng);
      if (dist > range) continue;
    }

    const amount = booking.priceVal || booking.price || 0;
    const message = {
      token: provider.fcmToken,
      notification: {
        title: "🔔 New Booking Alert!",
        body: `${booking.service} · ₹${amount} · ${booking.date || ""} ${booking.time || ""}`,
      },
      data: {
        bookingId: bookingId,
        service: booking.service || "",
        type: "new_booking",
        amount: String(amount),
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
      android: {
        priority: "high",
        notification: {
          channelId: "booking_alerts",
          sound: "default",
          defaultSound: true,
          defaultVibrateTimings: true,
          notificationPriority: "PRIORITY_MAX",
          visibility: "PUBLIC",
        },
      },
    };

    notifications.push(
      getMessaging().send(message)
        .then(() => console.log(`Notified provider: ${providerId}`))
        .catch((err) => console.log(`Failed provider ${providerId}: ${err.message}`))
    );
  }

  if (notifications.length > 0) await Promise.all(notifications);
  console.log(`Sent ${notifications.length} provider notifications`);
}

async function notifyCustomer(bookingId, booking) {
  const customerId = booking.customerId;
  if (!customerId) return;

  const db = getDatabase();
  const customerSnap = await db.ref(`customers/${customerId}`).once("value");
  if (!customerSnap.exists()) return;

  const customer = customerSnap.val();
  const fcmToken = customer.fcmToken;
  if (!fcmToken) {
    console.log(`No FCM token for customer: ${customerId}`);
    return;
  }

  const providerName = booking.providerName || booking.acceptedBy?.name || "Your provider";
  const providerPhone = booking.acceptedBy?.phone || "";
  const service = booking.service || "Service";

  const message = {
    token: fcmToken,
    notification: {
      title: "✅ Provider Accepted Your Booking!",
      body: `${providerName} will arrive soon for ${service}. Tap to view details.`,
    },
    data: {
      bookingId: bookingId,
      type: "booking_accepted",
      providerName: providerName,
      providerPhone: providerPhone,
      click_action: "FLUTTER_NOTIFICATION_CLICK",
    },
    android: {
      priority: "high",
      notification: {
        channelId: "booking_updates",
        sound: "default",
        defaultSound: true,
        defaultVibrateTimings: true,
        notificationPriority: "PRIORITY_HIGH",
        visibility: "PUBLIC",
      },
    },
  };

  try {
    await getMessaging().send(message);
    console.log(`Customer notified: ${customerId}`);
  } catch (err) {
    console.log(`Failed to notify customer: ${err.message}`);
  }
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat/2)*Math.sin(dLat/2) +
    Math.cos((lat1*Math.PI)/180)*Math.cos((lat2*Math.PI)/180)*
    Math.sin(dLng/2)*Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
