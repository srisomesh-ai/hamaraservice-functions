const {onValueWritten} = require("firebase-functions/v2/database");
const {initializeApp} = require("firebase-admin/app");
const {getDatabase} = require("firebase-admin/database");
const {getMessaging} = require("firebase-admin/messaging");

initializeApp({
  databaseURL: "https://hamaraservice-s009-default-rtdb.asia-southeast1.firebasedatabase.app"
});

exports.notifyProviders = onValueWritten(
  {
    ref: "/active_bookings/{bookingId}",
    region: "asia-southeast1",
    instance: "hamaraservice-s009-default-rtdb",
    database: "hamaraservice-s009-default-rtdb",
  },
  async (event) => {
    const bookingId = event.params.bookingId;
    const booking = event.data.after.val();

    console.log(`Function triggered for booking: ${bookingId}`);
    console.log(`Booking status: ${booking ? booking.status : 'null'}`);

    if (!booking || booking.status !== "searching") {
      console.log("Skipping - not a searching booking");
      return null;
    }
    if (booking.acceptedBy) {
      console.log("Skipping - already accepted");
      return null;
    }

    const svcName = (booking.service || "").toLowerCase();
    const bookingLat = booking.lat || 0;
    const bookingLng = booking.lng || 0;
    const range = booking.range || 20;

    console.log(`Service: ${svcName}, Range: ${range}km`);

    const db = getDatabase();
    const providersSnap = await db.ref("providers").once("value");
    if (!providersSnap.exists()) {
      console.log("No providers found");
      return null;
    }

    const providers = providersSnap.val();
    const notifications = [];
    let checkedCount = 0;

    for (const [providerId, provider] of Object.entries(providers)) {
      checkedCount++;
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
        const dist = haversine(
          bookingLat, bookingLng,
          provider.lat, provider.lng
        );
        if (dist > range) continue;
      }

      const amount = booking.priceVal || booking.price || 0;
      console.log(`Sending notification to provider: ${providerId}`);

      const message = {
        token: provider.fcmToken,
        notification: {
          title: "New Booking Alert!",
          body: `${booking.service} - Rs.${amount} - ${booking.date || ""} ${booking.time || ""}`,
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
          .then(() => console.log(`Successfully notified ${providerId}`))
          .catch((err) => console.log(`Failed to notify ${providerId}: ${err.message}`))
      );
    }

    console.log(`Checked ${checkedCount} providers, sending ${notifications.length} notifications`);
    
    if (notifications.length > 0) {
      await Promise.all(notifications);
    }

    return null;
  }
);

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
