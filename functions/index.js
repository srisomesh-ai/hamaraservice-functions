const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

// Trigger when a new booking is added to active_bookings
exports.notifyProviders = functions.database
  .ref("/active_bookings/{bookingId}")
  .onWrite(async (change, context) => {
    const bookingId = context.params.bookingId;
    const booking = change.after.val();

    // Only process searching bookings
    if (!booking || booking.status !== "searching") return null;
    if (booking.acceptedBy) return null;

    const svcName = (booking.service || "").toLowerCase();
    const bookingLat = booking.lat || 0;
    const bookingLng = booking.lng || 0;
    const range = booking.range || 20;

    // Get all providers
    const providersSnap = await admin.database().ref("providers").once("value");
    if (!providersSnap.exists()) return null;

    const providers = providersSnap.val();
    const notifications = [];

    for (const [providerId, provider] of Object.entries(providers)) {
      if (!provider.available) continue;
      if (provider.status !== "approved") continue;
      if (!provider.fcmToken) continue;

      // Check service match
      const services = provider.services || [];
      const hasService = Array.isArray(services) && services.some((s) => {
        const name = (s.name || s || "").toLowerCase();
        return name === svcName;
      });
      if (!hasService) continue;

      // Check distance
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
        admin.messaging().send(message).catch((err) => {
          console.log(`Failed to send to ${providerId}:`, err.message);
        })
      );
    }

    await Promise.all(notifications);
    console.log(`Notified ${notifications.length} providers for booking ${bookingId}`);
    return null;
  });

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
