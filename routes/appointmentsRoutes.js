const express = require("express");
const router = express.Router();
const {
  getAppointments,
  getCalendarData,
  createAppointment,
  updateAppointmentStatus,
  rescheduleAppointment,
  deleteAppointment,
  getClinicDurationSettings,
  updateClinicDurationSettings,
  addClinicHoliday,
  deleteClinicHoliday,
  getAppointmentById,
} = require("../controllers/appointmentsController");

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["id", "holidayId"]);
router.use(authMiddleware);

// 1. إعدادات مدة الكشف، الكراسي، ساعات عمل العيادة، والعطلات
router.get("/settings/duration", getClinicDurationSettings);
router.patch(
  "/settings/duration",
  authorizeRole("ClinicAdmin"),
  updateClinicDurationSettings,
);
router.post(
  "/settings/holidays",
  authorizeRole("ClinicAdmin"),
  addClinicHoliday,
);
router.delete(
  "/settings/holidays/:holidayId",
  authorizeRole("ClinicAdmin"),
  deleteClinicHoliday,
);

// 2. مسار التقويم اليومي السريع بأعمدة الأطباء
router.get(
  "/calendar",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getCalendarData,
);

// 3. المواعيد العامة (عرض، حجز، تعديل)
router.get(
  "/",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getAppointments,
);

router.get(
  "/:id",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getAppointmentById,
);

router.post(
  "/",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  createAppointment,
);

router.patch(
  "/:id/status",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  updateAppointmentStatus,
);

router.patch(
  "/:id/reschedule",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  rescheduleAppointment,
);

// 4. حذف الموعد نهائياً (ClinicAdmin فقط)
router.delete("/:id", authorizeRole("ClinicAdmin"), deleteAppointment);

module.exports = router;
