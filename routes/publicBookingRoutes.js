const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const publicBookingController = require("../controllers/publicBookingController");

// تحديد معدل الطلبات: أقصى حد 5 طلبات حجز لكل IP كل 15 دقيقة
const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 5,
  message: {
    error:
      "تم تجاوز الحد المسموح به من طلبات الحجز من هذا الجهاز، يرجى المحاولة بعد 15 دقيقة.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ميدلوير فخ البوتات (Honeypot)
const checkHoneypot = (req, res, next) => {
  // لو الحقل المخفي جه مليان من الفورم، يبقى ده بوت
  if (req.body.fax_number) {
    return res.status(400).json({ error: "تم رفض الطلب." });
  }
  next();
};

// 1. جلب بيانات بروفايل العيادة للجمهور
router.get("/clinics/:slug", publicBookingController.getPublicClinicProfile);

// 2. جلب المواعيد المتاحة لدكتور في يوم معين
router.get(
  "/clinics/:slugOrId/slots",
  publicBookingController.getPublicAvailableSlots
);

// 3. تقديم طلب حجز (محمي بالـ Rate Limiter والـ Honeypot)
router.post(
  "/clinics/:slug/booking-requests",
  bookingLimiter,
  checkHoneypot,
  publicBookingController.createPublicBookingRequest
);

module.exports = router;
