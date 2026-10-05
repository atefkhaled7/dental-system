require("dotenv").config();
const cors = require("cors");
const express = require("express");
const pool = require("./db");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const app = express();
const staffRoutes = require("./routes/staffRoutes");

// خلف Vercel لازم نثق في أول proxy عشان req.ip يطلع IP العميل الحقيقي
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(helmet());

// 2. حماية تسجيل الدخول من محاولات التخمين (10 محاولات كل 15 دقيقة)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: {
    error: "تم تجاوز عدد المحاولات المسموح بها، يرجى المحاولة بعد 15 دقيقة",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerClinicLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5, // 5 عيادات جديدة في الساعة لكل IP
  message: {
    error: "تم تجاوز عدد محاولات التسجيل، يرجى المحاولة لاحقاً",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/register-clinic", registerClinicLimiter);

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "100kb" }));

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
app.use("/api/staff", staffRoutes);

// 404 لأي مسار مش موجود
app.use((req, res) => {
  res.status(404).json({ error: "المسار غير موجود" });
});

// Global error handler (لازم 4 باراميترز)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "حجم الصورة أكبر من الحد المسموح (10 ميجابايت)"
        : "خطأ في رفع الملف";
    return res.status(400).json({ error: message });
  }

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "صيغة JSON غير صالحة" });
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "حجم الطلب كبير جداً" });
  }

  const status = err.status || err.statusCode || 500;

  if (status < 500) {
    return res.status(status).json({ error: err.message });
  }

  console.error("Unhandled error:", err);
  res.status(500).json({ error: "خطأ في السيرفر" });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}... Ready for Cash!`);
});

module.exports = app;
