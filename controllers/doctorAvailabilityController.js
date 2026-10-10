const pool = require("../db");
const { isValidUuid } = require("../middleware/validateUuid");
const { captureError } = require("../utils/errorTracker");



const cairoLocalTimeToDate = (dateStr, timeStr) => {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);

  // نبدأ باعتبار الوقت UTC كـ "wall clock" مؤقت
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  // نحسب فرق توقيت القاهرة ونصححه
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
    utcMs = Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMs;
  }

  return new Date(utcMs);
};

// 1. جلب شفتات وإجازات الطبيب
const getDoctorSchedule = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { doctorId } = req.params;

  if (!isValidUuid(doctorId)) {
    return res.status(400).json({ error: "معرّف الطبيب غير صالح" });
  }

  try {
    // جلب الشفتات الأسبوعية
    const shiftsRes = await pool.query(
      `SELECT id, day_of_week, start_time, end_time, is_active
       FROM doctor_availability
       WHERE clinic_id = $1 AND doctor_id = $2
       ORDER BY day_of_week ASC, start_time ASC;`,
      [clinic_id, doctorId]
    );

    // جلب الإجازات القادمة (من بداية اليوم الحالي)
    const leavesRes = await pool.query(
      `SELECT id, TO_CHAR(leave_date, 'YYYY-MM-DD') AS leave_date, notes
       FROM doctor_leaves
       WHERE clinic_id = $1 AND doctor_id = $2 AND leave_date >= CURRENT_DATE
       ORDER BY leave_date ASC;`,
      [clinic_id, doctorId]
    );

    res.status(200).json({
      shifts: shiftsRes.rows,
      leaves: leavesRes.rows,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching doctor schedule:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء جلب جدول الطبيب" });
  }
};

// 2. ضبط / استبدال الشفتات الأسبوعية للطبيب
const setDoctorShifts = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { doctorId } = req.params;
  const { shifts } = req.body; // مصفوفة من { day_of_week, start_time, end_time }

  if (!isValidUuid(doctorId)) {
    return res.status(400).json({ error: "معرّف الطبيب غير صالح" });
  }

  if (!Array.isArray(shifts)) {
    return res.status(400).json({ error: "يجب إرسال مصفوفة الشفتات" });
  }

  const targetDoctorId = req.params.doctorId || req.body.doctor_id;

  // لو المستخدم دكتور، نمنعه يعدل لأي دكتور تاني غير نفسه
  if (req.user.role === "Doctor" && req.user.id !== targetDoctorId) {
    return res.status(403).json({
      error: "غير مصرح لك بتعديل مواعيد أو إجازات أطباء آخرين",
    });
  }

  // التحقق من صحة مدخلات الشفتات
  for (const s of shifts) {
    const day = Number(s.day_of_week);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return res
        .status(400)
        .json({ error: "يوم الأسبوع يجب أن يكون بين 0 و 6" });
    }
    if (!s.start_time || !s.end_time || s.start_time >= s.end_time) {
      return res.status(400).json({
        error: "وقت بداية الشفت يجب أن يكون قبل وقت النهاية",
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // التأكد من أن الطبيب تابع لنفس العيادة
    const docCheck = await client.query(
      "SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor';",
      [doctorId, clinic_id]
    );
    if (docCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الطبيب غير موجود في هذه العيادة" });
    }

    // حذف الشفتات القديمة للطبيب
    await client.query(
      "DELETE FROM doctor_availability WHERE clinic_id = $1 AND doctor_id = $2;",
      [clinic_id, doctorId]
    );

    // إدخال الشفتات الجديدة
    const insertQuery = `
      INSERT INTO doctor_availability (clinic_id, doctor_id, day_of_week, start_time, end_time)
      VALUES ($1, $2, $3, $4, $5);
    `;
    for (const s of shifts) {
      await client.query(insertQuery, [
        clinic_id,
        doctorId,
        s.day_of_week,
        s.start_time,
        s.end_time,
      ]);
    }

    await client.query("COMMIT");
    res.status(200).json({ message: "تم حفظ جدول شفتات الطبيب بنجاح" });
  } catch (error) {
    captureError(error, req);
    await client.query("ROLLBACK");
    console.error("Error setting doctor shifts:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء حفظ شفتات الطبيب" });
  } finally {
    client.release();
  }
};

// 3. إضافة يوم إجازة للطبيب
const addDoctorLeave = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { doctorId } = req.params;
  const { leave_date, notes } = req.body;

  if (!isValidUuid(doctorId)) {
    return res.status(400).json({ error: "معرّف الطبيب غير صالح" });
  }

  if (!leave_date || !/^\d{4}-\d{2}-\d{2}$/.test(leave_date)) {
    return res
      .status(400)
      .json({ error: "صيغة تاريخ الإجازة يجب أن تكون YYYY-MM-DD" });
  }

  const targetDoctorId = req.params.doctorId || req.body.doctor_id;

  // لو المستخدم دكتور، نمنعه يعدل لأي دكتور تاني غير نفسه
  if (req.user.role === "Doctor" && req.user.id !== targetDoctorId) {
    return res.status(403).json({
      error: "غير مصرح لك بتعديل مواعيد أو إجازات أطباء آخرين",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO doctor_leaves (clinic_id, doctor_id, leave_date, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING id, TO_CHAR(leave_date, 'YYYY-MM-DD') AS leave_date, notes;`,
      [clinic_id, doctorId, leave_date, notes?.trim() || null]
    );
    res.status(201).json({
      message: "تم تسجيل إجازة الطبيب بنجاح",
      leave: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res
        .status(400)
        .json({ error: "تاريخ الإجازة مسجل بالفعل لهذا الطبيب" });
    }
    captureError(error, req);
    console.error("Error adding doctor leave:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء إضافة إجازة الطبيب" });
  }
};

// 4. حذف إجازة للطبيب
const deleteDoctorLeave = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { doctorId, leaveId } = req.params;

  if (!isValidUuid(doctorId) || !isValidUuid(leaveId)) {
    return res.status(400).json({ error: "معرّف غير صالح" });
  }

  const targetDoctorId = req.params.doctorId || req.body.doctor_id;

  // لو المستخدم دكتور، نمنعه يعدل لأي دكتور تاني غير نفسه
  if (req.user.role === "Doctor" && req.user.id !== targetDoctorId) {
    return res.status(403).json({
      error: "غير مصرح لك بتعديل مواعيد أو إجازات أطباء آخرين",
    });
  }

  try {
    const result = await pool.query(
      "DELETE FROM doctor_leaves WHERE id = $1 AND doctor_id = $2 AND clinic_id = $3 RETURNING id;",
      [leaveId, doctorId, clinic_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "الإجازة غير موجودة" });
    }
    res.status(200).json({ message: "تم إلغاء الإجازة بنجاح" });
  } catch (error) {
    captureError(error, req);
    console.error("Error deleting doctor leave:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء حذف الإجازة" });
  }
};

// 5. محرك حساب الـ Slots المتاحة للطبيب في تاريخ محدد
const getAvailableSlots = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { doctorId } = req.params;
  const { date, procedure_code_id } = req.query;

  if (!isValidUuid(doctorId)) {
    return res.status(400).json({ error: "معرّف الطبيب غير صالح" });
  }

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res
      .status(400)
      .json({ error: "تاريخ الكشف مطلوب بصيغة YYYY-MM-DD" });
  }

  try {
    // أ) التحقق هل الطبيب في إجازة في هذا التاريخ؟
    const leaveCheck = await pool.query(
      "SELECT id, notes FROM doctor_leaves WHERE clinic_id = $1 AND doctor_id = $2 AND leave_date = $3::date;",
      [clinic_id, doctorId, date]
    );
    if (leaveCheck.rows.length > 0) {
      return res.status(200).json({
        available: false,
        reason: "الطبيب في إجازة في هذا التاريخ",
        slots: [],
      });
    }

    // ب) حساب يوم الأسبوع بتوقيت القاهرة
    const targetDate = new Date(`${date}T12:00:00Z`);
    const dayOfWeek = targetDate.getUTCDay(); // 0-6

    // جـ) جلب شفتات الطبيب في هذا اليوم
    const shiftsRes = await pool.query(
      `SELECT start_time, end_time
       FROM doctor_availability
       WHERE clinic_id = $1 AND doctor_id = $2 AND day_of_week = $3 AND is_active = TRUE
       ORDER BY start_time ASC;`,
      [clinic_id, doctorId, dayOfWeek]
    );

    if (shiftsRes.rows.length === 0) {
      return res.status(200).json({
        available: false,
        reason: "الطبيب لا يعمل في هذا اليوم من الأسبوع",
        slots: [],
      });
    }

    // د) تحديد مدة الكشف (إما من الإجراء أو مدة العيادة الافتراضية)
    let slotDuration = 30;
    if (procedure_code_id && isValidUuid(procedure_code_id)) {
      const procRes = await pool.query(
        "SELECT duration_minutes FROM procedure_codes WHERE id = $1 AND clinic_id = $2 AND is_active = TRUE;",
        [procedure_code_id, clinic_id]
      );
      if (procRes.rows[0]?.duration_minutes) {
        slotDuration = Number(procRes.rows[0].duration_minutes);
      } else {
        const clinicRes = await pool.query(
          "SELECT default_appointment_duration FROM clinics WHERE id = $1;",
          [clinic_id]
        );
        slotDuration =
          Number(clinicRes.rows[0]?.default_appointment_duration) || 30;
      }
    } else {
      const clinicRes = await pool.query(
        "SELECT default_appointment_duration FROM clinics WHERE id = $1;",
        [clinic_id]
      );
      slotDuration =
        Number(clinicRes.rows[0]?.default_appointment_duration) || 30;
    }

    // هـ) جلب المواعيد المحجوزة بالفعل للطبيب في هذا اليوم (بتوقيت القاهرة)
    const apptsRes = await pool.query(
      `SELECT 
         appointment_date,
         duration_minutes,
         (appointment_date + (duration_minutes * INTERVAL '1 minute')) AS appointment_end
       FROM appointments
       WHERE clinic_id = $1 
         AND doctor_id = $2 
         AND status <> 'cancelled'
         AND DATE(appointment_date AT TIME ZONE 'Africa/Cairo') = $3::date;`,
      [clinic_id, doctorId, date]
    );

    const bookedIntervals = apptsRes.rows.map((row) => ({
      start: new Date(row.appointment_date).getTime(),
      end: new Date(row.appointment_end).getTime(),
    }));

    // و) تقسيم كل شفت إلى Slots وفحص التعارض وتخطي الأوقات السابقة
    const nowTime = Date.now();
    const availableSlots = [];

    for (const shift of shiftsRes.rows) {
      // تحويل start_time و end_time إلى تواريخ كاملة بتوقيت القاهرة
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

        // 1. تخطي الأوقات السابقة لو الكشف اليوم
        const isPast = slotStart < nowTime + 5 * 60 * 1000; // سماحية 5 دقائق

        // 2. فحص التداخل مع أي موعد محجوز
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

        // الانتقال للـ Slot التالي
        currentSlotTime += slotDurationMs;
      }
    }

    res.status(200).json({
      available: true,
      date,
      slot_duration_minutes: slotDuration,
      total_slots: availableSlots.length,
      slots: availableSlots,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error calculating available slots:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء حساب الأوقات المتاحة" });
  }
};

module.exports = {
  getDoctorSchedule,
  setDoctorShifts,
  addDoctorLeave,
  deleteDoctorLeave,
  getAvailableSlots,
};
