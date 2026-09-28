const pool = require("../db");

const getAppointments = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { patient_id, doctor_id, date } = req.query; // 👈 استقبلنا doctor_id و date

    let query = `
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
    `;
    const queryParams = [clinicId];

    // 1. فلترة برقم المريض
    if (patient_id) {
      queryParams.push(patient_id);
      query += ` AND a.patient_id = $${queryParams.length}`;
    }

    // 2. فلترة بالطبيب المعالج
    if (doctor_id) {
      queryParams.push(doctor_id);
      query += ` AND a.doctor_id = $${queryParams.length}`;
    }

    // 3. فلترة بتاريخ محدد (مثل تاريخ اليوم)
    if (date) {
      queryParams.push(date);
      query += ` AND DATE(a.appointment_date) = $${queryParams.length}`;
    }

    query += ` ORDER BY a.appointment_date ASC;`;

    const result = await pool.query(query, queryParams);
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
      "SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor'",
      [doctor_id, clinic_id]
    );

    if (doctorCheck.rows.length === 0) {
      return res.status(400).json({
        error: "المستخدم المحدد غير مسجل كطبيب مصرح له في هذه العيادة",
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

    const now = new Date();
    const appDate = new Date(appointment_date);

    if (isNaN(appDate.getTime())) {
      return res.status(400).json({ error: "تاريخ الميعاد غير صالح" });
    }

    if (appDate < new Date(now.getTime() - 15 * 60 * 1000)) {
      return res
        .status(400)
        .json({ error: "لا يمكن حجز ميعاد في تاريخ أو وقت سابق" });
    }

    const maxFuture = new Date();
    maxFuture.setFullYear(maxFuture.getFullYear() + 1);
    if (appDate > maxFuture) {
      return res
        .status(400)
        .json({ error: "لا يمكن حجز ميعاد لأكثر من سنة في المستقبل" });
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
    if (error.code === "23505") {
      return res.status(409).json({
        error: "الدكتور لديه ميعاد آخر محجوز بالفعل في هذا التوقيت",
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

const rescheduleAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const { appointment_date } = req.body;
    const clinic_id = req.user.clinic_id;

    if (!appointment_date) {
      return res
        .status(400)
        .json({ error: "يرجى تحديد التاريخ والوقت الجديد" });
    }

    const newAppDate = new Date(appointment_date);
    if (isNaN(newAppDate.getTime())) {
      return res.status(400).json({ error: "تاريخ الموعد غير صالح" });
    }

    // التأكد إن الوقت مش ماضي
    const now = new Date();
    if (newAppDate < new Date(now.getTime() - 15 * 60 * 1000)) {
      return res.status(400).json({ error: "لا يمكن إعادة الجدولة لوقت ماضي" });
    }

    // جلب بيانات الموعد الحالي لمعرفة الطبيب
    const currentApp = await pool.query(
      "SELECT doctor_id FROM appointments WHERE id = $1 AND clinic_id = $2",
      [id, clinic_id]
    );

    if (currentApp.rows.length === 0) {
      return res.status(404).json({ error: "الموعد غير موجود في هذه العيادة" });
    }

    const doctor_id = currentApp.rows[0].doctor_id;

    // فحص تعارض المواعيد مع نفس الدكتور في التوقيت الجديد (باستثناء الموعد نفسه)
    const conflictCheck = await pool.query(
      `SELECT id FROM appointments 
       WHERE clinic_id = $1 AND doctor_id = $2 AND appointment_date = $3 
       AND status = 'scheduled' AND id != $4`,
      [clinic_id, doctor_id, appointment_date, id]
    );

    if (conflictCheck.rows.length > 0) {
      return res
        .status(409)
        .json({
          error: "الدكتور لديه ميعاد آخر محجوز بالفعل في هذا التوقيت الجديد",
        });
    }

    // تحديث الموعد وإعادته لحالة scheduled
    const updateQuery = `
      UPDATE appointments 
      SET appointment_date = $1, status = 'scheduled', updated_at = CURRENT_TIMESTAMP 
      WHERE id = $2 AND clinic_id = $3 
      RETURNING *;
    `;

    const result = await pool.query(updateQuery, [
      appointment_date,
      id,
      clinic_id,
    ]);

    res.status(200).json({
      message: "تمت إعادة جدولة الموعد بنجاح",
      appointment: result.rows[0],
    });
  } catch (error) {
    console.error("Error rescheduling appointment:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء إعادة الجدولة" });
  }
};

module.exports = {
  getAppointments,
  createAppointment,
  updateAppointmentStatus,
  rescheduleAppointment,
};
