const pool = require("../db");

const createProcedureCode = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { default_price, description, code } = req.body;

  try {
    if (default_price === undefined || default_price === null || !description || !code) {
      return res.status(400).json({ message: "يوجد حقل فارغ !" });
    }
    if (default_price < 0) {
      return res.status(400).json({ message: "السعر لا يمكن أن يكون سالبًا" });
    }
    const cleanCode = code.trim().toUpperCase();
    const result = await pool.query(
      "INSERT INTO procedure_codes (clinic_id, code, description, default_price) VALUES ($1, $2, $3, $4) RETURNING *",
      [clinic_id, cleanCode, description, default_price]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res
        .status(400)
        .json({ message: "كود الإجراء مسجل بالفعل في هذه العيادة" });
    }
    console.error(error);
    res.status(500).json({ message: "حدث خطأ أثناء إنشاء كود الإجراء" });
  }
};

const getProcedureCodes = async (req, res) => {
  const clinic_id = req.user.clinic_id;

  try {
    const result = await pool.query(
      "SELECT * FROM procedure_codes WHERE clinic_id = $1 AND is_active = true ORDER BY code ASC",
      [clinic_id]
    );
    res.status(200).json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "حدث خطأ أثناء جلب أكواد الإجراءات" });
  }
}

module.exports = { createProcedureCode, getProcedureCodes };
