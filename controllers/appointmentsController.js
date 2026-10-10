const pool = require("../db");
const { logActivity } = require("../utils/auditLogger");
const { normalizeEgyptianPhone } = require("../utils/phoneNormalizer");
const { isValidUuid } = require("../middleware/validateUuid");
const { captureError } = require("../utils/errorTracker");
// ==========================================
// 1. جلب المواعيد مع الفلاتر (بتوقيت Africa/Cairo)
// ==========================================
// ==========================================
// 1. جلب المواعيد مع الفلاتر والـ Pagination (بتوقيت Africa/Cairo)
// ==========================================
const getAppointments = async (req, res) => {
  try {
    const { clinic_id } = req.user;
    const { date, doctor_id, patient_id, status, page, limit } = req.query;

    // فحص صحة الـ UUIDs في الفلاتر
    if (doctor_id && !isValidUuid(doctor_id)) {
      return res.status(400).json({ error: "معرّف الطبيب في الفلتر غير صالح" });
    }
    if (patient_id && !isValidUuid(patient_id)) {
      return res.status(400).json({ error: "معرّف المريض في الفلتر غير صالح" });
    }

    let query = `
      SELECT 
        a.id,
        a.clinic_id,
        a.patient_id,
        a.doctor_id,
        a.appointment_date,
        a.duration_minutes,
        (a.appointment_date + (a.duration_minutes * INTERVAL '1 minute')) AS appointment_end,
        a.status,
        a.notes,
        a.created_at,
        p.name AS patient_name,
        p.phone_number AS patient_phone,
        u.name AS doctor_name,
        inv.id AS invoice_id,
        inv.status AS invoice_status,
        inv.total_amount AS invoice_total,
        COUNT(*) OVER() AS full_count
      FROM appointments a
      JOIN patients p
        ON a.patient_id = p.id
        AND a.clinic_id = p.clinic_id
      JOIN users u
        ON a.doctor_id = u.id
        AND a.clinic_id = u.clinic_id
      LEFT JOIN LATERAL (
        SELECT
          inv.id,
          inv.status,
          inv.total_amount
        FROM invoices inv
        WHERE inv.appointment_id = a.id
          AND inv.clinic_id = a.clinic_id
          AND inv.is_archived = FALSE
          AND inv.status <> 'cancelled'
        ORDER BY inv.created_at DESC
        LIMIT 1
      ) inv ON TRUE
      WHERE a.clinic_id = $1
    `;
    const params = [clinic_id];
    let paramCounter = 2;

    // فلترة التاريخ بتوقيت القاهرة الصريح
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({
          error: "صيغة التاريخ غير صالحة (يجب أن تكون YYYY-MM-DD)",
        });
      }
      query += ` AND DATE(a.appointment_date AT TIME ZONE 'Africa/Cairo') = $${paramCounter}::date`;
      params.push(date);
      paramCounter++;
    }
    if (doctor_id) {
      query += ` AND a.doctor_id = $${paramCounter}`;
      params.push(doctor_id);
      paramCounter++;
    }
    if (patient_id) {
      query += ` AND a.patient_id = $${paramCounter}`;
      params.push(patient_id);
      paramCounter++;
    }
    if (status) {
      query += ` AND a.status = $${paramCounter}`;
      params.push(status);
      paramCounter++;
    }

    query += ` ORDER BY a.appointment_date ASC`;

    // دعم الـ Pagination إذا طُلبت في الـ query params
    const isPaginated = page !== undefined || limit !== undefined;
    if (isPaginated) {
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
      const offset = (pageNum - 1) * limitNum;

      query += ` LIMIT $${paramCounter} OFFSET $${paramCounter + 1};`;
      params.push(limitNum, offset);

      const result = await pool.query(query, params);
      const total =
        result.rows.length > 0 ? Number(result.rows[0].full_count) : 0;
      const appointments = result.rows.map(({ full_count, ...appt }) => appt);
      const totalPages = Math.ceil(total / limitNum) || 1;

      return res.status(200).json({
        appointments,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages,
        },
      });
    }

    // إذا لم تُطلب pagination (مثل الكالندر اليومي)، نرجع النتائج مباشرة
    const result = await pool.query(query + ";", params);
    const appointments = result.rows.map(({ full_count, ...appt }) => appt);
    return res.status(200).json({ appointments });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching appointments:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء جلب المواعيد" });
  }
};

