const pool = require("../db");
const { logActivity } = require("../utils/auditLogger");
const { isValidUuid } = require("../middleware/validateUuid");
const { captureError } = require("../utils/errorTracker");

const createInvoice = async (req, res) => {
  const {
    patient_id,
    appointment_id,
    items,
    initial_payment,
    doctor_id,
    appointment_date,
  } = req.body;
  const clinic_id = req.user.clinic_id;

  // 🔒 فحص الـ UUIDs لمدخلات الـ body (بدون أي queryParams)
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

  // فحص بنود الفاتورة والأسعار
  for (const item of items) {
    if (
      !item.description ||
      typeof item.description !== "string" ||
      item.description.trim() === ""
    ) {
      return res.status(400).json({ error: "وصف البند مطلوب لكل البنود" });
    }
    const qty = parseInt(item.quantity, 10);
    if (isNaN(qty) || qty <= 0) {
      return res
        .status(400)
        .json({ error: "الكمية يجب أن تكون رقماً صحيحاً أكبر من الصفر" });
    }
    const price = parseFloat(item.unit_price);
    if (isNaN(price) || price < 0) {
      return res
        .status(400)
        .json({ error: "سعر الوحدة يجب أن يكون رقماً صالحاً وغير سالب" });
    }
  }

  // حساب الإجمالي بالقروش لتجنب مشاكل الفاصلة العائمة
  const totalAmountInCents = items.reduce((total, item) => {
    const qty = parseInt(item.quantity, 10);
    const unitPriceCents = Math.round(parseFloat(item.unit_price) * 100);
    return total + qty * unitPriceCents;
  }, 0);

  const totalAmount = totalAmountInCents / 100;
  const paidNow = initial_payment ? parseFloat(initial_payment.amount) || 0 : 0;
  const paidNowCents = Math.round(paidNow * 100);

  if (paidNowCents > totalAmountInCents) {
    return res.status(400).json({
      error: "المبلغ المدفوع أكبر من إجمالي الفاتورة",
    });
  }

  let initialStatus = "unpaid";
  // إذا كانت الفاتورة بقيمة صفر (كشف مجاني) أو تم سداد كامل المبلغ فوراً
  if (
    totalAmountInCents === 0 ||
    (paidNowCents >= totalAmountInCents && totalAmountInCents > 0)
  ) {
    initialStatus = "paid";
  } else if (paidNowCents > 0) {
    initialStatus = "partially_paid";
  }

  const validMethods = [
    "cash",
    "card",
    "bank_transfer",
    "vodafone_cash",
    "other",
  ];
  // توحيد الحروف الصغيرة ومعالجة الفروق الشائعة
  let rawMethod = (initial_payment?.payment_method || "cash")
    .toLowerCase()
    .trim();
  if (rawMethod === "transfer") rawMethod = "bank_transfer";
  if (rawMethod === "vodafonecash") rawMethod = "vodafone_cash";
  const paymentMethod = rawMethod;

  if (paidNowCents > 0 && !validMethods.includes(paymentMethod)) {
    return res.status(400).json({ error: "طريقة الدفع غير صالحة" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // 🔒 1. فحص عزل المريض أولاً (Tenant Isolation Check)
    const patientCheck = await client.query(
      `SELECT id FROM patients WHERE id = $1 AND clinic_id = $2`,
      [patient_id, clinic_id],
    );

    if (patientCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المريض غير موجود في هذه العيادة" });
    }

    let finalAppointmentId = appointment_id || null;

    // 2. التحقق من الموعد إذا تم تمريره
    if (finalAppointmentId) {
      const apptCheck = await client.query(
        `SELECT id
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

    // 3. إنشاء موعد تلقائي سليم ومحمى من التعارض إذا حُدد دكتور بدون موعد سابق
    if (!finalAppointmentId && doctor_id) {
      // قفل صف الطبيب النشط لحماية التزامن
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

      // فحص صحة التاريخ
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

      // جلب مدة الكشف الافتراضية للعيادة
      const clinicRes = await client.query(
        "SELECT default_appointment_duration FROM clinics WHERE id = $1",
        [clinic_id],
      );
      const apptDuration =
        Number(clinicRes.rows[0]?.default_appointment_duration) || 30;

      const isFuture = appDate > new Date();
      const appStatus = isFuture ? "scheduled" : "completed";

      // إذا كان الموعد في المستقبل، نطبق فحص التعارض الزمني
      if (isFuture) {
        const conflictCheck = await client.query(
          `SELECT id FROM appointments
       WHERE clinic_id = $1 
         AND doctor_id = $2 
         AND status = 'scheduled'
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

    // 4. إنشاء الفاتورة
    const insertInvoiceQuery = `
      INSERT INTO invoices (clinic_id, patient_id, appointment_id, total_amount, status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const invoiceResult = await client.query(insertInvoiceQuery, [
      clinic_id,
      patient_id,
      finalAppointmentId,
      totalAmount,
      initialStatus,
    ]);

    const newInvoice = invoiceResult.rows[0];
    const invoiceId = newInvoice.id;

    // 5. إدخال البنود
    const insertItemQuery = `
      INSERT INTO invoice_items (clinic_id, invoice_id, procedure_code_id, description, quantity, unit_price, total_price)
      VALUES ($1, $2, $3, $4, $5, $6, $7);
    `;

    for (const item of items) {
      const qty = parseInt(item.quantity, 10);
      const unitPrice = parseFloat(item.unit_price);
      const itemTotal = (qty * Math.round(unitPrice * 100)) / 100;

      await client.query(insertItemQuery, [
        clinic_id,
        invoiceId,
        item.procedure_code_id || null,
        item.description.trim(),
        qty,
        unitPrice,
        itemTotal,
      ]);
    }

    // 6. تسجيل الدفعة الفورية إذا وُجدت
    if (paidNow > 0) {
      await client.query(
        `INSERT INTO payments (clinic_id, invoice_id, amount, payment_method, notes, status, created_by, paid_at)
     VALUES ($1, $2, $3, $4, $5, 'paid', $6, CURRENT_TIMESTAMP);`,
        [
          clinic_id,
          invoiceId,
          paidNow,
          paymentMethod,
          initial_payment?.notes || "دفعة فورية عند إصدار الفاتورة",
          req.user.id,
        ],
      );
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
        } بإنشاء فاتورة جديدة بقيمة ${totalAmount} ج.م للمريض #${String(
          patient_id,
        ).slice(0, 8)}`,
        metadata: {
          total_amount: totalAmount,
          status: initialStatus,
          items_count: items.length,
        },
      });

      if (paidNow > 0) {
        await logActivity({
          clinic_id,
          user_id: req.user.id,
          action: "RECORD_PAYMENT",
          entity_type: "invoice",
          entity_id: invoiceId,
          description: `قام ${
            req.user.name || "الموظف"
          } بتحصيل دفعة بقيمة ${paidNow} ج.م للفاتورة #${invoiceId.slice(
            0,
            8,
          )}`,
          metadata: {
            amount: paidNow,
            payment_method: paymentMethod,
          },
        });
      }
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    res.status(201).json({
      message: "تم إنشاء الفاتورة بنجاح",
      invoice: newInvoice,
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
        error: "بيانات غير صحيحة (مريض أو دكتور أو بند غير موجود)",
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
    // 1. حساب الـ Pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const offset = (pageNum - 1) * limitNum;

    let query = `
      SELECT 
        invoices.id, 
        patients.name AS patient_name, 
        patients.phone_number AS patient_phone, 
        invoices.total_amount, 
        invoices.status, 
        invoices.created_at,
        invoices.appointment_id,
        COALESCE(
          SUM(CASE WHEN payments.status = 'paid' THEN payments.amount ELSE 0 END),
          0
        ) AS paid_amount,
        (
          invoices.total_amount -
          COALESCE(
            SUM(CASE WHEN payments.status = 'paid' THEN payments.amount ELSE 0 END),
            0
          )
        ) AS remaining_amount,
        COUNT(*) OVER() AS full_count
      FROM invoices 
      JOIN patients ON invoices.patient_id = patients.id AND patients.clinic_id = invoices.clinic_id
      LEFT JOIN payments ON invoices.id = payments.invoice_id AND invoices.clinic_id = payments.clinic_id
      WHERE invoices.clinic_id = $1
    `;

    const queryParams = [clinic_id];
    let paramCounter = 2;

    // 2. فلتر البحث بالاسم أو التليفون
    if (search && search.trim() !== "") {
      queryParams.push(`%${search.trim()}%`);
      query += ` AND (patients.name ILIKE $${paramCounter} OR patients.phone_number ILIKE $${paramCounter})`;
      paramCounter++;
    }

    // 3. فلتر حالة الدفع (paid / partially_paid / unpaid / cancelled)
    if (status && status.trim() !== "") {
      queryParams.push(status.trim());
      query += ` AND invoices.status = $${paramCounter}`;
      paramCounter++;
    }

    // 4. فلتر مريض محدد
    if (patient_id) {
      queryParams.push(patient_id);
      query += ` AND invoices.patient_id = $${paramCounter}`;
      paramCounter++;
    }

    // 5. فلتر الأرشفة (الافتراضي: الفواتير النشطة فقط)
    const isArchived = archived === "true";
    queryParams.push(isArchived);
    query += ` AND invoices.is_archived = $${paramCounter}`;
    paramCounter++;

    // 6. الترتيب وتقسيم الصفحات
    query += ` GROUP BY invoices.id, patients.name, patients.phone_number ORDER BY invoices.created_at DESC LIMIT $${paramCounter} OFFSET $${
      paramCounter + 1
    };`;
    queryParams.push(limitNum, offset);

    const invoicesResult = await pool.query(query, queryParams);

    // استخراج الإجمالي الكلي للنتائج المطابقة
    const total =
      invoicesResult.rows.length > 0
        ? Number(invoicesResult.rows[0].full_count)
        : 0;

    // تنظيف الحقل full_count من كائنات الفواتير
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

const getInvoiceById = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const invoiceId = req.params.id;

  if (!isValidUuid(req.params.id)) {
    return res.status(400).json({ error: "معرّف الفاتورة غير صالح" });
  }

  try {
    // جلب الفاتورة مع المريض والدكتور وميعاد الكشف
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
      LEFT JOIN users ON appointments.doctor_id = users.id
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

    // جلب البنود
    const itemsResult = await pool.query(
      "SELECT procedure_code_id, description, quantity, unit_price, total_price FROM invoice_items WHERE clinic_id = $1 AND invoice_id = $2",
      [clinic_id, invoiceId],
    );
    invoice.items = itemsResult.rows;

    // جلب سجل المدفوعات بالتفصيل (دفع إيه وإمتى وطريقة الدفع)
    const paymentsResult = await pool.query(
      "SELECT id, amount, payment_method, CASE WHEN status = 'pending' AND expires_at < NOW() THEN 'expired' ELSE status END AS status, notes, paid_at, created_at FROM payments WHERE clinic_id = $1 AND invoice_id = $2 ORDER BY paid_at DESC",
      [clinic_id, invoiceId],
    );
    invoice.payments = paymentsResult.rows;

    // حساب المدفوع والمتبقي
    const totalPaid = paymentsResult.rows
      .filter((p) => p.status === "paid")
      .reduce((sum, p) => sum + parseFloat(p.amount), 0);

    invoice.paid_amount = totalPaid;
    invoice.remaining_amount = parseFloat(invoice.total_amount) - totalPaid;

    res.status(200).json(invoice);
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching invoice by ID:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء جلب الفاتورة" });
  }
};

const cancelInvoice = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const invoiceId = req.params.id;

  if (!isValidUuid(req.params.id)) {
    return res.status(400).json({ error: "معرّف الفاتورة غير صالح" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // إلغاء الفاتورة فقط إذا كانت غير مدفوعة وتتبع نفس العيادة
    const result = await client.query(
      `UPDATE invoices 
       SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP 
       WHERE clinic_id = $1 AND id = $2 AND status = 'unpaid' 
       RETURNING *`,
      [clinic_id, invoiceId],
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "الفاتورة غير موجودة أو تم سدادها بالفعل ولا يمكن إلغاؤها",
      });
    }

    // فك بنود خطط العلاج المربوطة بهذه الفاتورة لترجع قابلة للفوترة من جديد
    await client.query(
      `UPDATE treatment_plan_items 
   SET invoice_id = NULL
   WHERE clinic_id = $1 AND invoice_id = $2`,
      [clinic_id, invoiceId],
    );

    // إلغاء أي روابط دفع إلكتروني معلقة (pending) تابعة لهذه الفاتورة
    await client.query(
      `UPDATE payments 
   SET status = 'cancelled', 
       notes = COALESCE(notes, '') || ' [ملغى: تم إلغاء الفاتورة الأصلية]'
   WHERE clinic_id = $1 AND invoice_id = $2 AND status = 'pending'`,
      [clinic_id, invoiceId],
    );

    await client.query("COMMIT");

    // تسجيل العملية في الرقابة
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
      message: "تم إلغاء الفاتورة وفك بنود العلاج المرتبطة بنجاح",
      invoice: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);

    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback failed:", rollbackError.message);
      }
    }

    console.error("Error canceling invoice:", error.message);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء إلغاء الفاتورة",
    });
  } finally {
    if (client) client.release();
  }
};

const archiveInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    const clinic_id = req.user.clinic_id;
    const userRole = req.user.role;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "معرّف الفاتورة غير صالح" });
    }

    // منع الريسبشن من أرشفة الفواتير
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

    // 🔒 تسجيل العملية في الرقابة أولاً قبل إرسال الرد لضمان عدم ضياعها على Vercel
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
// 6. تصدير التقرير المالي والفواتير كـ CSV
// ClinicAdmin فقط
// ==========================================
const exportInvoices = async (req, res) => {
  try {
    const { clinic_id, role } = req.user;

    // طبقة حماية إضافية داخل الـcontroller
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
        (
          invoices.total_amount -
          COALESCE(
            SUM(
              CASE
                WHEN payments.status = 'paid'
                THEN payments.amount
                ELSE 0
              END
            ),
            0
          )
        ) AS remaining_amount
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

    // حماية قيم CSV من الاقتباسات + Formula Injection
    const escapeCsvValue = (value) => {
      const stringValue = String(value ?? "");

      const safeValue = /^[=+\-@]/.test(stringValue)
        ? `'${stringValue}`
        : stringValue;

      return `"${safeValue.replace(/"/g, '""')}"`;
    };

    // UTF-8 BOM لدعم العربية بشكل أفضل في Excel
    let csv =
      "\uFEFFرقم الفاتورة,اسم المريض,رقم الهاتف,إجمالي الفاتورة (ج.م),المدفوع (ج.م),المتبقي (ج.م),حالة الدفع,تاريخ الفاتورة\n";

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

      const total = parseFloat(inv.total_amount || 0);
      const paid = parseFloat(inv.paid_amount || 0);
      const remaining = parseFloat(inv.remaining_amount || 0);

      const status = escapeCsvValue(statusMap[inv.status] || inv.status || "-");

      const date = escapeCsvValue(inv.created_at || "-");

      csv += `${invId},${patient},${phone},${total},${paid},${remaining},${status},${date}\n`;
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
  cancelInvoice,
  archiveInvoice,
  exportInvoices,
};
