const pool = require("../db");

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

  if (!patient_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "المريض وبنود الفاتورة مطلوبة" });
  }

  // فحص البنود
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

  // حساب الإجمالي بالقروش
  const totalAmountInCents = items.reduce((total, item) => {
    const qty = parseInt(item.quantity, 10);
    const unitPriceCents = Math.round(parseFloat(item.unit_price) * 100);
    return total + qty * unitPriceCents;
  }, 0);

  const totalAmount = totalAmountInCents / 100;
  const paidNow = initial_payment ? parseFloat(initial_payment.amount) || 0 : 0;
  const paidNowCents = Math.round(paidNow * 100);

  // تحديد الحالة المبدئية
  let initialStatus = "unpaid";
  if (paidNowCents >= totalAmountInCents && totalAmountInCents > 0) {
    initialStatus = "paid";
  } else if (paidNowCents > 0) {
    initialStatus = "partially_paid";
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let finalAppointmentId = appointment_id || null;

    if (!finalAppointmentId && doctor_id) {
      const appDate = appointment_date
        ? new Date(appointment_date)
        : new Date();
      // لو التاريخ في المستقبل يبقى scheduled، لو دلوقتي أو ماضي بسيط يبقى completed
      const appStatus = appDate > new Date() ? "scheduled" : "completed";

      const autoAppt = await client.query(
        `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_date, status, notes)
         VALUES ($1, $2, $3, $4, $5, 'كشف مربوط بالفاتورة')
         RETURNING id;`,
        [clinic_id, patient_id, doctor_id, appDate, appStatus]
      );
      finalAppointmentId = autoAppt.rows[0].id;
    }

    // وبعدها بنحط finalAppointmentId في كويري الفاتورة:
    const insertInvoiceQuery = `
      INSERT INTO invoices (clinic_id, patient_id, appointment_id, total_amount, status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const invoiceResult = await client.query(insertInvoiceQuery, [
      clinic_id,
      patient_id,
      finalAppointmentId, // 👈 بقى مربوط بالدكتور أوتوماتيك
      totalAmount,
      initialStatus,
    ]);

    const newInvoice = invoiceResult.rows[0];
    const invoiceId = newInvoice.id;

    // 2. إدخال البنود
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

    // 3. الدفع الفوري التلقائي لو تم تحديد مبلغ مدفوع الآن
    if (paidNow > 0) {
      await client.query(
        `INSERT INTO payments (clinic_id, invoice_id, amount, payment_method, notes)
         VALUES ($1, $2, $3, $4, $5);`,
        [
          clinic_id,
          invoiceId,
          paidNow,
          initial_payment.payment_method || "cash",
          initial_payment.notes || "دفعة فورية عند إصدار الفاتورة",
        ]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      message: "تم إنشاء الفاتورة بنجاح",
      invoice: newInvoice,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating invoice:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء إنشاء الفاتورة" });
  } finally {
    client.release();
  }
};

const getInvoices = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { search, status, patient_id, archived } = req.query;

  try {
    let query = `
      SELECT 
        invoices.id, 
        patients.name AS patient_name, 
        patients.phone_number AS patient_phone, 
        invoices.total_amount, 
        invoices.status, 
        invoices.created_at,
        invoices.appointment_id,
        COALESCE(SUM(payments.amount), 0) AS paid_amount,
        (invoices.total_amount - COALESCE(SUM(payments.amount), 0)) AS remaining_amount
      FROM invoices 
      JOIN patients ON invoices.patient_id = patients.id 
      LEFT JOIN payments ON invoices.id = payments.invoice_id AND invoices.clinic_id = payments.clinic_id
      WHERE invoices.clinic_id = $1
    `;
    const queryParams = [clinic_id];

    if (search) {
      queryParams.push(`%${search}%`);
      query += ` AND (patients.name ILIKE $${queryParams.length} OR patients.phone_number ILIKE $${queryParams.length})`;
    }

    if (status) {
      queryParams.push(status);
      query += ` AND invoices.status = $${queryParams.length}`;
    }

    if (patient_id) {
      queryParams.push(patient_id);
      query += ` AND invoices.patient_id = $${queryParams.length}`;
    }

    // لو باعت archived=true نجيب الفواتير المؤرشفة، غير كدة نجيب النشطة فقط
    const isArchived = archived === "true" ? true : false;
    queryParams.push(isArchived);
    query += ` AND invoices.is_archived = $${queryParams.length}`;

    query += ` GROUP BY invoices.id, patients.name, patients.phone_number ORDER BY invoices.created_at DESC;`;

    const invoicesResult = await pool.query(query, queryParams);
    res.status(200).json(invoicesResult.rows);
  } catch (error) {
    console.error("Error fetching invoices:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء جلب الفواتير" });
  }
};

const getInvoiceById = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const invoiceId = req.params.id;

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
      [clinic_id, invoiceId]
    );
    invoice.items = itemsResult.rows;

    // جلب سجل المدفوعات بالتفصيل (دفع إيه وإمتى وطريقة الدفع)
    const paymentsResult = await pool.query(
      "SELECT id, amount, payment_method, notes, paid_at FROM payments WHERE clinic_id = $1 AND invoice_id = $2 ORDER BY paid_at DESC",
      [clinic_id, invoiceId]
    );
    invoice.payments = paymentsResult.rows;

    // حساب المدفوع والمتبقي
    const totalPaid = paymentsResult.rows.reduce(
      (sum, p) => sum + parseFloat(p.amount),
      0
    );
    invoice.paid_amount = totalPaid;
    invoice.remaining_amount = parseFloat(invoice.total_amount) - totalPaid;

    res.status(200).json(invoice);
  } catch (error) {
    console.error("Error fetching invoice by ID:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء جلب الفاتورة" });
  }
};

const cancelInvoice = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const invoiceId = req.params.id;

  try {
    const result = await pool.query(
      "UPDATE invoices SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE clinic_id = $1 AND id = $2 AND status = 'unpaid' RETURNING *",
      [clinic_id, invoiceId]
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "الفاتورة غير موجودة أو تم دفعها ولا يمكن إلغاؤها" });
    }

    res
      .status(200)
      .json({ message: "تم إلغاء الفاتورة بنجاح", invoice: result.rows[0] });
  } catch (error) {
    console.error("Error canceling invoice:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء إلغاء الفاتورة" });
  }
};

const archiveInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    const clinic_id = req.user.clinic_id;
    const userRole = req.user.role;

    // حماية صارمة: منع الريسبشن نهائياً من أرشفة الفواتير (الأدمن فقط)
    if (userRole === "Receptionist") {
      return res.status(403).json({
        error: "غير مصرح لك بأرشفة الفواتير، هذه الصلاحية لمدير العيادة فقط",
      });
    }

    const query = `
      UPDATE invoices 
      SET is_archived = TRUE, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $1 AND clinic_id = $2 AND is_archived = FALSE
      RETURNING id, total_amount, is_archived;
    `;

    const result = await pool.query(query, [id, clinic_id]);

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "الفاتورة غير موجودة أو تمت أرشفتها بالفعل" });
    }

    res.status(200).json({
      message: "تم أرشفة الفاتورة بنجاح ولا يمكن التراجع عن هذا الإجراء",
      invoice: result.rows[0],
    });
  } catch (error) {
    console.error("Error archiving invoice:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء أرشفة الفاتورة" });
  }
};

module.exports = {
  createInvoice,
  getInvoices,
  getInvoiceById,
  cancelInvoice,
  archiveInvoice,
};
