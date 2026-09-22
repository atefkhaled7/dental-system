const pool = require("../db");

const createClinic = async (req, res) => {
  try {
    const { doctor_name, phone, specialty } = req.body;
    const result = await pool.query(
      "INSERT INTO clinics (doctor_name, phone, specialty) VALUES ($1, $2, $3) RETURNING *",
      [doctor_name, phone, specialty]
    );
    res.status(201).json({
      message: "Clinic added successfully for Cash!",
      clinic: result.rows[0],
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server Error" });
  }
};

const getClinics = async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM clinics");
    res.status(200).json({ clinics: result.rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server Error" });
  }
};

const updateClinic = async (req, res) => {
  try {
    const { id } = req.params;
    const { doctor_name, phone, specialty } = req.body;
    const result = await pool.query(
      "UPDATE clinics SET doctor_name = $1, phone = $2, specialty = $3 WHERE id = $4 RETURNING *",
      [doctor_name, phone, specialty, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Clinic not found" });
    }
    res
      .status(200)
      .json({ message: "Clinic updated successfully", clinic: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: "Server Error" });
  }
};

const deleteClinic = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "DELETE FROM clinics WHERE id = $1 RETURNING *",
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