// ==========================================
// 2. جلب تفاصيل موعد محدد
// ==========================================
const getAppointmentById = async (req, res) => {
  try {
    const { clinic_id } = req.user;
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT 
        a.id,
        a.clinic_id,
        a.patient_id,
        a.doctor_id,
        a.appointment_date,
        a.duration_minutes,
        (a.appointment_date + (a.duration_minutes * INTERVAL '1 minute')) AS appointment_end,
        a.status,
        a.notes,
        a.created_at,
        p.name AS patient_name,
        p.phone_number AS patient_phone,
        p.gender AS patient_gender,
        p.medical_alerts AS patient_medical_alerts,
        u.name AS doctor_name
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id AND a.clinic_id = p.clinic_id
      JOIN users u ON a.doctor_id = u.id AND a.clinic_id = u.clinic_id
      WHERE a.id = $1 AND a.clinic_id = $2;
      `,
      [id, clinic_id]
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "الموعد غير موجود أو لا ينتمي لعيادتك" });
    }

    res.status(200).json({ appointment: result.rows[0] });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching appointment details:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء جلب تفاصيل الموعد" });
  }
};

// ==========================================
// 3. إنشاء موعد جديد (مع الحماية من التعارض والتزامن)
// ==========================================
const createAppointment = async (req, res) => {
  const {
    patient_id,
    new_patient,
    doctor_id,
    appointment_date,
    duration_minutes,
    notes,
  } = req.body;

  if (!doctor_id || !isValidUuid(doctor_id)) {
    return res.status(400).json({
      error: "معرّف الطبيب مطلوب وغير صالح",
    });
  }
  if (patient_id && !isValidUuid(patient_id)) {
    return res.status(400).json({
      error: "معرّف المريض المختار غير صالح",
    });
  }
  if (!appointment_date) {
    return res.status(400).json({
      error: "موعد الكشف مطلوب",
    });
  }

  // 1. التحقق من صحة تاريخ الموعد وسماحية الـ 5 دقائق
  const parsedDate = new Date(appointment_date);
  if (isNaN(parsedDate.getTime())) {
    return res.status(400).json({ error: "صيغة تاريخ ووقت الموعد غير صحيحة" });
  }

  const now = new Date();
  if (parsedDate < new Date(now.getTime() - 5 * 60 * 1000)) {
    return res.status(400).json({
      error: "لا يمكن حجز موعد في تاريخ أو وقت سابق",
    });
  }

  const maxFutureDate = new Date();
  maxFutureDate.setFullYear(maxFutureDate.getFullYear() + 1);
  if (parsedDate > maxFutureDate) {
    return res.status(400).json({
      error: "لا يمكن حجز موعد لأكثر من سنة في المستقبل",
    });
  }

  const client = await pool.connect();
  try {
    const { clinic_id } = req.user;

    await client.query("BEGIN");

    // 2. قفل صف الطبيب النشط (is_active = TRUE) لحل مشكلة التزامن (Concurrency)
    const doctorLock = await client.query(
      `SELECT id, name FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor' AND is_active = TRUE FOR UPDATE`,
      [doctor_id, clinic_id]
    );

    if (doctorLock.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error:
          "الطبيب المحدد غير موجود أو غير تابع لعيادتك أو حسابه معطل حالياً",
      });
    }

    // 3. التحقق من مدة الكشف (من 5 إلى 240 دقيقة) أو القيمة الافتراضية
    let appointmentDuration;
    if (
      duration_minutes !== undefined &&
      duration_minutes !== null &&
      duration_minutes !== ""
    ) {
      const parsedDuration = Number(duration_minutes);
      if (
        !Number.isInteger(parsedDuration) ||
        parsedDuration < 5 ||
        parsedDuration > 240
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "مدة الكشف يجب أن تكون رقماً صحيحاً بين 5 و 240 دقيقة",
        });
      }
      appointmentDuration = parsedDuration;
    } else {
      const clinicRes = await client.query(
        "SELECT default_appointment_duration FROM clinics WHERE id = $1",
        [clinic_id]
      );
      const storedDuration = Number(
        clinicRes.rows[0]?.default_appointment_duration
      );
      appointmentDuration =
        Number.isInteger(storedDuration) &&
        storedDuration >= 5 &&
        storedDuration <= 240
          ? storedDuration
          : 30;
    }

    // 4. تحديد المريض
    let finalPatientId = patient_id;

    if (!finalPatientId) {
      if (!new_patient || !new_patient.name || !new_patient.phone_number) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "يجب اختيار مريض مسجل أو إدخال اسم ورقم هاتف المريض الجديد",
        });
      }

      const { name, phone_number, gender, date_of_birth, medical_alerts } =
        new_patient;

      const cleanName = typeof name === "string" ? name.trim() : "";
      if (cleanName.length < 2) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "اسم المريض مطلوب ويجب ألا يقل عن حرفين" });
      }

      const cleanPhone = normalizeEgyptianPhone(phone_number);
      if (!cleanPhone) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "رقم الهاتف المصري غير صحيح",
        });
      }

      // توحيد النوع وتجاوز حساسية الأحرف
      let normalizedGender = null;
      if (gender) {
        const lowerGender = String(gender).trim().toLowerCase();
        if (lowerGender === "female") normalizedGender = "Female";
        else if (lowerGender === "male") normalizedGender = "Male";
        else {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: "النوع يجب أن يكون Male أو Female" });
        }
      }

      if (date_of_birth) {
        const dob = new Date(date_of_birth);
        if (isNaN(dob.getTime()) || dob > new Date()) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "تاريخ ميلاد المريض غير صالح ولا يمكن أن يكون في المستقبل",
          });
        }
      }

      // فحص وجود مريض مسجل بنفس الرقم
      const existingPatientCheck = await client.query(
        "SELECT id, name, is_active FROM patients WHERE clinic_id = $1 AND phone_number = $2",
        [clinic_id, cleanPhone]
      );

      if (existingPatientCheck.rows.length > 0) {
        const foundPatient = existingPatientCheck.rows[0];

        if (foundPatient.is_active === false) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `رقم الهاتف مسجل للمريض (${foundPatient.name}) وهو مؤرشف حالياً. يرجى إلغاء أرشفة المريض أولاً من قائمة المرضى.`,
          });
        }

        finalPatientId = foundPatient.id;
      } else {
        const cleanMedicalAlerts =
          typeof medical_alerts === "string"
            ? medical_alerts.trim() || null
            : null;

        const createdPatient = await client.query(
          `
          INSERT INTO patients (clinic_id, name, phone_number, gender, date_of_birth, medical_alerts)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id;
          `,
          [
            clinic_id,
            cleanName,
            cleanPhone,
            normalizedGender,
            date_of_birth || null,
            cleanMedicalAlerts,
          ]
        );
        finalPatientId = createdPatient.rows[0].id;
      }
    } else {
      // التأكد من أن المريض المختار نشط
      const patientCheck = await client.query(
        "SELECT id, is_active FROM patients WHERE id = $1 AND clinic_id = $2",
        [finalPatientId, clinic_id]
      );

      if (patientCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "المريض المحدد غير موجود" });
      }

      if (patientCheck.rows[0].is_active === false) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "لا يمكن حجز موعد لمريض مؤرشف. يرجى إلغاء أرشفته أولاً.",
        });
      }
    }

    const parsedDateForDB = parsedDate.toISOString();

    // 5. فحص تعارض المواعيد الزمني (Interval Overlap)
    const conflictCheck = await client.query(
      `
      SELECT 
        a.id, 
        a.appointment_date,
        a.duration_minutes,
        (a.appointment_date + (a.duration_minutes * INTERVAL '1 minute')) AS existing_end
      FROM appointments a
      WHERE a.clinic_id = $1 
        AND a.doctor_id = $2 
        AND a.status = 'scheduled'
        AND a.appointment_date < ($3::timestamptz + ($4 * INTERVAL '1 minute'))
        AND (a.appointment_date + (a.duration_minutes * INTERVAL '1 minute')) > $3::timestamptz
      LIMIT 1;
      `,
      [clinic_id, doctor_id, parsedDateForDB, appointmentDuration]
    );

    if (conflictCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      const conflict = conflictCheck.rows[0];
      return res.status(409).json({
        error: "يوجد تعارض في المواعيد: الطبيب لديه كشف محجوز في هذا التوقيت",
        conflict: {
          start: conflict.appointment_date,
          end: conflict.existing_end,
          duration: conflict.duration_minutes,
        },
      });
    }

    const cleanNotes = typeof notes === "string" ? notes.trim() || null : null;

    // 6. حفظ الموعد
    const insertResult = await client.query(
      `
      INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_date, duration_minutes, notes, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
      RETURNING *;
      `,
      [
        clinic_id,
        finalPatientId,
        doctor_id,
        parsedDateForDB,
        appointmentDuration,
        cleanNotes,
      ]
    );

    await client.query("COMMIT");

    await logActivity({
      clinic_id,
      user_id: req.user.id,
      action: "CREATE_APPOINTMENT",
      entity_type: "appointment",
      entity_id: insertResult.rows[0].id,
      description: `قام ${
        req.user.name
      } بحجز موعد جديد للمريض #${finalPatientId.slice(0, 8)}`,
      metadata: {
        doctor_id,
        appointment_date: parsedDateForDB,
        duration_minutes: appointmentDuration,
      },
    });

    return res.status(201).json({
      message: "تم حجز الموعد بنجاح",
      appointment: insertResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      if (
        error.detail?.includes("phone_number") ||
        error.constraint?.includes("phone")
      ) {
        return res
          .status(400)
          .json({ error: "رقم الهاتف مسجل بالفعل لمريض آخر" });
      }
      return res.status(409).json({
        error:
          "يوجد تعارض في المواعيد: تم حجز هذا الموعد بالفعل من قبل مستخدم آخر",
      });
    }
    captureError(error, req);
    console.error("Error creating appointment:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء حجز الموعد" });
  } finally {
    client.release();
  }
};

