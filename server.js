require("dotenv").config();
const express = require("express");
const pool = require("./db");
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}... Ready for Cash!`);
});

const testConnection = async () => {
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("Database connected like a boss at:", res.rows[0].now);
  } catch (err) {
    console.error("Error connecting to the database:", err.message);
  }
};

testConnection();

app.post("/api/clinics", async (req, res) => {
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
});

app.get("/api/clinics", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM clinics");
    const formattedClinics = result.rows.map((clinic) => ({
      doctor_name: clinic.doctor_name,
      specialty: clinic.specialty,
    }));
    res.status(200).json({ clinics: formattedClinics });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server Error" });
  }
});
