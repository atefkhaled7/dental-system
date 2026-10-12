const pool = require("../db");
const { captureError } = require("../utils/errorTracker");

const getReportsSummary = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { from: startDate, to: endDate } = req.query;

  const isValidDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  };

  if (
    (startDate && !isValidDate(startDate)) ||
    (endDate && !isValidDate(endDate))
  ) {
    return res.status(400).json({
      error: "التاريخ غير صالح. استخدم الصيغة YYYY-MM-DD",
    });
  }

  if (startDate && endDate && startDate > endDate) {
    return res.status(400).json({
      error: "تاريخ البداية يجب أن يكون قبل تاريخ النهاية أو مساويًا له",
    });
  }

  try {
    let start = startDate;
    let end = endDate;
    if (!start || !end) {
      const nowCairoRes = await pool.query(
        `SELECT TO_CHAR(date_trunc('month', NOW() AT TIME ZONE 'Africa/Cairo'), 'YYYY-MM-DD') AS start_date,
                TO_CHAR(NOW() AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') AS end_date;`,
      );
      start = start || nowCairoRes.rows[0].start_date;
      end = end || nowCairoRes.rows[0].end_date;
    }

    if (start > end) {
      return res.status(400).json({
        error: "تاريخ البداية يجب أن يكون قبل تاريخ النهاية أو مساويًا له",
      });
    }

    // 1. إجمالي المقبوضات والتحصيل الفعلي في الفترة وتوزيع طرق الدفع
    const paymentsQuery = `
      SELECT 
        COALESCE(SUM(p.amount), 0) AS total_collected,
        COUNT(p.id) AS payments_count,
        COALESCE(SUM(CASE WHEN p.payment_method = 'cash' THEN p.amount ELSE 0 END), 0) AS cash_amount,
        COALESCE(SUM(CASE WHEN p.payment_method = 'card' THEN p.amount ELSE 0 END), 0) AS card_amount,
        COALESCE(SUM(CASE WHEN p.payment_method = 'bank_transfer' THEN p.amount ELSE 0 END), 0) AS transfer_amount,
        COALESCE(
          SUM(CASE WHEN p.payment_method = 'vodafone_cash' THEN p.amount ELSE 0 END),
          0
        ) AS vodafone_cash_amount,
        COALESCE(SUM(CASE WHEN p.payment_method = 'other' THEN p.amount ELSE 0 END), 0) AS other_amount
      FROM payments p
      JOIN invoices inv ON p.invoice_id = inv.id
      WHERE p.clinic_id = $1
        AND p.status = 'paid'
        AND inv.status <> 'cancelled'
        AND (p.paid_at AT TIME ZONE 'Africa/Cairo')::date >= $2::date
        AND (p.paid_at AT TIME ZONE 'Africa/Cairo')::date <= $3::date;
    `;

    // 2. إجمالي الفواتير الصادرة في الفترة
    const invoicesQuery = `
      SELECT 
        COALESCE(SUM(total_amount), 0) AS total_invoiced,
        COUNT(id) AS invoices_count
      FROM invoices
      WHERE clinic_id = $1
        AND status <> 'cancelled'
        AND (created_at AT TIME ZONE 'Africa/Cairo')::date >= $2::date
        AND (created_at AT TIME ZONE 'Africa/Cairo')::date <= $3::date;
    `;

    // 3. إجمالي الديون المعلقة الحالية على العيادة
    const currentDuesQuery = `
      SELECT COALESCE(SUM(inv.total_amount - COALESCE(p_sum.total_paid, 0)), 0) AS current_total_dues
      FROM invoices inv
      LEFT JOIN (
        SELECT invoice_id, SUM(amount) AS total_paid
        FROM payments
        WHERE clinic_id = $1 AND status = 'paid'
        GROUP BY invoice_id
      ) p_sum ON inv.id = p_sum.invoice_id
      WHERE inv.clinic_id = $1
        AND inv.is_archived = FALSE
        AND inv.status NOT IN ('paid', 'cancelled');
    `;

    // 4. إحصائيات المواعيد ونسبة الـ No-Show
    const appointmentsQuery = `
      SELECT 
        COUNT(id) AS total_appointments,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed_count,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cancelled_count,
        COUNT(CASE WHEN status = 'no_show' THEN 1 END) AS no_show_count
      FROM appointments
      WHERE clinic_id = $1
        AND (appointment_date AT TIME ZONE 'Africa/Cairo')::date >= $2::date
        AND (appointment_date AT TIME ZONE 'Africa/Cairo')::date <= $3::date;
    `;

    // 🌟 5. إنتاجية الأطباء الشاملة (تشمل فواتير المواعيد وفواتير خطط العلاج + الأطباء المعطلين ذوي السجلات التاريخية)
    const doctorsProductionQuery = `
      WITH appointment_stats AS (
        SELECT
          a.doctor_id,
          COUNT(*) AS total_appointments,
          COUNT(*) FILTER (
            WHERE a.status = 'completed'
          ) AS completed_appointments,
          COUNT(*) FILTER (
            WHERE a.status = 'no_show'
          ) AS no_show_appointments
        FROM appointments a
        WHERE a.clinic_id = $1
          AND (a.appointment_date AT TIME ZONE 'Africa/Cairo')::date
              BETWEEN $2::date AND $3::date
        GROUP BY a.doctor_id
      ),
      doctor_production AS (
        SELECT
          COALESCE(inv.doctor_id, a.doctor_id) AS doctor_id,
          COALESCE(SUM(inv.total_amount), 0) AS total_revenue_generated
        FROM invoices inv
        LEFT JOIN appointments a 
          ON inv.appointment_id = a.id 
         AND a.clinic_id = $1
        WHERE inv.clinic_id = $1
          AND inv.status <> 'cancelled'
          AND (inv.created_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $2::date AND $3::date
          AND COALESCE(inv.doctor_id, a.doctor_id) IS NOT NULL
        GROUP BY COALESCE(inv.doctor_id, a.doctor_id)
      )
      SELECT
        u.id AS doctor_id,
        CASE 
          WHEN u.is_active = TRUE THEN u.name 
          ELSE u.name || ' (سابق)' 
        END AS doctor_name,
        COALESCE(s.total_appointments, 0) AS total_appointments,
        COALESCE(s.completed_appointments, 0) AS completed_appointments,
        COALESCE(s.no_show_appointments, 0) AS no_show_appointments,
        COALESCE(p.total_revenue_generated, 0) AS total_revenue_generated
      FROM users u
      LEFT JOIN appointment_stats s ON s.doctor_id = u.id
      LEFT JOIN doctor_production p ON p.doctor_id = u.id
      WHERE u.clinic_id = $1
        AND u.role = 'Doctor'
        AND (u.is_active = TRUE OR COALESCE(s.total_appointments, 0) > 0 OR COALESCE(p.total_revenue_generated, 0) > 0)
      ORDER BY
        total_revenue_generated DESC,
        completed_appointments DESC;
    `;

    // تشغيل الاستعلامات بالتوازي
    const [paymentsRes, invoicesRes, duesRes, apptsRes, doctorsRes] =
      await Promise.all([
        pool.query(paymentsQuery, [clinicId, start, end]),
        pool.query(invoicesQuery, [clinicId, start, end]),
        pool.query(currentDuesQuery, [clinicId]),
        pool.query(appointmentsQuery, [clinicId, start, end]),
        pool.query(doctorsProductionQuery, [clinicId, start, end]),
      ]);

    const apptStats = apptsRes.rows[0];
    const totalAppts = parseInt(apptStats.total_appointments, 10) || 0;
    const completedCount = parseInt(apptStats.completed_count, 10) || 0;
    const noShowCount = parseInt(apptStats.no_show_count, 10) || 0;
    const eligibleAppointments = completedCount + noShowCount;
    const noShowRate =
      eligibleAppointments > 0
        ? Number(((noShowCount / eligibleAppointments) * 100).toFixed(1))
        : 0;

    res.status(200).json({
      period: { startDate: start, endDate: end },
      financials: {
        total_collected: parseFloat(paymentsRes.rows[0]?.total_collected || 0),
        total_invoiced: parseFloat(invoicesRes.rows[0]?.total_invoiced || 0),
        current_total_dues: parseFloat(
          duesRes.rows[0]?.current_total_dues || 0,
        ),
        payments_count: parseInt(paymentsRes.rows[0]?.payments_count || 0, 10),
        payment_methods: {
          cash: parseFloat(paymentsRes.rows[0]?.cash_amount || 0),
          card: parseFloat(paymentsRes.rows[0]?.card_amount || 0),
          transfer: parseFloat(paymentsRes.rows[0]?.transfer_amount || 0),
          other: parseFloat(paymentsRes.rows[0]?.other_amount || 0),
          vodafone_cash: parseFloat(
            paymentsRes.rows[0]?.vodafone_cash_amount || 0,
          ),
        },
      },
      appointments: {
        total: totalAppts,
        completed: completedCount,
        cancelled: parseInt(apptStats.cancelled_count, 10) || 0,
        no_show: noShowCount,
        no_show_rate_percent: parseFloat(noShowRate),
      },
      doctors_production: doctorsRes.rows.map((d) => ({
        doctor_id: d.doctor_id,
        doctor_name: d.doctor_name,
        total_appointments: parseInt(d.total_appointments, 10) || 0,
        completed_appointments: parseInt(d.completed_appointments, 10) || 0,
        no_show_appointments: parseInt(d.no_show_appointments, 10) || 0,
        total_revenue_generated: parseFloat(d.total_revenue_generated || 0),
      })),
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error generating reports summary:", error.message);
    res.status(500).json({ error: "فشل إنشاء التقرير" });
  }
};

module.exports = { getReportsSummary };
