require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const pool = require("./db");
const { captureError } = require("./utils/errorTracker");
const app = express();

// 1. خلف Vercel / Reverse Proxy نثق في أول Hop عشان نقرأ IP العميل الحقيقي
if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
  app.set("trust proxy", 1);
}

// 2. ترويسات الأمان الأساسية (Helmet)
app.use(helmet());

// 3. CORS Whitelist محكمة بدون ثغرة الـ Trailing Slash
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, "")) // تنظيف السلاش الأخيرة
  .filter(Boolean);

// في بيئة التطوير المحلية اسمح بالـ localhost تلقائياً
if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push("http://localhost:5173", "http://localhost:3000");
}

app.use(
  cors({
    origin: (origin, callback) => {
      // السماح بطلبات السيرفر الداخلية / الأدوات (no origin) أو الدومينات المعتمدة
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// 4. Body Parsers (حماية من الـ DoS عبر تقييد حجم الـ Payload)
app.use(express.json({ limit: "100kb" }));

// 5. Rate Limiters (محطوطة بعد الـ CORS لضمان وصول رسائل الـ 429 بترويسات سليمة)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 10, // 10 محاولات فاشلة
  skipSuccessfulRequests: true, // المحاولات الناجحة لا تحسب
  message: {
    error: "تم تجاوز عدد المحاولات المسموح بها، يرجى المحاولة بعد 15 دقيقة",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// تطبيق الـ Rate Limiter على تسجيل الدخول
app.use("/api/auth/login", loginLimiter);

// 6. Health Check Endpoint (لفحص جاهزية السيرفر والـ Database ومراقبة Uptime)
app.get("/api/health", async (req, res) => {
  const startTime = Date.now();
  try {
    const dbRes = await pool.query("SELECT 1 AS alive");
    const latency = Date.now() - startTime;

    res.status(200).json({
      status: "healthy",
      uptime_seconds: Math.floor(process.uptime()),
      db: {
        status: dbRes.rows.length > 0 ? "connected" : "unknown",
        latency_ms: latency,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    captureError(err, req);
    console.error("Health Check Failed:", err.message);

    return res.status(503).json({
      status: "unhealthy",
      error: "فشل الاتصال بقاعدة البيانات",
      timestamp: new Date().toISOString(),
    });
  }
});

const registerClinicLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: {
    error: "تم تجاوز عدد محاولات التسجيل، يرجى المحاولة لاحقاً",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/auth/register-clinic", registerClinicLimiter);

// 7. Routes التوجيه للموديولات
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
app.use("/api/staff", require("./routes/staffRoutes"));
app.use("/api/audit-logs", require("./routes/auditRoutes"));
app.use(
  "/api/doctor-availability",
  require("./routes/doctorAvailabilityRoutes")
);
app.use("/api/public", require("./routes/publicBookingRoutes"));
app.use("/api/booking-requests", require("./routes/bookingRequestsRoutes"));

// 8. مسار 404
app.use((req, res) => {
  res.status(404).json({ error: "المسار غير موجود" });
});

// 9. Global Error Handler المركزي
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "حجم الصورة أكبر من الحد المسموح (4 ميجابايت)"
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

  console.error("Unhandled Server Error:", err);

  // إرسال الخطأ إلى Sentry مع بيانات العيادة والمستخدم والمسار
  captureError(err, {
    method: req.method,
    url: req.originalUrl,
    clinic_id: req.user?.clinic_id || null,
    user_id: req.user?.id || null,
    ip: req.ip,
  });

  res.status(500).json({ error: "حدث خطأ غير متوقع في الخادم" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}... Ready for Cash!`);
});

module.exports = app;
