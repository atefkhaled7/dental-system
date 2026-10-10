const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const {
  recordPayment,
  createOnlinePayment,
  handlePaymobWebhook,
  voidPayment, // 👈 1. استيراد دالة الإلغاء
} = require("../controllers/paymentsController");
const authorizeRole = require("../middleware/roleMiddleware");

// 1. الدفع اليدوي (محمي بتسجيل الدخول)
router.post(
  "/record",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  recordPayment,
);

// 2. إنشاء رابط دفع إلكتروني (محمي بتسجيل الدخول)
router.post(
  "/online/create",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  createOnlinePayment,
);

// 3. Webhook من Paymob (عام ومحمي بـ HMAC Signature)
router.post("/webhook/paymob", handlePaymobWebhook);

router.post(
  "/",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  recordPayment,
);

// 🔒 4. إلغاء / تصحيح دفعة مالية يدوية (خاص بمدير العيادة فقط)
router.post(
  "/:id/void",
  authMiddleware,
  authorizeRole("ClinicAdmin"),
  voidPayment,
);

module.exports = router;
