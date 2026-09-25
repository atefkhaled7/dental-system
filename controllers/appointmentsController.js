const pool = require("../db");

const getAppointments = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;

    const query = `
      SELECT 
        a.id AS appointment_id,
        a.appointment_date,
        a.status,
        a.notes,
        p.id AS patient_id,
        p.name AS patient_name,
        p.phone_number AS patient_phone,
        u.id AS doctor_id,
        u.name AS doctor_name
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id AND a.clinic_id = p.clinic_id
      JOIN users u ON a.doctor_id = u.id AND a.clinic_id = u.clinic_id
      WHERE a.clinic_id = $1
      ORDER BY a.appointment_date ASC;
    `;

    const result = await pool.query(query, [clinicId]);
    res.status(200).json({ appointments: result.rows });
  } catch (err) {
    console.error("Error fetching appointments:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

const createAppointment = async (req, res) => {
  try {
    const clinic_id = req.user.clinic_id;
    const { patient_id, doctor_id, appointment_date, notes } = req.body;
    if (!patient_id || !doctor_id || !appointment_date) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const doctorCheck = await pool.query(
      "SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role IN ('Doctor', 'ClinicAdmin')",
      [doctor_id, clinic_id]
    );

    if (doctorCheck.rows.length === 0) {
      return res.status(400).json({ 
        error: "المستخدم المحدد غير مسجل كطبيب مصرح له في هذه العيادة" 
      });
    }
    const conflictCheck = await pool.query(
      "SELECT id FROM appointments WHERE clinic_id = $1 AND doctor_id = $2 AND appointment_date = $3 AND status = 'scheduled'",
      [clinic_id, doctor_id, appointment_date]
    );
    if (conflictCheck.rows.length > 0) {
      return res.status(409).json({
        error: "الدكتور لديه ميعاد آخر محجوز بالفعل في هذا التوقيت",
      });
    }

    const query = `
      INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_date, notes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;

    const result = await pool.query(query, [
      clinic_id,
      patient_id,
      doctor_id,
      appointment_date,
      notes || null,
    ]);
    res.status(201).json({ appointment: result.rows[0] });
  } catch (error) {
    // لو الـ Unique Index منع الحجز المزدوج:
    if (error.code === "23505") {
      return res.status(409).json({
        error: "الدكتور لديه ميعاد آخر محجوز بالفعل في هذا التوقيت",
      });
    }

    if (error.code === "23505") {
      return res.status(409).json({ 
        error: "الدكتور لديه ميعاد آخر محجوز بالفعل في هذا التوقيت" 
      });
    }

    if (error.code === "23503") {
      return res
        .status(400)
        .json({ error: "المريض أو الدكتور غير مسجلين في هذه العيادة" });
    }

    console.error("Error creating appointment:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

const updateAppointmentStatus = async (req, res) => {
  try {
    const { id } = req.params; // 👈 متطابق مع :id في الراوت
    const { status } = req.body;
    const clinic_id = req.user.clinic_id; // 👈 هنسحبه ونستخدمه تحت
    const validStatuses = ["scheduled", "completed", "no_show", "cancelled"];

    if (!validStatuses.includes(status)) {
      return res
        .status(400)
        .json({ error: "حالة الميعاد غير صالحة (Invalid status)" });
    }

    const query = `
      UPDATE appointments 
      SET status = $1, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $2 AND clinic_id = $3 
      RETURNING *;
    `;

    const result = await pool.query(query, [status, id, clinic_id]);

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "الميعاد غير موجود في هذه العيادة" });
    }

    res.status(200).json({
      message: "تم تحديث حالة الميعاد بنجاح",
      appointment: result.rows[0],
    });
  } catch (error) {
    console.error("Error updating appointment status:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

module.exports = {
  getAppointments,
  createAppointment,
  updateAppointmentStatus,
};
