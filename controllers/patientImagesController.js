const pool = require("../db");
const path = require("path");
const crypto = require("crypto");
const { logActivity } = require("../utils/auditLogger");
const storageService = require("../utils/storageService");
const { captureError } = require("../utils/errorTracker");
const VALID_CATEGORIES = [
  "xray_periapical",
  "xray_panoramic",
  "photo_before",
  "photo_after",
  "other",
];

const VALID_FDI_TEETH = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33,
  34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48,
]);

// 🔒 فحص الـ Magic Bytes مباشرة من الذاكرة (Buffer) بدون I/O
const verifyImageMagicBytes = (buffer) => {
  if (!buffer || buffer.length < 12) return false;

  // 1. JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }

  // 2. PNG: 89 50 4E 47
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return true;
  }

  // 3. WEBP: RIFF....WEBP
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return true;
  }

  return false;
};

// 1. رفع صورة طبية جديدة لمريض
const uploadPatientImage = async (req, res) => {
  let uploadedKey = null;

  try {
    const clinicId = req.user.clinic_id;
    const userId = req.user.id;
    const { patientId } = req.params;
    const { tooth_number, category, description } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "يرجى اختيار ملف الصورة لرفعه" });
    }

    // 🔒 1. فحص الـ Magic Bytes الحقيقي للملف من الـ Buffer
    const isValidImage = verifyImageMagicBytes(req.file.buffer);
    if (!isValidImage) {
      return res.status(400).json({
        error:
          "الملف المرفوع ليس صورة صالحة أو تم التلاعب بامتداده (يسمح فقط بـ JPG, PNG, WEBP)",
      });
    }

    // 🔒 2. فحص المريض وعزل العيادة
    const patientCheck = await pool.query(
      "SELECT id FROM patients WHERE id = $1 AND clinic_id = $2 AND is_active = TRUE",
      [patientId, clinicId]
    );

    if (patientCheck.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "المريض غير موجود في هذه العيادة أو تمت أرشفته" });
    }

    // 3. فحص رقم السن بنظام FDI
    let validatedTooth = null;
    if (
      tooth_number !== undefined &&
      tooth_number !== null &&
      tooth_number !== ""
    ) {
      const parsedTooth = parseInt(tooth_number, 10);
      if (isNaN(parsedTooth) || !VALID_FDI_TEETH.has(parsedTooth)) {
        return res.status(400).json({ error: "رقم السن غير صالح بنظام FDI" });
      }
      validatedTooth = parsedTooth;
    }

    const normalizedCategory =
      category && VALID_CATEGORIES.includes(category) ? category : "other";

    // توليد اسم فريد للملف
    const uniqueSuffix = crypto.randomBytes(16).toString("hex");
    const ext = path.extname(req.file.originalname).toLowerCase();
    const storageKey = `clinic_${clinicId}_${uniqueSuffix}${ext}`;

    // 🚀 الرفع عبر خدمة التخزين
    const uploadRes = await storageService.uploadFile({
      buffer: req.file.buffer,
      filename: storageKey,
      mimeType: req.file.mimetype,
    });
    uploadedKey = uploadRes.key;

    const query = `
      INSERT INTO patient_images (
        clinic_id, patient_id, tooth_number, category, 
        file_url, file_name, mime_type, file_size, description, uploaded_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *;
    `;

    const values = [
      clinicId,
      patientId,
      validatedTooth,
      normalizedCategory,
      uploadRes.key,
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
      description ? description.trim() : null,
      userId,
    ];

    const result = await pool.query(query, values);

    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: userId,
        action: "UPLOAD_PATIENT_IMAGE",
        entity_type: "patient_image",
        entity_id: result.rows[0].id,
        description: `قام ${
          req.user.name || "الطبيب"
        } برفع صورة طبية (${normalizedCategory}) للمريض #${patientId.slice(
          0,
          8
        )}`,
        metadata: {
          category: normalizedCategory,
          tooth_number: validatedTooth,
          file_size: req.file.size,
        },
      });
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    res.status(201).json({
      message: "تم رفع وتوثيق الصورة الطبية بنجاح",
      image: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    if (uploadedKey) {
      await storageService.deleteFile(uploadedKey);
    }
    console.error("Error uploading patient image:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء رفع الصورة" });
  }
};

