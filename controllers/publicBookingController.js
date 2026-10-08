const pool = require("../db");
const { isValidUuid } = require("../middleware/validateUuid");
const { normalizeEgyptianPhone } = require("../utils/phoneNormalizer");

// تحويل وقت محلي في القاهرة إلى Date/UTC بدون hardcoded +03:00
const cairoLocalTimeToDate = (dateStr, timeStr) => {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);

  const targetUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  let utcMs = targetUtcMs;

  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(utcMs));

    const values = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        values[part.type] = part.value;
      }
    }

    const cairoAsUtcMs = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second)
    );

    const offsetMs = cairoAsUtcMs - utcMs;
    utcMs = targetUtcMs - offsetMs;
  }

  return new Date(utcMs);
};
// دالة مساعدة لجلب العيادة عبر الـ slug أو الـ UUID
const resolveClinic = async (identifier) => {
  let query =
    "SELECT id, name, phone_number, address, bio, slug, is_active FROM clinics WHERE ";
  let params = [identifier];

  if (isValidUuid(identifier)) {
    query += "id = $1;";
  } else {
    query += "slug = $1;";
  }

  const res = await pool.query(query, params);
  if (res.rows.length === 0 || res.rows[0].is_active === false) {
    return null;
  }
  return res.rows[0];
};

// 1. جلب بيانات الصفحة العامة للعيادة (الأطباء والخدمات)
const getPublicClinicProfile = async (req, res) => {
  const { slugOrId } = req.params;

  try {
    const clinic = await resolveClinic(slugOrId);
    if (!clinic) {
      return res
        .status(404)
        .json({ error: "العيادة غير موجودة أو غير متاحة حالياً" });
    }

    // جلب الأطباء النشطين في العيادة
    const doctorsRes = await pool.query(
      `SELECT id, name FROM users 
       WHERE clinic_id = $1 AND role = 'Doctor' AND is_active = TRUE 
       ORDER BY name ASC;`,
      [clinic.id]
    );

    // جلب الخدمات وأكواد العلاج النشطة مع مدة كل خدمة وأسعارها
    const servicesRes = await pool.query(
      `SELECT id, code, description, default_price, duration_minutes 
       FROM procedure_codes 
       WHERE clinic_id = $1 AND is_active = TRUE 
       ORDER BY description ASC;`,
      [clinic.id]
    );

    res.status(200).json({
      clinic: {
        id: clinic.id,
        name: clinic.name,
        phone_number: clinic.phone_number,
        address: clinic.address || "العنوان متاح بالعيادة",
        bio: clinic.bio || "عيادة أسنان متخصصة تقدم أفضل رعاية طبية لأسنانك.",
        slug: clinic.slug,
      },
      doctors: doctorsRes.rows,
      services: servicesRes.rows,
    });
  } catch (error) {
    console.error("Error fetching public clinic profile:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء تحميل بيانات العيادة" });
  }
};

