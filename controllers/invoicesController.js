const pool = require("../db");
const { logActivity } = require("../utils/auditLogger");
const { isValidUuid } = require("../middleware/validateUuid");
const { captureError } = require("../utils/errorTracker");

const VALID_PAYMENT_METHODS = [
  "cash",
  "card",
  "bank_transfer",
  "vodafone_cash",
  "instapay",
  "cheque",
  "other",
];

// أرقام الأسنان الدائمة المسموحة في chk_invoice_items_tooth_number
const VALID_PERMANENT_TEETH = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33,
  34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48,
]);

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

const isValidDateStr = (val) => {
  if (typeof val !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const d = new Date(`${val}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === val;
};

// توليد تواريخ شهرية متتالية للأقساط
const addMonthsToDateStr = (dateStr, monthsToAdd) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const targetMonthIndex = m - 1 + monthsToAdd;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const maxDayInMonth = new Date(
    Date.UTC(targetYear, normalizedMonth + 1, 0),
  ).getUTCDate();
  const safeDay = Math.min(d, maxDayInMonth);
  return `${targetYear}-${String(normalizedMonth + 1).padStart(2, "0")}-${String(safeDay).padStart(2, "0")}`;
};

// ==========================================
// 1. إنشاء فاتورة جديدة (مع الخصومات وجدولة الأقساط)
// ==========================================
const createInvoice = async (req, res) => {
  const {
    patient_id,
    appointment_id,
    items,
    discount_type,
    discount_value,
    notes,
    initial_payment,
    installments_plan,
    doctor_id,
    appointment_date,
  } = req.body;
  const clinic_id = req.user.clinic_id;

  let finalAppointmentId = appointment_id || null;
  let finalInvoiceDoctorId = null;

  if (!patient_id || !isValidUuid(patient_id)) {
    return res.status(400).json({ error: "معرّف المريض غير صالح" });
  }
  if (appointment_id && !isValidUuid(appointment_id)) {
    return res.status(400).json({ error: "معرّف الموعد غير صالح" });
  }
  if (doctor_id && !isValidUuid(doctor_id)) {
    return res.status(400).json({ error: "معرّف الطبيب غير صالح" });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "بنود الفاتورة مطلوبة" });
  }

  for (const item of items) {
    if (
      !item.description ||
      typeof item.description !== "string" ||
      item.description.trim() === ""
    ) {
      return res.status(400).json({ error: "وصف البند مطلوب لكل البنود" });
    }
    if (item.procedure_code_id && !isValidUuid(item.procedure_code_id)) {
      return res
        .status(400)
        .json({ error: "معرّف الإجراء الطبي المرفق بالبند غير صالح" });
    }
    if (
      item.tooth_number !== undefined &&
      item.tooth_number !== null &&
      item.tooth_number !== ""
    ) {
      const parsedTooth = Number(item.tooth_number);
      if (
        !Number.isInteger(parsedTooth) ||
        !VALID_PERMANENT_TEETH.has(parsedTooth)
      ) {
        return res.status(400).json({
          error: `رقم السن (${item.tooth_number}) غير صالح طبقاً لنظام FDI`,
        });
      }
    }
    const qty = Number(item.quantity);

    if (!Number.isInteger(qty) || qty <= 0 || qty > 1000) {
      return res.status(400).json({
        error: "الكمية يجب أن تكون رقماً صحيحاً بين 1 و1000",
      });
    }

    const price = Number(item.unit_price);

    if (
      item.unit_price === "" ||
      (typeof item.unit_price === "string" && item.unit_price.trim() === "") ||
      item.unit_price === null ||
      item.unit_price === undefined ||
      !Number.isFinite(price) ||
      price < 0
    ) {
      return res.status(400).json({
        error: "سعر الوحدة يجب أن يكون رقماً صالحاً وغير سالب",
      });
    }
  }

  // 1) حساب المجموع الفرعي بالقروش (Subtotal in Cents)
  const subtotalCents = items.reduce((total, item) => {
    const qty = Number(item.quantity);
    const unitPriceCents = Math.round(Number(item.unit_price) * 100);

    return total + qty * unitPriceCents;
  }, 0);

  // 2) حساب الخصم والتحقق من صحته
  let cleanDiscountType = null;
  let cleanDiscountValue = 0;
  let discountAmountCents = 0;

  const hasDiscountType =
    discount_type !== undefined &&
    discount_type !== null &&
    String(discount_type).trim() !== "";

  const hasDiscountValue =
    discount_value !== undefined &&
    discount_value !== null &&
    discount_value !== "";

  if (hasDiscountType || hasDiscountValue) {
    const type = String(discount_type || "").trim();
    const value = Number(discount_value);

    if (
      !hasDiscountType ||
      !hasDiscountValue ||
      !["fixed", "percentage"].includes(type) ||
      !Number.isFinite(value) ||
      value < 0
    ) {
      return res.status(400).json({
        error: "نوع الخصم أو قيمته غير صالح",
      });
    }

    if (type === "percentage" && value > 100) {
      return res.status(400).json({
        error: "نسبة الخصم لا يمكن أن تتجاوز 100%",
      });
    }

    if (value > 0 && subtotalCents > 0) {
      cleanDiscountType = type;
      cleanDiscountValue = Number(value.toFixed(2));

      if (type === "percentage") {
        discountAmountCents = Math.round(
          (subtotalCents * cleanDiscountValue) / 100,
        );
      } else {
        discountAmountCents = Math.round(cleanDiscountValue * 100);

        if (discountAmountCents > subtotalCents) {
          return res.status(400).json({
            error: "قيمة الخصم لا يمكن أن تتجاوز إجمالي بنود الفاتورة",
          });
        }
      }
    }
  }

  // لو الخصم الفعلي يساوي صفرًا، خزّن النوع والقيمة بصفر/NULL
  // لتوافق قيد chk_invoices_discount_amounts.
  if (discountAmountCents <= 0) {
    cleanDiscountType = null;
    cleanDiscountValue = 0;
    discountAmountCents = 0;
  }

  const totalAmountInCents = Math.max(0, subtotalCents - discountAmountCents);
  const subtotalAmount = subtotalCents / 100;
  const discountAmount = discountAmountCents / 100;
  const totalAmount = totalAmountInCents / 100;

  // 3) التحقق من الدفعة الفورية إن وُجدت
  let paidNowCents = 0;
  if (
    initial_payment &&
    initial_payment.amount !== undefined &&
    initial_payment.amount !== null &&
    initial_payment.amount !== ""
  ) {
    const rawPaid = parseFloat(initial_payment.amount);
    if (isNaN(rawPaid) || rawPaid < 0) {
      return res.status(400).json({
        error: "المبلغ المدفوع يجب أن يكون رقماً صالحاً وغير سالب",
      });
    }
    if (rawPaid > 0 && rawPaid < 0.01) {
      return res.status(400).json({
        error: "أقل مبلغ دفع مسموح به هو 0.01 ج.م (قرش واحد)",
      });
    }
    paidNowCents = Math.round(rawPaid * 100);
  }

  const paidNow = paidNowCents / 100;

  if (paidNowCents > totalAmountInCents) {
    return res.status(400).json({
      error: "المبلغ المدفوع أكبر من صافي الفاتورة بعد الخصم",
    });
  }

  let initialStatus = "unpaid";
  if (
    totalAmountInCents === 0 ||
    (paidNowCents >= totalAmountInCents && totalAmountInCents > 0)
  ) {
    initialStatus = "paid";
  } else if (paidNowCents > 0) {
    initialStatus = "partially_paid";
  }

  const paymentMethod = normalizePaymentMethod(initial_payment?.payment_method);

  if (paidNowCents > 0 && !VALID_PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({ error: "طريقة الدفع غير صالحة" });
  }

  // 4) التحقق من خطة الأقساط إن تم تمريرها
  const remainingCents = totalAmountInCents - paidNowCents;
  const preparedInstallments = [];

  if (installments_plan && remainingCents > 0) {
    if (
      Array.isArray(installments_plan.items) &&
      installments_plan.items.length > 0
    ) {
      let sumInstCents = 0;
      for (let i = 0; i < installments_plan.items.length; i++) {
        const inst = installments_plan.items[i];
        const instCents = Math.round(parseFloat(inst.amount) * 100);
        if (isNaN(instCents) || instCents <= 0) {
          return res
            .status(400)
            .json({ error: `مبلغ القسط رقم ${i + 1} غير صالح` });
        }
        if (!isValidDateStr(inst.due_date)) {
          return res.status(400).json({
            error: `تاريخ استحقاق القسط رقم ${i + 1} غير صالح (YYYY-MM-DD)`,
          });
        }
        sumInstCents += instCents;
        preparedInstallments.push({
          installment_number: i + 1,
          title:
            typeof inst.title === "string" && inst.title.trim()
              ? inst.title.trim()
              : `القسط رقم ${i + 1}`,
          amount: instCents / 100,
          due_date: inst.due_date,
          notes: inst.notes || null,
        });
      }
      if (sumInstCents !== remainingCents) {
        return res.status(400).json({
          error: `مجموع الأقساط (${sumInstCents / 100} ج.م) يجب أن يساوي المبلغ المتبقي على الفاتورة (${remainingCents / 100} ج.م)`,
        });
      }
    } else if (installments_plan.count) {
      const count = parseInt(installments_plan.count, 10);
      if (isNaN(count) || count < 1 || count > 36) {
        return res
          .status(400)
          .json({ error: "عدد الأقساط يجب أن يكون بين 1 و 36 قسطاً" });
      }
      if (remainingCents < count) {
        return res.status(400).json({
          error: "المبلغ المتبقي أقل من أن يقسم على هذا العدد من الأقساط",
        });
      }

      const firstDueDate =
        installments_plan.first_due_date &&
        isValidDateStr(installments_plan.first_due_date)
          ? installments_plan.first_due_date
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
              .toISOString()
              .slice(0, 10);

      const baseInstCents = Math.floor(remainingCents / count);
      const remainderCents = remainingCents - baseInstCents * count;

      for (let i = 0; i < count; i++) {
        const instCents =
          i === count - 1 ? baseInstCents + remainderCents : baseInstCents;
        preparedInstallments.push({
          installment_number: i + 1,
          title: `القسط ${i + 1} من ${count}`,
          amount: instCents / 100,
          due_date: addMonthsToDateStr(firstDueDate, i),
          notes: installments_plan.notes || null,
        });
      }
    }
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // 🔒 1. فحص عزل المريض
    const patientCheck = await client.query(
      `SELECT id FROM patients WHERE id = $1 AND clinic_id = $2`,
      [patient_id, clinic_id],
    );

    if (patientCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المريض غير موجود في هذه العيادة" });
    }

    // 2. التحقق من الموعد إذا تم تمريره
    if (finalAppointmentId) {
      const apptCheck = await client.query(
        `SELECT id, doctor_id
         FROM appointments
         WHERE id = $1
           AND clinic_id = $2
           AND patient_id = $3
         FOR UPDATE`,
        [finalAppointmentId, clinic_id, patient_id],
      );

      if (apptCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "الموعد المحدد لا يخص هذا المريض أو العيادة",
        });
      }
      const appointmentDoctorId = apptCheck.rows[0].doctor_id;

      if (
        doctor_id &&
        String(doctor_id).toLowerCase() !==
          String(appointmentDoctorId || "").toLowerCase()
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "الطبيب المحدد لا يطابق الطبيب المسجل في الموعد",
        });
      }

      finalInvoiceDoctorId = appointmentDoctorId || null;

      const existingInvoiceCheck = await client.query(
        `SELECT id
         FROM invoices
         WHERE clinic_id = $1
           AND appointment_id = $2
           AND is_archived = FALSE
           AND status <> 'cancelled'
         LIMIT 1`,
        [clinic_id, finalAppointmentId],
      );

      if (existingInvoiceCheck.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "هذا الموعد لديه فاتورة نشطة بالفعل",
        });
      }
    }

    // 3. إنشاء موعد تلقائي إذا حُدد دكتور بدون موعد سابق
    if (!finalAppointmentId && doctor_id) {
      const doctorCheck = await client.query(
        "SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor' AND is_active = TRUE FOR UPDATE",
        [doctor_id, clinic_id],
      );
      if (doctorCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "المستخدم المحدد غير مسجل كطبيب مصرح له أو حسابه معطل",
        });
      }

      let appDate;
      if (appointment_date) {
        appDate = new Date(appointment_date);
        if (isNaN(appDate.getTime())) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "تاريخ ووقت الموعد غير صالح" });
        }
      } else {
        appDate = new Date();
      }

      const clinicRes = await client.query(
        "SELECT default_appointment_duration FROM clinics WHERE id = $1",
        [clinic_id],
      );
      const apptDuration =
        Number(clinicRes.rows[0]?.default_appointment_duration) || 30;

      const isFuture = appDate > new Date();
      const appStatus = isFuture ? "scheduled" : "completed";

      if (isFuture) {
        const conflictCheck = await client.query(
          `SELECT id FROM appointments
           WHERE clinic_id = $1 
             AND doctor_id = $2 
             AND status NOT IN ('cancelled', 'no_show')
             AND appointment_date < ($3::timestamptz + ($4 * INTERVAL '1 minute'))
             AND (appointment_date + (duration_minutes * INTERVAL '1 minute')) > $3::timestamptz
           LIMIT 1`,
          [clinic_id, doctor_id, appDate.toISOString(), apptDuration],
        );

        if (conflictCheck.rows.length > 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "يوجد تعارض: الطبيب لديه كشف آخر محجوز في نفس هذا التوقيت",
          });
        }
      }

      finalInvoiceDoctorId = doctor_id;

      const autoAppt = await client.query(
        `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_date, duration_minutes, status, notes)
         VALUES ($1, $2, $3, $4, $5, $6, 'كشف مربوط بالفاتورة')
         RETURNING id;`,
        [
          clinic_id,
          patient_id,
          doctor_id,
          appDate.toISOString(),
          apptDuration,
          appStatus,
        ],
      );
      finalAppointmentId = autoAppt.rows[0].id;
    }

    // 4. إنشاء الفاتورة مع حفظ الخصم وصافي المبلغ
    const insertInvoiceQuery = `
      INSERT INTO invoices (
        clinic_id, patient_id, appointment_id, doctor_id,
        subtotal_amount, discount_type, discount_value, discount_amount,
        total_amount, status, notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *;
    `;
    const invoiceResult = await client.query(insertInvoiceQuery, [
      clinic_id,
      patient_id,
      finalAppointmentId,
      finalInvoiceDoctorId,
      subtotalAmount,
      cleanDiscountType,
      cleanDiscountValue,
      discountAmount,
      totalAmount,
      initialStatus,
      typeof notes === "string" && notes.trim() ? notes.trim() : null,
    ]);

    const newInvoice = invoiceResult.rows[0];
    const invoiceId = newInvoice.id;

    // 5. إدخال البنود بدقة القروش
    const insertItemQuery = `
      INSERT INTO invoice_items (clinic_id, invoice_id, procedure_code_id, tooth_number, description, quantity, unit_price, total_price)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
    `;

    for (const item of items) {
      const qty = Number(item.quantity);
      const unitPriceCents = Math.round(Number(item.unit_price) * 100);
      const unitPrice = unitPriceCents / 100;
      const itemTotal = (qty * unitPriceCents) / 100;
      const toothNumber =
        item.tooth_number !== undefined &&
        item.tooth_number !== null &&
        item.tooth_number !== ""
          ? Number(item.tooth_number)
          : null;

      await client.query(insertItemQuery, [
        clinic_id,
        invoiceId,
        item.procedure_code_id || null,
        toothNumber,
        item.description.trim(),
        qty,
        unitPrice,
        itemTotal,
      ]);
    }

    // 6. تسجيل الدفعة الفورية إذا وُجدت
    if (paidNowCents > 0) {
      await client.query(
        `INSERT INTO payments (clinic_id, invoice_id, amount, payment_method, reference_number, notes, status, created_by, paid_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'paid', $7, CURRENT_TIMESTAMP);`,
        [
          clinic_id,
          invoiceId,
          paidNow,
          paymentMethod,
          initial_payment?.reference_number?.trim() || null,
          initial_payment?.notes || "دفعة مقدمة عند إصدار الفاتورة",
          req.user.clinic_id ? req.user.id : null,
        ],
      );
    }

    // 7. تسجيل جدول الأقساط إن وُجد (مع فحص انتماء خطة العلاج لنفس العيادة والمريض)
    let validTreatmentPlanId = null;
    if (installments_plan?.treatment_plan_id) {
      const planId = installments_plan.treatment_plan_id;

      if (!isValidUuid(planId)) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          error: "معرّف خطة العلاج غير صالح",
        });
      }

      const planCheck = await client.query(
        `SELECT id
     FROM treatment_plans
     WHERE id = $1
       AND clinic_id = $2
       AND patient_id = $3`,
        [planId, clinic_id, patient_id],
      );

      if (planCheck.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          error: "خطة العلاج غير موجودة أو لا تخص هذا المريض في هذه العيادة",
        });
      }

      validTreatmentPlanId = planCheck.rows[0].id;
    }

    const createdInstallments = [];
    for (const inst of preparedInstallments) {
      const instRes = await client.query(
        `INSERT INTO installments (
          clinic_id, patient_id, invoice_id, treatment_plan_id,
          installment_number, title, amount, due_date, notes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *;`,
        [
          clinic_id,
          patient_id,
          invoiceId,
          validTreatmentPlanId,
          inst.installment_number,
          inst.title,
          inst.amount,
          inst.due_date,
          inst.notes,
        ],
      );
      createdInstallments.push(instRes.rows[0]);
    }

    await client.query("COMMIT");

    try {
      await logActivity({
        clinic_id,
        user_id: req.user.id,
        action: "CREATE_INVOICE",
        entity_type: "invoice",
        entity_id: invoiceId,
        description: `قام ${
          req.user.name || "الموظف"
        } بإنشاء فاتورة بقيمة صافية ${totalAmount} ج.م${
          discountAmount > 0 ? ` (بعد خصم ${discountAmount} ج.م)` : ""
        } للمريض #${String(patient_id).slice(0, 8)}`,
        metadata: {
          subtotal_amount: subtotalAmount,
          discount_amount: discountAmount,
          total_amount: totalAmount,
          status: initialStatus,
          items_count: items.length,
          installments_count: createdInstallments.length,
        },
      });
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    res.status(201).json({
      message: "تم إنشاء الفاتورة بنجاح",
      invoice: {
        ...newInvoice,
        installments: createdInstallments,
      },
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback failed:", rollbackError.message);
      }
    }

    if (error.code === "23503") {
      return res.status(400).json({
        error: "بيانات غير صحيحة (مريض أو دكتور أو إجراء غير موجود)",
      });
    }
    if (error.code === "22P02") {
      return res.status(400).json({
        error: "معرّف غير صالح",
      });
    }

    console.error("Error creating invoice:", error.message);
    captureError(error, req);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء إنشاء الفاتورة",
    });
  } finally {
    if (client) client.release();
  }
};

