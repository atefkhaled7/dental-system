const express = require("express");
const router = express.Router();
const {
  getPatientTeeth,
  updateToothCondition,
  getToothHistory,
} = require("../controllers/dentalChartController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["patientId"]);

const ALL = ["ClinicAdmin", "Doctor", "Receptionist"];
const CLINICAL = ["ClinicAdmin", "Doctor"];

router.get(
  "/patients/:patientId",
  authMiddleware,
  authorizeRole(...ALL),
  getPatientTeeth
);
router.put(
  "/patients/:patientId/teeth/:toothNumber",
  authMiddleware,
  authorizeRole(...CLINICAL),
  updateToothCondition
);
router.get(
  "/patients/:patientId/teeth/:toothNumber/history",
  authMiddleware,
  authorizeRole(...ALL),
  getToothHistory
);

module.exports = router;
