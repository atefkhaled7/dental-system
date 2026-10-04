require("dotenv").config();
const cors = require("cors");
const express = require("express");
const pool = require("./db");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const app = express();


app.use(helmet());

// 2. حماية تسجيل الدخول من محاولات التخمين (10 محاولات كل 15 دقيقة)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: "تم تجاوز عدد المحاولات المسموح بها، يرجى المحاولة بعد 15 دقيقة",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/auth/login", loginLimiter);

app.use(cors());
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
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/patients", require("./routes/patientsRoutes"));
app.use("/api/procedure-codes", require("./routes/procedureCodesRoutes"));
app.use("/api/invoices", require("./routes/invoicesRoutes"));
app.use("/api/payments", require("./routes/paymentRoutes"));
app.use("/api/lab-orders", require("./routes/labOrdersRoutes"));
app.use("/api/dashboard", require("./routes/dashboardRoutes"));
app.use("/api/dental-chart", require("./routes/dentalChartRoutes"));
app.use("/api/treatment-plans", require("./routes/treatmentPlansRoutes"));
app.use("/api/patient-images", require("./routes/patientImagesRoutes"));
app.use("/api/whatsapp", require("./routes/whatsappRoutes"));

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}... Ready for Cash!`);
});