const getPatientImages = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { patientId } = req.params;
    const { tooth_number, category, archived, page, limit } = req.query;
    const isArchived = archived === "true";

    let query = `
      SELECT 
        pi.*,
        u.name AS doctor_name,
        COUNT(*) OVER() AS full_count
      FROM patient_images pi
      LEFT JOIN users u ON pi.uploaded_by = u.id
      WHERE pi.clinic_id = $1 AND pi.patient_id = $2 AND pi.is_archived = $3
    `;
    const queryParams = [clinicId, patientId, isArchived];

    if (tooth_number) {
      queryParams.push(parseInt(tooth_number, 10));
      query += ` AND pi.tooth_number = $${queryParams.length}`;
    }
    if (category && VALID_CATEGORIES.includes(category)) {
      queryParams.push(category);
      query += ` AND pi.category = $${queryParams.length}`;
    }
    query += ` ORDER BY pi.created_at DESC`;

    const isPaginated = page !== undefined || limit !== undefined;
    if (isPaginated) {
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
      const offset = (pageNum - 1) * limitNum;

      query += ` LIMIT $${queryParams.length + 1} OFFSET $${
        queryParams.length + 2
      };`;
      queryParams.push(limitNum, offset);

      const result = await pool.query(query, queryParams);
      const total =
        result.rows.length > 0 ? Number(result.rows[0].full_count) : 0;
      const images = result.rows.map(({ full_count, ...img }) => img);
      const totalPages = Math.ceil(total / limitNum) || 1;

      return res.status(200).json({
        images,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages,
        },
      });
    }

    const result = await pool.query(query + ";", queryParams);
    const images = result.rows.map(({ full_count, ...img }) => img);
    res.status(200).json({ images });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching patient images:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء جلب الصور الطبية" });
  }
};

// 🌟 3. عرض وتحميل الصورة الطبية بأمان (Streaming من Cloudinary أو محلياً)
const getProtectedImageFile = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { id } = req.params;

    const imageQuery = `
      SELECT file_url, file_name, mime_type 
      FROM patient_images 
      WHERE id = $1 AND clinic_id = $2;
    `;
    const imageRes = await pool.query(imageQuery, [id, clinicId]);

    if (imageRes.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "الصورة غير موجودة أو غير مصرح لك بالوصول إليها" });
    }

    const { file_url, mime_type } = imageRes.rows[0];

    const fileData = await storageService.getFileStream(file_url);
    if (!fileData) {
      return res.status(404).json({ error: "ملف الصورة غير موجود على الخادم" });
    }

    res.setHeader("Content-Type", mime_type);
    res.setHeader("Cache-Control", "private, max-age=86400"); // كاش آمن لمدة يوم للمستخدم المصرح له

    // لو الـ stream متاح (سواء من R2 أو FileStream)
    if (fileData.stream?.pipe) {
      fileData.stream.pipe(res);
    } else if (fileData.filePath) {
      res.sendFile(fileData.filePath);
    } else {
      captureError(error, req);
      res.status(500).json({ error: "تعذر قراءة بيانات الملف" });
    }
  } catch (error) {
    captureError(error, req);
    console.error("Error streaming image file:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء فتح الصورة" });
  }
};

// 4. أرشفة الصورة الطبية (Soft Delete)
const archivePatientImage = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const userRole = req.user.role;
    const { id } = req.params;

    if (!["ClinicAdmin", "Doctor"].includes(userRole)) {
      return res
        .status(403)
        .json({ error: "غير مصرح لك بأرشفة السجلات الطبية أو صور الأشعة" });
    }

    const query = `
      UPDATE patient_images
      SET is_archived = TRUE
      WHERE id = $1 AND clinic_id = $2 AND is_archived = FALSE
      RETURNING *;
    `;

    const result = await pool.query(query, [id, clinicId]);

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "الصورة الطبية غير موجودة أو تمت أرشفتها بالفعل" });
    }

    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: "ARCHIVE_PATIENT_IMAGE",
        entity_type: "patient_image",
        entity_id: id,
        description: `قام ${
          req.user.name || "المستخدم"
        } بأرشفة صورة طبية للمريض #${result.rows[0].patient_id.slice(0, 8)}`,
        metadata: {
          image_id: id,
        },
      });
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    res.status(200).json({
      message: "تمت أرشفة الصورة الطبية بنجاح مع الحفاظ على السجل القانوني",
      image: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error archiving patient image:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء أرشفة الصورة" });
  }
};

module.exports = {
  uploadPatientImage,
  getPatientImages,
  getProtectedImageFile,
  archivePatientImage,
};
