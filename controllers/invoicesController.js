const pool = require("../db");

const createInvoice = async (req, res) => {
  const client = await pool.connect();
  try {
    const clinic_id = req.user.clinic_id;
    const { patient_id, appointment_id, items } = req.body;

    if(!patient_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "المريض وبنود الفاتورة مطلوبة" });
    }

    const totalAmount = items.reduce((total, item) => total + (item.quantity * item.unit_price), 0);

    await client.query("BEGIN");

    const insertInvoiceQuery = `
      INSERT INTO invoices (clinic_id, patient_id, appointment_id, total_amount, status)
      VALUES ($1, $2, $3, $4, 'unpaid')
      RETURNING *;
    `;
    const invoiceResult = await client.query(insertInvoiceQuery, [clinic_id, patient_id, appointment_id, totalAmount]);
    const invoiceId = invoiceResult.rows[0].id;
    const newInvoice = invoiceResult.rows[0];

    for (const item of items) {
      const insertItemQuery = `
        INSERT INTO invoice_items (invoice_id, procedure_code_id, quantity, unit_price, clinic_id, total_price, description)
        VALUES ($1, $2, $3, $4, $5, $6, $7);
      `;
      await client.query(insertItemQuery, [invoiceId, item.procedure_code_id, item.quantity, item.unit_price, clinic_id, totalAmount, item.description]);
    }

    await client.query("COMMIT");

    res.status(201).json(newInvoice);
  }catch(error){
    await client.query("ROLLBACK");
    console.error("Error creating invoice:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
};

module.exports = { createInvoice };