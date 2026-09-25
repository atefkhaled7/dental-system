const pool = require("../db");

const createInvoice = async (req, res) => {
  const { patient_id, appointment_id, items } = req.body;
  const clinic_id = req.user.clinic_id;

  // 1. التحقق من وجود المريض والبنود
  if (!patient_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "المريض وبنود الفاتورة مطلوبة" });
  }

  // 2. فحص صارم لكل بند (Validation) لمنع الـ Data Integrity Bugs
  for (const item of items) {
    if (!item.description || typeof item.description !== 'string' || item.description.trim() === '') {
      return res.status(400).json({ error: "وصف البند (description) مطلوب لكل البنود" });
    }

    const qty = parseInt(item.quantity, 10);
    if (isNaN(qty) || qty <= 0) {
      return res.status(400).json({ error: "الكمية (quantity) يجب أن تكون رقماً صحيحاً أكبر من الصفر" });
    }

    const price = parseFloat(item.unit_price);
    if (isNaN(price) || price < 0) {
      return res.status(400).json({ error: "سعر الوحدة (unit_price) يجب أن يكون رقماً صالحاً وغير سالب" });
    }
  }

  // 3. حساب إجمالي الفاتورة بدقة القروش (Cents) لمنع عيوب الـ Floating Point
  const totalAmountInCents = items.reduce((total, item) => {
    const qty = parseInt(item.quantity, 10);
    const unitPriceCents = Math.round(parseFloat(item.unit_price) * 100);
    return total + (qty * unitPriceCents);
  }, 0);

  const totalAmount = totalAmountInCents / 100;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // إنشاء الفاتورة الرئيسية
    const insertInvoiceQuery = `
      INSERT INTO invoices (clinic_id, patient_id, appointment_id, total_amount, status)
      VALUES ($1, $2, $3, $4, 'unpaid')
      RETURNING *;
    `;
    const invoiceResult = await client.query(insertInvoiceQuery, [
      clinic_id,
      patient_id,
      appointment_id || null,
      totalAmount,
    ]);

    const newInvoice = invoiceResult.rows[0];
    const invoiceId = newInvoice.id;

    // إدخال البنود بند بند بقيمها النظيفة والمفحوصة
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

    await client.query("COMMIT");

    res.status(201).json({
      message: "تم إنشاء الفاتورة وبنودها بنجاح",
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
  const { search, status } = req.query;

  try {
    let query = `
      SELECT 
        invoices.id, 
        patients.name AS patient_name, 
        patients.phone_number AS patient_phone, 
        invoices.total_amount, 
        invoices.status, 
        invoices.created_at 
      FROM invoices 
      JOIN patients ON invoices.patient_id = patients.id 
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

    query += ` ORDER BY invoices.created_at DESC;`;

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
    const invoiceResult = await pool.query(
      "SELECT invoices.id, patients.name AS patient_name, patients.phone_number AS patient_phone, invoices.total_amount, invoices.status, invoices.created_at FROM invoices JOIN patients ON invoices.patient_id = patients.id WHERE invoices.clinic_id = $1 AND invoices.id = $2",
      [clinic_id, invoiceId]
    );

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ error: "الفاتورة غير موجودة" });
    }

    const invoice = invoiceResult.rows[0];

    const itemsResult = await pool.query(
      "SELECT procedure_code_id, description, quantity, unit_price, total_price FROM invoice_items WHERE clinic_id = $1 AND invoice_id = $2",
      [clinic_id, invoiceId]
    );

    invoice.items = itemsResult.rows;

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
      return res.status(404).json({ error: "الفاتورة غير موجودة أو تم دفعها ولا يمكن إلغاؤها" });
    }

    res.status(200).json({ message: "تم إلغاء الفاتورة بنجاح", invoice: result.rows[0] });
  } catch (error) {
    console.error("Error canceling invoice:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء إلغاء الفاتورة" });
  }
};

module.exports = { createInvoice, getInvoices, getInvoiceById, cancelInvoice };