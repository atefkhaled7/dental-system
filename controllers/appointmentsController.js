const pool = require("../db");
const { logActivity } = require("../utils/auditLogger");
const { normalizeEgyptianPhone } = require("../utils/phoneNormalizer");
const { isValidUuid } = require("../middleware/validateUuid");
const { captureError } = require("../utils/errorTracker");
const {
  validateAppointmentSlot,
} = require("../services/appointmentConflictEngine");

// دوال مساعدة لتطبيع الأسماء العربية للمقارنة العادلة
const normalizeArabicName = (n) =>
  (n || "")
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ");

// التحقق من صحة التاريخ الفعلي في التقويم (يمنع 2026-02-31)
const isRealDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// التحقق من احتواء تاريخ ووقت الموعد على إزاحة المنطقة الزمنية (Z أو +02:00)
const hasTimezoneOffset = (s) =>
  typeof s === "string" && /(Z|[+-]\d{2}:?\d{2})$/i.test(s.trim());

// ==========================================
// 1. جلب المواعيد مع الفلاتر والـ Pagination (بتوقيت Africa/Cairo)
// ==========================================
const getAppointments = async (req, res) => {
  try {
    const { clinic_id } = req.user;
    const { date, doctor_id, patient_id, status, page, limit } = req.query;

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
        COALESCE(pmh.alert_level, 'none') AS medical_alert_level,
        CASE
          WHEN pmh.alert_level IN ('moderate', 'critical') OR (p.medical_alerts IS NOT NULL AND p.medical_alerts <> '')
          THEN TRUE
          ELSE FALSE
        END AS has_medical_alert,
        COUNT(*) OVER() AS full_count
      FROM appointments a
      JOIN patients p
        ON a.patient_id = p.id
        AND a.clinic_id = p.clinic_id
      LEFT JOIN patient_medical_history pmh
        ON p.id = pmh.patient_id AND p.clinic_id = pmh.clinic_id
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

    if (date) {
      if (!isRealDate(date)) {
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
// 1.B مسار التقويم السريع (GET /appointments/calendar?from=&to=&doctor_ids=)
// بدون Pagination وبكل بيانات الشيفتات والإجازات وساعات عمل العيادة
// ==========================================
const getCalendarData = async (req, res) => {
  try {
    const { clinic_id } = req.user;
    const { from, to, doctor_ids } = req.query;

    if (!from || !isRealDate(from) || !to || !isRealDate(to)) {
      return res.status(400).json({
        error: "يجب تحديد تاريخ البداية والنهاية بصيغة YYYY-MM-DD",
        code: "VALIDATION_ERROR",
      });
    }

    // فلتر الأطباء الاختياري
    let doctorFilterIds = null;
    if (
      doctor_ids &&
      typeof doctor_ids === "string" &&
      doctor_ids.trim() !== ""
    ) {
      const parsedIds = doctor_ids
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      for (const dId of parsedIds) {
        if (!isValidUuid(dId)) {
          return res.status(400).json({ error: "أحد معرفات الأطباء غير صالح" });
        }
      }
      if (parsedIds.length > 0) {
        doctorFilterIds = parsedIds;
      }
    }

    // جلب كل البيانات بالتوازي في ضربة واحدة سريعة
    const appointmentsQuery = `
      SELECT
        a.id,
        a.patient_id,
        a.doctor_id,
        a.appointment_date,
        a.duration_minutes,
        (a.appointment_date + (a.duration_minutes * INTERVAL '1 minute')) AS appointment_end,
        a.status,
        a.notes,
        p.name AS patient_name,
        p.phone_number AS patient_phone,
        p.medical_alerts AS patient_medical_alerts,
        u.name AS doctor_name,
        COALESCE(pmh.alert_level, 'none') AS medical_alert_level,
        CASE
          WHEN pmh.alert_level IN ('moderate', 'critical') OR (p.medical_alerts IS NOT NULL AND p.medical_alerts <> '')
          THEN TRUE
          ELSE FALSE
        END AS has_medical_alert,
        inv.id AS invoice_id,
        inv.status AS invoice_status,
        inv.total_amount AS invoice_total
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id AND a.clinic_id = p.clinic_id
      LEFT JOIN patient_medical_history pmh ON p.id = pmh.patient_id AND p.clinic_id = pmh.clinic_id
      JOIN users u ON a.doctor_id = u.id AND a.clinic_id = u.clinic_id
      LEFT JOIN LATERAL (
        SELECT inv.id, inv.status, inv.total_amount
        FROM invoices inv
        WHERE inv.appointment_id = a.id
          AND inv.clinic_id = a.clinic_id
          AND inv.is_archived = FALSE
          AND inv.status <> 'cancelled'
        ORDER BY inv.created_at DESC
        LIMIT 1
      ) inv ON TRUE
      WHERE a.clinic_id = $1
        AND DATE(a.appointment_date AT TIME ZONE 'Africa/Cairo') >= $2::date
        AND DATE(a.appointment_date AT TIME ZONE 'Africa/Cairo') <= $3::date
        ${doctorFilterIds ? `AND a.doctor_id = ANY($4::uuid[])` : ""}
      ORDER BY a.appointment_date ASC;
    `;

    const apptParams = doctorFilterIds
      ? [clinic_id, from, to, doctorFilterIds]
      : [clinic_id, from, to];

    const [
      appointmentsRes,
      doctorsRes,
      shiftsRes,
      leavesRes,
      clinicRes,
      workingHoursRes,
      holidaysRes,
    ] = await Promise.all([
      pool.query(appointmentsQuery, apptParams),
      pool.query(
        `SELECT id, name FROM users WHERE clinic_id = $1 AND role = 'Doctor' AND is_active = TRUE ORDER BY name ASC`,
        [clinic_id],
      ),
      pool.query(
        `SELECT doctor_id, day_of_week, start_time, end_time FROM doctor_availability WHERE clinic_id = $1 AND is_active = TRUE`,
        [clinic_id],
      ),
      pool.query(
        `SELECT doctor_id, TO_CHAR(leave_date, 'YYYY-MM-DD') AS leave_date, notes FROM doctor_leaves WHERE clinic_id = $1 AND leave_date >= $2::date AND leave_date <= $3::date`,
        [clinic_id, from, to],
      ),
      pool.query(
        `SELECT default_appointment_duration, COALESCE(total_chairs_count, 1) AS total_chairs_count FROM clinics WHERE id = $1`,
        [clinic_id],
      ),
      pool.query(
        `SELECT weekday, open_time, close_time, breaks, is_closed FROM clinic_working_hours WHERE clinic_id = $1 ORDER BY weekday ASC`,
        [clinic_id],
      ),
      pool.query(
        `SELECT id, TO_CHAR(date, 'YYYY-MM-DD') AS date, reason FROM clinic_holidays WHERE clinic_id = $1 AND date >= $2::date AND date <= $3::date ORDER BY date ASC`,
        [clinic_id, from, to],
      ),
    ]);

    return res.status(200).json({
      appointments: appointmentsRes.rows,
      doctors: doctorsRes.rows,
      doctor_shifts: shiftsRes.rows,
      doctor_leaves: leavesRes.rows,
      clinic_settings: {
        default_appointment_duration:
          clinicRes.rows[0]?.default_appointment_duration || 30,
        total_chairs_count: clinicRes.rows[0]?.total_chairs_count || 1,
        working_hours: workingHoursRes.rows,
        holidays: holidaysRes.rows,
      },
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error in getCalendarData:", error.message);
    return res.status(500).json({ error: "حدث خطأ أثناء جلب بيانات التقويم" });
  }
};

// ==========================================
// 2. جلب تفاصيل موعد محدد (مع ملخص التنبيه الطبي للدرج الجانبي)
// ==========================================
const getAppointmentById = async (req, res) => {
  try {
    const { clinic_id } = req.user;
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "معرّف الموعد غير صالح" });
    }

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
        p.date_of_birth AS patient_dob,
        p.guardian_name AS patient_guardian_name,
        p.guardian_phone AS patient_guardian_phone,
        p.medical_alerts AS patient_medical_alerts,
        COALESCE(pmh.alert_level, 'none') AS medical_alert_level,
        CASE
          WHEN pmh.alert_level IN ('moderate', 'critical') OR (p.medical_alerts IS NOT NULL AND p.medical_alerts <> '')
          THEN TRUE
          ELSE FALSE
        END AS has_medical_alert,
        pmh.answers AS medical_history_answers,
        u.name AS doctor_name
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id AND a.clinic_id = p.clinic_id
      LEFT JOIN patient_medical_history pmh ON p.id = pmh.patient_id AND p.clinic_id = pmh.clinic_id
      JOIN users u ON a.doctor_id = u.id AND a.clinic_id = u.clinic_id
      WHERE a.id = $1 AND a.clinic_id = $2;
      `,
      [id, clinic_id],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "الموعد غير موجود أو لا ينتمي لعيادتك" });
    }

    const appointment = result.rows[0];

    // جلب حساسيات المريض لعرضها في الدرج الجانبي
    const allergiesRes = await pool.query(
      `SELECT substance, severity, category FROM patient_allergies WHERE patient_id = $1 AND clinic_id = $2`,
      [appointment.patient_id, clinic_id],
    );

    res.status(200).json({
      appointment: {
        ...appointment,
        patient_allergies: allergiesRes.rows,
      },
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching appointment details:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء جلب تفاصيل الموعد" });
  }
};

// ==========================================
// 3. إنشاء موعد جديد (مع محرك التعارضات المركزي وفحص الكراسي و allow_override)
// ==========================================
const createAppointment = async (req, res) => {
  const {
    patient_id,
    new_patient,
    doctor_id,
    appointment_date,
    duration_minutes,
    notes,
    allow_override,
  } = req.body || {};

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

  if (typeof notes === "string" && notes.trim().length > 1000) {
    return res.status(400).json({
      error: "الملاحظات لا يمكن أن تتجاوز 1000 حرف",
    });
  }

  if (!hasTimezoneOffset(appointment_date)) {
    return res.status(400).json({
      error: "موعد الكشف يجب أن يتضمن المنطقة الزمنية بصيغة ISO صريحة",
    });
  }

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

  let client;
  let broken = false;

  try {
    client = await pool.connect();
    const { clinic_id, role } = req.user;
    await client.query("BEGIN");

    // 1. قفل صف العيادة والطبيب النشط لضمان دقة فحص تزامن الكراسي والطبيب
    const clinicLock = await client.query(
      `SELECT id, default_appointment_duration, COALESCE(total_chairs_count, 1) AS total_chairs_count FROM clinics WHERE id = $1 FOR UPDATE`,
      [clinic_id],
    );

    const doctorLock = await client.query(
      `SELECT id, name FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor' AND is_active = TRUE FOR UPDATE`,
      [doctor_id, clinic_id],
    );

    if (doctorLock.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error:
          "الطبيب المحدد غير موجود أو غير تابع لعيادتك أو حسابه معطل حالياً",
      });
    }

    // 2. التحقق من مدة الكشف (من 5 إلى 480 دقيقة)
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
        parsedDuration > 480
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "مدة الكشف يجب أن تكون رقماً صحيحاً بين 5 و 480 دقيقة",
        });
      }
      appointmentDuration = parsedDuration;
    } else {
      const storedDuration = Number(
        clinicLock.rows[0]?.default_appointment_duration,
      );
      appointmentDuration =
        Number.isInteger(storedDuration) &&
        storedDuration >= 5 &&
        storedDuration <= 480
          ? storedDuration
          : 30;
    }

    // 3. تحديد المريض
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
      if (cleanName.length < 2 || cleanName.length > 100) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "اسم المريض مطلوب ويجب أن يكون بين حرفين و 100 حرف" });
      }
      const cleanPhone = normalizeEgyptianPhone(phone_number);
      if (!cleanPhone) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "رقم الهاتف المصري غير صحيح",
        });
      }

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
        if (!isRealDate(date_of_birth)) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "تاريخ ميلاد المريض غير صالح (YYYY-MM-DD)",
          });
        }
        if (new Date(date_of_birth) > new Date()) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "تاريخ ميلاد المريض لا يمكن أن يكون في المستقبل",
          });
        }
      }

      const existingPatientCheck = await client.query(
        "SELECT id, name, is_active FROM patients WHERE clinic_id = $1 AND phone_number = $2",
        [clinic_id, cleanPhone],
      );

      if (existingPatientCheck.rows.length > 0) {
        const foundPatient = existingPatientCheck.rows[0];
        if (foundPatient.is_active === false) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `رقم الهاتف مسجل للمريض (${foundPatient.name}) وهو مؤرشف حالياً. يرجى إلغاء أرشفة المريض أولاً من قائمة المرضى.`,
          });
        }

        const enteredNameNorm = normalizeArabicName(cleanName);
        const existingNameNorm = normalizeArabicName(foundPatient.name);
        if (enteredNameNorm !== existingNameNorm) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `رقم الهاتف (${cleanPhone}) مسجل بالفعل في العيادة باسم مريض آخر (${foundPatient.name}). لمنع تداخل السجلات والملفات الطبية، يرجى اختيار المريض من القائمة أو استخدام رقم هاتف مخصص للمريض الجديد.`,
          });
        }
        finalPatientId = foundPatient.id;
      } else {
        if (
          typeof medical_alerts === "string" &&
          medical_alerts.trim().length > 1000
        ) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "التنبيهات الطبية لا يمكن أن تتجاوز 1000 حرف",
          });
        }
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
          ],
        );
        finalPatientId = createdPatient.rows[0].id;
      }
    } else {
      const patientCheck = await client.query(
        "SELECT id, is_active FROM patients WHERE id = $1 AND clinic_id = $2",
        [finalPatientId, clinic_id],
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

    // 4. استدعاء محرك التعارضات المركزي (Single Source of Truth)
    const slotValidation = await validateAppointmentSlot(client, {
      clinic_id,
      doctor_id,
      appointmentDateISO: parsedDateForDB,
      durationMinutes: appointmentDuration,
    });

    const canOverride = Boolean(
      allow_override === true && role === "ClinicAdmin",
    );

    if (slotValidation.hasConflict && !canOverride) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: slotValidation.error,
        code: slotValidation.code,
        conflict: slotValidation.conflict || null,
        can_override: role === "ClinicAdmin",
      });
    }

    const cleanNotes = typeof notes === "string" ? notes.trim() || null : null;

    // 5. حفظ الموعد
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
      ],
    );

    await client.query("COMMIT");

    try {
      await logActivity({
        clinic_id,
        user_id: req.user.id,
        action: "CREATE_APPOINTMENT",
        entity_type: "appointment",
        entity_id: insertResult.rows[0].id,
        description: `قام ${
          req.user.name || "الموظف"
        } بحجز موعد جديد للمريض #${finalPatientId.slice(0, 8)}${
          slotValidation.hasConflict && canOverride
            ? " (مع تجاوز تعارض بصلاحية المدير)"
            : ""
        }`,
        metadata: {
          doctor_id,
          appointment_date: parsedDateForDB,
          duration_minutes: appointmentDuration,
          overridden_conflict: slotValidation.hasConflict
            ? slotValidation.code
            : null,
        },
      });
    } catch (auditErr) {
      console.warn("Audit log warning:", auditErr.message);
    }

    return res.status(201).json({
      message: "تم حجز الموعد بنجاح",
      appointment: insertResult.rows[0],
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        broken = true;
        console.error("Rollback failed:", rollbackErr.message);
      }
    }
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
    if (client) client.release(broken);
  }
};

