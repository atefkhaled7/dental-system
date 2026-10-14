/**
 * محرك التعارضات المركزي (Single Source of Truth)
 * يفحص:
 * 1. عطلات العيادة الرسمية وساعات عمل العيادة (مع فترات الراحة breaks)
 * 2. إجازات الطبيب وشيفت عمل الطبيب
 * 3. تداخل مواعيد الطبيب نفسه
 * 4. تزامن الكراسي (COUNT(overlapping_active_appointments) < total_chairs_count)
 */

const ACTIVE_APPOINTMENT_STATUSES = ["scheduled", "arrived", "in_progress"];

const validateAppointmentSlot = async (
  dbClient,
  {
    clinic_id,
    doctor_id,
    appointmentDateISO,
    durationMinutes,
    excludeAppointmentId = null,
  },
) => {
  // 1. استخراج التاريخ واليوم والوقت بتوقيت القاهرة مباشرة من PostgreSQL لضمان الدقة
  const timeExtractRes = await dbClient.query(
    `
    SELECT
      ($1::timestamptz AT TIME ZONE 'Africa/Cairo')::date AS cairo_date,
      TO_CHAR(($1::timestamptz AT TIME ZONE 'Africa/Cairo')::date, 'YYYY-MM-DD') AS cairo_date_str,
      EXTRACT(DOW FROM ($1::timestamptz AT TIME ZONE 'Africa/Cairo'))::int AS weekday,
      ($1::timestamptz AT TIME ZONE 'Africa/Cairo')::time AS start_time,
      (($1::timestamptz + ($2 * INTERVAL '1 minute')) AT TIME ZONE 'Africa/Cairo')::time AS end_time,
      (($1::timestamptz + ($2 * INTERVAL '1 minute')) AT TIME ZONE 'Africa/Cairo')::date AS end_cairo_date
    `,
    [appointmentDateISO, durationMinutes],
  );

  const {
    cairo_date_str,
    weekday,
    start_time,
    end_time,
    cairo_date,
    end_cairo_date,
  } = timeExtractRes.rows[0];

  // منع امتداد الموعد لما بعد منتصف الليل في يوم تاني لتفادي لخبطة الشيفتات
  if (String(cairo_date) !== String(end_cairo_date)) {
    return {
      hasConflict: true,
      code: "CROSS_MIDNIGHT_NOT_ALLOWED",
      error: "لا يمكن أن يمتد الموعد لما بعد منتصف الليل في اليوم التالي",
    };
  }

  // ==========================================
  // أولاً: فحص العطلات الرسمية للعيادة
  // ==========================================
  const holidayRes = await dbClient.query(
    `SELECT reason FROM clinic_holidays WHERE clinic_id = $1 AND date = $2::date LIMIT 1`,
    [clinic_id, cairo_date_str],
  );

  if (holidayRes.rows.length > 0) {
    const reason = holidayRes.rows[0].reason;
    return {
      hasConflict: true,
      code: "CLINIC_HOLIDAY",
      error: `العيادة في عطلة رسمية في هذا التاريخ${reason ? ` (${reason})` : ""}`,
    };
  }

  // ==========================================
  // ثانياً: فحص ساعات عمل العيادة الرسمية
  // ==========================================
  const clinicHoursRes = await dbClient.query(
    `SELECT open_time, close_time, breaks, is_closed FROM clinic_working_hours WHERE clinic_id = $1 AND weekday = $2 LIMIT 1`,
    [clinic_id, weekday],
  );

  if (clinicHoursRes.rows.length > 0) {
    const ch = clinicHoursRes.rows[0];
    if (ch.is_closed) {
      return {
        hasConflict: true,
        code: "CLINIC_CLOSED_DAY",
        error: "العيادة مغلقة في هذا اليوم حسب جدول مواعيد العمل",
      };
    }

    if (start_time < ch.open_time || end_time > ch.close_time) {
      return {
        hasConflict: true,
        code: "OUTSIDE_CLINIC_HOURS",
        error: `الموعد يقع خارج ساعات عمل العيادة (${ch.open_time.slice(0, 5)} -${ch.close_time.slice(0, 5)})`,
      };
    }

    // فحص فترات الراحة (breaks JSONB: [{ start: "14:00", end: "15:00" }])
    if (Array.isArray(ch.breaks)) {
      for (const brk of ch.breaks) {
        if (brk.start && brk.end) {
          const bStart = brk.start.length === 5 ? `${brk.start}:00` : brk.start;
          const bEnd = brk.end.length === 5 ? `${brk.end}:00` : brk.end;
          if (start_time < bEnd && end_time > bStart) {
            return {
              hasConflict: true,
              code: "CLINIC_BREAK_TIME",
              error: `الموعد يتقاطع مع فترة راحة العيادة (${brk.start} -${brk.end})`,
            };
          }
        }
      }
    }
  }

  // ==========================================
  // ثالثاً: فحص إجازة الطبيب وشيفت الطبيب
  // ==========================================
  const doctorLeaveRes = await dbClient.query(
    `SELECT notes FROM doctor_leaves WHERE clinic_id = $1 AND doctor_id = $2 AND leave_date = $3::date LIMIT 1`,
    [clinic_id, doctor_id, cairo_date_str],
  );

  if (doctorLeaveRes.rows.length > 0) {
    const note = doctorLeaveRes.rows[0].notes;
    return {
      hasConflict: true,
      code: "DOCTOR_ON_LEAVE",
      error: `الطبيب في إجازة مسجلة في هذا التاريخ${note ? ` (${note})` : ""}`,
    };
  }

  // نفحص هل الطبيب له جدول شيفتات مسجل في السيستم أصلاً؟
  const anyDoctorShiftRes = await dbClient.query(
    `SELECT COUNT(*)::int AS total_shifts FROM doctor_availability WHERE clinic_id = $1 AND doctor_id = $2 AND is_active = TRUE`,
    [clinic_id, doctor_id],
  );

  if (anyDoctorShiftRes.rows[0].total_shifts > 0) {
    // الطبيب له جدول شيفتات مفعل -> يجب أن يقع الموعد داخل أحد شيفتات هذا اليوم
    const matchingShiftRes = await dbClient.query(
      `
      SELECT id, start_time, end_time
      FROM doctor_availability
      WHERE clinic_id = $1
        AND doctor_id = $2
        AND day_of_week = $3
        AND is_active = TRUE
        AND start_time <= $4::time
        AND end_time >= $5::time
      LIMIT 1
      `,
      [clinic_id, doctor_id, weekday, start_time, end_time],
    );

    if (matchingShiftRes.rows.length === 0) {
      return {
        hasConflict: true,
        code: "OUTSIDE_DOCTOR_SHIFT",
        error: "الموعد يقع خارج أوقات شيفت عمل الطبيب في هذا اليوم",
      };
    }
  }

  // ==========================================
  // رابعاً: فحص تداخل مواعيد الطبيب نفسه
  // ==========================================
  const doctorOverlapRes = await dbClient.query(
    `
    SELECT
      a.id,
      a.appointment_date,
      a.duration_minutes,
      (a.appointment_date + (a.duration_minutes * INTERVAL '1 minute')) AS existing_end,
      p.name AS patient_name
    FROM appointments a
    JOIN patients p ON a.patient_id = p.id AND a.clinic_id = p.clinic_id
    WHERE a.clinic_id = $1
      AND a.doctor_id = $2
      AND a.status NOT IN ('cancelled', 'no_show')
      AND ($5::uuid IS NULL OR a.id != $5::uuid)
      AND a.appointment_date < ($3::timestamptz + ($4 * INTERVAL '1 minute'))
      AND (a.appointment_date + (a.duration_minutes * INTERVAL '1 minute')) > $3::timestamptz
    LIMIT 1
    `,
    [
      clinic_id,
      doctor_id,
      appointmentDateISO,
      durationMinutes,
      excludeAppointmentId,
    ],
  );

  if (doctorOverlapRes.rows.length > 0) {
    const conflict = doctorOverlapRes.rows[0];
    return {
      hasConflict: true,
      code: "DOCTOR_APPOINTMENT_CONFLICT",
      error: `يوجد تعارض: الطبيب لديه موعد آخر مع المريض (${conflict.patient_name}) في نفس التوقيت`,
      conflict: {
        id: conflict.id,
        start: conflict.appointment_date,
        end: conflict.existing_end,
        duration: conflict.duration_minutes,
        patient_name: conflict.patient_name,
      },
    };
  }

  // ==========================================
  // خامساً: فحص تزامن الكراسي (Chair Capacity Check)
  // ==========================================

  // ==========================================
  // خامساً: فحص سعة الكراسي حسب أقصى إشغال متزامن
  // ==========================================
  const clinicChairsRes = await dbClient.query(
    `SELECT COALESCE(total_chairs_count, 1) AS total_chairs_count
     FROM clinics
     WHERE id = $1`,
    [clinic_id],
  );

  const totalChairs = Number(clinicChairsRes.rows[0]?.total_chairs_count || 1);

  const chairsOverlapRes = await dbClient.query(
    `
    WITH candidate AS (
      SELECT
        $2::timestamptz AS start_at,
        ($2::timestamptz + ($3 * INTERVAL '1 minute')) AS end_at
    ),
    overlapping AS (
      SELECT
        GREATEST(a.appointment_date, c.start_at) AS start_at,
        LEAST(
          a.appointment_date + (a.duration_minutes * INTERVAL '1 minute'),
          c.end_at
        ) AS end_at
      FROM appointments a
      CROSS JOIN candidate c
      WHERE a.clinic_id = $1
        AND a.status = ANY($5::text[])
        AND ($4::uuid IS NULL OR a.id <> $4::uuid)
        AND a.appointment_date < c.end_at
        AND (
          a.appointment_date +
          (a.duration_minutes * INTERVAL '1 minute')
        ) > c.start_at
    ),
    events AS (
      SELECT start_at AS event_time, 1 AS delta
      FROM overlapping

      UNION ALL

      SELECT end_at AS event_time, -1 AS delta
      FROM overlapping
    ),
    events_by_time AS (
      SELECT event_time, SUM(delta) AS delta
      FROM events
      GROUP BY event_time
    ),
    occupancy AS (
      SELECT
        SUM(delta) OVER (
          ORDER BY event_time
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS active_count
      FROM events_by_time
    )
    SELECT COALESCE(MAX(active_count), 0)::int AS peak_overlapping
    FROM occupancy;
    `,
    [
      clinic_id,
      appointmentDateISO,
      durationMinutes,
      excludeAppointmentId,
      ACTIVE_APPOINTMENT_STATUSES,
    ],
  );

  const peakOverlapping = Number(
    chairsOverlapRes.rows[0]?.peak_overlapping ?? 0,
  );

  if (peakOverlapping >= totalChairs) {
    return {
      hasConflict: true,
      code: "CHAIR_CAPACITY_EXCEEDED",
      error: `سيتم تجاوز سعة الكراسي المتاحة (${totalChairs}) في جزء من الفترة المطلوبة`,
      conflict: {
        total_chairs_count: totalChairs,
        overlapping_appointments: peakOverlapping,
      },
    };
  }

  return {
    hasConflict: false,
  };
};

module.exports = {
  validateAppointmentSlot,
  ACTIVE_APPOINTMENT_STATUSES,
};
