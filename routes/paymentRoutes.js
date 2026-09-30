const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const {
  recordPayment,
  createOnlinePayment,
  handlePaymobWebhook,
} = require("../controllers/paymentsController");
const authorizeRole = require("../middleware/roleMiddleware");

// 1. الدفع اليدوي (محمي بتسجيل الدخول)
router.post(
  "/record",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  recordPayment
);

// 2. إنشاء رابط دفع إلكتروني (محمي بتسجيل الدخول)
router.post(
  "/online/create",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  createOnlinePayment
);

// 3. Webhook من Paymob (عام ومحمي بـ HMAC Signature)
router.post(
  "/webhook/paymob",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  handlePaymobWebhook
);

router.post(
  "/",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  recordPayment
);

module.exports = router;
