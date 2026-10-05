const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

const {
  getClinicStaff,
  addStaffMember,
  toggleStaffStatus,
  resetStaffPassword,
  updateStaffName,
} = require("../controllers/staffController");

router.use(authMiddleware);

// 🌟 مسارات إدارة الطاقم (خاصة بمدير العيادة فقط ClinicAdmin)
router.use(authorizeRole("ClinicAdmin"));
applyUuidParams(router, ["id"]);

router.get("/", getClinicStaff);
router.post("/", addStaffMember);
router.patch("/:id/name", updateStaffName);
router.patch("/:id/toggle-status", toggleStaffStatus);
router.patch("/:id/reset-password", resetStaffPassword);

module.exports = router;
