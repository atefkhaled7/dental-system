const pool = require("../db");

const createClinic = async (req, res) => {
  try {
    const { name, phone_number, subdomain } = req.body;
    
    // فحص سريع 
    if (!name) {
      return res.status(400).json({ error: "اسم العيادة مطلوب clinic name is required." });
    }

    const result = await pool.query(
      "INSERT INTO clinics (name, phone_number, subdomain) VALUES ($1, $2, $3) RETURNING *",
      [name, phone_number || null, subdomain || null]
    );
    res.status(201).json({ message: "تم إنشاء العيادة بنجاح", clinic: result.rows[0] });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server Error" });
  }
};

const getClinics = async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM clinics ORDER BY created_at DESC");
    res.status(200).json({ clinics: result.rows });
  } catch (err) {
    console.error("Error fetching clinics:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

const updateClinic = async (req, res) => {
  try {
    const { id } = req.params; 
    const { name, phone_number, is_active } = req.body;
    
    const result = await pool.query(
      `UPDATE clinics SET name = COALESCE($1, name), phone_number = COALESCE($2, phone_number), is_active = COALESCE($3, is_active),updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *`,
      [name, phone_number, is_active, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "العيادة غير موجودة" });
    }
    res.status(200).json({ message: "تم تحديث بيانات العيادة بنجاح", clinic: result.rows[0] });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Server Error" });
  }
};

const deleteClinic = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "UPDATE clinics SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Clinic not found" });
    }
    res
      .status(200)
      .json({ message: "Clinic deleted successfully", clinic: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: "Server Error" });
  }
};

module.exports = { createClinic, getClinics,updateClinic, deleteClinic };
