const express = require("express");
const router = express.Router();
const {
  getPatientTreatmentPlans,
  createTreatmentPlan,
  addTreatmentPlanItem,
  updatePlanItemStatus,
  convertPlanItemsToInvoice,
  updateTreatmentPlanStatus,
  deleteTreatmentPlanItem,
} = require("../controllers/treatmentPlansController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["patientId", "planId", "itemId"]);

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

router.patch(
  "/:planId/status",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor"),
  updateTreatmentPlanStatus
);
router.delete(
  "/items/:itemId",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor"),
  deleteTreatmentPlanItem
);
module.exports = router;