// ==========================================
// 4. تحديث حالة الموعد (يشمل arrived و in_progress)
// ==========================================
const updateAppointmentStatus = async (req, res) => {
  let client;
  let broken = false;
  try {
    const { clinic_id, role } = req.user;
    const { id } = req.params;
    const { status, allow_override } = req.body || {};

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "معرّف الموعد غير صالح" });
    }

    const validStatuses = [
      "scheduled",
      "arrived",
      "in_progress",
      "completed",
      "cancelled",
      "no_show",
    ];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error:
          "الحالة غير صالحة. الحالات المسموحة: scheduled, arrived, in_progress, completed, cancelled, no_show",
      });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    await client.query(`SELECT id FROM clinics WHERE id = $1 FOR UPDATE`, [
      clinic_id,
    ]);

    const appCheck = await client.query(
      `SELECT * FROM appointments
   WHERE id = $1 AND clinic_id = $2
   FOR UPDATE`,
      [id, clinic_id],
    );
    if (appCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ error: "الموعد غير موجود أو لا ينتمي لعيادتك" });
    }

    const currentApp = appCheck.rows[0];
    if (currentApp.status === "completed" && status !== "completed") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "لا يمكن تغيير حالة موعد مكتمل",
      });
    }

    // لو بنرجع موعد ملغي أو no_show لحالة نشطة، نفحص التعارضات
    const wasInactive = ["cancelled", "no_show"].includes(currentApp.status);
    const becomingActive = ["scheduled", "arrived", "in_progress"].includes(
      status,
    );

    if (
      wasInactive &&
      status === "scheduled" &&
      new Date(currentApp.appointment_date) <
        new Date(Date.now() - 5 * 60 * 1000)
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error:
          "لا يمكن إعادة تفعيل موعد في الماضي إلى مجدول. يرجى تعديل توقيته أولاً.",
      });
    }

    if (wasInactive && becomingActive) {
      const doctorLock = await client.query(
        `SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor' AND is_active = TRUE FOR UPDATE`,
        [currentApp.doctor_id, clinic_id],
      );
      if (doctorLock.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "لا يمكن إعادة تفعيل الموعد لأن الطبيب غير نشط حالياً",
        });
      }

      const slotValidation = await validateAppointmentSlot(client, {
        clinic_id,
        doctor_id: currentApp.doctor_id,
        appointmentDateISO: new Date(currentApp.appointment_date).toISOString(),
        durationMinutes: currentApp.duration_minutes || 30,
        excludeAppointmentId: id,
      });

      const canOverride = Boolean(
        allow_override === true && role === "ClinicAdmin",
      );
      if (slotValidation.hasConflict && !canOverride) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: slotValidation.error,
          code: slotValidation.code,
          conflict: slotValidation.conflict || null,
          can_override: role === "ClinicAdmin",
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
      [status, id, clinic_id],
    );

    await client.query("COMMIT");

    try {
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
            ? `تم إلغاء الموعد #${id.slice(0, 8)}`
            : `تم تغيير حالة الموعد #${id.slice(0, 8)} من ${currentApp.status} إلى ${status}`,
        metadata: {
          old_status: currentApp.status,
          new_status: status,
        },
      });
    } catch (auditErr) {
      console.warn("Audit log warning:", auditErr.message);
    }

    res.status(200).json({
      message: "تم تحديث حالة الموعد بنجاح",
      appointment: result.rows[0],
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        broken = true;
        console.error("Rollback failed:", rollbackErr.message);
      }
    }
    captureError(error, req);
    console.error("Error updating appointment status:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء تحديث حالة الموعد" });
  } finally {
    if (client) client.release(broken);
  }
};

