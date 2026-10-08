const express = require("express");
const router = express.Router();
const {
  getDoctorSchedule,
  setDoctorShifts,
  addDoctorLeave,
  deleteDoctorLeave,
  getAvailableSlots,
} = require("../controllers/doctorAvailabilityController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["doctorId", "leaveId"]);
router.use(authMiddleware);

// 1. حساب الـ Slots المتاحة (للكل: دكتور، ريسبشن، أدمن)
router.get("/:doctorId/slots", getAvailableSlots);

// 2. جلب جدول الطبيب وإجازاته
router.get("/:doctorId", getDoctorSchedule);

// 3. تعديل الشفتات (أدمن أو الدكتور نفسه)
router.post(
  "/:doctorId/shifts",
  authorizeRole("ClinicAdmin", "Doctor"),
  setDoctorShifts
);

// 4. إدارة الإجازات
router.post(
  "/:doctorId/leaves",
  authorizeRole("ClinicAdmin", "Doctor"),
  addDoctorLeave
);
router.delete(
  "/:doctorId/leaves/:leaveId",
  authorizeRole("ClinicAdmin", "Doctor"),
  deleteDoctorLeave
);

module.exports = router;
