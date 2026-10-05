const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// مسار تخزين الصور الطبية
const uploadDir = path.join(__dirname, "../uploads/patient-images");

// إنشاء المجلد إذا لم يكن موجوداً
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
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
