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

// 1. استعراض خطط علاج المريض (متاح للجميع: طبيب، مدير، واستقبال للرد على المريض)
router.get(
  "/patients/:patientId",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getPatientTreatmentPlans,
);

// 2. إنشاء خطة علاج جديدة (قرار طبي: مقتصر على الطبيب ومدير العيادة فقط 🔒)
router.post(
  "/patients/:patientId",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor"),
  createTreatmentPlan,
);

// 3. إضافة إجراءات/أسنان لخطة العلاج (إجراء طبي: مقتصر على الطبيب ومدير العيادة فقط 🔒)
router.post(
  "/:planId/items",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor"),
  addTreatmentPlanItem,
);

// 4. تحديث الحالة الطبية للبند (إتمام العلاج: مقتصر على الطبيب ومدير العيادة فقط 🔒)
router.patch(
  "/items/:itemId/status",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor"),
  updatePlanItemStatus,
);

// 5. تحويل بنود الخطة لفاتورة تحصيل (مهمة مالية وإدارية: متاحة للاستقبال مع الطبيب والمدير ✅)
router.post(
  "/patients/:patientId/invoice",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  convertPlanItemsToInvoice,
);

// 6. تحديث حالة الخطة بالكامل (اعتماد أو إلغاء الخطة)
router.patch(
  "/:planId/status",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor"),
  updateTreatmentPlanStatus,
);

// 7. حذف بند من الخطة
router.delete(
  "/items/:itemId",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor"),
  deleteTreatmentPlanItem,
);

module.exports = router;
