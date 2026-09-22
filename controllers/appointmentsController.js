const pool = require("../db");

const getAppointments = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT patients.patient_name, doctors.doctor_name, appointments.appointment_date FROM appointments JOIN patients ON appointments.patient_id = patients.patient_id JOIN doctors ON appointments.doctor_id = doctors.doctor_id;"
    );
    res.status(200).json({ appointments: result.rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server Error" });
  }
};

const createAppointment = async (req, res) => {
  try {
    const { patient_id, doctor_id, appointment_date } = req.body;
    if (!patient_id || !doctor_id || !appointment_date) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const result = await pool.query(
      "INSERT INTO appointments (patient_id, doctor_id, appointment_date) VALUES ($1, $2, $3) RETURNING *",
      [patient_id, doctor_id, appointment_date]
    );
    res.status(201).json({ appointment: result.rows[0] });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Server Error" });
  }
};

module.exports = { getAppointments , createAppointment };
