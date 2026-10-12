const express = require("express");
const router = express.Router();
const {
  createClinic,
  getClinics,
  updateClinic,
  deleteClinic,
  renewSubscription,
  getOnboardingStatus,
} = require("../controllers/clinicsController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["id"]);

router.post("/", authMiddleware, authorizeRole("SuperAdmin"), createClinic);

router.get(
  "/",
  authMiddleware,
  authorizeRole("SuperAdmin", "ClinicAdmin", "Receptionist", "Doctor"),
  getClinics,
);

router.get(
  "/onboarding-status",
  authMiddleware,
  authorizeRole("ClinicAdmin"),
  getOnboardingStatus,
);

router.put(
  "/:id",
  authMiddleware,
  authorizeRole("SuperAdmin", "ClinicAdmin"),
  updateClinic,
);
router.delete(
  "/:id",
  authMiddleware,
  authorizeRole("SuperAdmin"),
  deleteClinic,
);

router.put(
  "/:id/subscription",
  authMiddleware,
  authorizeRole("SuperAdmin"),
  renewSubscription,
);

module.exports = router;