// ==========================================
// 4. تحديث حالة الموعد (مع فحص التعارض عند تفعيله إلى scheduled)
// ==========================================
const updateAppointmentStatus = async (req, res) => {
  const client = await pool.connect();
  try {
    const { clinic_id } = req.user;
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ["scheduled", "completed", "cancelled", "no_show"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error:
          "الحالة غير صالحة. الحالات المسموحة: scheduled, completed, cancelled, no_show",
      });
    }

    await client.query("BEGIN");

    const appCheck = await client.query(
      `SELECT * FROM appointments WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [id, clinic_id]
    );

    if (appCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ error: "الموعد غير موجود أو لا ينتمي لعيادتك" });
    }

    const currentApp = appCheck.rows[0];

    // منع تعديل حالة موعد مكتمل
    if (currentApp.status === "completed" && status !== "completed") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "لا يمكن تغيير حالة موعد مكتمل",
      });
    }

    // لو الموعد كان ملغي وبنرجعه scheduled، نتأكد إنه مفيش تعارض جديد وإنه مش في الماضي
    if (status === "scheduled" && currentApp.status !== "scheduled") {
      const now = new Date();
      if (
        new Date(currentApp.appointment_date) <
        new Date(now.getTime() - 5 * 60 * 1000)
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error:
            "لا يمكن إعادة تفعيل موعد في تاريخ سابق إلى 'مجدول'. يرجى تعديل توقيت الموعد أولاً (Reschedule).",
        });
      }

      // قفل صف الطبيب
      const doctorLock = await client.query(
        `SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor' AND is_active = TRUE FOR UPDATE`,
        [currentApp.doctor_id, clinic_id]
      );

      if (doctorLock.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "لا يمكن إعادة تفعيل الموعد لأن الطبيب غير نشط حالياً",
        });
      }

      const conflictCheck = await client.query(
        `
        SELECT 
          a.id, 
          a.appointment_date,
          (a.appointment_date + (a.duration_minutes * INTERVAL '1 minute')) AS existing_end
        FROM appointments a
        WHERE a.clinic_id = $1 
          AND a.doctor_id = $2 
          AND a.status = 'scheduled'
          AND a.id != $3
          AND a.appointment_date < ($4::timestamptz + ($5 * INTERVAL '1 minute'))
          AND (a.appointment_date + (a.duration_minutes * INTERVAL '1 minute')) > $4::timestamptz
        LIMIT 1;
        `,
        [
          clinic_id,
          currentApp.doctor_id,
          id,
          currentApp.appointment_date,
          currentApp.duration_minutes || 30,
        ]
      );

      if (conflictCheck.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:
            "لا يمكن إعادة تفعيل الموعد لوجود تعارض مع موعد آخر محجوز للطبيب في نفس التوقيت",
          conflict: conflictCheck.rows[0],
        });
      }
    }

    const result = await client.query(
      `
      UPDATE appointments 
      SET status = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND clinic_id = $3
      RETURNING *;
      `,
      [status, id, clinic_id]
    );

    await client.query("COMMIT");

    await logActivity({
      clinic_id,
      user_id: req.user.id,
      action:
        status === "cancelled"
          ? "CANCEL_APPOINTMENT"
          : "UPDATE_APPOINTMENT_STATUS",
      entity_type: "appointment",
      entity_id: id,
      description:
        status === "cancelled"
          ? `تمت الغاء الموعد #${id.slice(0, 8)}`
          : `تم تغيير حالة الموعد #${id.slice(0, 8)} من ${
              currentApp.status
            } إلى ${status}`,
      metadata: {
        old_status: currentApp.status,
        new_status: status,
      },
    });

    res.status(200).json({
      message: "تم تحديث حالة الموعد بنجاح",
      appointment: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return res.status(409).json({
        error: "تعارض: الطبيب لديه كشف آخر مسجل في نفس الفترة",
      });
    }
    captureError(error, req);
    console.error("Error updating appointment status:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء تحديث حالة الموعد" });
  } finally {
    client.release();
  }
};

