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
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  authMiddleware,
  addPatient
);
router.get(
  "/",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  authMiddleware,
  getPatients
);
router.get(
  "/:id",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  authMiddleware,
  getPatientById
);
router.put(
  "/:id",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  authMiddleware,
  updatePatient
);
router.delete(
  "/:id",
  authorizeRole("ClinicAdmin"),
  authMiddleware,
  deletePatient
);

module.exports = router;
