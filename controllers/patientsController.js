const pool = require("../db");

const addPatient = async (req, res) => {
  try {
    const clinic_id = req.user.clinic_id;
    const { name, phone_number, gender, date_of_birth, medical_alerts } = req.body;

    if (!name || !phone_number) {
      return res.status(400).json({ error: "اسم المريض ورقم الهاتف مطلوبين" });
    }

    const result = await pool.query(
      "INSERT INTO patients (name, phone_number, gender, clinic_id, date_of_birth, medical_alerts) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [name, phone_number, gender, clinic_id, date_of_birth, medical_alerts]
    );

    res.status(201).json({ message: "تم إضافة المريض بنجاح", patient: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') { // Unique violation
      return res.status(400).json({ error: "رقم الهاتف موجود بالفعل" });
    }
    console.error(err.message);
    res.status(500).json({ error: "Server Error" });
  }
}

const getPatients = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { search } = req.query;

    if (search) {
      const result = await pool.query(
        "SELECT * FROM patients WHERE clinic_id = $1 AND (name ILIKE $2 OR phone_number ILIKE $2) AND is_active = TRUE ORDER BY created_at DESC",
        [clinicId, `%${search}%`]
      );
      return res.status(200).json({ patients: result.rows });
    }
    const result = await pool.query(
      "SELECT * FROM patients WHERE clinic_id = $1 AND is_active = TRUE ORDER BY created_at DESC",
      [clinicId]
    );
    res.status(200).json({ patients: result.rows });
  } catch (err) {
    console.error("Error fetching patients:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

const getPatientById = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const patientId = req.params.id;

    const result = await pool.query(
      "SELECT * FROM patients WHERE id = $1 AND clinic_id = $2",
      [patientId, clinicId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "المريض غير موجود" });
    }

    res.status(200).json({ patient: result.rows[0] });
  } catch (err) {
    console.error("Error fetching patient by ID:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

const updatePatient = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const patientId = req.params.id;
    const { name, phone_number, gender, date_of_birth, medical_alerts } = req.body;

    const query = `
      UPDATE patients 
      SET 
        name = COALESCE($1, name),
        phone_number = COALESCE($2, phone_number),
        gender = COALESCE($3, gender),
        date_of_birth = COALESCE($4, date_of_birth),
        medical_alerts = COALESCE($5, medical_alerts),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6 AND clinic_id = $7
      RETURNING *;
    `;

    const result = await pool.query(query, [
      name || null,
      phone_number || null,
      gender || null,
      date_of_birth || null,
      medical_alerts || null,
      patientId,
      clinicId
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "المريض غير موجود" });
    }

    res.status(200).json({ 
      message: "تم تحديث بيانات المريض بنجاح", 
      patient: result.rows[0] 
    });
  } catch (err) {
    if (err.code === "23505") { // Unique violation لرقم التليفون
      return res.status(400).json({ error: "رقم الهاتف موجود بالفعل لمريض آخر في العيادة" });
    }
    console.error("Error updating patient:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

const deletePatient = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const patientId = req.params.id;

    const result = await pool.query(
      "update patients SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND clinic_id = $2 AND is_active = TRUE RETURNING id, name", [patientId, clinicId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "المريض غير موجود" });
    }

    res.status(200).json({ message: "تم حذف المريض بنجاح", patient: result.rows[0] });
  } catch (err) {
    console.error("Error deleting patient:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

module.exports = { addPatient, getPatients, getPatientById, updatePatient, deletePatient };