// ==========================================
// 5. تعديل موعد الكشف (Reschedule)
// ==========================================
const rescheduleAppointment = async (req, res) => {
  const { appointment_date, duration_minutes } = req.body;

  if (!appointment_date) {
    return res.status(400).json({ error: "تاريخ ووقت الموعد الجديد مطلوب" });
  }

  const parsedDate = new Date(appointment_date);
  if (isNaN(parsedDate.getTime())) {
    return res.status(400).json({ error: "صيغة التاريخ غير صحيحة" });
  }

  const now = new Date();
  if (parsedDate < new Date(now.getTime() - 5 * 60 * 1000)) {
    return res.status(400).json({
      error: "لا يمكن نقل الموعد إلى تاريخ أو وقت سابق",
    });
  }

  const maxFutureDate = new Date();
  maxFutureDate.setFullYear(maxFutureDate.getFullYear() + 1);
  if (parsedDate > maxFutureDate) {
    return res.status(400).json({
      error: "لا يمكن نقل الموعد لأكثر من سنة في المستقبل",
    });
  }

  const client = await pool.connect();
  try {
    const { clinic_id } = req.user;
    const { id } = req.params;

    await client.query("BEGIN");

    const currentApp = await client.query(
      `SELECT * FROM appointments WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [id, clinic_id]
    );

    if (currentApp.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ error: "الموعد غير موجود أو لا ينتمي لعيادتك" });
    }

    if (currentApp.rows[0].status === "completed") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "لا يمكن تعديل موعد مكتمل بالفعل" });
    }

    const doctor_id = currentApp.rows[0].doctor_id;

    const oldAppointmentDate = currentApp.rows[0].appointment_date;

    // قفل صف الطبيب والتأكد من أنه نشط
    const doctorLock = await client.query(
      `SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor' AND is_active = TRUE FOR UPDATE`,
      [doctor_id, clinic_id]
    );

    if (doctorLock.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "الطبيب غير موجود أو تم تعطيل حسابه حالياً",
      });
    }

    // التحقق من المدة بين 5 و 240 دقيقة
    let duration = currentApp.rows[0].duration_minutes || 30;
    if (
      duration_minutes !== undefined &&
      duration_minutes !== null &&
      duration_minutes !== ""
    ) {
      const parsedDuration = Number(duration_minutes);
      if (
        !Number.isInteger(parsedDuration) ||
        parsedDuration < 5 ||
        parsedDuration > 240
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "مدة الكشف يجب أن تكون رقماً صحيحاً بين 5 و 240 دقيقة",
        });
      }
      duration = parsedDuration;
    }

    const parsedDateForDB = parsedDate.toISOString();

    // فحص التعارض الزمني باستثناء الموعد الحالي
    const conflictCheck = await client.query(
      `
      SELECT 
        a.id, 
        a.appointment_date,
        (a.appointment_date + (a.duration_minutes * INTERVAL '1 minute')) AS existing_end
      FROM appointments a
      WHERE a.clinic_id = $1 
        AND a.doctor_id = $2 
        AND a.status = 'scheduled'
        AND a.id != $5
        AND a.appointment_date < ($3::timestamptz + ($4 * INTERVAL '1 minute'))
        AND (a.appointment_date + (a.duration_minutes * INTERVAL '1 minute')) > $3::timestamptz
      LIMIT 1;
      `,
      [clinic_id, doctor_id, parsedDateForDB, duration, id]
    );

    if (conflictCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "يوجد تعارض: الطبيب لديه كشف آخر مسجل في هذا التوقيت الجديد",
        conflict: conflictCheck.rows[0],
      });
    }

    const updateResult = await client.query(
      `
      UPDATE appointments
      SET appointment_date = $1,
          duration_minutes = $2,
          status = 'scheduled',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND clinic_id = $4
      RETURNING *;
      `,
      [parsedDateForDB, duration, id, clinic_id]
    );

    await client.query("COMMIT");

    await logActivity({
      clinic_id,
      user_id: req.user.id,
      action: "RESCHEDULE_APPOINTMENT",
      entity_type: "appointment",
      entity_id: id,
      description: `تم تعديل موعد الكشف #${id.slice(0, 8)}`,
      metadata: {
        old_appointment_date: oldAppointmentDate,
        new_appointment_date: parsedDateForDB,
        old_duration_minutes: currentApp.rows[0].duration_minutes,
        new_duration_minutes: duration,
      },
    });

    res.status(200).json({
      message: "تم تعديل الموعد بنجاح",
      appointment: updateResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return res.status(409).json({
        error: "تعارض: تم حجز هذا الموعد بالفعل من قبل مستخدم آخر",
      });
    }
    captureError(error, req);
    console.error("Error rescheduling appointment:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء تعديل الموعد" });
  } finally {
    client.release();
  }
};

