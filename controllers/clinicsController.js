const pool = require("../db");

const createClinic = async (req, res) => {
  try {
    const { name, phone_number, subdomain } = req.body;

    // فحص سريع
    if (!name) {
      return res
        .status(400)
        .json({ error: "اسم العيادة مطلوب clinic name is required." });
    }

    const result = await pool.query(
      "INSERT INTO clinics (name, phone_number, subdomain) VALUES ($1, $2, $3) RETURNING *",
      [name, phone_number || null, subdomain || null]
    );
    res
      .status(201)
      .json({ message: "تم إنشاء العيادة بنجاح", clinic: result.rows[0] });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server Error" });
  }
};

const getClinics = async (req, res) => {
  try {
    if (req.user.role === "SuperAdmin") {
      const result = await pool.query(
        "SELECT * FROM clinics ORDER BY created_at DESC"
      );
      return res.status(200).json({ clinics: result.rows });
    }

    const result = await pool.query("SELECT * FROM clinics WHERE id = $1", [
      req.user.clinic_id,
    ]);
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

    // فحص حاسم لمنع التعديل على عيادات الآخرين:
    if (req.user.role === "ClinicAdmin" && id !== req.user.clinic_id) {
      return res
        .status(403)
        .json({ error: "غير مصرح لك بتعديل بيانات عيادة أخرى" });
    }

    const activeStatus = req.user.role === "SuperAdmin" ? is_active : undefined;

    const result = await pool.query(
      `UPDATE clinics SET name = COALESCE($1, name), phone_number = COALESCE($2, phone_number), is_active = COALESCE($3, is_active), updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *;`,
      [name, phone_number, activeStatus, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "العيادة غير موجودة" });
    }

    res.status(200).json({
      message: "تم تحديث بيانات العيادة بنجاح",
      clinic: result.rows[0],
    });
  } catch (error) {
    console.error("Error updating clinic:", error.message);
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
      return res.status(404).json({ error: "العيادة غير موجودة" });
    }

    res
      .status(200)
      .json({ message: "تم تعطيل العيادة بنجاح", clinic: result.rows[0] });
  } catch (error) {
    console.error("Error deleting clinic:", error.message);
    res.status(500).json({ error: "Server Error" });
  }
};

module.exports = { createClinic, getClinics, updateClinic, deleteClinic };
