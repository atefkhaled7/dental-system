const pool = require("../db");

const recordPayment = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { invoice_id, amount, payment_method, notes } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "المبلغ المدفوع يجب أن يكون أكبر من الصفر" });
  }

  const validMethods = ["cash", "card", "bank_transfer", "other"];
  if (!validMethods.includes(payment_method)) {
    return res.status(400).json({ error: "طريقة الدفع غير صالحة" });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const invoiceResult = await client.query(
      "SELECT * FROM invoices WHERE id = $1 AND clinic_id = $2",
      [invoice_id, clinic_id]
    );

    if (invoiceResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الفاتورة غير موجودة" });
    }

    const invoice = invoiceResult.rows[0];

    if (invoice.status === "paid") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الفاتورة مدفوعة بالكامل بالفعل" });
    }

    if (invoice.status === "cancelled") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "لا يمكن الدفع لفاتورة ملغاة" });
    }

    const paidResult = await client.query(
      "SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE invoice_id = $1 AND clinic_id = $2",
      [invoice_id, clinic_id]
    );

    const alreadyPaid = parseFloat(paidResult.rows[0].total_paid);
    const invoiceTotal = parseFloat(invoice.total_amount);
    const newTotalPaid = alreadyPaid + parseFloat(amount);

    if (newTotalPaid > invoiceTotal) {
      await client.query("ROLLBACK");
      const remaining = invoiceTotal - alreadyPaid;
      return res.status(400).json({ 
        error: `المبلغ المدفوع أكبر من المتبقي على الفاتورة (المتبقي: ${remaining} جنيه)` 
      });
    }

    const paymentResult = await client.query(
      `INSERT INTO payments (clinic_id, invoice_id, amount, payment_method, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *;`,
      [clinic_id, invoice_id, amount, payment_method, notes || null]
    );

    const newStatus = (newTotalPaid >= invoiceTotal) ? "paid" : "partially_paid";

    await client.query(
      "UPDATE invoices SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND clinic_id = $3",
      [newStatus, invoice_id, clinic_id]
    );

    await client.query("COMMIT");

    res.status(201).json({
      message: "تم تسجيل الدفعة وتحديث الفاتورة بنجاح",
      payment: paymentResult.rows[0],
      invoice_status: newStatus,
      remaining_amount: invoiceTotal - newTotalPaid
    });

  } catch (error) {
    if (client) await client.query("ROLLBACK");
    console.error("Error recording payment:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء تسجيل الدفع" });
  } finally {
    if (client) client.release();
  }
};

module.exports = { recordPayment };