// ==========================================
// 6. حذف موعد نهائياً (ClinicAdmin فقط مع فك ارتباط الفواتير المؤرشفة وطلبات المعمل)
// ==========================================
const deleteAppointment = async (req, res) => {
  const client = await pool.connect();
  try {
    const { clinic_id, role } = req.user;
    const { id } = req.params;

    if (role !== "ClinicAdmin") {
      return res.status(403).json({
        error: "غير مصرح لك بحذف المواعيد نهائياً. يمكنك فقط إلغاء الموعد.",
      });
    }

    await client.query("BEGIN");

    // قفل سطر الموعد
    const appointmentCheck = await client.query(
      `
      SELECT id
      FROM appointments
      WHERE id = $1 AND clinic_id = $2
      FOR UPDATE;
      `,
      [id, clinic_id]
    );

    if (appointmentCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ error: "الموعد غير موجود أو لا ينتمي لعيادتك" });
    }

    // فحص الفواتير النشطة (غير المؤرشفة وغير الملغاة)
    const activeInvoiceCheck = await client.query(
      `
  SELECT id
  FROM invoices
  WHERE clinic_id = $1 
    AND appointment_id = $2 
    AND is_archived = false
    AND status <> 'cancelled';
  `,
      [clinic_id, id]
    );
    if (activeInvoiceCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error:
          "لا يمكن حذف هذا الموعد لوجود فاتورة نشطة مرتبطة به. يرجى إلغاء الموعد أو أرشفة/إلغاء الفاتورة أولاً.",
      });
    }
    // فك ارتباط طلبات المعمل وتحديث updated_at
    await client.query(
      `
  UPDATE lab_orders
  SET appointment_id = NULL, updated_at = CURRENT_TIMESTAMP
  WHERE clinic_id = $1 AND appointment_id = $2;
  `,
      [clinic_id, id]
    );
    // فك ارتباط أي فواتير أخرى (سواء مؤرشفة أو ملغاة) لتفادي Foreign Key Error
    await client.query(
      `
  UPDATE invoices
  SET appointment_id = NULL, updated_at = CURRENT_TIMESTAMP
  WHERE clinic_id = $1 AND appointment_id = $2;
  `,
      [clinic_id, id]
    );
    // حذف الموعد
    await client.query(
      `DELETE FROM appointments WHERE id = $1 AND clinic_id = $2;`,
      [id, clinic_id]
    );
    await client.query("COMMIT");

    try {
      await logActivity({
        clinic_id,
        user_id: req.user.id,
        action: "DELETE_APPOINTMENT",
        entity_type: "appointment",
        entity_id: id,
        description: `قام ${req.user.name || "المدير"} بحذف الموعد #${id.slice(
          0,
          8
        )} نهائياً من السيستم`,
        metadata: {
          appointment_id: id,
        },
      });
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    res.status(200).json({ message: "تم حذف الموعد بنجاح" });
  } catch (error) {
    captureError(error, req);
    await client.query("ROLLBACK");
    console.error("Error deleting appointment:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء حذف الموعد" });
  } finally {
    client.release();
  }
};

