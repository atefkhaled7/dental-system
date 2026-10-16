const express = require("express");
const router = express.Router();
const {
  getReportsSummary,
  getExpenses,
  createExpense,
  deleteExpense,
  upsertDoctorCompensation,
  getCommissionPayouts,
  recordCommissionPayout,
} = require("../controllers/reportsController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["id", "doctorId"]);

router.use(authMiddleware);

// التقارير والمصروفات والعمولات محصورة بمدير العيادة لحماية الخصوصية المالية
router.get("/summary", authorizeRole("ClinicAdmin"), getReportsSummary);

// مصروفات العيادة
router.get("/expenses", authorizeRole("ClinicAdmin"), getExpenses);
router.post("/expenses", authorizeRole("ClinicAdmin"), createExpense);
router.delete("/expenses/:id", authorizeRole("ClinicAdmin"), deleteExpense);

// نسب ورواتب الأطباء وسجل الصرف
router.put(
  "/doctors/:doctorId/compensation",
  authorizeRole("ClinicAdmin"),
  upsertDoctorCompensation,
);
router.get(
  "/commissions/payouts",
  authorizeRole("ClinicAdmin"),
  getCommissionPayouts,
);
router.post(
  "/commissions/payouts",
  authorizeRole("ClinicAdmin"),
  recordCommissionPayout,
);

module.exports = router;