// ==========================================
// 2. جلب الفواتير مع الـ Pagination والفلاتر
// ==========================================
const getInvoices = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { search, status, patient_id, archived, page, limit } = req.query;

  if (patient_id && !isValidUuid(patient_id)) {
    return res.status(400).json({ error: "معرّف المريض غير صالح" });
  }

  try {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const offset = (pageNum - 1) * limitNum;

    let query = `
      SELECT 
        invoices.id,
        invoices.patient_id,
        patients.name AS patient_name, 
        patients.phone_number AS patient_phone,
        invoices.subtotal_amount,
        invoices.discount_type,
        invoices.discount_value,
        invoices.discount_amount,
        invoices.total_amount, 
        invoices.status, 
        invoices.created_at,
        invoices.appointment_id,
        COALESCE(
          SUM(CASE WHEN payments.status = 'paid' THEN payments.amount ELSE 0 END),
          0
        ) AS paid_amount,
        CASE 
          WHEN invoices.status = 'cancelled' THEN 0 
          ELSE ROUND(
            GREATEST(
              0,
              invoices.total_amount - COALESCE(SUM(CASE WHEN payments.status = 'paid' THEN payments.amount ELSE 0 END), 0)
            ),
            2
          )
        END AS remaining_amount,
        (
          SELECT COUNT(*)::int
          FROM installments inst
          WHERE inst.invoice_id = invoices.id
            AND inst.clinic_id = invoices.clinic_id
            AND inst.status <> 'cancelled'
        ) AS installments_count,
        (
          SELECT COUNT(*)::int
          FROM installments inst
          WHERE inst.invoice_id = invoices.id
            AND inst.clinic_id = invoices.clinic_id
            AND inst.status IN ('pending', 'partially_paid')
            AND inst.due_date < (NOW() AT TIME ZONE 'Africa/Cairo')::date
        ) AS overdue_installments_count,
        COUNT(*) OVER() AS full_count
      FROM invoices 
      JOIN patients ON invoices.patient_id = patients.id AND patients.clinic_id = invoices.clinic_id
      LEFT JOIN payments ON invoices.id = payments.invoice_id AND invoices.clinic_id = payments.clinic_id
      WHERE invoices.clinic_id = $1
    `;

    const queryParams = [clinic_id];
    let paramCounter = 2;

    if (search && search.trim() !== "") {
      queryParams.push(`%${search.trim()}%`);
      query += ` AND (patients.name ILIKE $${paramCounter} OR patients.phone_number ILIKE $${paramCounter})`;
      paramCounter++;
    }

    if (status && status.trim() !== "") {
      queryParams.push(status.trim());
      query += ` AND invoices.status = $${paramCounter}`;
      paramCounter++;
    }

    if (patient_id) {
      queryParams.push(patient_id);
      query += ` AND invoices.patient_id = $${paramCounter}`;
      paramCounter++;
    }

    const isArchived = archived === "true";
    queryParams.push(isArchived);
    query += ` AND invoices.is_archived = $${paramCounter}`;
    paramCounter++;

    query += ` GROUP BY invoices.id, patients.name, patients.phone_number ORDER BY invoices.created_at DESC LIMIT $${paramCounter} OFFSET $${
      paramCounter + 1
    };`;
    queryParams.push(limitNum, offset);

    const invoicesResult = await pool.query(query, queryParams);

    const total =
      invoicesResult.rows.length > 0
        ? Number(invoicesResult.rows[0].full_count)
        : 0;

    const invoices = invoicesResult.rows.map(
      ({ full_count, ...invoice }) => invoice,
    );
    const totalPages = Math.ceil(total / limitNum) || 1;

    res.status(200).json({
      invoices,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
      },
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching invoices:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء جلب الفواتير" });
  }
};

