const pool = require("../db");
const { captureError } = require("../utils/errorTracker");
const { logActivity } = require("../utils/auditLogger");
const { isValidUuid } = require("../middleware/validateUuid");

// 1. جلب روشتات مريض معين
const getPatientPrescriptions = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { patientId } = req.params;
  try {
    const result = await pool.query(
      `
      SELECT 
        pr.*,
        u.name AS doctor_name,
        c.name AS clinic_name,
        c.phone_number AS clinic_phone,
        c.address AS clinic_address
      FROM prescriptions pr
      LEFT JOIN users u ON pr.doctor_id = u.id
      JOIN clinics c ON pr.clinic_id = c.id
      WHERE pr.patient_id = $1 AND pr.clinic_id = $2
      ORDER BY pr.prescription_date DESC, pr.created_at DESC;
      `,
      [patientId, clinicId],
    );
    res.status(200).json(result.rows);
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching prescriptions:", error.message);
    res.status(500).json({ error: "فشل جلب الروشتات الطبية" });
  }
};

// 2. إنشاء روشتة جديدة
const createPrescription = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { patientId } = req.params;
  const { doctor_id, prescription_date, diagnosis, medications, instructions } =
    req.body;

  try {
    // 🔒 فحص الأدوية
    if (
      !medications ||
      !Array.isArray(medications) ||
      medications.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "يجب إضافة دواء واحد على الأقل للروشتة" });
    }

    const cleanMedications = medications
      .filter((m) => m && m.name && m.name.trim())
      .map((m) => ({
        name: m.name.trim(),
        dosage: m.dosage?.trim() || "",
        duration: m.duration?.trim() || "",
        notes: m.notes?.trim() || "",
      }));

    if (cleanMedications.length === 0) {
      return res.status(400).json({ error: "اسم الدواء مطلوب" });
    }

    // 🔒 التأكد إن المريض يتبع العيادة ونشط
    const patientCheck = await pool.query(
      `SELECT id, name FROM patients WHERE id = $1 AND clinic_id = $2 AND is_active = TRUE LIMIT 1;`,
      [patientId, clinicId],
    );
    if (patientCheck.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "المريض غير موجود أو غير متاح في هذه العيادة" });
    }

    // 🔒 فحص الطبيب المسؤول قانونياً (منع التعيين الصامت وحماية الـ UUID من 500)
    let assignedDoctorId = null;

    if (req.user.role === "Doctor") {
      assignedDoctorId = req.user.id;
    } else {
      // لو المستخدم أدمن أو موظف استقبال، يلزم تحديد الطبيب وفحص صلاحية الـ UUID
      if (!doctor_id || !isValidUuid(doctor_id)) {
        return res.status(400).json({
          error: "يجب اختيار الطبيب المعالج المسؤول قانونياً عن إصدار الروشتة",
        });
      }
      assignedDoctorId = doctor_id;
    }

    // التأكد إن الطبيب يتبع العيادة وحسابه نشط
    const doctorCheck = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor' AND is_active = TRUE LIMIT 1;`,
      [assignedDoctorId, clinicId],
    );
    if (doctorCheck.rows.length === 0) {
      return res.status(400).json({
        error: "الطبيب المحدد غير موجود أو غير مسجل كطبيب معالج في هذه العيادة",
      });
    }

    // 🔒 حماية طول التشخيص وتنسيق التاريخ
    const safeDiagnosis =
      diagnosis && typeof diagnosis === "string"
        ? diagnosis.trim().slice(0, 255)
        : null;

    let safeDate = null;
    if (prescription_date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(prescription_date)) {
        return res
          .status(400)
          .json({ error: "صيغة تاريخ الروشتة غير صالحة (YYYY-MM-DD)" });
      }
      safeDate = prescription_date;
    }

    const result = await pool.query(
      `
      INSERT INTO prescriptions (
        clinic_id,
        patient_id,
        doctor_id,
        prescription_date,
        diagnosis,
        medications,
        instructions
      )
      VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, $6, $7)
      RETURNING *;
      `,
      [
        clinicId,
        patientId,
        assignedDoctorId,
        safeDate,
        safeDiagnosis,
        JSON.stringify(cleanMedications),
        instructions?.trim() || null,
      ],
    );

    // 🔒 تسجيل العملية في سجل الرقابة
    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: "CREATE_PRESCRIPTION",
        entity_type: "prescription",
        entity_id: result.rows[0].id,
        description: `قام ${req.user.name || "المستخدم"} بإصدار روشتة طبية للمريض (${patientCheck.rows[0].name})`,
        metadata: {
          doctor_id: assignedDoctorId,
          medications_count: cleanMedications.length,
        },
      });
    } catch (auditErr) {
      console.warn("Audit log failed for prescription:", auditErr.message);
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    captureError(error, req);
    console.error("Error creating prescription:", error.message);
    res.status(500).json({ error: "فشل حفظ الروشتة الطبية" });
  }
};
// 3. حذف روشتة
const deletePrescription = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { id } = req.params;
  try {
    const result = await pool.query(
      `DELETE FROM prescriptions WHERE id = $1 AND clinic_id = $2 RETURNING id, patient_id;`,
      [id, clinicId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "الروشتة غير موجودة" });
    }

    // 🔒 تسجيل الحذف في سجل الرقابة
    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: "DELETE_PRESCRIPTION",
        entity_type: "prescription",
        entity_id: id,
        description: `قام ${req.user.name || "المستخدم"} بحذف روشتة طبية سابقة للمريض #${result.rows[0].patient_id.slice(0, 8)}`,
      });
    } catch (auditErr) {
      console.warn(
        "Audit log failed for prescription deletion:",
        auditErr.message,
      );
    }

    res.status(200).json({ message: "تم حذف الروشتة بنجاح" });
  } catch (error) {
    captureError(error, req);
    console.error("Error deleting prescription:", error.message);
    res.status(500).json({ error: "فشل حذف الروشتة" });
  }
};

module.exports = {
  getPatientPrescriptions,
  createPrescription,
  deletePrescription,
};
