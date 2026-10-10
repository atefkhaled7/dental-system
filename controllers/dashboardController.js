const pool = require("../db");

const getDashboardStats = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const isClinicAdmin =
      req.user.role === "ClinicAdmin";

    // 1. دخل اليوم الفعلي بتوقيت مصر (متاح للجميع لمطابقة كاش الدرج)
    const todayIncomeQuery = `
      SELECT COALESCE(SUM(p.amount), 0) AS today_income
      FROM payments p
      JOIN invoices inv ON p.invoice_id = inv.id
      WHERE p.clinic_id = $1 
        AND p.status = 'paid'
        AND inv.status <> 'cancelled'
        AND (p.paid_at AT TIME ZONE 'Africa/Cairo')::date = (NOW() AT TIME ZONE 'Africa/Cairo')::date;
    `;

    // 2. إيرادات الشهر الحالي (تُحسب فقط لمدير العيادة لحماية الخصوصية)
    const monthIncomeQuery = isClinicAdmin
      ? `SELECT COALESCE(SUM(p.amount), 0) AS month_income
         FROM payments p
         JOIN invoices inv ON p.invoice_id = inv.id
         WHERE p.clinic_id = $1 
           AND p.status = 'paid'
           AND inv.status <> 'cancelled'
           AND p.paid_at >= date_trunc('month', NOW() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo'
           AND p.paid_at < (date_trunc('month', NOW() AT TIME ZONE 'Africa/Cairo') + INTERVAL '1 month') AT TIME ZONE 'Africa/Cairo';`
      : `SELECT 0 AS month_income;`;

    // 3. فلوس برة (تُحسب فقط لمدير العيادة لحماية الخصوصية)
    const totalDuesQuery = isClinicAdmin
      ? `SELECT COALESCE(SUM(inv.total_amount - COALESCE(p_sum.total_paid, 0)), 0) AS total_dues
         FROM invoices inv
         LEFT JOIN (
           SELECT invoice_id, SUM(amount) AS total_paid
           FROM payments
           WHERE clinic_id = $1 
             AND status = 'paid'
           GROUP BY invoice_id
         ) p_sum ON inv.id = p_sum.invoice_id
         WHERE inv.clinic_id = $1 
           AND inv.is_archived = FALSE 
           AND inv.status NOT IN ('paid', 'cancelled');`
      : `SELECT 0 AS total_dues;`;

    // 4. مواعيد اليوم الحية
    const todayAppointmentsQuery = `
      SELECT 
        a.id AS appointment_id,
        a.appointment_date,
        a.status,
        a.notes,
        p.id AS patient_id,
        p.name AS patient_name,
        p.phone_number AS patient_phone,
        u.id AS doctor_id,
        u.name AS doctor_name,
        inv.id AS appointment_invoice_id,
        inv.status AS appointment_invoice_status,
        COALESCE(patient_dues.total_due, 0) AS patient_total_due
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id AND a.clinic_id = p.clinic_id
      JOIN users u ON a.doctor_id = u.id AND a.clinic_id = u.clinic_id
      LEFT JOIN LATERAL (
        SELECT i.id, i.status
        FROM invoices i
        WHERE i.appointment_id = a.id
          AND i.clinic_id = a.clinic_id
          AND i.is_archived = FALSE
          AND i.status <> 'cancelled'
        ORDER BY i.created_at DESC
        LIMIT 1
      ) inv ON TRUE
      LEFT JOIN (
        SELECT 
          i.patient_id,
          SUM(i.total_amount - COALESCE(pay_sum.paid, 0)) AS total_due
        FROM invoices i
        LEFT JOIN (
          SELECT invoice_id, SUM(amount) AS paid 
          FROM payments 
          WHERE clinic_id = $1 
            AND status = 'paid'
          GROUP BY invoice_id
        ) pay_sum ON i.id = pay_sum.invoice_id
        WHERE i.clinic_id = $1 
          AND i.is_archived = FALSE 
          AND i.status NOT IN ('paid', 'cancelled')
        GROUP BY i.patient_id
      ) patient_dues ON p.id = patient_dues.patient_id
      WHERE a.clinic_id = $1
        AND DATE(a.appointment_date AT TIME ZONE 'Africa/Cairo') =
            (NOW() AT TIME ZONE 'Africa/Cairo')::date
      ORDER BY a.appointment_date ASC;
    `;

    // 5. طلبات المعمل العاجلة
    const urgentLabOrdersQuery = `
      SELECT 
        lo.id,
        lo.case_number,
        lo.lab_name,
        lo.expected_at,
        lo.status,
        p.name AS patient_name,
        u.name AS doctor_name,
        CASE 
          WHEN (lo.expected_at AT TIME ZONE 'Africa/Cairo')::date < (NOW() AT TIME ZONE 'Africa/Cairo')::date THEN 'overdue'
          WHEN (lo.expected_at AT TIME ZONE 'Africa/Cairo')::date = (NOW() AT TIME ZONE 'Africa/Cairo')::date THEN 'today'
          WHEN (lo.expected_at AT TIME ZONE 'Africa/Cairo')::date = (NOW() AT TIME ZONE 'Africa/Cairo')::date + 1 THEN 'tomorrow'
          ELSE 'upcoming'
        END AS urgency
      FROM lab_orders lo
      JOIN patients p ON lo.patient_id = p.id AND p.clinic_id = lo.clinic_id
      JOIN users u ON lo.doctor_id = u.id AND u.clinic_id = lo.clinic_id
      WHERE lo.clinic_id = $1 
        AND lo.status NOT IN ('received', 'cancelled')
        AND (lo.expected_at AT TIME ZONE 'Africa/Cairo')::date <= (NOW() AT TIME ZONE 'Africa/Cairo')::date + 1
      ORDER BY lo.expected_at ASC;
    `;

    // 6. إجمالي المرضى النشطين
    const activePatientsQuery = `
      SELECT COUNT(*) AS active_patients_count
      FROM patients
      WHERE clinic_id = $1 AND is_active = TRUE;
    `;

    // 7. طلبات الحجز أونلاين المعلقة الصالحة
    const pendingBookingsQuery = `
      SELECT COUNT(*) AS pending_count
      FROM booking_requests
      WHERE clinic_id = $1 
        AND status = 'pending' 
        AND expires_at > NOW();
    `;

    // تشغيل جميع الاستعلامات بالتوازي
    const [
      incomeRes,
      monthIncomeRes,
      duesRes,
      appointmentsRes,
      labRes,
      patientsRes,
      pendingBookingsRes,
    ] = await Promise.all([
      pool.query(todayIncomeQuery, [clinicId]),

      isClinicAdmin
        ? pool.query(monthIncomeQuery, [clinicId])
        : Promise.resolve({ rows: [{ month_income: 0 }] }),

      isClinicAdmin
        ? pool.query(totalDuesQuery, [clinicId])
        : Promise.resolve({ rows: [{ total_dues: 0 }] }),
      pool.query(todayAppointmentsQuery, [clinicId]),
      pool.query(urgentLabOrdersQuery, [clinicId]),
      pool.query(activePatientsQuery, [clinicId]),
      pool.query(pendingBookingsQuery, [clinicId]),
    ]);

    const todayAppointments = appointmentsRes.rows;

    // 👈 استبعاد المواعيد الملغية من عداد مواعيد اليوم النشطة
    const activeAppointmentsCount = todayAppointments.filter(
      (a) => a.status !== "cancelled",
    ).length;

    const completedCount = todayAppointments.filter(
      (a) => a.status === "completed",
    ).length;

    res.status(200).json({
      stats: {
        today_income: parseFloat(incomeRes.rows[0]?.today_income || 0),
        // لو مش أدمن هترجع null لحماية الأسرار المالية
        month_income: isClinicAdmin
          ? parseFloat(monthIncomeRes.rows[0]?.month_income || 0)
          : null,
        total_dues: isClinicAdmin
          ? parseFloat(duesRes.rows[0]?.total_dues || 0)
          : null,
        today_appointments_count: activeAppointmentsCount, // 👈 محسوب بدون الملغي
        today_completed_count: completedCount,
        urgent_lab_orders_count: labRes.rows.length,
        active_patients_count: parseInt(
          patientsRes.rows[0]?.active_patients_count || 0,
          10,
        ),
        pending_bookings_count: parseInt(
          pendingBookingsRes.rows[0]?.pending_count || 0,
          10,
        ), // 👈 عدد طلبات الأونلاين
      },
      today_appointments: todayAppointments,
      urgent_lab_orders: labRes.rows,
    });
  } catch (error) {
    console.error("Error fetching dashboard stats:", error.message);
    res
      .status(500)
      .json({ error: "خطأ في السيرفر أثناء تحميل إحصائيات الداشبورد" });
  }
};

module.exports = { getDashboardStats };
