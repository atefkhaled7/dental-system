const pool = require("../db");
const { captureError } = require("../utils/errorTracker");

// الحالات المعتمدة لحالة السن
const VALID_CONDITIONS = [
  "sound", // سليم
  "caries", // تسوس
  "filled", // محشو
  "rct", // علاج عصب
  "crown", // تركيبة / تاج
  "missing", // مخلوع
  "implant", // زراعة
];

// أرقام الأسنان الدائمة حسب ترقيم FDI
const VALID_ADULT_TEETH = new Set([
  // الربع الأول - علوي يمين
  11, 12, 13, 14, 15, 16, 17, 18,

  // الربع الثاني - علوي شمال
  21, 22, 23, 24, 25, 26, 27, 28,

  // الربع الثالث - سفلي شمال
  31, 32, 33, 34, 35, 36, 37, 38,

  // الربع الرابع - سفلي يمين
  41, 42, 43, 44, 45, 46, 47, 48,
]);

// ============================================================
// 1. جلب كل الأسنان المسجلة لمريض معين
// ============================================================
const getPatientTeeth = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { patientId } = req.params;

    const patientCheck = await pool.query(
      `SELECT id
       FROM patients
       WHERE id = $1
         AND clinic_id = $2
         AND is_active = TRUE`,
      [patientId, clinicId]
    );

    if (patientCheck.rows.length === 0) {
      return res.status(404).json({
        error: "المريض غير موجود في هذه العيادة أو تمت أرشفته",
      });
    }

    const query = `
      SELECT
        id,
        tooth_number,
        condition,
        notes,
        updated_at
      FROM patient_teeth
      WHERE clinic_id = $1
        AND patient_id = $2
      ORDER BY tooth_number ASC;
    `;

    const result = await pool.query(query, [clinicId, patientId]);

    return res.status(200).json({
      teeth: result.rows,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching patient teeth:", error.message);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء جلب مخطط الأسنان",
    });
  }
};

// ============================================================
// 2. تحديث حالة سن معين + تسجيل الحركة في tooth_history
// ============================================================
const updateToothCondition = async (req, res) => {
  const client = await pool.connect();

  try {
    const clinicId = req.user.clinic_id;
    const userId = req.user.id;

    const { patientId, toothNumber } = req.params;
    const { condition, notes, procedure_name } = req.body;

    // التحقق من رقم السن حسب FDI
    const toothNum = Number(toothNumber);

    if (!Number.isInteger(toothNum) || !VALID_ADULT_TEETH.has(toothNum)) {
      return res.status(400).json({
        error: "رقم السن غير صحيح طبقاً للترقيم الطبي المعتمد (FDI)",
      });
    }

    // التحقق من حالة السن
    if (!condition || !VALID_CONDITIONS.includes(condition.toLowerCase())) {
      return res.status(400).json({
        error: `حالة السن غير صالحة. الحالات المسموحة: ${VALID_CONDITIONS.join(
          ", "
        )}`,
      });
    }

    const normalizedCondition = condition.toLowerCase();

    // التحقق من المريض ونطاق العيادة
    const patientCheck = await client.query(
      `SELECT id
       FROM patients
       WHERE id = $1
         AND clinic_id = $2
         AND is_active = TRUE`,
      [patientId, clinicId]
    );

    if (patientCheck.rows.length === 0) {
      return res.status(404).json({
        error: "المريض غير موجود في هذه العيادة أو تمت أرشفته",
      });
    }

    await client.query("BEGIN");

    // --------------------------------------------------------
    // A) تحديث أو إدخال السن الحالي (UPSERT)
    // --------------------------------------------------------
    const upsertQuery = `
      INSERT INTO patient_teeth (
        clinic_id,
        patient_id,
        tooth_number,
        condition,
        notes,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (clinic_id, patient_id, tooth_number)
      DO UPDATE SET
        condition = EXCLUDED.condition,
        notes = EXCLUDED.notes,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;

    const toothRes = await client.query(upsertQuery, [
      clinicId,
      patientId,
      toothNum,
      normalizedCondition,
      notes || null,
    ]);

    // --------------------------------------------------------
    // B) إضافة سجل دائم في tooth_history
    // --------------------------------------------------------
    const historyQuery = `
      INSERT INTO tooth_history (
        clinic_id,
        patient_id,
        tooth_number,
        condition,
        procedure_name,
        notes,
        created_by
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7
      )
      RETURNING *;
    `;

    await client.query(historyQuery, [
      clinicId,
      patientId,
      toothNum,
      normalizedCondition,
      procedure_name || null,
      notes || null,
      userId,
    ]);

    await client.query("COMMIT");

    return res.status(200).json({
      message: "تم تحديث حالة السن وتسجيل الإجراء في السجل الطبي",
      tooth: toothRes.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Rollback error:", rollbackError.message);
    }

    console.error("Error updating tooth condition:", error.message);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء تحديث السن",
    });
  } finally {
    client.release();
  }
};

// ============================================================
// 3. جلب الـ Timeline الكامل لتاريخ سن محدد
// ============================================================
const getToothHistory = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { patientId, toothNumber } = req.params;

    // التحقق من رقم السن حسب FDI
    const toothNum = Number(toothNumber);

    if (!Number.isInteger(toothNum) || !VALID_ADULT_TEETH.has(toothNum)) {
      return res.status(400).json({
        error: "رقم السن غير صحيح طبقاً للترقيم الطبي المعتمد (FDI)",
      });
    }

    // التحقق من المريض ونطاق العيادة
    const patientCheck = await pool.query(
      `SELECT id
       FROM patients
       WHERE id = $1
         AND clinic_id = $2
         AND is_active = TRUE`,
      [patientId, clinicId]
    );

    if (patientCheck.rows.length === 0) {
      return res.status(404).json({
        error: "المريض غير موجود في هذه العيادة أو تمت أرشفته",
      });
    }

    const query = `
      SELECT
        th.id,
        th.tooth_number,
        th.condition,
        th.procedure_name,
        th.notes,
        th.created_at,
        u.name AS doctor_name
      FROM tooth_history th
      LEFT JOIN users u
        ON th.created_by = u.id
       AND u.clinic_id = th.clinic_id
      WHERE th.clinic_id = $1
        AND th.patient_id = $2
        AND th.tooth_number = $3
      ORDER BY th.created_at DESC;
    `;

    const result = await pool.query(query, [clinicId, patientId, toothNum]);

    return res.status(200).json({
      history: result.rows,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching tooth history:", error.message);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء جلب تاريخ السن",
    });
  }
};

module.exports = {
  getPatientTeeth,
  updateToothCondition,
  getToothHistory,
};
