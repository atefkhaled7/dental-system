require("dotenv").config();
const express = require("express");
const pool = require("./db");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;



const testConnection = async () => {
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("Database connected like a boss at:", res.rows[0].now);
  } catch (err) {
    console.error("Error connecting to the database:", err.message);
  }
};
testConnection();

app.use("/api/clinics", require("./routes/clinicsRoutes"));
app.use("/api/appointments", require("./routes/appointmentsRoutes"));

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}... Ready for Cash!`);
});