// 2. حساب المواعيد والـ Slots المتاحة للحجز العام أونلاين
const getPublicAvailableSlots = async (req, res) => {
  const { slugOrId } = req.params;
  const { doctor_id, date, procedure_id } = req.query;

  try {
    const clinic = await resolveClinic(slugOrId);
    if (!clinic) {
      return res.status(404).json({ error: "العيادة غير موجودة" });
    }

    if (!doctor_id || !isValidUuid(doctor_id)) {
      return res.status(400).json({ error: "يجب اختيار الطبيب" });
    }

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res
        .status(400)
        .json({ error: "تاريخ الكشف مطلوب بصيغة YYYY-MM-DD" });
    }

    // منع الحجز في التواريخ السابقة
    const todayCairo = new Date().toLocaleDateString("en-CA", {
      timeZone: "Africa/Cairo",
    });
    if (date < todayCairo) {
      return res.status(400).json({ error: "لا يمكن حجز موعد في تاريخ سابق" });
    }

    // فحص إجازات الطبيب
    const leaveCheck = await pool.query(
      "SELECT id FROM doctor_leaves WHERE clinic_id = $1 AND doctor_id = $2 AND leave_date = $3::date;",
      [clinic.id, doctor_id, date]
    );
    if (leaveCheck.rows.length > 0) {
      return res.status(200).json({
        available: false,
        reason: "الطبيب في إجازة في هذا التاريخ",
        slots: [],
      });
    }

    // حساب يوم الأسبوع
    const targetDate = new Date(`${date}T12:00:00Z`);
    const dayOfWeek = targetDate.getUTCDay();

    // جلب شفتات الطبيب
    const shiftsRes = await pool.query(
      `SELECT start_time, end_time FROM doctor_availability 
       WHERE clinic_id = $1 AND doctor_id = $2 AND day_of_week = $3 AND is_active = TRUE 
       ORDER BY start_time ASC;`,
      [clinic.id, doctor_id, dayOfWeek]
    );

    if (shiftsRes.rows.length === 0) {
      return res.status(200).json({
        available: false,
        reason: "الطبيب لا يعمل في هذا اليوم",
        slots: [],
      });
    }

    // حساب مدة الكشف
    let slotDuration = null;

    if (procedure_id !== undefined) {
      if (!isValidUuid(procedure_id)) {
        return res.status(400).json({
          error: "معرّف الخدمة غير صالح",
        });
      }

      const procRes = await pool.query(
        `SELECT duration_minutes
         FROM procedure_codes
         WHERE id = $1
           AND clinic_id = $2
           AND is_active = TRUE;`,
        [procedure_id, clinic.id]
      );

      if (procRes.rows.length === 0) {
        return res.status(404).json({
          error: "الخدمة غير موجودة أو غير متاحة حالياً",
        });
      }

      slotDuration = Number(procRes.rows[0].duration_minutes);
    }

    if (!slotDuration) {
      const clinicRes = await pool.query(
        `SELECT default_appointment_duration
         FROM clinics
         WHERE id = $1
           AND is_active = TRUE;`,
        [clinic.id]
      );

      slotDuration =
        Number(clinicRes.rows[0]?.default_appointment_duration) || 30;
    }

    // جلب المواعيد المحجوزة بالفعل بتوقيت القاهرة
    const apptsRes = await pool.query(
      `SELECT appointment_date, (appointment_date + (duration_minutes * INTERVAL '1 minute')) AS appointment_end
       FROM appointments
       WHERE clinic_id = $1 AND doctor_id = $2 AND status <> 'cancelled'
         AND DATE(appointment_date AT TIME ZONE 'Africa/Cairo') = $3::date;`,
      [clinic.id, doctor_id, date]
    );

    // جلب طلبات الحجز المعلقة التي لم تنتهِ صلاحيتها لمنع تكرار نفس الـ Slot
    const pendingRequestsRes = await pool.query(
      `SELECT requested_date, (requested_date + (duration_minutes * INTERVAL '1 minute')) AS request_end
       FROM booking_requests
       WHERE clinic_id = $1 AND doctor_id = $2 AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP
         AND DATE(requested_date AT TIME ZONE 'Africa/Cairo') = $3::date;`,
      [clinic.id, doctor_id, date]
    );

    const bookedIntervals = [
      ...apptsRes.rows.map((r) => ({
        start: new Date(r.appointment_date).getTime(),
        end: new Date(r.appointment_end).getTime(),
      })),
      ...pendingRequestsRes.rows.map((r) => ({
        start: new Date(r.requested_date).getTime(),
        end: new Date(r.request_end).getTime(),
      })),
    ];

    const nowTime = Date.now();
    const availableSlots = [];

    for (const shift of shiftsRes.rows) {
      const [startHour, startMin] = shift.start_time.split(":").map(Number);
      const [endHour, endMin] = shift.end_time.split(":").map(Number);

      let currentSlotTime = cairoLocalTimeToDate(
        date,
        `${String(startHour).padStart(2, "0")}:${String(startMin).padStart(
          2,
          "0"
        )}`
      ).getTime();

      const shiftEndTime = cairoLocalTimeToDate(
        date,
        `${String(endHour).padStart(2, "0")}:${String(endMin).padStart(2, "0")}`
      ).getTime();
      const slotDurationMs = slotDuration * 60 * 1000;

      while (currentSlotTime + slotDurationMs <= shiftEndTime) {
        const slotStart = currentSlotTime;
        const slotEnd = currentSlotTime + slotDurationMs;

        const isPast = slotStart < nowTime + 10 * 60 * 1000; // سماحية 10 دقائق من الآن
        const hasOverlap = bookedIntervals.some(
          (b) => slotStart < b.end && slotEnd > b.start
        );

        if (!isPast && !hasOverlap) {
          const slotDateObj = new Date(slotStart);
          const timeString = slotDateObj.toLocaleTimeString("ar-EG", {
            timeZone: "Africa/Cairo",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          });
          availableSlots.push({
            time: timeString,
            iso: new Date(slotStart).toISOString(),
            duration_minutes: slotDuration,
          });
        }

        currentSlotTime += slotDurationMs;
      }
    }

    res.status(200).json({
      available: true,
      date,
      total_slots: availableSlots.length,
      slots: availableSlots,
    });
  } catch (error) {
    console.error("Error fetching public slots:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء حساب الأوقات المتاحة" });
  }
};

