const express = require("express");
const router = express.Router();
const {
  getPatientPrescriptions,
  createPrescription,
  deletePrescription,
} = require("../controllers/prescriptionsController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["patientId", "id"]);

// 1. جلب روشتات المريض
router.get(
  "/patients/:patientId/prescriptions",
  authMiddleware,
  getPatientPrescriptions,
);

// 2. إنشاء روشتة جديدة للمريض (دكتور ومدير عيادة فقط)
router.post(
  "/patients/:patientId/prescriptions",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor"),
  createPrescription,
);

// 3. حذف روشتة
router.delete(
  "/prescriptions/:id",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor"),
  deletePrescription,
);

module.exports = router;
