const pool = require("../db");

const getDashboardStats = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;

    // 1. دخل اليوم الفعلي (الكاش والتحصيلات المسجلة اليوم فقط للفواتير النشطة)
    const todayIncomeQuery = `
      SELECT COALESCE(SUM(p.amount), 0) AS today_income
      FROM payments p
      JOIN invoices inv ON p.invoice_id = inv.id
      WHERE p.clinic_id = $1 
        AND DATE(p.paid_at) = CURRENT_DATE 
        AND inv.is_archived = FALSE;
    `;

    // 2. فلوس برة (إجمالي المبالغ المتبقية على المرضى في الفواتير غير المؤرشفة وغير المسددة بالكامل)
    const totalDuesQuery = `
      SELECT COALESCE(SUM(inv.total_amount - COALESCE(p_sum.total_paid, 0)), 0) AS total_dues
      FROM invoices inv
      LEFT JOIN (
        SELECT invoice_id, SUM(amount) AS total_paid
        FROM payments
        WHERE clinic_id = $1
        GROUP BY invoice_id
      ) p_sum ON inv.id = p_sum.invoice_id
      WHERE inv.clinic_id = $1 
        AND inv.is_archived = FALSE 
        AND inv.status NOT IN ('paid', 'cancelled');
    `;

    // 3. مواعيد اليوم الحية + فحص الفاتورة السابقة + إجمالي ديون المريض
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
   -- فحص هل الموعد له فاتورة نشطة
   LEFT JOIN invoices inv ON a.id = inv.appointment_id AND inv.clinic_id = a.clinic_id AND inv.is_archived = FALSE
   -- حساب إجمالي الديون المتبقية على هذا المريض في العيادة
   LEFT JOIN (
     SELECT 
       i.patient_id,
       SUM(i.total_amount - COALESCE(pay_sum.paid, 0)) AS total_due
     FROM invoices i
     LEFT JOIN (
       SELECT invoice_id, SUM(amount) AS paid 
       FROM payments 
       WHERE clinic_id = $1 
       GROUP BY invoice_id
     ) pay_sum ON i.id = pay_sum.invoice_id
     WHERE i.clinic_id = $1 AND i.is_archived = FALSE AND i.status NOT IN ('paid', 'cancelled')
     GROUP BY i.patient_id
   ) patient_dues ON p.id = patient_dues.patient_id
   WHERE a.clinic_id = $1 AND DATE(a.appointment_date) = CURRENT_DATE
   ORDER BY a.appointment_date ASC;
 `;

    // 4. طلبات المعمل العاجلة (التي لم تُستلم بعد: متأخرة أو تسليمها اليوم أو غداً)
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
          WHEN lo.expected_at::date < CURRENT_DATE THEN 'overdue'
          WHEN lo.expected_at::date = CURRENT_DATE THEN 'today'
          WHEN lo.expected_at::date = CURRENT_DATE + 1 THEN 'tomorrow'
          ELSE 'upcoming'
        END AS urgency
      FROM lab_orders lo
      JOIN patients p ON lo.patient_id = p.id
      JOIN users u ON lo.doctor_id = u.id
      WHERE lo.clinic_id = $1 
        AND lo.status NOT IN ('received', 'cancelled')
        AND lo.expected_at::date <= CURRENT_DATE + 1
      ORDER BY lo.expected_at ASC;
    `;

    // تشغيل الاستعلامات بالتوازي لسرعة فائقة
    const [incomeRes, duesRes, appointmentsRes, labRes] = await Promise.all([
      pool.query(todayIncomeQuery, [clinicId]),
      pool.query(totalDuesQuery, [clinicId]),
      pool.query(todayAppointmentsQuery, [clinicId]),
      pool.query(urgentLabOrdersQuery, [clinicId]),
    ]);

    const todayAppointments = appointmentsRes.rows;
    const completedCount = todayAppointments.filter(
      (a) => a.status === "completed"
    ).length;

    res.status(200).json({
      stats: {
        today_income: parseFloat(incomeRes.rows[0]?.today_income || 0),
        total_dues: parseFloat(duesRes.rows[0]?.total_dues || 0),
        today_appointments_count: todayAppointments.length,
        today_completed_count: completedCount,
        urgent_lab_orders_count: labRes.rows.length,
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