// ==========================================
// 7. جلب إعدادات مدة الكشف للعيادة
// ==========================================
const getClinicDurationSettings = async (req, res) => {
  try {
    const { clinic_id } = req.user;
    const result = await pool.query(
      "SELECT default_appointment_duration FROM clinics WHERE id = $1",
      [clinic_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "العيادة غير موجودة" });
    }

    res.status(200).json({
      default_appointment_duration:
        result.rows[0].default_appointment_duration || 30,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching clinic duration settings:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء جلب إعدادات العيادة" });
  }
};

// ==========================================
// 8. تحديث مدة الكشف الافتراضية للعيادة
// ==========================================
const updateClinicDurationSettings = async (req, res) => {
  try {
    const { clinic_id, role } = req.user;
    const { default_appointment_duration } = req.body;

    const duration = Number(default_appointment_duration);
    if (!Number.isInteger(duration) || duration < 5 || duration > 240) {
      return res.status(400).json({
        error:
          "مدة الكشف الافتراضية يجب أن تكون رقماً صحيحاً بين 5 و 240 دقيقة",
      });
    }

    const result = await pool.query(
      `
      UPDATE clinics
      SET default_appointment_duration = $1
      WHERE id = $2
      RETURNING id, name, default_appointment_duration;
      `,
      [duration, clinic_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "العيادة غير موجودة",
      });
    }

    res.status(200).json({
      message: "تم تحديث مدة الكشف الافتراضية للعيادة بنجاح",
      clinic: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error updating clinic duration settings:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء تحديث إعدادات العيادة" });
  }
};

module.exports = {
  getAppointments,
  getAppointmentById,
  createAppointment,
  updateAppointmentStatus,
  rescheduleAppointment,
  deleteAppointment,
  getClinicDurationSettings,
  updateClinicDurationSettings,
};