// ==========================================
// 3. جلب تفاصيل فاتورة واحدة (مع البنود والدفعات والأقساط)
// ==========================================
const getInvoiceById = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const invoiceId = req.params.id;

  if (!isValidUuid(invoiceId)) {
    return res.status(400).json({ error: "معرّف الفاتورة غير صالح" });
  }

  try {
    const invoiceQuery = `
      SELECT 
        invoices.*, 
        patients.name AS patient_name, 
        patients.phone_number AS patient_phone,
        users.name AS doctor_name,
        appointments.appointment_date
      FROM invoices 
      JOIN patients ON invoices.patient_id = patients.id 
      LEFT JOIN appointments ON invoices.appointment_id = appointments.id
      LEFT JOIN users
        ON COALESCE(invoices.doctor_id, appointments.doctor_id) = users.id
       AND users.clinic_id = invoices.clinic_id
      WHERE invoices.clinic_id = $1 AND invoices.id = $2
    `;

    const invoiceResult = await pool.query(invoiceQuery, [
      clinic_id,
      invoiceId,
    ]);

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ error: "الفاتورة غير موجودة" });
    }

    const invoice = invoiceResult.rows[0];

    const [itemsResult, paymentsResult, installmentsResult] = await Promise.all(
      [
        pool.query(
          "SELECT id, procedure_code_id, tooth_number, description, quantity, unit_price, total_price FROM invoice_items WHERE clinic_id = $1 AND invoice_id = $2 ORDER BY created_at ASC",
          [clinic_id, invoiceId],
        ),
        pool.query(
          "SELECT id, amount, payment_method, reference_number, CASE WHEN status = 'pending' AND expires_at < NOW() THEN 'expired' ELSE status END AS status, notes, paid_at, created_at FROM payments WHERE clinic_id = $1 AND invoice_id = $2 ORDER BY paid_at DESC",
          [clinic_id, invoiceId],
        ),
        pool.query(
          `SELECT
             id, installment_number, title, amount, paid_amount,
             ROUND(GREATEST(0, amount - paid_amount), 2) AS remaining_amount,
             TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date,
             CASE
               WHEN status IN ('pending', 'partially_paid') AND due_date < (NOW() AT TIME ZONE 'Africa/Cairo')::date
               THEN 'overdue'
               ELSE status
             END AS status,
             payment_id, paid_at, notes
           FROM installments
           WHERE clinic_id = $1 AND invoice_id = $2 AND status <> 'cancelled'
           ORDER BY installment_number ASC, due_date ASC`,
          [clinic_id, invoiceId],
        ),
      ],
    );

    invoice.items = itemsResult.rows;
    invoice.payments = paymentsResult.rows;
    invoice.installments = installmentsResult.rows;

    const totalPaidCents = paymentsResult.rows
      .filter((p) => p.status === "paid")
      .reduce((sum, p) => sum + Math.round(parseFloat(p.amount) * 100), 0);

    const totalAmountCents = Math.round(parseFloat(invoice.total_amount) * 100);
    const remainingCents =
      invoice.status === "cancelled"
        ? 0
        : Math.max(0, totalAmountCents - totalPaidCents);

    invoice.paid_amount = totalPaidCents / 100;
    invoice.remaining_amount = remainingCents / 100;

    res.status(200).json(invoice);
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching invoice by ID:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء جلب الفاتورة" });
  }
};

