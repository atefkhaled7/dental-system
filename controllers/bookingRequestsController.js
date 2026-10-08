const pool = require("../db");
const { isValidUuid } = require("../middleware/validateUuid");
const { logActivity } = require("../utils/auditLogger");

// 1. جلب طلبات الحجز للعيادة مع الفلترة والـ Pagination
const getBookingRequests = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { status, page, limit } = req.query;

  try {
    // تحديث تلقائي للطلبات المنتهية (Booking Expiry Auto-update)
    await pool.query(
      `UPDATE booking_requests 
       SET status = 'expired', updated_at = CURRENT_TIMESTAMP
       WHERE clinic_id = $1 AND status = 'pending' AND expires_at < CURRENT_TIMESTAMP;`,
      [clinic_id]
    );

    let query = `
      SELECT 
        br.id,
        br.patient_name,
        br.patient_phone,
        br.requested_date,
        br.duration_minutes,
        br.status,
        br.notes,
        br.expires_at,
        br.created_at,
        u.name AS doctor_name,
        pc.description AS service_name,
        pc.default_price AS service_price,
        COUNT(*) OVER() AS full_count
      FROM booking_requests br
      JOIN users u ON br.doctor_id = u.id AND br.clinic_id = u.clinic_id
      LEFT JOIN procedure_codes pc ON br.procedure_code_id = pc.id AND br.clinic_id = pc.clinic_id
      WHERE br.clinic_id = $1
    `;
    const params = [clinic_id];

    if (status && status !== "all") {
      params.push(status);
      query += ` AND br.status = $${params.length}`;
    }

    query += ` ORDER BY br.created_at DESC`;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const offset = (pageNum - 1) * limitNum;

    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2};`;
    params.push(limitNum, offset);

    const result = await pool.query(query, params);
    const total =
      result.rows.length > 0 ? Number(result.rows[0].full_count) : 0;
    const requests = result.rows.map(({ full_count, ...r }) => r);
    const totalPages = Math.ceil(total / limitNum) || 1;

    res.status(200).json({
      booking_requests: requests,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Error fetching booking requests:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء جلب طلبات الحجز" });
  }
};

// 2. قبول طلب الحجز وتحويله إلى موعد رسمي ومريض
const approveBookingRequest = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { id } = req.params;

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: "معرّف الطلب غير صالح" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // قفل سطر الطلب
    const reqRes = await client.query(
      `SELECT * FROM booking_requests 
       WHERE id = $1 AND clinic_id = $2 
       FOR UPDATE;`,
      [id, clinic_id]
    );

    if (reqRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "طلب الحجز غير موجود" });
    }

    const booking = reqRes.rows[0];

    if (booking.status !== "pending") {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: `لا يمكن قبول طلب بحالة: ${booking.status}` });
    }

    if (new Date(booking.expires_at) < new Date()) {
      await client.query(
        "UPDATE booking_requests SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = $1;",
        [id]
      );
      await client.query("COMMIT");
      return res.status(400).json({ error: "عذراً، انتهت صلاحية هذا الطلب" });
    }

    const doctorLockRes = await client.query(
      `SELECT id
       FROM users
       WHERE id = $1
         AND clinic_id = $2
         AND role = 'Doctor'
         AND is_active = TRUE
       FOR UPDATE;`,
      [booking.doctor_id, clinic_id]
    );

    if (doctorLockRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "الطبيب غير موجود أو غير متاح حالياً",
      });
    }

    // أ) فحص هل المريض مسجل مسبقاً بنفس رقم الهاتف في العيادة؟
    let patientId;
    const patientCheck = await client.query(
      "SELECT id FROM patients WHERE clinic_id = $1 AND phone_number = $2;",
      [clinic_id, booking.patient_phone]
    );

    if (patientCheck.rows.length > 0) {
      patientId = patientCheck.rows[0].id;
    } else {
      // تسجيل مريض جديد تلقائياً
      const createPatientRes = await client.query(
        `INSERT INTO patients (clinic_id, name, phone_number, is_active)
         VALUES ($1, $2, $3, TRUE)
         RETURNING id;`,
        [clinic_id, booking.patient_name, booking.patient_phone]
      );
      patientId = createPatientRes.rows[0].id;
    }

    // ب) فحص تعارض المواعيد للطبيب
    const conflictCheck = await client.query(
      `SELECT id FROM appointments
       WHERE clinic_id = $1 AND doctor_id = $2 AND status = 'scheduled'
         AND appointment_date < ($3::timestamptz + ($4 * INTERVAL '1 minute'))
         AND (appointment_date + (duration_minutes * INTERVAL '1 minute')) > $3::timestamptz
       LIMIT 1;`,
      [
        clinic_id,
        booking.doctor_id,
        booking.requested_date,
        booking.duration_minutes,
      ]
    );

    if (conflictCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "يوجد تعارض: تم حجز كشف آخر للطبيب في نفس هذا الموعد",
      });
    }

    // جـ) إنشاء الموعد الرسمي
    const apptRes = await client.query(
      `INSERT INTO appointments (
        clinic_id, patient_id, doctor_id, appointment_date, 
        duration_minutes, notes, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
      RETURNING *;`,
      [
        clinic_id,
        patientId,
        booking.doctor_id,
        booking.requested_date,
        booking.duration_minutes,
        `حجز مؤكد من الموقع العام: ${booking.notes || "لا توجد ملاحظات"}`,
      ]
    );

    // د) تحديث حالة طلب الحجز إلى approved
    await client.query(
      `UPDATE booking_requests 
       SET status = 'approved', updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1;`,
      [id]
    );

    await client.query("COMMIT");

    // تسجيل العملية في سجل الرقابة بدون التأثير على نجاح العملية الأساسية
    try {
      await logActivity({
        clinic_id,
        user_id: req.user.id,
        action: "APPROVE_BOOKING_REQUEST",
        entity_type: "appointment",
        entity_id: apptRes.rows[0].id,
        description: `قام ${
          req.user.name || "الاستقبال"
        } بالموافقة على طلب الحجز للمريض (${booking.patient_name})`,
        metadata: {
          booking_request_id: id,
          appointment_id: apptRes.rows[0].id,
        },
      });
    } catch (auditErr) {
      console.error("Audit log failed:", auditErr.message);
    }

    res.status(200).json({
      message: "تمت الموافقة على طلب الحجز وتأكيد الموعد بنجاح",
      appointment: apptRes.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error approving booking request:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء تأكيد طلب الحجز" });
  } finally {
    client.release();
  }
};

// 3. رفض طلب الحجز
const rejectBookingRequest = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { id } = req.params;

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: "معرّف الطلب غير صالح" });
  }

  try {
    const result = await pool.query(
      `UPDATE booking_requests 
       SET status = 'rejected', updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND clinic_id = $2 AND status = 'pending'
       RETURNING *;`,
      [id, clinic_id]
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "الطلب غير موجود أو تمت معالجته بالفعل" });
    }
    try {
      await logActivity({
        clinic_id,
        user_id: req.user.id,
        action: "REJECT_BOOKING_REQUEST",
        entity_type: "booking_request",
        entity_id: id,
        description: `قام ${
          req.user.name || "الاستقبال"
        } برفض طلب حجز للمريض (${result.rows[0].patient_name})`,
        metadata: {
          booking_request_id: id,
        },
      });
    } catch (auditErr) {
      console.error("Audit log failed:", auditErr.message);
    }

    res.status(200).json({
      message: "تم رفض طلب الحجز",
      booking_request: result.rows[0],
    });
  } catch (error) {
    console.error("Error rejecting booking request:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء رفض طلب الحجز" });
  }
};

module.exports = {
  getBookingRequests,
  approveBookingRequest,
  rejectBookingRequest,
};
