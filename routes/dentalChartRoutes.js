const express = require("express");
const router = express.Router();
const {
  getPatientTeeth,
  updateToothCondition,
  getToothHistory,
} = require("../controllers/dentalChartController");
const authMiddleware = require("../middleware/authMiddleware");

// مسارات مخطط الأسنان
router.get("/patients/:patientId", authMiddleware, getPatientTeeth);
router.put("/patients/:patientId/teeth/:toothNumber", authMiddleware, updateToothCondition);
router.get("/patients/:patientId/teeth/:toothNumber/history", authMiddleware, getToothHistory);

module.exports = router;