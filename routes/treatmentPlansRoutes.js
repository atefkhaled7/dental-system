const express = require("express");
const router = express.Router();
const {
  getPatientTreatmentPlans,
  createTreatmentPlan,
  addTreatmentPlanItem,
  updatePlanItemStatus,
  convertPlanItemsToInvoice,
} = require("../controllers/treatmentPlansController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");

// مسارات خطط العلاج
router.get(
  "/patients/:patientId",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getPatientTreatmentPlans
);
router.post(
  "/patients/:patientId",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  createTreatmentPlan
);
router.post(
  "/:planId/items",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  addTreatmentPlanItem
);
router.patch(
  "/items/:itemId/status",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  updatePlanItemStatus
);
router.post(
  "/patients/:patientId/invoice",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  convertPlanItemsToInvoice
);

module.exports = router;