// ==========================================
// 4. إنشاء أو إعادة جدولة أقساط لفاتورة قائمة
// ==========================================
const createInvoiceInstallments = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const invoiceId = req.params.id;
  const { count, first_due_date, items, notes } = req.body;

  if (!isValidUuid(invoiceId)) {
    return res.status(400).json({ error: "معرّف الفاتورة غير صالح" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const invRes = await client.query(
      "SELECT * FROM invoices WHERE id = $1 AND clinic_id = $2 FOR UPDATE",
      [invoiceId, clinic_id],
    );
    if (invRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الفاتورة غير موجودة" });
    }
    const invoice = invRes.rows[0];
    if (invoice.status === "cancelled" || invoice.status === "paid") {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "لا يمكن جدولة أقساط لفاتورة مسددة بالكامل أو ملغاة" });
    }

    const paidRes = await client.query(
      "SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE invoice_id = $1 AND clinic_id = $2 AND status = 'paid'",
      [invoiceId, clinic_id],
    );

    const totalCents = Math.round(parseFloat(invoice.total_amount) * 100);
    const paidCents = Math.round(parseFloat(paidRes.rows[0].total_paid) * 100);
    const remainingCents = Math.max(0, totalCents - paidCents);

    if (remainingCents <= 0) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "لا يوجد مبلغ متبقي لجدولته على هذه الفاتورة" });
    }

    // 1) حذف أي أقساط سابقة غير مدفوعة (paid_amount = 0) لتجنب تضارب uq_installments_invoice_number
    await client.query(
      `DELETE FROM installments
       WHERE invoice_id = $1 AND clinic_id = $2 AND paid_amount = 0`,
      [invoiceId, clinic_id],
    );

    // 2) إقفال أي قسط مدفوع جزئياً على قيمته المسددة فعلياً ليتوافق مع chk_installment_paid_status
    await client.query(
      `UPDATE installments
       SET amount = paid_amount,
           status = 'paid',
           updated_at = CURRENT_TIMESTAMP
       WHERE invoice_id = $1
         AND clinic_id = $2
         AND paid_amount > 0
         AND status <> 'paid'`,
      [invoiceId, clinic_id],
    );

    // 3) حساب آخر رقم قسط مسجل للبدء من بعده
    const maxNumRes = await client.query(
      `SELECT COALESCE(MAX(installment_number), 0)::int AS max_num
       FROM installments
       WHERE invoice_id = $1 AND clinic_id = $2`,
      [invoiceId, clinic_id],
    );
    const startNumber = (maxNumRes.rows[0]?.max_num || 0) + 1;

    const prepared = [];
    if (Array.isArray(items) && items.length > 0) {
      let sumCents = 0;
      for (let i = 0; i < items.length; i++) {
        const c = Math.round(parseFloat(items[i].amount) * 100);
        if (isNaN(c) || c <= 0 || !isValidDateStr(items[i].due_date)) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: `بيانات القسط رقم ${i + 1} غير صالحة` });
        }
        sumCents += c;
        prepared.push({
          installment_number: startNumber + i,
          title: items[i].title?.trim() || `القسط رقم ${startNumber + i}`,
          amount: c / 100,
          due_date: items[i].due_date,
          notes: items[i].notes || notes || null,
        });
      }
      if (sumCents !== remainingCents) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `مجموع الأقساط (${sumCents / 100} ج.م) يجب أن يساوي المتبقي على الفاتورة (${remainingCents / 100} ج.م)`,
        });
      }
    } else {
      const num = parseInt(count, 10);
      if (isNaN(num) || num < 1 || num > 36) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "عدد الأقساط يجب أن يكون بين 1 و 36" });
      }
      if (remainingCents < num) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "المبلغ المتبقي أقل من أن يقسم على هذا العدد من الأقساط",
        });
      }

      const startDue = isValidDateStr(first_due_date)
        ? first_due_date
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10);
      const baseCents = Math.floor(remainingCents / num);
      const remCents = remainingCents - baseCents * num;

      for (let i = 0; i < num; i++) {
        const c = i === num - 1 ? baseCents + remCents : baseCents;
        prepared.push({
          installment_number: startNumber + i,
          title: `القسط ${startNumber + i}`,
          amount: c / 100,
          due_date: addMonthsToDateStr(startDue, i),
          notes: notes || null,
        });
      }
    }

    const inserted = [];
    for (const inst of prepared) {
      const r = await client.query(
        `INSERT INTO installments (
          clinic_id, patient_id, invoice_id, installment_number, title, amount, due_date, notes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *;`,
        [
          clinic_id,
          invoice.patient_id,
          invoiceId,
          inst.installment_number,
          inst.title,
          inst.amount,
          inst.due_date,
          inst.notes,
        ],
      );
      inserted.push(r.rows[0]);
    }

    await client.query("COMMIT");

    res.status(201).json({
      message: "تم حفظ جدول الأقساط بنجاح",
      installments: inserted,
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    captureError(error, req);
    console.error("Error creating installments:", error.message);
    res.status(500).json({ error: "فشل إنشاء جدول الأقساط" });
  } finally {
    if (client) client.release();
  }
};

