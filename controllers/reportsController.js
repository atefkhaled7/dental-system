const pool = require("../db");
const { logActivity } = require("../utils/auditLogger");
const { isValidUuid } = require("../middleware/validateUuid");
const { captureError } = require("../utils/errorTracker");

const VALID_EXPENSE_METHODS = [
  "cash",
  "card",
  "bank_transfer",
  "vodafone_cash",
  "instapay",
  "cheque",
  "other",
];

const normalizePaymentMethod = (raw) => {
  let m = String(raw || "cash")
    .toLowerCase()
    .trim();
  if (m === "transfer") m = "bank_transfer";
  if (m === "vodafonecash") m = "vodafone_cash";
  if (m === "insta_pay" || m === "insta-pay") m = "instapay";
  if (m === "check") m = "cheque";
  return m;
};

const isValidDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
};

// ==========================================
// 1. الملخص المالي والتشغيلي الشامل وإنتاجية وعمولات الأطباء
// ==========================================
const getReportsSummary = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { from: startDate, to: endDate } = req.query;

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

    // 1. إجمالي المقبوضات وتوزيع طرق الدفع (بما فيها InstaPay والشيكات والدفع الإلكتروني)
    const paymentsQuery = `
      SELECT 
        COALESCE(SUM(p.amount), 0) AS total_collected,
        COUNT(p.id) AS payments_count,
        COALESCE(SUM(CASE WHEN p.payment_method = 'cash' THEN p.amount ELSE 0 END), 0) AS cash_amount,
        COALESCE(SUM(CASE WHEN p.payment_method = 'card' THEN p.amount ELSE 0 END), 0) AS card_amount,
        COALESCE(SUM(CASE WHEN p.payment_method = 'bank_transfer' THEN p.amount ELSE 0 END), 0) AS transfer_amount,
        COALESCE(SUM(CASE WHEN p.payment_method = 'vodafone_cash' THEN p.amount ELSE 0 END), 0) AS vodafone_cash_amount,
        COALESCE(SUM(CASE WHEN p.payment_method = 'instapay' THEN p.amount ELSE 0 END), 0) AS instapay_amount,
        COALESCE(SUM(CASE WHEN p.payment_method = 'cheque' THEN p.amount ELSE 0 END), 0) AS cheque_amount,
        COALESCE(SUM(CASE WHEN p.payment_method = 'online' THEN p.amount ELSE 0 END), 0) AS online_amount,
        COALESCE(SUM(CASE WHEN p.payment_method = 'other' THEN p.amount ELSE 0 END), 0) AS other_amount
      FROM payments p
      JOIN invoices inv ON p.invoice_id = inv.id AND inv.clinic_id = p.clinic_id
      WHERE p.clinic_id = $1
        AND p.status = 'paid'
        AND inv.status <> 'cancelled'
        AND (p.paid_at AT TIME ZONE 'Africa/Cairo')::date >= $2::date
        AND (p.paid_at AT TIME ZONE 'Africa/Cairo')::date <= $3::date;
    `;

    // 2. إجمالي الفواتير والخصومات في الفترة
    const invoicesQuery = `
      SELECT 
        COALESCE(SUM(subtotal_amount), 0) AS total_subtotal,
        COALESCE(SUM(discount_amount), 0) AS total_discount,
        COALESCE(SUM(total_amount), 0) AS total_invoiced,
        COUNT(id) AS invoices_count
      FROM invoices
      WHERE clinic_id = $1
        AND status <> 'cancelled'
        AND (created_at AT TIME ZONE 'Africa/Cairo')::date >= $2::date
        AND (created_at AT TIME ZONE 'Africa/Cairo')::date <= $3::date;
    `;

    // 3. إجمالي الديون المعلقة الحالية على المرضى + إجمالي الأقساط المتأخرة
    const currentDuesQuery = `
      SELECT
        COALESCE(SUM(GREATEST(0, inv.total_amount - COALESCE(p_sum.total_paid, 0))), 0) AS current_total_dues,
        (
          SELECT COALESCE(SUM(inst.amount - inst.paid_amount), 0)
          FROM installments inst
          JOIN invoices i2 ON inst.invoice_id = i2.id AND i2.clinic_id = inst.clinic_id
          WHERE inst.clinic_id = $1
            AND inst.status = 'pending'
            AND i2.status NOT IN ('paid', 'cancelled')
            AND inst.due_date < (NOW() AT TIME ZONE 'Africa/Cairo')::date
        ) AS overdue_installments_amount,
        (
          SELECT COUNT(*)::int
          FROM installments inst
          JOIN invoices i2 ON inst.invoice_id = i2.id AND i2.clinic_id = inst.clinic_id
          WHERE inst.clinic_id = $1
            AND inst.status = 'pending'
            AND i2.status NOT IN ('paid', 'cancelled')
            AND inst.due_date < (NOW() AT TIME ZONE 'Africa/Cairo')::date
        ) AS overdue_installments_count
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

    // 4. مصروفات العيادة في الفترة وتوزيعها حسب البند + مستحقات المعامل غير المسددة
    const expensesQuery = `
      SELECT
        COALESCE(SUM(amount), 0) AS total_expenses,
        COALESCE(SUM(CASE WHEN lab_order_id IS NOT NULL OR category = 'مدفوعات معامل الأسنان' THEN amount ELSE 0 END), 0) AS lab_expenses,
        COUNT(id)::int AS expenses_count,
        (
          SELECT COALESCE(SUM(GREATEST(0, cost - paid_amount)), 0)
          FROM lab_orders
          WHERE clinic_id = $1
            AND status <> 'cancelled'
            AND payment_status <> 'paid'
        ) AS unpaid_lab_dues
      FROM expenses
      WHERE clinic_id = $1
        AND expense_date >= $2::date
        AND expense_date <= $3::date;
    `;

    const expensesByCategoryQuery = `
      SELECT
        category,
        COALESCE(SUM(amount), 0) AS total_amount,
        COUNT(id)::int AS count
      FROM expenses
      WHERE clinic_id = $1
        AND expense_date >= $2::date
        AND expense_date <= $3::date
      GROUP BY category
      ORDER BY total_amount DESC;
    `;

    // 5. إحصائيات المواعيد ونسبة الـ No-Show
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

    // 6. إنتاجية الأطباء الشاملة + حساب نسب العمولات والرواتب المستحقة في الفترة
    const doctorsProductionQuery = `
      WITH appointment_stats AS (
        SELECT
          a.doctor_id,
          COUNT(*) AS total_appointments,
          COUNT(*) FILTER (WHERE a.status = 'completed') AS completed_appointments,
          COUNT(*) FILTER (WHERE a.status = 'no_show') AS no_show_appointments
        FROM appointments a
        WHERE a.clinic_id = $1
          AND (a.appointment_date AT TIME ZONE 'Africa/Cairo')::date BETWEEN $2::date AND $3::date
        GROUP BY a.doctor_id
      ),
      doctor_invoiced AS (
        SELECT
          COALESCE(inv.doctor_id, a.doctor_id) AS doctor_id,
          COALESCE(SUM(inv.total_amount), 0) AS total_revenue_generated
        FROM invoices inv
        LEFT JOIN appointments a ON inv.appointment_id = a.id AND a.clinic_id = $1
        WHERE inv.clinic_id = $1
          AND inv.status <> 'cancelled'
          AND (inv.created_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $2::date AND $3::date
          AND COALESCE(inv.doctor_id, a.doctor_id) IS NOT NULL
        GROUP BY COALESCE(inv.doctor_id, a.doctor_id)
      ),
      doctor_collected AS (
        SELECT
          COALESCE(inv.doctor_id, a.doctor_id) AS doctor_id,
          COALESCE(SUM(pay.amount), 0) AS total_collected_generated
        FROM payments pay
        JOIN invoices inv ON pay.invoice_id = inv.id AND inv.clinic_id = $1
        LEFT JOIN appointments a ON inv.appointment_id = a.id AND a.clinic_id = $1
        WHERE pay.clinic_id = $1
          AND pay.status = 'paid'
          AND inv.status <> 'cancelled'
          AND (pay.paid_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $2::date AND $3::date
          AND COALESCE(inv.doctor_id, a.doctor_id) IS NOT NULL
        GROUP BY COALESCE(inv.doctor_id, a.doctor_id)
      ),
      doctor_labs AS (
        SELECT
          lo.doctor_id,
          COALESCE(SUM(lo.cost), 0) AS total_lab_cost
        FROM lab_orders lo
        WHERE lo.clinic_id = $1
          AND lo.status <> 'cancelled'
          AND (lo.sent_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $2::date AND $3::date
        GROUP BY lo.doctor_id
      ),
      doctor_payouts AS (
        SELECT
          cp.doctor_id,
          COALESCE(SUM(cp.total_payout), 0) AS payouts_in_period
        FROM commission_payouts cp
        WHERE cp.clinic_id = $1
          AND (cp.paid_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $2::date AND $3::date
        GROUP BY cp.doctor_id
      )
      SELECT
        u.id AS doctor_id,
        u.is_active,
        CASE 
          WHEN u.is_active = TRUE THEN u.name 
          ELSE u.name || ' (سابق)' 
        END AS doctor_name,
        COALESCE(s.total_appointments, 0) AS total_appointments,
        COALESCE(s.completed_appointments, 0) AS completed_appointments,
        COALESCE(s.no_show_appointments, 0) AS no_show_appointments,
        COALESCE(di.total_revenue_generated, 0) AS total_revenue_generated,
        COALESCE(dc.total_collected_generated, 0) AS total_collected_generated,
        COALESCE(dl.total_lab_cost, 0) AS total_lab_cost,
        COALESCE(sc.base_salary, 0) AS base_salary,
        COALESCE(sc.commission_type, 'collected') AS commission_type,
        COALESCE(sc.commission_rate, 0) AS commission_rate,
        COALESCE(dp.payouts_in_period, 0) AS payouts_in_period
      FROM users u
      LEFT JOIN appointment_stats s ON s.doctor_id = u.id
      LEFT JOIN doctor_invoiced di ON di.doctor_id = u.id
      LEFT JOIN doctor_collected dc ON dc.doctor_id = u.id
      LEFT JOIN doctor_labs dl ON dl.doctor_id = u.id
      LEFT JOIN staff_compensation sc ON sc.user_id = u.id AND sc.clinic_id = u.clinic_id
      LEFT JOIN doctor_payouts dp ON dp.doctor_id = u.id
      WHERE u.clinic_id = $1
        AND u.role = 'Doctor'
        AND (
  u.is_active = TRUE
  OR COALESCE(s.total_appointments, 0) > 0
  OR COALESCE(di.total_revenue_generated, 0) > 0
  OR COALESCE(dc.total_collected_generated, 0) > 0
  OR COALESCE(dl.total_lab_cost, 0) > 0
  OR COALESCE(dp.payouts_in_period, 0) > 0
)
      ORDER BY
        total_collected_generated DESC,
        total_revenue_generated DESC,
        completed_appointments DESC;
    `;

    const [
      paymentsRes,
      invoicesRes,
      duesRes,
      expensesRes,
      expensesByCatRes,
      apptsRes,
      doctorsRes,
    ] = await Promise.all([
      pool.query(paymentsQuery, [clinicId, start, end]),
      pool.query(invoicesQuery, [clinicId, start, end]),
      pool.query(currentDuesQuery, [clinicId]),
      pool.query(expensesQuery, [clinicId, start, end]),
      pool.query(expensesByCategoryQuery, [clinicId, start, end]),
      pool.query(appointmentsQuery, [clinicId, start, end]),
      pool.query(doctorsProductionQuery, [clinicId, start, end]),
    ]);

    const totalCollectedCents = Math.round(
      Number(paymentsRes.rows[0]?.total_collected || 0) * 100,
    );
    const totalExpensesCents = Math.round(
      Number(expensesRes.rows[0]?.total_expenses || 0) * 100,
    );
    const netProfitCents = totalCollectedCents - totalExpensesCents;

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
        total_collected: totalCollectedCents / 100,
        total_subtotal: Number(invoicesRes.rows[0]?.total_subtotal || 0),
        total_discount: Number(invoicesRes.rows[0]?.total_discount || 0),
        total_invoiced: Number(invoicesRes.rows[0]?.total_invoiced || 0),
        invoices_count: parseInt(invoicesRes.rows[0]?.invoices_count || 0, 10),
        total_expenses: totalExpensesCents / 100,
        lab_expenses: Number(expensesRes.rows[0]?.lab_expenses || 0),
        expenses_count: parseInt(expensesRes.rows[0]?.expenses_count || 0, 10),
        net_profit: netProfitCents / 100,
        current_total_dues: Number(duesRes.rows[0]?.current_total_dues || 0),
        overdue_installments_amount: Number(
          duesRes.rows[0]?.overdue_installments_amount || 0,
        ),
        overdue_installments_count:
          duesRes.rows[0]?.overdue_installments_count || 0,
        unpaid_lab_dues: Number(expensesRes.rows[0]?.unpaid_lab_dues || 0),
        payments_count: parseInt(paymentsRes.rows[0]?.payments_count || 0, 10),
        payment_methods: {
          cash: Number(paymentsRes.rows[0]?.cash_amount || 0),
          card: Number(paymentsRes.rows[0]?.card_amount || 0),
          transfer: Number(paymentsRes.rows[0]?.transfer_amount || 0),
          vodafone_cash: Number(paymentsRes.rows[0]?.vodafone_cash_amount || 0),
          instapay: Number(paymentsRes.rows[0]?.instapay_amount || 0),
          cheque: Number(paymentsRes.rows[0]?.cheque_amount || 0),
          online: Number(paymentsRes.rows[0]?.online_amount || 0),
          other: Number(paymentsRes.rows[0]?.other_amount || 0),
        },
        expenses_by_category: expensesByCatRes.rows.map((c) => ({
          category: c.category,
          total_amount: Number(c.total_amount || 0),
          count: c.count,
        })),
      },
      appointments: {
        total: totalAppts,
        completed: completedCount,
        cancelled: parseInt(apptStats.cancelled_count, 10) || 0,
        no_show: noShowCount,
        no_show_rate_percent: parseFloat(noShowRate),
      },
      doctors_production: doctorsRes.rows.map((d) => {
        const revCents = Math.round(
          Number(d.total_revenue_generated || 0) * 100,
        );
        const colCents = Math.round(
          Number(d.total_collected_generated || 0) * 100,
        );
        const labCents = Math.round(Number(d.total_lab_cost || 0) * 100);
        const baseSalaryCents = Math.round(Number(d.base_salary || 0) * 100);
        const rate = Number(d.commission_rate || 0);
        const commType = d.commission_type || "collected";

        let basisCents = colCents;
        if (commType === "invoiced") {
          basisCents = revCents;
        } else if (commType === "after_lab_cost") {
          basisCents = Math.max(0, colCents - labCents);
        }

        const commissionCents = Math.round((basisCents * rate) / 100);
        const totalEntitlementCents = baseSalaryCents + commissionCents;

        return {
          doctor_id: d.doctor_id,
          doctor_name: d.doctor_name,
          is_active: d.is_active,
          total_appointments: parseInt(d.total_appointments, 10) || 0,
          completed_appointments: parseInt(d.completed_appointments, 10) || 0,
          no_show_appointments: parseInt(d.no_show_appointments, 10) || 0,
          total_revenue_generated: revCents / 100,
          total_collected_generated: colCents / 100,
          total_lab_cost: labCents / 100,
          base_salary: baseSalaryCents / 100,
          commission_type: commType,
          commission_rate: rate,
          gross_basis_amount: basisCents / 100,
          calculated_commission: commissionCents / 100,
          total_entitlement: totalEntitlementCents / 100,
          payouts_in_period: Number(d.payouts_in_period || 0),
        };
      }),
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error generating reports summary:", error.message);
    res.status(500).json({ error: "فشل إنشاء التقرير" });
  }
};

// ==========================================
// 2. جلب وإضافة وحذف مصروفات العيادة (Expenses)
// ==========================================
const getExpenses = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { from, to, category, search, page, limit } = req.query;

  if (from && !isValidDate(from)) {
    return res.status(400).json({
      error: "تاريخ البداية غير صالح (YYYY-MM-DD)",
    });
  }

  if (to && !isValidDate(to)) {
    return res.status(400).json({
      error: "تاريخ النهاية غير صالح (YYYY-MM-DD)",
    });
  }

  try {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const offset = (pageNum - 1) * limitNum;

    const params = [clinicId];
    let whereSql = `WHERE e.clinic_id = $1`;

    if (from && isValidDate(from)) {
      params.push(from);
      whereSql += ` AND e.expense_date >= $${params.length}::date`;
    }
    if (to && isValidDate(to)) {
      params.push(to);
      whereSql += ` AND e.expense_date <= $${params.length}::date`;
    }
    if (category && category.trim() !== "") {
      params.push(category.trim());
      whereSql += ` AND e.category = $${params.length}`;
    }
    if (search && search.trim() !== "") {
      params.push(`%${search.trim()}%`);
      whereSql += ` AND (e.title ILIKE $${params.length} OR e.vendor_name ILIKE $${params.length} OR e.notes ILIKE $${params.length})`;
    }

    params.push(limitNum, offset);

    const result = await pool.query(
      `SELECT
         e.id,
         e.category,
         e.title,
         e.amount,
         e.payment_method,
         TO_CHAR(e.expense_date, 'YYYY-MM-DD') AS expense_date,
e.vendor_name,
e.lab_order_id,
EXISTS (
  SELECT 1
  FROM commission_payouts cp
  WHERE cp.expense_id = e.id
    AND cp.clinic_id = e.clinic_id
) AS is_payout,
e.notes,
         e.created_at,
         u.name AS created_by_name,
         COUNT(*) OVER() AS full_count
       FROM expenses e
       LEFT JOIN users u ON e.created_by = u.id AND u.clinic_id = e.clinic_id
       ${whereSql}
       ORDER BY e.expense_date DESC, e.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length};`,
      params,
    );

    const total =
      result.rows.length > 0 ? Number(result.rows[0].full_count) : 0;
    const expenses = result.rows.map(({ full_count, ...row }) => row);

    res.status(200).json({
      expenses,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching expenses:", error.message);
    res.status(500).json({ error: "فشل جلب سجل المصروفات" });
  }
};

const createExpense = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const {
    category,
    title,
    amount,
    payment_method,
    expense_date,
    vendor_name,
    notes,
  } = req.body;

  if (!category || typeof category !== "string" || !category.trim()) {
    return res.status(400).json({ error: "تصنيف المصروف مطلوب" });
  }
  if (!title || typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "بيان / عنوان المصروف مطلوب" });
  }

  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount < 0.01) {
    return res
      .status(400)
      .json({ error: "قيمة المصروف يجب أن تكون رقماً أكبر من الصفر" });
  }

  const cleanMethod = normalizePaymentMethod(payment_method);
  if (!VALID_EXPENSE_METHODS.includes(cleanMethod)) {
    return res.status(400).json({ error: "طريقة الدفع غير صالحة" });
  }

  if (expense_date && !isValidDate(expense_date)) {
    return res
      .status(400)
      .json({ error: "تاريخ المصروف غير صالح (YYYY-MM-DD)" });
  }

  const cleanAmount = Math.round(parsedAmount * 100) / 100;

  try {
    const result = await pool.query(
      `INSERT INTO expenses (
         clinic_id, category, title, amount, payment_method,
         expense_date, vendor_name, notes, created_by
       )
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, $8, $9)
       RETURNING *, TO_CHAR(expense_date, 'YYYY-MM-DD') AS expense_date;`,
      [
        clinicId,
        category.trim(),
        title.trim(),
        cleanAmount,
        cleanMethod,
        expense_date || null,
        vendor_name?.trim() || null,
        notes?.trim() || null,
        req.user.clinic_id ? req.user.id : null,
      ],
    );

    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: "CREATE_EXPENSE",
        entity_type: "expense",
        entity_id: result.rows[0].id,
        description: `قام ${req.user.name || "المدير"} بتسجيل مصروف (${title.trim()}) بقيمة ${cleanAmount} ج.م`,
        metadata: {
          category: category.trim(),
          amount: cleanAmount,
          payment_method: cleanMethod,
        },
      });
    } catch (auditErr) {
      console.error("Audit log failed:", auditErr.message);
    }

    res.status(201).json({
      message: "تم تسجيل المصروف بنجاح",
      expense: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error creating expense:", error.message);
    res.status(500).json({ error: "فشل تسجيل المصروف" });
  }
};

const deleteExpense = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { id } = req.params;

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: "معرّف المصروف غير صالح" });
  }

  try {
    const checkRes = await pool.query(
      `SELECT id, title, amount, lab_order_id,
              (SELECT COUNT(*)::int FROM commission_payouts cp WHERE cp.expense_id = expenses.id AND cp.clinic_id = expenses.clinic_id) AS payout_links
       FROM expenses
       WHERE id = $1 AND clinic_id = $2`,
      [id, clinicId],
    );

    if (checkRes.rows.length === 0) {
      return res.status(404).json({ error: "المصروف غير موجود" });
    }

    const exp = checkRes.rows[0];
    if (exp.lab_order_id) {
      return res.status(400).json({
        error:
          "لا يمكن حذف دفعة مرتبطة بطلب معمل مباشرة من هنا حفاظاً على دقة حساب المعمل",
      });
    }
    if (exp.payout_links > 0) {
      return res.status(400).json({
        error: "لا يمكن حذف مصروف مرتبط بتسوية عمولة طبيب مسجلة",
      });
    }

    await pool.query("DELETE FROM expenses WHERE id = $1 AND clinic_id = $2", [
      id,
      clinicId,
    ]);

    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: "DELETE_EXPENSE",
        entity_type: "expense",
        entity_id: id,
        description: `قام ${req.user.name || "المدير"} بحذف مصروف (${exp.title}) بقيمة ${exp.amount} ج.م`,
      });
    } catch (auditErr) {
      console.error("Audit log failed:", auditErr.message);
    }

    res.status(200).json({ message: "تم حذف المصروف بنجاح" });
  } catch (error) {
    captureError(error, req);
    console.error("Error deleting expense:", error.message);
    res.status(500).json({ error: "فشل حذف المصروف" });
  }
};

// ==========================================
// 3. إعدادات نسب ورواتب الأطباء (Staff Compensation) وصرف المستحقات
// ==========================================
const upsertDoctorCompensation = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { doctorId } = req.params;
  const { base_salary, commission_type, commission_rate, notes } = req.body;

  if (!isValidUuid(doctorId)) {
    return res.status(400).json({ error: "معرّف الطبيب غير صالح" });
  }

  const parsedSalary = Number(base_salary ?? 0);
  if (!Number.isFinite(parsedSalary) || parsedSalary < 0) {
    return res
      .status(400)
      .json({ error: "الراتب الأساسي يجب أن يكون رقماً غير سالب" });
  }

  const parsedRate = Number(commission_rate ?? 0);
  if (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100) {
    return res
      .status(400)
      .json({ error: "نسبة العمولة يجب أن تكون بين 0 و 100%" });
  }

  const cleanCommType = String(commission_type || "collected").trim();
  if (!["collected", "invoiced", "after_lab_cost"].includes(cleanCommType)) {
    return res.status(400).json({ error: "نوع حساب العمولة غير صالح" });
  }

  try {
    const docCheck = await pool.query(
      "SELECT id, name FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor'",
      [doctorId, clinicId],
    );
    if (docCheck.rows.length === 0) {
      return res.status(404).json({ error: "الطبيب غير موجود في هذه العيادة" });
    }

    const result = await pool.query(
      `INSERT INTO staff_compensation (
         user_id, clinic_id, base_salary, commission_type, commission_rate, notes, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id)
       DO UPDATE SET
         base_salary = EXCLUDED.base_salary,
         commission_type = EXCLUDED.commission_type,
         commission_rate = EXCLUDED.commission_rate,
         notes = EXCLUDED.notes,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *;`,
      [
        doctorId,
        clinicId,
        Math.round(parsedSalary * 100) / 100,
        cleanCommType,
        Number(parsedRate.toFixed(2)),
        notes?.trim() || null,
      ],
    );

    res.status(200).json({
      message: `تم حفظ إعدادات راتب ونسبة د. ${docCheck.rows[0].name} بنجاح`,
      compensation: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error upserting doctor compensation:", error.message);
    res.status(500).json({ error: "فشل حفظ إعدادات عمولة الطبيب" });
  }
};

const getCommissionPayouts = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { doctor_id } = req.query;

  if (doctor_id && !isValidUuid(doctor_id)) {
    return res.status(400).json({ error: "معرّف الطبيب غير صالح" });
  }

  try {
    const params = [clinicId];
    let whereSql = `WHERE cp.clinic_id = $1`;
    if (doctor_id) {
      params.push(doctor_id);
      whereSql += ` AND cp.doctor_id = $2`;
    }

    const result = await pool.query(
      `SELECT
         cp.id,
         cp.doctor_id,
         u.name AS doctor_name,
         TO_CHAR(cp.period_start, 'YYYY-MM-DD') AS period_start,
         TO_CHAR(cp.period_end, 'YYYY-MM-DD') AS period_end,
         cp.gross_basis_amount,
         cp.lab_deduction_amount,
         cp.commission_rate,
         cp.commission_amount,
         cp.base_salary_amount,
         cp.total_payout,
         cp.payment_method,
         cp.expense_id,
         cp.notes,
         cp.paid_at,
         admin_u.name AS paid_by_name
       FROM commission_payouts cp
       JOIN users u ON cp.doctor_id = u.id AND u.clinic_id = cp.clinic_id
       LEFT JOIN users admin_u ON cp.paid_by = admin_u.id AND admin_u.clinic_id = cp.clinic_id
       ${whereSql}
       ORDER BY cp.paid_at DESC
       LIMIT 100;`,
      params,
    );

    res.status(200).json({ payouts: result.rows });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching commission payouts:", error.message);
    res.status(500).json({ error: "فشل جلب سجل صرف مستحقات الأطباء" });
  }
};

const recordCommissionPayout = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const {
    doctor_id,
    period_start,
    period_end,
    gross_basis_amount = 0,
    lab_deduction_amount = 0,
    commission_rate = 0,
    commission_amount = 0,
    base_salary_amount = 0,
    total_payout,
    payment_method,
    notes,
  } = req.body;

  if (!doctor_id || !isValidUuid(doctor_id)) {
    return res.status(400).json({ error: "معرّف الطبيب غير صالح" });
  }

  if (!isValidDate(period_start) || !isValidDate(period_end)) {
    return res
      .status(400)
      .json({ error: "تاريخ بداية أو نهاية الفترة غير صالح (YYYY-MM-DD)" });
  }

  if (period_start > period_end) {
    return res.status(400).json({
      error: "تاريخ نهاية الفترة يجب أن يكون بعد أو يساوي تاريخ البداية",
    });
  }

  const parsedTotal = Number(total_payout);

  if (!Number.isFinite(parsedTotal) || parsedTotal < 0.01) {
    return res
      .status(400)
      .json({ error: "إجمالي المبلغ المصروف يجب أن يكون أكبر من الصفر" });
  }

  const requestedCommissionCents = Math.round(
    Number(commission_amount ?? 0) * 100,
  );

  const requestedSalaryCents = Math.round(
    Number(base_salary_amount ?? 0) * 100,
  );

  if (
    !Number.isFinite(requestedCommissionCents) ||
    !Number.isFinite(requestedSalaryCents) ||
    requestedCommissionCents < 0 ||
    requestedSalaryCents < 0 ||
    Math.round(parsedTotal * 100) !==
      requestedCommissionCents + requestedSalaryCents
  ) {
    return res.status(400).json({
      error:
        "إجمالي المستحقات يجب أن يساوي الراتب الأساسي بالإضافة إلى العمولة",
    });
  }

  const cleanMethod = normalizePaymentMethod(payment_method);
  if (!VALID_EXPENSE_METHODS.includes(cleanMethod)) {
    return res.status(400).json({ error: "طريقة الدفع غير صالحة" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const docRes = await client.query(
      `SELECT
     u.id,
     u.name,
     COALESCE(sc.base_salary, 0) AS base_salary,
     COALESCE(sc.commission_type, 'collected') AS commission_type,
     COALESCE(sc.commission_rate, 0) AS commission_rate
   FROM users u
   LEFT JOIN staff_compensation sc
     ON sc.user_id = u.id
    AND sc.clinic_id = u.clinic_id
   WHERE u.id = $1
     AND u.clinic_id = $2
     AND u.role = 'Doctor'
   FOR UPDATE OF u`,
      [doctor_id, clinicId],
    );
    if (docRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الطبيب غير موجود" });
    }

    const doctorName = docRes.rows[0].name;
    const doctor = docRes.rows[0];

    const commissionRate = Number(doctor.commission_rate || 0);
    const baseSalaryCents = Math.round(Number(doctor.base_salary || 0) * 100);

    // الراتب الثابت يُعامل كاستحقاق شهري، لذلك لا نسمح
    // بتسجيل راتب عن فترة تمتد بين شهرين مختلفين.
    if (
      requestedSalaryCents > 0 &&
      period_start.slice(0, 7) !== period_end.slice(0, 7)
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error:
          "صرف الراتب الثابت يجب أن يكون ضمن شهر واحد. اختر فترة داخل الشهر المطلوب.",
      });
    }

    // منع إعادة حساب العمولة عن نفس الأيام باستخدام فترة
    // مختلفة ومتداخلة. يسمح باستكمال صرف جزئي لنفس الفترة بالضبط.
    if (requestedCommissionCents > 0) {
      const overlapRes = await client.query(
        `SELECT 1
     FROM commission_payouts
     WHERE clinic_id = $1
       AND doctor_id = $2
       AND commission_amount > 0
       AND period_start <= $4::date
       AND period_end >= $3::date
       AND NOT (
         period_start = $3::date
         AND period_end = $4::date
       )
     LIMIT 1`,
        [clinicId, doctor_id, period_start, period_end],
      );

      if (overlapRes.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:
            "تم تسجيل عمولة لفترة تتداخل مع الفترة المحددة. استخدم نفس بداية ونهاية الفترة السابقة لاستكمال الصرف، أو اختر فترة غير متداخلة.",
        });
      }
    }

    // حساب الفواتير والتحصيل وتكلفة المعمل من قاعدة البيانات.
    // لا نثق في القيم المحسوبة التي ترسلها الواجهة.
    const basisRes = await client.query(
      `WITH doctor_invoiced AS (
     SELECT COALESCE(SUM(inv.total_amount), 0) AS total
     FROM invoices inv
     LEFT JOIN appointments a
       ON inv.appointment_id = a.id
      AND a.clinic_id = $1
     WHERE inv.clinic_id = $1
       AND inv.status <> 'cancelled'
       AND (inv.created_at AT TIME ZONE 'Africa/Cairo')::date
           BETWEEN $3::date AND $4::date
       AND COALESCE(inv.doctor_id, a.doctor_id) = $2
   ),
   doctor_collected AS (
     SELECT COALESCE(SUM(pay.amount), 0) AS total
     FROM payments pay
     JOIN invoices inv
       ON pay.invoice_id = inv.id
      AND inv.clinic_id = $1
     LEFT JOIN appointments a
       ON inv.appointment_id = a.id
      AND a.clinic_id = $1
     WHERE pay.clinic_id = $1
       AND pay.status = 'paid'
       AND inv.status <> 'cancelled'
       AND (pay.paid_at AT TIME ZONE 'Africa/Cairo')::date
           BETWEEN $3::date AND $4::date
       AND COALESCE(inv.doctor_id, a.doctor_id) = $2
   ),
   doctor_labs AS (
     SELECT COALESCE(SUM(lo.cost), 0) AS total
     FROM lab_orders lo
     WHERE lo.clinic_id = $1
       AND lo.status <> 'cancelled'
       AND (lo.sent_at AT TIME ZONE 'Africa/Cairo')::date
           BETWEEN $3::date AND $4::date
       AND lo.doctor_id = $2
   )
   SELECT
     (SELECT total FROM doctor_invoiced) AS total_revenue_generated,
     (SELECT total FROM doctor_collected) AS total_collected_generated,
     (SELECT total FROM doctor_labs) AS total_lab_cost`,
      [clinicId, doctor_id, period_start, period_end],
    );

    const basisRow = basisRes.rows[0];

    const revenueCents = Math.round(
      Number(basisRow.total_revenue_generated || 0) * 100,
    );

    const collectedCents = Math.round(
      Number(basisRow.total_collected_generated || 0) * 100,
    );

    const labCents = Math.round(Number(basisRow.total_lab_cost || 0) * 100);

    let commissionBasisCents = collectedCents;

    if (doctor.commission_type === "invoiced") {
      commissionBasisCents = revenueCents;
    } else if (doctor.commission_type === "after_lab_cost") {
      commissionBasisCents = Math.max(0, collectedCents - labCents);
    }

    // قراءة إجمالي العمولة المصروفة وأساس أول دفعة عن نفس الفترة.
    const previousCommissionRes = await client.query(
      `SELECT
         COALESCE(SUM(cp.commission_amount), 0) AS paid,
         (
           SELECT cp0.commission_rate
           FROM commission_payouts cp0
           WHERE cp0.clinic_id = $1
             AND cp0.doctor_id = $2
             AND cp0.period_start = $3::date
             AND cp0.period_end = $4::date
             AND cp0.commission_amount > 0
           ORDER BY cp0.paid_at ASC, cp0.id ASC
           LIMIT 1
         ) AS locked_rate,
         (
           SELECT cp0.gross_basis_amount
           FROM commission_payouts cp0
           WHERE cp0.clinic_id = $1
             AND cp0.doctor_id = $2
             AND cp0.period_start = $3::date
             AND cp0.period_end = $4::date
             AND cp0.commission_amount > 0
           ORDER BY cp0.paid_at ASC, cp0.id ASC
           LIMIT 1
         ) AS locked_basis,
         (
           SELECT cp0.lab_deduction_amount
           FROM commission_payouts cp0
           WHERE cp0.clinic_id = $1
             AND cp0.doctor_id = $2
             AND cp0.period_start = $3::date
             AND cp0.period_end = $4::date
             AND cp0.commission_amount > 0
           ORDER BY cp0.paid_at ASC, cp0.id ASC
           LIMIT 1
         ) AS locked_lab_deduction
       FROM commission_payouts cp
       WHERE cp.clinic_id = $1
         AND cp.doctor_id = $2
         AND cp.period_start = $3::date
         AND cp.period_end = $4::date`,
      [clinicId, doctor_id, period_start, period_end],
    );

    const previousCommission = previousCommissionRes.rows[0];

    const previousCommissionCents = Math.round(
      Number(previousCommission.paid || 0) * 100,
    );

    const hasPreviousCommission = previousCommissionCents > 0;

    // أول دفعة عمولة تحدد النسبة وأساس الحساب لبقية الدفعات
    // الجزئية عن الفترة نفسها.
    const effectiveCommissionRate = hasPreviousCommission
      ? Number(previousCommission.locked_rate)
      : commissionRate;

    const effectiveCommissionBasisCents = hasPreviousCommission
      ? Math.round(Number(previousCommission.locked_basis) * 100)
      : commissionBasisCents;

    const effectiveLabDeductionCents =
      hasPreviousCommission && previousCommission.locked_lab_deduction !== null
        ? Math.round(Number(previousCommission.locked_lab_deduction) * 100)
        : labCents;

    const calculatedCommissionCents = Math.round(
      (effectiveCommissionBasisCents * effectiveCommissionRate) / 100,
    );

    const remainingCommissionCents = Math.max(
      0,
      calculatedCommissionCents - previousCommissionCents,
    );

    if (requestedCommissionCents > remainingCommissionCents) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `العمولة المطلوبة تتجاوز المتبقي المستحق لهذه الفترة. المتبقي: ${(remainingCommissionCents / 100).toLocaleString("en-US")} ج.م`,
      });
    }

    // الراتب يُحسب على مستوى شهر period_start، وليس على مستوى
    // تاريخ الدفع الفعلي paid_at ولا عدد الأيام في الفلتر.
    const previousSalaryRes = await client.query(
      `SELECT COALESCE(SUM(base_salary_amount), 0) AS paid
   FROM commission_payouts
   WHERE clinic_id = $1
     AND doctor_id = $2
     AND period_start >= date_trunc('month', $3::date)::date
     AND period_start <
         (date_trunc('month', $3::date) + INTERVAL '1 month')::date`,
      [clinicId, doctor_id, period_start],
    );

    const previousSalaryCents = Math.round(
      Number(previousSalaryRes.rows[0].paid || 0) * 100,
    );

    const remainingSalaryCents = Math.max(
      0,
      baseSalaryCents - previousSalaryCents,
    );

    if (requestedSalaryCents > remainingSalaryCents) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `الراتب المطلوب يتجاوز المتبقي من الراتب الثابت للشهر. المتبقي: ${(remainingSalaryCents / 100).toLocaleString("en-US")} ج.م`,
      });
    }
    const cleanTotalPayout =
      (requestedCommissionCents + requestedSalaryCents) / 100;

    // 1. تسجيل عملية الصرف تلقائياً في مصروفات العيادة
    const expenseRes = await client.query(
      `INSERT INTO expenses (
         clinic_id, category, title, amount, payment_method,
         vendor_name, notes, created_by
       )
       VALUES ($1, 'رواتب وعمولات الأطباء', $2, $3, $4, $5, $6, $7)
       RETURNING *;`,
      [
        clinicId,
        `صرف مستحقات ونسبة د. ${doctorName} (${period_start} إلى ${period_end})`,
        cleanTotalPayout,
        cleanMethod,
        `د. ${doctorName}`,
        notes?.trim() || null,
        req.user.clinic_id ? req.user.id : null,
      ],
    );

    const createdExpense = expenseRes.rows[0];

    // 2. تسجيل التسوية في جدول commission_payouts
    const payoutRes = await client.query(
      `INSERT INTO commission_payouts (
         clinic_id, doctor_id, period_start, period_end,
         gross_basis_amount, lab_deduction_amount, commission_rate,
         commission_amount, base_salary_amount, total_payout,
         payment_method, expense_id, notes, paid_by
       )
       VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *;`,
      [
        clinicId,
        doctor_id,
        period_start,
        period_end,
        effectiveCommissionBasisCents / 100,
        effectiveLabDeductionCents / 100,
        effectiveCommissionRate,
        requestedCommissionCents / 100,
        requestedSalaryCents / 100,
        cleanTotalPayout,
        cleanMethod,
        createdExpense.id,
        notes?.trim() || null,
        req.user.clinic_id ? req.user.id : null,
      ],
    );

    await client.query("COMMIT");

    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: "RECORD_COMMISSION_PAYOUT",
        entity_type: "commission_payout",
        entity_id: payoutRes.rows[0].id,
        description: `قام ${req.user.name || "المدير"} بصرف مستحقات د. ${doctorName} بقيمة ${cleanTotalPayout} ج.م`,
        metadata: {
          doctor_id,
          total_payout: cleanTotalPayout,
          period_start,
          period_end,
        },
      });
    } catch (auditErr) {
      console.error("Audit log failed:", auditErr.message);
    }

    res.status(201).json({
      message: `تم تسجيل صرف مستحقات د. ${doctorName} وقيدها في المصروفات بنجاح`,
      payout: payoutRes.rows[0],
      expense: createdExpense,
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    captureError(error, req);
    console.error("Error recording commission payout:", error.message);
    res.status(500).json({ error: "فشل تسجيل صرف مستحقات الطبيب" });
  } finally {
    if (client) client.release();
  }
};

module.exports = {
  getReportsSummary,
  getExpenses,
  createExpense,
  deleteExpense,
  upsertDoctorCompensation,
  getCommissionPayouts,
  recordCommissionPayout,
};
