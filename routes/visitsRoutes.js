const express = require("express");
const router = express.Router();
const {
  createOrGetAppointmentVisit,
  getVisitById,
  getPatientVisits,
  updateVisit,
  finalizeVisit,
  getNoteTemplates,
  createNoteTemplate,
  deleteNoteTemplate,
} = require("../controllers/visitsController");

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

// تفعيل التحقق التلقائي من معرّفات الـ UUID في الـ URL
applyUuidParams(router, ["id", "patientId"]);
router.use(authMiddleware);

// 1. فتح أو إنشاء زيارة سريرية مرتبطة بموعد
router.post(
  "/appointments/:id/visit",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  createOrGetAppointmentVisit,
);

// 2. جلب سجل زيارات مريض معين
router.get(
  "/patients/:patientId/visits",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getPatientVisits,
);

// 3. جلب وتحديث واعتماد زيارة محددة
router.get(
  "/visits/:id",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getVisitById,
);

router.put("/visits/:id", authorizeRole("ClinicAdmin", "Doctor"), updateVisit);

router.post(
  "/visits/:id/finalize",
  authorizeRole("ClinicAdmin", "Doctor"),
  finalizeVisit,
);

// 4. قوالب الملاحظات السريرية
router.get(
  "/note-templates",
  authorizeRole("ClinicAdmin", "Doctor"),
  getNoteTemplates,
);

router.post(
  "/note-templates",
  authorizeRole("ClinicAdmin", "Doctor"),
  createNoteTemplate,
);

router.delete(
  "/note-templates/:id",
  authorizeRole("ClinicAdmin", "Doctor"),
  deleteNoteTemplate,
);

module.exports = router;