// ==========================================
// 5. جلب الأقساط المستحقة والمتأخرة للعيادة
// ==========================================
const getDueInstallments = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { filter = "all", patient_id } = req.query; // filter: overdue | upcoming | all

  try {
    const params = [clinic_id];
    let whereSql = `
      WHERE inst.clinic_id = $1
        AND inst.status IN ('pending', 'partially_paid')
        AND inv.status NOT IN ('cancelled', 'paid')
    `;

    if (patient_id) {
      params.push(patient_id);
      whereSql += ` AND inst.patient_id = $${params.length}`;
    }

    if (filter === "overdue") {
      whereSql += ` AND inst.due_date < (NOW() AT TIME ZONE 'Africa/Cairo')::date`;
    } else if (filter === "upcoming") {
      whereSql += ` AND inst.due_date BETWEEN (NOW() AT TIME ZONE 'Africa/Cairo')::date AND ((NOW() AT TIME ZONE 'Africa/Cairo')::date + INTERVAL '14 days')`;
    }

    if (patient_id && !isValidUuid(patient_id)) {
      return res.status(400).json({
        error: "معرّف المريض غير صالح",
      });
    }

    const result = await pool.query(
      `SELECT
         inst.id,
         inst.invoice_id,
         inst.patient_id,
         p.name AS patient_name,
         p.phone_number AS patient_phone,
         inst.installment_number,
         inst.title,
         inst.amount,
         inst.paid_amount,
         ROUND(GREATEST(0, inst.amount - inst.paid_amount), 2) AS remaining_amount,
         TO_CHAR(inst.due_date, 'YYYY-MM-DD') AS due_date,
         CASE
           WHEN inst.due_date < (NOW() AT TIME ZONE 'Africa/Cairo')::date THEN 'overdue'
           ELSE inst.status
         END AS status,
         inst.notes
       FROM installments inst
       JOIN invoices inv ON inst.invoice_id = inv.id AND inv.clinic_id = inst.clinic_id
       JOIN patients p ON inst.patient_id = p.id AND p.clinic_id = inst.clinic_id
       ${whereSql}
       ORDER BY inst.due_date ASC, inst.installment_number ASC
       LIMIT 100;`,
      params,
    );

    res.status(200).json({ installments: result.rows });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching due installments:", error.message);
    res.status(500).json({ error: "فشل جلب الأقساط المستحقة" });
  }
};