// ==========================================
// 5. تعديل موعد الكشف (Reschedule) مع محرك التعارضات
// ==========================================
const rescheduleAppointment = async (req, res) => {
  const {
    appointment_date,
    duration_minutes,
    doctor_id: new_doctor_id,
    allow_override,
  } = req.body || {};
  const { id } = req.params;

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: "معرّف الموعد غير صالح" });
  }
  if (!appointment_date) {
    return res.status(400).json({ error: "تاريخ ووقت الموعد الجديد مطلوب" });
  }
  if (!hasTimezoneOffset(appointment_date)) {
    return res.status(400).json({
      error: "تاريخ ووقت الموعد الجديد يجب أن يتضمن المنطقة الزمنية بصيغة ISO",
    });
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

  let client;
  let broken = false;
  try {
    client = await pool.connect();
    const { clinic_id, role } = req.user;
    await client.query("BEGIN");

    await client.query(`SELECT id FROM clinics WHERE id = $1 FOR UPDATE`, [
      clinic_id,
    ]);

    const currentApp = await client.query(
      `SELECT * FROM appointments WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [id, clinic_id],
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

    const targetDoctorId =
      new_doctor_id && isValidUuid(new_doctor_id)
        ? new_doctor_id
        : currentApp.rows[0].doctor_id;
    const oldAppointmentDate = currentApp.rows[0].appointment_date;

    const doctorLock = await client.query(
      `SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor' AND is_active = TRUE FOR UPDATE`,
      [targetDoctorId, clinic_id],
    );
    if (doctorLock.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "الطبيب غير موجود أو تم تعطيل حسابه حالياً",
      });
    }

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
        parsedDuration > 480
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "مدة الكشف يجب أن تكون رقماً صحيحاً بين 5 و 480 دقيقة",
        });
      }
      duration = parsedDuration;
    }

    const parsedDateForDB = parsedDate.toISOString();

    const slotValidation = await validateAppointmentSlot(client, {
      clinic_id,
      doctor_id: targetDoctorId,
      appointmentDateISO: parsedDateForDB,
      durationMinutes: duration,
      excludeAppointmentId: id,
    });

    const canOverride = Boolean(
      allow_override === true && role === "ClinicAdmin",
    );
    if (slotValidation.hasConflict && !canOverride) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: slotValidation.error,
        code: slotValidation.code,
        conflict: slotValidation.conflict || null,
        can_override: role === "ClinicAdmin",
      });
    }

    const updateResult = await client.query(
      `
      UPDATE appointments
      SET appointment_date = $1,
          duration_minutes = $2,
          doctor_id = $3,
          status = 'scheduled',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $4 AND clinic_id = $5
      RETURNING *;
      `,
      [parsedDateForDB, duration, targetDoctorId, id, clinic_id],
    );

    await client.query("COMMIT");

    try {
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
    } catch (auditErr) {
      console.warn("Audit log warning:", auditErr.message);
    }

    res.status(200).json({
      message: "تم تعديل الموعد بنجاح",
      appointment: updateResult.rows[0],
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        broken = true;
        console.error("Rollback failed:", rollbackErr.message);
      }
    }
    captureError(error, req);
    console.error("Error rescheduling appointment:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء تعديل الموعد" });
  } finally {
    if (client) client.release(broken);
  }
};

