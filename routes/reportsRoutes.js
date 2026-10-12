const express = require("express");
const router = express.Router();
const { getReportsSummary } = require("../controllers/reportsController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");

router.use(authMiddleware);

// التقارير محصورة فقط لمدير العيادة لحماية الخصوصية المالية
router.get("/summary", authorizeRole("ClinicAdmin"), getReportsSummary);

module.exports = router;