// ==========================================
// 6. كشف حساب المريض المجمع والجاهز للطباعة (Patient Statement)
// ==========================================
const getPatientFinancialStatement = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { patientId } = req.params;

  if (!isValidUuid(patientId)) {
    return res.status(400).json({ error: "معرّف المريض غير صالح" });
  }

  try {
    const [clinicRes, patientRes, invoicesRes, paymentsRes, installmentsRes] =
      await Promise.all([
        pool.query(
          "SELECT name, phone_number, address FROM clinics WHERE id = $1",
          [clinic_id],
        ),
        pool.query(
          "SELECT id, name, phone_number, age, gender, created_at FROM patients WHERE id = $1 AND clinic_id = $2",
          [patientId, clinic_id],
        ),
        pool.query(
          `SELECT
             inv.id,
             inv.subtotal_amount,
             inv.discount_type,
             inv.discount_value,
             inv.discount_amount,
             inv.total_amount,
             inv.status,
             inv.notes,
             inv.created_at,
             u.name AS doctor_name,
             COALESCE(
               (SELECT json_agg(json_build_object(
                 'description', ii.description,
                 'tooth_number', ii.tooth_number,
                 'quantity', ii.quantity,
                 'unit_price', ii.unit_price,
                 'total_price', ii.total_price
               )) FROM invoice_items ii WHERE ii.invoice_id = inv.id AND ii.clinic_id = inv.clinic_id),
               '[]'::json
             ) AS items
           FROM invoices inv
           LEFT JOIN users u ON inv.doctor_id = u.id AND u.clinic_id = inv.clinic_id
           WHERE inv.clinic_id = $1 AND inv.patient_id = $2 AND inv.status <> 'cancelled'
           ORDER BY inv.created_at DESC`,
          [clinic_id, patientId],
        ),
        pool.query(
          `SELECT
             p.id,
             p.invoice_id,
             p.amount,
             p.payment_method,
             p.reference_number,
             p.notes,
             p.paid_at,
             u.name AS received_by_name
           FROM payments p
           JOIN invoices inv ON p.invoice_id = inv.id AND inv.clinic_id = p.clinic_id
           LEFT JOIN users u
  ON p.created_by = u.id
 AND u.clinic_id = p.clinic_id
           WHERE p.clinic_id = $1 AND inv.patient_id = $2 AND p.status = 'paid' AND inv.status <> 'cancelled'
           ORDER BY p.paid_at DESC`,
          [clinic_id, patientId],
        ),
        pool.query(
          `SELECT
             inst.id,
             inst.invoice_id,
             inst.installment_number,
             inst.title,
             inst.amount,
             inst.paid_amount,
             ROUND(GREATEST(0, inst.amount - inst.paid_amount), 2) AS remaining_amount,
             TO_CHAR(inst.due_date, 'YYYY-MM-DD') AS due_date,
             CASE
               WHEN inst.status IN ('pending', 'partially_paid') AND inst.due_date < (NOW() AT TIME ZONE 'Africa/Cairo')::date
               THEN 'overdue'
               ELSE inst.status
             END AS status
           FROM installments inst
           JOIN invoices inv ON inst.invoice_id = inv.id AND inv.clinic_id = inst.clinic_id
           WHERE inst.clinic_id = $1 AND inst.patient_id = $2 AND inst.status <> 'cancelled' AND inv.status <> 'cancelled'
           ORDER BY inst.due_date ASC`,
          [clinic_id, patientId],
        ),
      ]);

    if (patientRes.rows.length === 0) {
      return res.status(404).json({ error: "المريض غير موجود" });
    }

    const totalSubtotalCents = invoicesRes.rows.reduce(
      (s, i) =>
        s +
        Math.round(parseFloat(i.subtotal_amount || i.total_amount || 0) * 100),
      0,
    );
    const totalDiscountCents = invoicesRes.rows.reduce(
      (s, i) => s + Math.round(parseFloat(i.discount_amount || 0) * 100),
      0,
    );
    const totalInvoicedCents = invoicesRes.rows.reduce(
      (s, i) => s + Math.round(parseFloat(i.total_amount || 0) * 100),
      0,
    );
    const totalPaidCents = paymentsRes.rows.reduce(
      (s, p) => s + Math.round(parseFloat(p.amount || 0) * 100),
      0,
    );
    const totalRemainingCents = Math.max(
      0,
      totalInvoicedCents - totalPaidCents,
    );

    res.status(200).json({
      clinic: clinicRes.rows[0] || {},
      patient: patientRes.rows[0],
      summary: {
        total_subtotal: totalSubtotalCents / 100,
        total_discount: totalDiscountCents / 100,
        total_invoiced: totalInvoicedCents / 100,
        total_paid: totalPaidCents / 100,
        total_remaining: totalRemainingCents / 100,
      },
      invoices: invoicesRes.rows,
      payments: paymentsRes.rows,
      installments: installmentsRes.rows,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching patient statement:", error.message);
    res.status(500).json({ error: "فشل جلب كشف حساب المريض" });
  }
};

// ==========================================
// 7. إلغاء الفاتورة غير المدفوعة
// ==========================================
const cancelInvoice = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const invoiceId = req.params.id;

  if (!isValidUuid(invoiceId)) {
    return res.status(400).json({ error: "معرّف الفاتورة غير صالح" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const checkRes = await client.query(
      `SELECT status FROM invoices WHERE clinic_id = $1 AND id = $2 FOR UPDATE`,
      [clinic_id, invoiceId],
    );

    if (checkRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الفاتورة غير موجودة" });
    }

    const currentStatus = checkRes.rows[0].status;
    if (currentStatus === "cancelled") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الفاتورة ملغاة بالفعل" });
    }

    if (currentStatus !== "unpaid") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "لا يمكن إلغاء فاتورة تم سداد جزء منها أو تم سدادها بالكامل",
      });
    }

    const result = await client.query(
      `UPDATE invoices 
       SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP 
       WHERE clinic_id = $1 AND id = $2 
       RETURNING *`,
      [clinic_id, invoiceId],
    );

    await client.query(
      `UPDATE treatment_plan_items 
       SET invoice_id = NULL
       WHERE clinic_id = $1 AND invoice_id = $2`,
      [clinic_id, invoiceId],
    );

    await client.query(
      `UPDATE payments 
       SET status = 'cancelled', 
           notes = COALESCE(notes, '') || ' [ملغى: تم إلغاء الفاتورة الأصلية]'
       WHERE clinic_id = $1 AND invoice_id = $2 AND status = 'pending'`,
      [clinic_id, invoiceId],
    );

    await client.query(
      `UPDATE installments
       SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE clinic_id = $1 AND invoice_id = $2 AND status <> 'cancelled'`,
      [clinic_id, invoiceId],
    );

    await client.query("COMMIT");

    try {
      await logActivity({
        clinic_id,
        user_id: req.user.id,
        action: "CANCEL_INVOICE",
        entity_type: "invoice",
        entity_id: invoiceId,
        description: `قام ${
          req.user.name || "المستخدم"
        } بإلغاء الفاتورة #${invoiceId.slice(0, 8)}`,
      });
    } catch (auditErr) {
      console.error("Audit log failed for cancelInvoice:", auditErr.message);
    }

    res.status(200).json({
      message: "تم إلغاء الفاتورة والأقساط وفك بنود العلاج المرتبطة بنجاح",
      invoice: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Error canceling invoice:", error.message);
    return res.status(500).json({
      error: "خطأ في السيرفر أثناء إلغاء الفاتورة",
    });
  } finally {
    if (client) client.release();
  }
};