// ==========================================
// 6. حذف موعد نهائياً (ClinicAdmin فقط)
// ==========================================
const deleteAppointment = async (req, res) => {
  let client;
  let broken = false;
  try {
    const { clinic_id, role } = req.user;
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "معرّف الموعد غير صالح" });
    }
    if (role !== "ClinicAdmin") {
      return res.status(403).json({
        error: "غير مصرح لك بحذف المواعيد نهائياً. يمكنك فقط إلغاء الموعد.",
      });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const appointmentCheck = await client.query(
      `SELECT id FROM appointments WHERE id = $1 AND clinic_id = $2 FOR UPDATE;`,
      [id, clinic_id],
    );
    if (appointmentCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ error: "الموعد غير موجود أو لا ينتمي لعيادتك" });
    }

    const activeInvoiceCheck = await client.query(
      `
      SELECT id
      FROM invoices
      WHERE clinic_id = $1
        AND appointment_id = $2
        AND is_archived = false
        AND status <> 'cancelled';
      `,
      [clinic_id, id],
    );
    if (activeInvoiceCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error:
          "لا يمكن حذف هذا الموعد لوجود فاتورة نشطة مرتبطة به. يرجى إلغاء الموعد أو أرشفة/إلغاء الفاتورة أولاً.",
      });
    }

    await client.query(
      `UPDATE lab_orders SET appointment_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE clinic_id = $1 AND appointment_id = $2;`,
      [clinic_id, id],
    );

    await client.query(
      `UPDATE invoices SET appointment_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE clinic_id = $1 AND appointment_id = $2;`,
      [clinic_id, id],
    );

    await client.query(
      `DELETE FROM appointments WHERE id = $1 AND clinic_id = $2;`,
      [id, clinic_id],
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
          8,
        )} نهائياً من السيستم`,
        metadata: { appointment_id: id },
      });
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    res.status(200).json({ message: "تم حذف الموعد بنجاح" });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        broken = true;
        console.error("Rollback failed:", rollbackErr.message);
      }
    }
    captureError(error, req);
    console.error("Error deleting appointment:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء حذف الموعد" });
  } finally {
    if (client) client.release(broken);
  }
};

// ==========================================
// 7. جلب وتحديث إعدادات الكشف والكراسي وساعات عمل العيادة والعطلات
// ==========================================
const getClinicDurationSettings = async (req, res) => {
  try {
    const { clinic_id } = req.user;
    const [clinicRes, hoursRes, holidaysRes] = await Promise.all([
      pool.query(
        "SELECT default_appointment_duration, COALESCE(total_chairs_count, 1) AS total_chairs_count FROM clinics WHERE id = $1",
        [clinic_id],
      ),
      pool.query(
        "SELECT weekday, open_time, close_time, breaks, is_closed FROM clinic_working_hours WHERE clinic_id = $1 ORDER BY weekday ASC",
        [clinic_id],
      ),
      pool.query(
        "SELECT id, TO_CHAR(date, 'YYYY-MM-DD') AS date, reason FROM clinic_holidays WHERE clinic_id = $1 AND date >= CURRENT_DATE ORDER BY date ASC",
        [clinic_id],
      ),
    ]);

    if (clinicRes.rows.length === 0) {
      return res.status(404).json({ error: "العيادة غير موجودة" });
    }

    res.status(200).json({
      default_appointment_duration:
        clinicRes.rows[0].default_appointment_duration || 30,
      total_chairs_count: clinicRes.rows[0].total_chairs_count || 1,
      working_hours: hoursRes.rows,
      holidays: holidaysRes.rows,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching clinic duration settings:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء جلب إعدادات العيادة" });
  }
};

const updateClinicDurationSettings = async (req, res) => {
  let client;
  try {
    const { clinic_id } = req.user;
    const { default_appointment_duration, total_chairs_count, working_hours } =
      req.body || {};

    client = await pool.connect();
    await client.query("BEGIN");

    if (default_appointment_duration !== undefined) {
      const duration = Number(default_appointment_duration);
      if (!Number.isInteger(duration) || duration < 5 || duration > 480) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error:
            "مدة الكشف الافتراضية يجب أن تكون رقماً صحيحاً بين 5 و 480 دقيقة",
        });
      }
      await client.query(
        `UPDATE clinics SET default_appointment_duration = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [duration, clinic_id],
      );
    }

    if (total_chairs_count !== undefined) {
      const chairs = Number(total_chairs_count);
      if (!Number.isInteger(chairs) || chairs < 1 || chairs > 50) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "عدد كراسي العيادة يجب أن يكون بين 1 و 50 كرسي",
        });
      }
      await client.query(
        `UPDATE clinics SET total_chairs_count = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [chairs, clinic_id],
      );
    }

    // تحديث جدول ساعات عمل العيادة الأسبوعية إن وُجد
    if (Array.isArray(working_hours)) {
      for (const day of working_hours) {
        const weekday = Number(day.weekday);
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;

        const openTime = day.open_time || "09:00";
        const closeTime = day.close_time || "22:00";
        const isClosed = Boolean(day.is_closed);
        const breaks = Array.isArray(day.breaks) ? day.breaks : [];

        await client.query(
          `
          INSERT INTO clinic_working_hours (clinic_id, weekday, open_time, close_time, breaks, is_closed, updated_at)
          VALUES ($1, $2, $3::time, $4::time, $5::jsonb, $6, CURRENT_TIMESTAMP)
          ON CONFLICT (clinic_id, weekday)
          DO UPDATE SET
            open_time = EXCLUDED.open_time,
            close_time = EXCLUDED.close_time,
            breaks = EXCLUDED.breaks,
            is_closed = EXCLUDED.is_closed,
            updated_at = CURRENT_TIMESTAMP;
          `,
          [
            clinic_id,
            weekday,
            openTime,
            closeTime,
            JSON.stringify(breaks),
            isClosed,
          ],
        );
      }
    }

    await client.query("COMMIT");

    const updatedRes = await pool.query(
      "SELECT id, name, default_appointment_duration, total_chairs_count FROM clinics WHERE id = $1",
      [clinic_id],
    );

    res.status(200).json({
      message: "تم تحديث إعدادات التشغيل والكراسي وساعات العمل بنجاح",
      clinic: updatedRes.rows[0],
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (e) {}
    }
    captureError(error, req);
    console.error("Error updating clinic duration settings:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء تحديث إعدادات العيادة" });
  } finally {
    if (client) client.release();
  }
};

// إضافة عطلة رسمية للعيادة
const addClinicHoliday = async (req, res) => {
  try {
    const { clinic_id } = req.user;
    const { date, reason } = req.body || {};

    if (!date || !isRealDate(date)) {
      return res
        .status(400)
        .json({ error: "يرجى إدخال تاريخ عطلة صالح (YYYY-MM-DD)" });
    }

    const result = await pool.query(
      `
      INSERT INTO clinic_holidays (clinic_id, date, reason)
      VALUES ($1, $2::date, $3)
      ON CONFLICT (clinic_id, date)
      DO UPDATE SET reason = EXCLUDED.reason
      RETURNING id, TO_CHAR(date, 'YYYY-MM-DD') AS date, reason;
      `,
      [clinic_id, date, reason?.trim() || null],
    );

    return res.status(201).json({
      message: "تم تسجيل عطلة العيادة بنجاح",
      holiday: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error adding clinic holiday:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء إضافة العطلة" });
  }
};

// حذف عطلة رسمية
const deleteClinicHoliday = async (req, res) => {
  try {
    const { clinic_id } = req.user;
    const { holidayId } = req.params;

    if (!isValidUuid(holidayId)) {
      return res.status(400).json({ error: "معرّف العطلة غير صالح" });
    }

    await pool.query(
      `DELETE FROM clinic_holidays WHERE id = $1 AND clinic_id = $2`,
      [holidayId, clinic_id],
    );

    return res.status(200).json({ message: "تم حذف العطلة بنجاح" });
  } catch (error) {
    captureError(error, req);
    console.error("Error deleting clinic holiday:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء حذف العطلة" });
  }
};

module.exports = {
  getAppointments,
  getCalendarData,
  getAppointmentById,
  createAppointment,
  updateAppointmentStatus,
  rescheduleAppointment,
  deleteAppointment,
  getClinicDurationSettings,
  updateClinicDurationSettings,
  addClinicHoliday,
  deleteClinicHoliday,
};