// 3. إنشاء طلب حجز جديد من قبل المريض (Cash at Clinic)
const createPublicBookingRequest = async (req, res) => {
  const { slugOrId } = req.params;

  const {
    doctor_id,
    procedure_id,
    requested_date,
    patient_name,
    patient_phone,
    notes,
  } = req.body;

  try {
    const clinic = await resolveClinic(slugOrId);

    if (!clinic) {
      return res.status(404).json({
        error: "العيادة غير موجودة أو معطلة",
      });
    }

    if (
      !patient_name ||
      typeof patient_name !== "string" ||
      patient_name.trim().length < 2
    ) {
      return res.status(400).json({
        error: "اسم المريض مطلوب ويجب أن يكون حرفين على الأقل",
      });
    }

    const cleanPhone = normalizeEgyptianPhone(patient_phone);

    if (!cleanPhone) {
      return res.status(400).json({
        error: "رقم الهاتف المصري غير صحيح",
      });
    }

    if (!doctor_id || !isValidUuid(doctor_id)) {
      return res.status(400).json({
        error: "يرجى اختيار الطبيب المعالج",
      });
    }

    if (
      procedure_id !== undefined &&
      procedure_id !== null &&
      procedure_id !== ""
    ) {
      if (!isValidUuid(procedure_id)) {
        return res.status(400).json({
          error: "معرّف الخدمة غير صالح",
        });
      }
    }

    if (!requested_date) {
      return res.status(400).json({
        error: "يرجى تحديد وقت الموعد المطلوب",
      });
    }

    const reqDate = new Date(requested_date);

    if (isNaN(reqDate.getTime())) {
      return res.status(400).json({
        error: "موعد الحجز غير صالح",
      });
    }

    const now = new Date();

    // يجب أن يكون الموعد بعد أكثر من ساعتين
    const minimumBookingTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    if (reqDate <= minimumBookingTime) {
      return res.status(400).json({
        error: "يجب أن يكون الموعد المطلوب بعد ساعتين على الأقل من الآن",
      });
    }

    // التحقق من الطبيب
    const doctorRes = await pool.query(
      `SELECT id
       FROM users
       WHERE id = $1
         AND clinic_id = $2
         AND role = 'Doctor'
         AND is_active = TRUE;`,
      [doctor_id, clinic.id]
    );

    if (doctorRes.rows.length === 0) {
      return res.status(404).json({
        error: "الطبيب غير موجود أو غير متاح حالياً",
      });
    }

    // حساب مدة الخدمة
    let duration = null;
    let normalizedProcedureId = null;

    if (procedure_id) {
      const procRes = await pool.query(
        `SELECT duration_minutes
         FROM procedure_codes
         WHERE id = $1
           AND clinic_id = $2
           AND is_active = TRUE;`,
        [procedure_id, clinic.id]
      );

      if (procRes.rows.length === 0) {
        return res.status(404).json({
          error: "الخدمة غير موجودة أو غير متاحة حالياً",
        });
      }

      normalizedProcedureId = procedure_id;
      duration = procRes.rows[0].duration_minutes
        ? Number(procRes.rows[0].duration_minutes)
        : null;
    }

    if (!duration) {
      const clinicRes = await pool.query(
        `SELECT default_appointment_duration
         FROM clinics
         WHERE id = $1
           AND is_active = TRUE;`,
        [clinic.id]
      );

      duration = Number(clinicRes.rows[0]?.default_appointment_duration) || 30;
    }

    const slotEnd = new Date(reqDate.getTime() + duration * 60 * 1000);

    // تاريخ اليوم بتوقيت القاهرة
    const cairoDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
    }).format(reqDate);

    // حساب يوم الأسبوع بتوقيت القاهرة
    const cairoParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Africa/Cairo",
      weekday: "short",
    }).formatToParts(reqDate);

    const weekdayName = cairoParts.find(
      (part) => part.type === "weekday"
    )?.value;

    const weekdayMap = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };

    const dayOfWeek = weekdayMap[weekdayName];

    // التحقق من الإجازة
    const leaveRes = await pool.query(
      `SELECT id
       FROM doctor_leaves
       WHERE clinic_id = $1
         AND doctor_id = $2
         AND leave_date = $3::date;`,
      [clinic.id, doctor_id, cairoDate]
    );

    if (leaveRes.rows.length > 0) {
      return res.status(400).json({
        error: "الطبيب في إجازة في هذا التاريخ",
      });
    }

    // جلب شفتات الطبيب
    const shiftsRes = await pool.query(
      `SELECT start_time, end_time
       FROM doctor_availability
       WHERE clinic_id = $1
         AND doctor_id = $2
         AND day_of_week = $3
         AND is_active = TRUE
       ORDER BY start_time ASC;`,
      [clinic.id, doctor_id, dayOfWeek]
    );

    // التأكد أن الموعد المطلوب يقع بالكامل داخل أحد الشفتات
    const isInsideShift = shiftsRes.rows.some((shift) => {
      const [startHour, startMin] = shift.start_time.split(":").map(Number);

      const [endHour, endMin] = shift.end_time.split(":").map(Number);

      const shiftStart = cairoLocalTimeToDate(
        cairoDate,
        `${String(startHour).padStart(2, "0")}:${String(startMin).padStart(
          2,
          "0"
        )}`
      ).getTime();

      const shiftEnd = cairoLocalTimeToDate(
        cairoDate,
        `${String(endHour).padStart(2, "0")}:${String(endMin).padStart(2, "0")}`
      ).getTime();

      return reqDate.getTime() >= shiftStart && slotEnd.getTime() <= shiftEnd;
    });

    if (!isInsideShift) {
      return res.status(400).json({
        error: "الوقت المطلوب خارج ساعات عمل الطبيب",
      });
    }

    // ==========================================
    // منع الـ race condition أثناء إنشاء الطلب
    // ==========================================
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // قفل صف الطبيب مؤقتاً أثناء فحص + إنشاء الطلب
      await client.query(
        `SELECT id
         FROM users
         WHERE id = $1
           AND clinic_id = $2
           AND role = 'Doctor'
           AND is_active = TRUE
         FOR UPDATE;`,
        [doctor_id, clinic.id]
      );

      // فحص المواعيد المؤكدة المتعارضة
      const appointmentConflictRes = await client.query(
        `SELECT id
         FROM appointments
         WHERE clinic_id = $1
           AND doctor_id = $2
           AND status <> 'cancelled'
           AND appointment_date < $4
           AND (
             appointment_date +
             (duration_minutes * INTERVAL '1 minute')
           ) > $3
         LIMIT 1;`,
        [clinic.id, doctor_id, reqDate.toISOString(), slotEnd.toISOString()]
      );

      if (appointmentConflictRes.rows.length > 0) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          error: "هذا الموعد لم يعد متاحاً، يرجى اختيار موعد آخر",
        });
      }

      // فحص طلبات الحجز المعلقة المتعارضة
      const pendingConflictRes = await client.query(
        `SELECT id
         FROM booking_requests
         WHERE clinic_id = $1
           AND doctor_id = $2
           AND status = 'pending'
           AND expires_at > CURRENT_TIMESTAMP
           AND requested_date < $4
           AND (
             requested_date +
             (duration_minutes * INTERVAL '1 minute')
           ) > $3
         LIMIT 1;`,
        [clinic.id, doctor_id, reqDate.toISOString(), slotEnd.toISOString()]
      );

      if (pendingConflictRes.rows.length > 0) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          error: "هذا الموعد لم يعد متاحاً، يرجى اختيار موعد آخر",
        });
      }

      // مهلة انتهاء الطلب
      const expiry24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const expiryBeforeAppt = new Date(reqDate.getTime() - 2 * 60 * 60 * 1000);

      const expiresAt =
        expiryBeforeAppt < expiry24h ? expiryBeforeAppt : expiry24h;

      const insertRes = await client.query(
        `INSERT INTO booking_requests (
          clinic_id,
          doctor_id,
          procedure_code_id,
          patient_name,
          patient_phone,
          requested_date,
          duration_minutes,
          notes,
          expires_at,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
        RETURNING *;`,
        [
          clinic.id,
          doctor_id,
          normalizedProcedureId,
          patient_name.trim(),
          cleanPhone,
          reqDate.toISOString(),
          duration,
          notes?.trim() || null,
          expiresAt.toISOString(),
        ]
      );

      await client.query("COMMIT");

      return res.status(201).json({
        success: true,
        message:
          "تم إرسال طلب الحجز بنجاح! سيقوم فريق العيادة بمراجعته والتواصل معك لتأكيد الموعد.",
        booking_request: {
          id: insertRes.rows[0].id,
          patient_name: insertRes.rows[0].patient_name,
          requested_date: insertRes.rows[0].requested_date,
          expires_at: insertRes.rows[0].expires_at,
          payment_method: "cash_at_clinic",
        },
      });
    } catch (dbError) {
      await client.query("ROLLBACK");
      throw dbError;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error creating public booking request:", error.message);

    res.status(500).json({
      error: "حدث خطأ أثناء إرسال طلب الحجز، يرجى المحاولة لاحقاً",
    });
  }
};

module.exports = {
  getPublicClinicProfile,
  getPublicAvailableSlots,
  createPublicBookingRequest,
};