// ==========================================
// 8. أرشفة الفاتورة
// ==========================================
const archiveInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    const clinic_id = req.user.clinic_id;
    const userRole = req.user.role;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "معرّف الفاتورة غير صالح" });
    }

    if (userRole !== "ClinicAdmin") {
      return res.status(403).json({
        error: "غير مصرح لك بأرشفة الفواتير، هذه الصلاحية لمدير العيادة فقط",
      });
    }

    const query = `
      UPDATE invoices
      SET is_archived = TRUE,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND clinic_id = $2
        AND is_archived = FALSE
        AND status IN ('paid', 'cancelled')
      RETURNING id, total_amount, status, is_archived;
    `;

    const result = await pool.query(query, [id, clinic_id]);

    if (result.rows.length === 0) {
      return res.status(400).json({
        error: "لا يمكن أرشفة الفاتورة إلا إذا كانت مدفوعة بالكامل أو ملغاة",
      });
    }

    try {
      await logActivity({
        clinic_id,
        user_id: req.user.id,
        action: "ARCHIVE_INVOICE",
        entity_type: "invoice",
        entity_id: id,
        description: `تمت أرشفة الفاتورة #${id.slice(0, 8)}`,
      });
    } catch (auditErr) {
      console.error("Audit log failed for archiveInvoice:", auditErr.message);
    }

    res.status(200).json({
      message: "تم أرشفة الفاتورة بنجاح",
      invoice: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error archiving invoice:", error.message);
    res.status(500).json({
      error: "خطأ في السيرفر أثناء أرشفة الفاتورة",
    });
  }
};

