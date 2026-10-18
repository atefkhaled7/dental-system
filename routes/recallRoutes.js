const express = require("express");
const router = express.Router();
const {
  getTomorrowReminders,
  getRecallCandidates,
  logRecallAction,
  getMessageTemplates,
  updateMessageTemplate,
} = require("../controllers/recallController");

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");

const ALL_ROLES = ["SuperAdmin", "ClinicAdmin", "Doctor", "Receptionist"];
const ADMIN_ROLES = ["SuperAdmin", "ClinicAdmin"];

// 1. تذكيرات مواعيد الغد (استعراض وتوليد روابط wa.me)
router.get(
  "/tomorrow-reminders",
  authMiddleware,
  authorizeRole(...ALL_ROLES),
  getTomorrowReminders
);

// 2. محرك استدعاء المرضى السريري والمالي (فحص دوري، خطط علاج، No-Show)
router.get(
  "/candidates",
  authMiddleware,
  authorizeRole(...ALL_ROLES),
  getRecallCandidates
);

// 3. توثيق إرسال رسالة استدعاء لتفعيل فترة الـ Cooldown
router.post(
  "/log",
  authMiddleware,
  authorizeRole(...ALL_ROLES),
  logRecallAction
);

// 4. استعراض قوالب الرسائل
router.get(
  "/templates",
  authMiddleware,
  authorizeRole(...ALL_ROLES),
  getMessageTemplates
);

// 5. تعديل قوالب الرسائل (للأدمن)
router.put(
  "/templates",
  authMiddleware,
  authorizeRole(...ADMIN_ROLES),
  updateMessageTemplate
);

module.exports = router;