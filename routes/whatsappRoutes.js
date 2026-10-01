// routes/whatsappRoutes.js
const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const { getAppointmentWhatsAppLink } = require("../controllers/whatsappController");

// محمي بتسجيل الدخول للعيادة
router.get("/appointment-link", authMiddleware, getAppointmentWhatsAppLink);

module.exports = router;