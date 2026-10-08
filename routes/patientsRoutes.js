const express = require("express");

const router = express.Router();
const multer = require("multer");
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
const {
  addPatient,
  getPatients,
  getPatientById,
  updatePatient,
  deletePatient,
  restorePatient,
  exportPatients,
  importPatientsFromCsv,
} = require("../controllers/patientsController");

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");

const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["id"]);

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

// تصدير بيانات المرضى - ClinicAdmin فقط
router.get(
  "/export",
  authMiddleware,
  authorizeRole("ClinicAdmin"),
  exportPatients
);

router.post(
  "/import",
  authMiddleware,
  authorizeRole("ClinicAdmin"),
  uploadCsv.single("file"),
  importPatientsFromCsv
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

router.patch(
  "/:id/restore",
  authMiddleware,
  authorizeRole("ClinicAdmin"),
  restorePatient
);

module.exports = router;
