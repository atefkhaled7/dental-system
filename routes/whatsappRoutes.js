const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const {
  getAppointmentWhatsAppLink,
  getInvoiceWhatsAppLink,
} = require("../controllers/whatsappController");

// محمي بتسجيل الدخول للعيادة
router.get("/appointment-link", authMiddleware, getAppointmentWhatsAppLink);
router.get("/invoice-link", authMiddleware, getInvoiceWhatsAppLink);

module.exports = router;
