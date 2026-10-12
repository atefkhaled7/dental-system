const express = require("express");
const router = express.Router();
const {
  createSupportTicket,
  getSupportTickets,
  updateTicketStatus,
} = require("../controllers/supportController");
const authMiddleware = require("../middleware/authMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["id"]);

router.use(authMiddleware);

// إنشاء تذكرة (متاح لكل الأدوار داخل العيادة)
router.post("/tickets", createSupportTicket);

// استعراض التذاكر
router.get("/tickets", getSupportTickets);

// تحديث حالة التذكرة (مع التحقق الصارم من صحة الـ UUID)
router.patch("/tickets/:id", updateTicketStatus);

module.exports = router;
