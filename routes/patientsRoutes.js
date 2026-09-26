const express = require("express");
const router = express.Router();
const {
  addPatient,
  getPatients,
  getPatientById,
  updatePatient,
  deletePatient,
} = require("../controllers/patientsController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");

router.post(
  "/",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),

  addPatient
);
router.get(
  "/",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),

  getPatients
);
router.get(
  "/:id",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),

  getPatientById
);
router.put(
  "/:id",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),

  updatePatient
);
router.delete(
  "/:id",
  authMiddleware,
  authorizeRole("ClinicAdmin"),

  deletePatient
);

module.exports = router;
