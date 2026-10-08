const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

// مسار تخزين الصور الطبية (على Vercel المسار الوحيد القابل للكتابة هو /tmp)
const uploadDir = process.env.VERCEL
  ? path.join(os.tmpdir(), "patient-images")
  : path.join(__dirname, "../uploads/patient-images");

// إنشاء المجلد بأمان مع حماية من انهيار السيرفر
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (err) {
  console.warn("⚠ Warning: Could not create upload directory:", err.message);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // اسم فريد مشفر + الامتداد الأصلي
    const uniqueSuffix = crypto.randomBytes(16).toString("hex");
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uniqueSuffix}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    const err = new Error(
      "نوع الملف غير مدعوم. الأنواع المسموحة هي: JPG, PNG, WEBP فقط."
    );
    err.status = 400;
    cb(err, false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 ميجابايت كحد أقصى
  },
});

module.exports = upload;
module.exports.uploadDir = uploadDir;
