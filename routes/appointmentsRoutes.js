const express = require("express");
const router = express.Router();
const {
  getAppointments,
  createAppointment,
  updateAppointmentStatus,
  rescheduleAppointment,
  deleteAppointment,
  getClinicDurationSettings,
  updateClinicDurationSettings,
  getAppointmentById,
} = require("../controllers/appointmentsController");

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["id"]);
router.use(authMiddleware);

// 1. إعدادات مدة الكشف
router.get("/settings/duration", getClinicDurationSettings);
router.patch(
  "/settings/duration",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  updateClinicDurationSettings
);

// 2. المواعيد العامة (عرض، حجز، تعديل)
router.get(
  "/",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getAppointments
);

router.get(
  "/:id",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getAppointmentById
);

router.post(
  "/",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  createAppointment
);
router.patch(
  "/:id/status",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  updateAppointmentStatus
);
router.patch(
  "/:id/reschedule",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  rescheduleAppointment
);

// 3. حذف الموعد نهائياً (ClinicAdmin فقط حصراً لمنع العبث) 👈
router.delete("/:id", authorizeRole("ClinicAdmin"), deleteAppointment);

module.exports = router;
