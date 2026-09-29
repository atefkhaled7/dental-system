const pool = require("../db");

// الحالات المعتمدة دولياً لحالة السن
const VALID_CONDITIONS = [
  "sound",    // سليم
  "caries",   // تسوس
  "filled",   // محشو
  "rct",      // علاج عصب
  "crown",    // تركيبة / تاج
  "missing",  // مخلوع
  "implant",  // زراعة
];

// 1. جلب كل الأسنان المسجلة لمريض معين
const getPatientTeeth = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { patientId } = req.params;

    const query = `
      SELECT id, tooth_number, condition, notes, updated_at
      FROM patient_teeth
      WHERE clinic_id = $1 AND patient_id = $2
      ORDER BY tooth_number ASC;
    `;

    const result = await pool.query(query, [clinicId, patientId]);
    res.status(200).json({ teeth: result.rows });
  } catch (error) {
    console.error("Error fetching patient teeth:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء جلب مخطط الأسنان" });
  }
};

// 2. تحديث حالة سن معين + تسجيل الحركة في الـ History (Transaction)
const updateToothCondition = async (req, res) => {
  const client = await pool.connect();
  try {
    const clinicId = req.user.clinic_id;
    const userId = req.user.id;
    const { patientId, toothNumber } = req.params;
    const { condition, notes, procedure_name } = req.body;

    const toothNum = parseInt(toothNumber, 10);
    if (isNaN(toothNum) || toothNum < 11 || toothNum > 48) {
      return res.status(400).json({ error: "رقم السن غير صالح (يجب أن يكون بين 11 و 48)" });
    }

    if (!condition || !VALID_CONDITIONS.includes(condition.toLowerCase())) {
      return res.status(400).json({
        error: `حالة السن غير صالحة. الحالات المسموحة: ${VALID_CONDITIONS.join(", ")}`,
      });
    }

    const normalizedCondition = condition.toLowerCase();

    await client.query("BEGIN");

    // أ) تحديث أو إدخال السن الحالي (UPSERT)
    const upsertQuery = `
      INSERT INTO patient_teeth (clinic_id, patient_id, tooth_number, condition, notes, updated_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
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

    // ب) إضافة سجل تاريخي دائم في tooth_history
    const historyQuery = `
      INSERT INTO tooth_history (clinic_id, patient_id, tooth_number, condition, procedure_name, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
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

    res.status(200).json({
      message: "تم تحديث حالة السن وتسجيل الإجراء في السجل الطبي",
      tooth: toothRes.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating tooth condition:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء تحديث السن" });
  } finally {
    client.release();
  }
};

// 3. جلب الـ Timeline الكامل لتاريخ سن محدد
const getToothHistory = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { patientId, toothNumber } = req.params;

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
      LEFT JOIN users u ON th.created_by = u.id
      WHERE th.clinic_id = $1 AND th.patient_id = $2 AND th.tooth_number = $3
      ORDER BY th.created_at DESC;
    `;

    const result = await pool.query(query, [clinicId, patientId, toothNumber]);
    res.status(200).json({ history: result.rows });
  } catch (error) {
    console.error("Error fetching tooth history:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء جلب تاريخ السن" });
  }
};

module.exports = {
  getPatientTeeth,
  updateToothCondition,
  getToothHistory,
};