// ==========================================
// 9. تصدير التقرير المالي والفواتير كـ CSV
// ==========================================
const exportInvoices = async (req, res) => {
  try {
    const { clinic_id, role } = req.user;

    if (role !== "ClinicAdmin") {
      return res.status(403).json({
        error: "غير مصرح لك بتصدير التقارير المالية",
      });
    }

    const query = `
      SELECT
        invoices.id,
        patients.name AS patient_name,
        patients.phone_number AS patient_phone,
        invoices.subtotal_amount,
        invoices.discount_amount,
        invoices.total_amount,
        invoices.status,
        TO_CHAR(
          invoices.created_at AT TIME ZONE 'Africa/Cairo',
          'DD/MM/YYYY'
        ) AS created_at,
        COALESCE(
          SUM(
            CASE
              WHEN payments.status = 'paid'
              THEN payments.amount
              ELSE 0
            END
          ),
          0
        ) AS paid_amount,
        CASE 
          WHEN invoices.status = 'cancelled' THEN 0 
          ELSE ROUND(
            GREATEST(
              0,
              invoices.total_amount - COALESCE(SUM(CASE WHEN payments.status = 'paid' THEN payments.amount ELSE 0 END), 0)
            ),
            2
          )
        END AS remaining_amount
      FROM invoices
      JOIN patients
        ON invoices.patient_id = patients.id
       AND patients.clinic_id = invoices.clinic_id
      LEFT JOIN payments
        ON invoices.id = payments.invoice_id
       AND invoices.clinic_id = payments.clinic_id
      WHERE invoices.clinic_id = $1
        AND invoices.is_archived = FALSE
      GROUP BY
        invoices.id,
        patients.name,
        patients.phone_number
      ORDER BY invoices.created_at DESC;
    `;

    const result = await pool.query(query, [clinic_id]);

    const escapeCsvValue = (value) => {
      const stringValue = String(value ?? "");
      const safeValue = /^[=+\-@]/.test(stringValue)
        ? `'${stringValue}`
        : stringValue;

      return `"${safeValue.replace(/"/g, '""')}"`;
    };

    let csv =
      "\uFEFFرقم الفاتورة,اسم المريض,رقم الهاتف,الإجمالي قبل الخصم (ج.م),الخصم (ج.م),الصافي (ج.م),المدفوع (ج.م),المتبقي (ج.م),حالة الدفع,تاريخ الفاتورة\n";

    const statusMap = {
      paid: "مدفوعة بالكامل",
      partially_paid: "مدفوعة جزئياً",
      unpaid: "غير مدفوعة",
      cancelled: "ملغاة",
    };

    result.rows.forEach((inv) => {
      const invId = escapeCsvValue(`#${String(inv.id).slice(0, 8)}`);
      const patient = escapeCsvValue(inv.patient_name || "");
      const phone = escapeCsvValue(inv.patient_phone || "");

      const subtotal = parseFloat(inv.subtotal_amount || inv.total_amount || 0);
      const discount = parseFloat(inv.discount_amount || 0);
      const total = parseFloat(inv.total_amount || 0);
      const paid = parseFloat(inv.paid_amount || 0);
      const remaining = parseFloat(inv.remaining_amount || 0);

      const status = escapeCsvValue(statusMap[inv.status] || inv.status || "-");
      const date = escapeCsvValue(inv.created_at || "-");

      csv += `${invId},${patient},${phone},${subtotal},${discount},${total},${paid},${remaining},${status},${date}\n`;
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=invoices_report_${Date.now()}.csv`,
    );

    try {
      await logActivity({
        clinic_id,
        user_id: req.user.id,
        action: "EXPORT_INVOICES",
        entity_type: "invoice",
        description: `قام ${
          req.user.name || "المدير"
        } بتصدير تقرير الفواتير المالي بصيغة CSV`,
        metadata: {
          exported_count: result.rows.length,
        },
      });
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    return res.status(200).send(csv);
  } catch (err) {
    captureError(err, req);
    console.error("Error exporting invoices:", err.message);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء تصدير الفواتير",
    });
  }
};

module.exports = {
  createInvoice,
  getInvoices,
  getInvoiceById,
  createInvoiceInstallments,
  getDueInstallments,
  getPatientFinancialStatement,
  cancelInvoice,
  archiveInvoice,
  exportInvoices,
};
