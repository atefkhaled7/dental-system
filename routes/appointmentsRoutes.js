const express = require("express");
const router = express.Router();
const {
  getAppointments,
  createAppointment,
  updateAppointmentStatus,
  rescheduleAppointment,
  deleteAppointment,
} = require("../controllers/appointmentsController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");

router.get(
  "/",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getAppointments
);
router.post(
  "/",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  createAppointment
);
router.patch(
  "/:id/status",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  updateAppointmentStatus
);
router.patch(
  "/:id/reschedule",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  rescheduleAppointment
);
router.delete(
  "/:id",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  deleteAppointment
);
module.exports = router;
