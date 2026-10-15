const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const publicBookingController = require("../controllers/publicBookingController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const upload = require("../middleware/uploadMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["id"]);

// تحديد معدل الطلبات: أقصى حد 5 طلبات حجز لكل IP كل 15 دقيقة
const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
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
  if (req.body && req.body.fax_number) {
    return res.status(400).json({ error: "تم رفض الطلب." });
  }
  next();
};

// ==========================================
// أولاً: مسارات الجمهور (Public Endpoints)
// ==========================================
router.get("/clinics/:slug", publicBookingController.getPublicClinicProfile);

router.get(
  "/clinics/:slug/slots",
  publicBookingController.getPublicAvailableSlots,
);

router.post(
  "/clinics/:slug/booking-requests",
  bookingLimiter,
  checkHoneypot,
  publicBookingController.createPublicBookingRequest,
);

// ==========================================
// ثانياً: مسارات إدارة موقع العيادة العام لـ ClinicAdmin
// ==========================================
router.get(
  "/site-settings/me",
  authMiddleware,
  authorizeRole("ClinicAdmin"),
  publicBookingController.getMyClinicSiteSettings,
);

router.put(
  "/site-settings/me",
  authMiddleware,
  authorizeRole("ClinicAdmin"),
  publicBookingController.updateMyClinicSiteSettings,
);

router.post(
  "/site-settings/upload-image",
  authMiddleware,
  authorizeRole("ClinicAdmin"),
  upload.single("image"),
  publicBookingController.uploadSiteAsset,
);

router.post(
  "/site-settings/gallery",
  authMiddleware,
  authorizeRole("ClinicAdmin"),
  publicBookingController.addGalleryItem,
);

router.delete(
  "/site-settings/gallery/:id",
  authMiddleware,
  authorizeRole("ClinicAdmin"),
  publicBookingController.deleteGalleryItem,
);

router.post(
  "/site-settings/faqs",
  authMiddleware,
  authorizeRole("ClinicAdmin"),
  publicBookingController.addClinicFaq,
);

router.delete(
  "/site-settings/faqs/:id",
  authMiddleware,
  authorizeRole("ClinicAdmin"),
  publicBookingController.deleteClinicFaq,
);

router.post(
  "/site-settings/testimonials",
  authMiddleware,
  authorizeRole("ClinicAdmin"),
  publicBookingController.addClinicTestimonial,
);

router.delete(
  "/site-settings/testimonials/:id",
  authMiddleware,
  authorizeRole("ClinicAdmin"),
  publicBookingController.deleteClinicTestimonial,
);

module.exports = router;
