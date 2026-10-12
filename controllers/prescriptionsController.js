const pool = require("../db");
const { captureError } = require("../utils/errorTracker");
const { logActivity } = require("../utils/auditLogger");
const { isValidUuid } = require("../middleware/validateUuid");

// التحقق من صحة التاريخ الفعلي في التقويم
const isRealDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// 1. جلب روشتات مريض معين
const getPatientPrescriptions = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { patientId } = req.params;

  if (!isValidUuid(patientId)) {
    return res.status(400).json({ error: "معرّف المريض غير صالح" });
  }

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
    req.body || {};

  if (!isValidUuid(patientId)) {
    return res.status(400).json({ error: "معرّف المريض غير صالح" });
  }

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

    const limits = {
      name: 255,
      dosage: 255,
      duration: 255,
      notes: 500,
    };

    for (const m of medications) {
      if (!m || typeof m !== "object") continue;

      for (const [field, max] of Object.entries(limits)) {
        if (typeof m[field] === "string" && m[field].trim().length > max) {
          return res.status(400).json({
            error: `حقل ${field} في بيانات الدواء تجاوز الحد المسموح`,
          });
        }
      }
    }

    if (typeof instructions === "string" && instructions.trim().length > 1000) {
      return res.status(400).json({
        error: "تعليمات الروشتة يجب ألا تتجاوز 1000 حرف",
      });
    }

    const cleanMedications = medications
      .filter((m) => m && typeof m.name === "string" && m.name.trim())
      .map((m) => ({
        name: m.name.trim().slice(0, 255),
        dosage:
          typeof m.dosage === "string" ? m.dosage.trim().slice(0, 255) : "",
        duration:
          typeof m.duration === "string" ? m.duration.trim().slice(0, 255) : "",
        notes: typeof m.notes === "string" ? m.notes.trim().slice(0, 500) : "",
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

    // 🔒 فحص الطبيب المسؤول قانونياً
    let assignedDoctorId = null;
    if (req.user.role === "Doctor") {
      assignedDoctorId = req.user.id;
    } else {
      if (!doctor_id || !isValidUuid(doctor_id)) {
        return res.status(400).json({
          error: "يجب اختيار الطبيب المعالج المسؤول قانونياً عن إصدار الروشتة",
        });
      }
      assignedDoctorId = doctor_id;
    }

    const doctorCheck = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor' AND is_active = TRUE LIMIT 1;`,
      [assignedDoctorId, clinicId],
    );
    if (doctorCheck.rows.length === 0) {
      return res.status(400).json({
        error: "الطبيب المحدد غير موجود أو غير مسجل كطبيب معالج في هذه العيادة",
      });
    }

    // 🔒 حماية طول التشخيص وتنسيق التاريخ الفعلي
    const safeDiagnosis =
      diagnosis && typeof diagnosis === "string"
        ? diagnosis.trim().slice(0, 255)
        : null;

    let safeDate = null;
    if (prescription_date) {
      if (!isRealDate(prescription_date)) {
        return res
          .status(400)
          .json({ error: "تاريخ الروشتة غير صالح، استخدم الصيغة YYYY-MM-DD" });
      }
      safeDate = prescription_date;
    }

    // ✅ استخدام توقيت القاهرة في حال لم يتم تحديد تاريخ الروشتة
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
      VALUES ($1, $2, $3, COALESCE($4, (NOW() AT TIME ZONE 'Africa/Cairo')::date), $5, $6, $7)
      RETURNING *;
      `,
      [
        clinicId,
        patientId,
        assignedDoctorId,
        safeDate,
        safeDiagnosis,
        JSON.stringify(cleanMedications),
        instructions && typeof instructions === "string"
          ? instructions.trim().slice(0, 1000)
          : null,
      ],
    );

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
    if (error.code === "22008") {
      return res
        .status(400)
        .json({ error: "تاريخ الروشتة خارج النطاق المسموح به" });
    }
    if (error.code === "22001") {
      return res
        .status(400)
        .json({ error: "أحد البيانات يتجاوز الحد الأقصى للحروف" });
    }
    captureError(error, req);
    console.error("Error creating prescription:", error.message);
    res.status(500).json({ error: "فشل حفظ الروشتة الطبية" });
  }
};

// 3. حذف روشتة
const deletePrescription = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { id } = req.params;

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: "معرّف الروشتة غير صالح" });
  }

  try {
    const result = await pool.query(
      `DELETE FROM prescriptions WHERE id = $1 AND clinic_id = $2 RETURNING id, patient_id;`,
      [id, clinicId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "الروشتة غير موجودة" });
    }

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
