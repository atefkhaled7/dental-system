const pool = require("../db");
const { isValidUuid } = require("../middleware/validateUuid");
const { normalizeEgyptianPhone } = require("../utils/phoneNormalizer");
const { captureError } = require("../utils/errorTracker");
const {
  validateAppointmentSlot,
} = require("../services/appointmentConflictEngine");
const {
  uploadPublicSiteImage,
  deleteFile,
} = require("../utils/storageService");

const isRealDate = (dateStr) => {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr))
    return false;
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dateStr;
};

const cairoLocalTimeToDate = (dateStr, timeStr) => {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);

  const targetUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utcMs = targetUtcMs;

  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(utcMs));

    const values = {};
    for (const part of parts) {
      if (part.type !== "literal") values[part.type] = part.value;
    }

    const cairoAsUtcMs = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );

    const offsetMs = cairoAsUtcMs - utcMs;
    utcMs = targetUtcMs - offsetMs;
  }

  return new Date(utcMs);
};

const isClinicPublicAssetKey = (key, clinicId) =>
  typeof key === "string" && key.startsWith(`curosta_public_site/${clinicId}/`);

// التحقق إن الرابط https صالح (يمنع javascript: وغيره)
const isHttpsUrl = (value) => {
  if (typeof value !== "string") return false;
  try {
    return new URL(value.trim()).protocol === "https:";
  } catch {
    return false;
  }
};

// حدود الأطوال حسب أعمدة جدول clinic_site
const SITE_MAX_LENGTHS = {
  hero_title: 200,
  whatsapp_number: 30,
  city: 100,
  area: 100,
  theme_color: 20,
  seo_title: 200,
};

const SITE_URL_FIELDS = [
  "logo_url",
  "cover_url",
  "facebook_url",
  "instagram_url",
  "tiktok_url",
  "google_maps_url",
];

// جلب العيادة عبر الـ slug أو الـ UUID أو البحث في slug_history للتحويل 301
const resolveClinic = async (identifier) => {
  if (!identifier || typeof identifier !== "string") return null;
  const cleanId = identifier.trim().toLowerCase();

  let query = `
    SELECT id, name, phone_number, address, bio, slug, is_active,
           subscription_ends_at, default_appointment_duration,
           COALESCE(total_chairs_count, 1) AS total_chairs_count
    FROM clinics
    WHERE `;

  if (isValidUuid(cleanId)) {
    query += "id = $1;";
  } else {
    query += "LOWER(slug) = $1;";
  }

  const res = await pool.query(query, [cleanId]);
  if (res.rows.length > 0) {
    if (res.rows[0].is_active === false) return null;
    return { clinic: res.rows[0], redirected: false };
  }

  // إذا لم يُعثر على الـ slug الحالي، نبحث في slug_history لدعم التحويل الدائم 301
  if (!isValidUuid(cleanId)) {
    const historyRes = await pool.query(
      `
      SELECT c.id, c.name, c.phone_number, c.address, c.bio, c.slug, c.is_active,
             c.subscription_ends_at, c.default_appointment_duration,
             COALESCE(c.total_chairs_count, 1) AS total_chairs_count
      FROM slug_history sh
      JOIN clinics c ON sh.clinic_id = c.id
      WHERE LOWER(sh.old_slug) = $1 AND c.is_active = TRUE
      LIMIT 1;
      `,
      [cleanId],
    );

    if (historyRes.rows.length > 0) {
      return { clinic: historyRes.rows[0], redirected: true };
    }
  }

  return null;
};

// التحقق الاختياري من Cloudflare Turnstile إن كان مفعلاً في السيرفر
const verifyTurnstileToken = async (token, remoteIp) => {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey) return true; // غير مفعل في البيئة الحالية
  if (!token) return false;

  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: secretKey,
          response: token,
          remoteip: remoteIp,
        }),
      },
    );
    const data = await response.json();
    return Boolean(data.success);
  } catch (err) {
    console.error("Turnstile verification error:", err.message);
    return false;
  }
};

// ==========================================
// 1. جلب بيانات الموقع العام للعيادة + SEO JSON-LD (GET /public/clinics/:slug)
// ==========================================
const getPublicClinicProfile = async (req, res) => {
  const slug = req.params.slug || req.params.slugOrId;

  try {
    const resolved = await resolveClinic(slug);
    if (!resolved || !resolved.clinic) {
      return res
        .status(404)
        .json({ error: "العيادة غير موجودة أو غير متاحة حالياً" });
    }

    const { clinic, redirected } = resolved;

    // نجيب بيانات الموقع أولاً (بأعمدة صريحة) ونفحص النشر قبل باقي الاستعلامات
    const siteRes = await pool.query(
      `SELECT hero_title, hero_subtitle, logo_url, cover_url, whatsapp_number,
              facebook_url, instagram_url, tiktok_url, google_maps_url,
              city, area, theme_color, seo_title, seo_description, is_published
       FROM clinic_site
       WHERE clinic_id = $1`,
      [clinic.id],
    );
    const site = siteRes.rows[0] || {};

    if (site.is_published === false) {
      return res
        .status(404)
        .json({ error: "الموقع العام لهذه العيادة غير منشور حالياً" });
    }

    const [
      bookingSettingsRes,
      doctorsRes,
      servicesRes,
      galleryRes,
      faqsRes,
      testimonialsRes,
      workingHoursRes,
    ] = await Promise.all([
      pool.query(
        `SELECT is_online_booking_enabled, min_advance_hours, max_advance_days, booking_instructions
         FROM booking_settings
         WHERE clinic_id = $1`,
        [clinic.id],
      ),
      pool.query(
        `SELECT id, name FROM users WHERE clinic_id = $1 AND role = 'Doctor' AND is_active = TRUE ORDER BY name ASC;`,
        [clinic.id],
      ),
      pool.query(
        `SELECT id, code, description, default_price, duration_minutes FROM procedure_codes WHERE clinic_id = $1 AND is_active = TRUE ORDER BY description ASC;`,
        [clinic.id],
      ),
      pool.query(
        `SELECT id, image_url, before_image_url, caption, category, sort_order FROM clinic_gallery_items WHERE clinic_id = $1 ORDER BY sort_order ASC, created_at DESC LIMIT 12;`,
        [clinic.id],
      ),
      pool.query(
        `SELECT id, question, answer, sort_order FROM clinic_faqs WHERE clinic_id = $1 AND is_visible = TRUE ORDER BY sort_order ASC, created_at ASC;`,
        [clinic.id],
      ),
      pool.query(
        `SELECT id, patient_display_name, rating, comment, sort_order, created_at FROM clinic_testimonials WHERE clinic_id = $1 AND is_visible = TRUE ORDER BY sort_order ASC, created_at DESC LIMIT 10;`,
        [clinic.id],
      ),
      pool.query(
        `SELECT weekday, open_time, close_time, is_closed FROM clinic_working_hours WHERE clinic_id = $1 ORDER BY weekday ASC;`,
        [clinic.id],
      ),
    ]);

    const bookingSettings = bookingSettingsRes.rows[0] || {
      is_online_booking_enabled: true,
      min_advance_hours: 2,
      max_advance_days: 30,
      booking_instructions: null,
    };

    const isSubscriptionExpired = Boolean(
      clinic.subscription_ends_at &&
      new Date(clinic.subscription_ends_at) < new Date(),
    );

    const isBookingEnabled =
      !isSubscriptionExpired &&
      bookingSettings.is_online_booking_enabled !== false;

    const frontendBase = (
      process.env.FRONTEND_URL || "https://curosta.com"
    ).replace(/\/$/, "");
    const canonicalUrl = `${frontendBase}/c/${clinic.slug}`;

    // توليد كائن JSON-LD قياسي من نوع Dentist لمحركات بحث جوجل
    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "Dentist",
      name: site.seo_title || clinic.name,
      description:
        site.seo_description ||
        site.hero_subtitle ||
        clinic.bio ||
        `احجز موعدك أونلاين في ${clinic.name} - رعاية متكاملة لطب وجراحة الأسنان.`,
      url: canonicalUrl,
      telephone: site.whatsapp_number || clinic.phone_number || undefined,
      image: site.cover_url || site.logo_url || undefined,
      address: {
        "@type": "PostalAddress",
        streetAddress: clinic.address || undefined,
        addressLocality: site.area || site.city || "مصر",
        addressCountry: "EG",
      },
    };

    return res.status(200).json({
      redirect_301: redirected ? clinic.slug : null,
      clinic: {
        id: clinic.id,
        name: clinic.name,
        phone_number: clinic.phone_number,
        whatsapp_number: site.whatsapp_number || clinic.phone_number,
        address: clinic.address || "العنوان متاح بالعيادة",
        city: site.city || "",
        area: site.area || "",
        bio:
          clinic.bio ||
          "عيادة أسنان متخصصة تقدم أحدث خدمات طب وجراحة وتجميل الأسنان.",
        slug: clinic.slug,
        hero_title: site.hero_title || clinic.name,
        hero_subtitle:
          site.hero_subtitle ||
          clinic.bio ||
          "ابتسامتك الصحية تبدأ من هنا — احجز موعدك الآن بسهولة",
        logo_url: site.logo_url || null,
        cover_url: site.cover_url || null,
        facebook_url: site.facebook_url || null,
        instagram_url: site.instagram_url || null,
        tiktok_url: site.tiktok_url || null,
        google_maps_url: site.google_maps_url || null,
        theme_color: site.theme_color || "#14b8a6",
        is_booking_enabled: isBookingEnabled,
        booking_settings: bookingSettings,
      },
      doctors: doctorsRes.rows,
      services: servicesRes.rows,
      gallery: galleryRes.rows,
      faqs: faqsRes.rows,
      testimonials: testimonialsRes.rows,
      working_hours: workingHoursRes.rows,
      seo: {
        title: site.seo_title || `${clinic.name} | حجز موعد أسنان أونلاين`,
        description:
          site.seo_description ||
          site.hero_subtitle ||
          clinic.bio ||
          `احجز موعدك الآن في ${clinic.name}`,
        canonical_url: canonicalUrl,
        og_image: site.cover_url || site.logo_url || null,
        json_ld: jsonLd,
      },
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching public clinic profile:", error.message);
    return res.status(500).json({
      error: "حدث خطأ أثناء تحميل بيانات العيادة",
    });
  }
};

// ==========================================
// 2. مسار حساب الخانات المتاحة (GET /public/clinics/:slug/slots)
// يستهلك نفس قواعد محرك التعارضات وساعات عمل العيادة والعطلات وتزامن الكراسي
// ==========================================
const getPublicAvailableSlots = async (req, res) => {
  const slug = req.params.slug || req.params.slugOrId;
  const { doctor_id, date, procedure_id } = req.query;

  try {
    const resolved = await resolveClinic(slug);
    if (!resolved || !resolved.clinic) {
      return res.status(404).json({ error: "العيادة غير موجودة" });
    }
    const { clinic } = resolved;

    const isSubscriptionExpired = Boolean(
      clinic.subscription_ends_at &&
      new Date(clinic.subscription_ends_at) < new Date(),
    );

    const bookingSettingsRes = await pool.query(
      `SELECT * FROM booking_settings WHERE clinic_id = $1`,
      [clinic.id],
    );
    const bookingSettings = bookingSettingsRes.rows[0] || {
      is_online_booking_enabled: true,
      min_advance_hours: 2,
      max_advance_days: 30,
    };

    if (
      isSubscriptionExpired ||
      bookingSettings.is_online_booking_enabled === false
    ) {
      return res.status(200).json({
        available: false,
        reason:
          "الحجز الإلكتروني غير متاح لهذه العيادة حالياً، يرجى التواصل هاتفياً.",
        slots: [],
      });
    }

    if (!doctor_id || !isValidUuid(doctor_id)) {
      return res.status(400).json({ error: "يجب اختيار الطبيب" });
    }
    const doctorCheck = await pool.query(
      `SELECT id
   FROM users
   WHERE id = $1
     AND clinic_id = $2
     AND role = 'Doctor'
     AND is_active = TRUE
   LIMIT 1`,
      [doctor_id, clinic.id],
    );

    if (doctorCheck.rows.length === 0) {
      return res.status(404).json({
        error: "الطبيب غير موجود أو غير متاح في هذه العيادة",
      });
    }

    if (!date || !isRealDate(date)) {
      return res
        .status(400)
        .json({ error: "تاريخ الكشف غير صالح، استخدم الصيغة YYYY-MM-DD" });
    }

    const todayCairo = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
    }).format(new Date());

    if (date < todayCairo) {
      return res.status(400).json({ error: "لا يمكن حجز موعد في تاريخ سابق" });
    }

    // 1. فحص عطلات العيادة الرسمية (clinic_holidays)
    const holidayRes = await pool.query(
      `SELECT reason FROM clinic_holidays WHERE clinic_id = $1 AND date = $2::date LIMIT 1`,
      [clinic.id, date],
    );
    if (holidayRes.rows.length > 0) {
      const r = holidayRes.rows[0].reason;
      return res.status(200).json({
        available: false,
        reason: `العيادة في عطلة رسمية في هذا التاريخ${r ? ` (${r})` : ""}`,
        slots: [],
      });
    }

    // حساب يوم الأسبوع (0=الأحد .. 6=السبت)
    const targetDate = new Date(`${date}T12:00:00Z`);
    const dayOfWeek = targetDate.getUTCDay();

    // 2. فحص ساعات عمل العيادة الرسمية (clinic_working_hours)
    const clinicHoursRes = await pool.query(
      `SELECT open_time, close_time, breaks, is_closed FROM clinic_working_hours WHERE clinic_id = $1 AND weekday = $2 LIMIT 1`,
      [clinic.id, dayOfWeek],
    );

    const clinicDaySchedule = clinicHoursRes.rows[0] || null;
    if (clinicDaySchedule && clinicDaySchedule.is_closed) {
      return res.status(200).json({
        available: false,
        reason: "العيادة مغلقة في هذا اليوم من الأسبوع",
        slots: [],
      });
    }

    // 3. فحص إجازات الطبيب (doctor_leaves)
    const leaveCheck = await pool.query(
      "SELECT notes FROM doctor_leaves WHERE clinic_id = $1 AND doctor_id = $2 AND leave_date = $3::date;",
      [clinic.id, doctor_id, date],
    );
    if (leaveCheck.rows.length > 0) {
      return res.status(200).json({
        available: false,
        reason: "الطبيب في إجازة في هذا التاريخ",
        slots: [],
      });
    }

    // 4. جلب شفتات الطبيب (أو استخدام ساعات عمل العيادة إذا لم يكن للطبيب جدول شفتات مخصص)
    const anyDoctorShiftRes = await pool.query(
      `SELECT COUNT(*)::int AS total_shifts FROM doctor_availability WHERE clinic_id = $1 AND doctor_id = $2 AND is_active = TRUE`,
      [clinic.id, doctor_id],
    );

    let activeWindows = [];
    if (anyDoctorShiftRes.rows[0].total_shifts > 0) {
      const shiftsRes = await pool.query(
        `SELECT start_time, end_time FROM doctor_availability
         WHERE clinic_id = $1 AND doctor_id = $2 AND day_of_week = $3 AND is_active = TRUE
         ORDER BY start_time ASC;`,
        [clinic.id, doctor_id, dayOfWeek],
      );
      if (shiftsRes.rows.length === 0) {
        return res.status(200).json({
          available: false,
          reason: "الطبيب لا يعمل في هذا اليوم",
          slots: [],
        });
      }
      activeWindows = shiftsRes.rows;
    } else if (clinicDaySchedule) {
      activeWindows = [
        {
          start_time: clinicDaySchedule.open_time,
          end_time: clinicDaySchedule.close_time,
        },
      ];
    } else {
      activeWindows = [{ start_time: "10:00:00", end_time: "22:00:00" }];
    }

    // 5. حساب مدة الكشف بناءً على الخدمة المختارة أو الافتراضي للعيادة
    let slotDuration = null;
    if (
      procedure_id &&
      typeof procedure_id === "string" &&
      procedure_id.trim() !== "" &&
      procedure_id !== "null" &&
      procedure_id !== "undefined"
    ) {
      if (!isValidUuid(procedure_id.trim())) {
        return res.status(400).json({ error: "معرّف الخدمة غير صالح" });
      }
      const procRes = await pool.query(
        `SELECT duration_minutes FROM procedure_codes WHERE id = $1 AND clinic_id = $2 AND is_active = TRUE;`,
        [procedure_id.trim(), clinic.id],
      );
      if (procRes.rows.length === 0) {
        return res.status(404).json({
          error: "الخدمة غير موجودة أو غير متاحة في هذه العيادة",
        });
      }

      slotDuration = Number(procRes.rows[0].duration_minutes) || null;
    }
    if (!slotDuration) {
      slotDuration = Number(clinic.default_appointment_duration) || 30;
    }
    slotDuration = Math.min(480, Math.max(5, slotDuration));

    // 6. جلب جميع مواعيد العيادة في هذا اليوم (لفحص تعارض الطبيب + فحص سعة الكراسي الإجمالية!)
    const [allClinicApptsRes, pendingRequestsRes] = await Promise.all([
      pool.query(
        `SELECT doctor_id, appointment_date, (appointment_date + (duration_minutes * INTERVAL '1 minute')) AS appointment_end
         FROM appointments
        WHERE clinic_id = $1 AND status IN ('scheduled', 'arrived', 'in_progress')
           AND DATE(appointment_date AT TIME ZONE 'Africa/Cairo') = $2::date;`,
        [clinic.id, date],
      ),
      pool.query(
        `SELECT doctor_id, requested_date, (requested_date + (duration_minutes * INTERVAL '1 minute')) AS request_end
         FROM booking_requests
         WHERE clinic_id = $1 AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP
           AND DATE(requested_date AT TIME ZONE 'Africa/Cairo') = $2::date;`,
        [clinic.id, date],
      ),
    ]);

    const allIntervals = [
      ...allClinicApptsRes.rows.map((r) => ({
        doctor_id: r.doctor_id,
        start: new Date(r.appointment_date).getTime(),
        end: new Date(r.appointment_end).getTime(),
      })),
      ...pendingRequestsRes.rows.map((r) => ({
        doctor_id: r.doctor_id,
        start: new Date(r.requested_date).getTime(),
        end: new Date(r.request_end).getTime(),
      })),
    ];

    const minAdvanceMs =
      Number(bookingSettings.min_advance_hours ?? 2) * 60 * 60 * 1000;

    const maxAdvanceDays = Number(bookingSettings.max_advance_days ?? 30);

    const maxAdvanceMs = maxAdvanceDays * 24 * 60 * 60 * 1000;
    const nowTime = Date.now();
    const totalChairs = Number(clinic.total_chairs_count) || 1;

    // حدود ساعات فتح وإغلاق العيادة وفترات الراحة
    const clinicOpenMs = clinicDaySchedule
      ? cairoLocalTimeToDate(
          date,
          clinicDaySchedule.open_time.slice(0, 5),
        ).getTime()
      : null;
    const clinicCloseMs = clinicDaySchedule
      ? cairoLocalTimeToDate(
          date,
          clinicDaySchedule.close_time.slice(0, 5),
        ).getTime()
      : null;

    const clinicBreaksMs = Array.isArray(clinicDaySchedule?.breaks)
      ? clinicDaySchedule.breaks
          .filter((b) => b.start && b.end)
          .map((b) => ({
            start: cairoLocalTimeToDate(date, b.start.slice(0, 5)).getTime(),
            end: cairoLocalTimeToDate(date, b.end.slice(0, 5)).getTime(),
          }))
      : [];

    const availableSlots = [];

    for (const shift of activeWindows) {
      const [startHour, startMin] = shift.start_time.split(":").map(Number);
      const [endHour, endMin] = shift.end_time.split(":").map(Number);

      let currentSlotTime = cairoLocalTimeToDate(
        date,
        `${String(startHour).padStart(2, "0")}:${String(startMin).padStart(2, "0")}`,
      ).getTime();

      const shiftEndTime = cairoLocalTimeToDate(
        date,
        `${String(endHour).padStart(2, "0")}:${String(endMin).padStart(2, "0")}`,
      ).getTime();

      const slotDurationMs = slotDuration * 60 * 1000;

      while (currentSlotTime + slotDurationMs <= shiftEndTime) {
        const slotStart = currentSlotTime;
        const slotEnd = currentSlotTime + slotDurationMs;

        // أ) هل الوقت مضى أو أقل من مهلة الحجز المسبقة؟
        const isTooSoon = slotStart <= nowTime + minAdvanceMs;
        const isTooFar = slotStart > nowTime + maxAdvanceMs;

        // ب) هل يقع خارج ساعات فتح وإغلاق العيادة أو داخل فترة راحة؟
        const outsideClinicHours =
          (clinicOpenMs !== null && slotStart < clinicOpenMs) ||
          (clinicCloseMs !== null && slotEnd > clinicCloseMs);

        const inClinicBreak = clinicBreaksMs.some(
          (brk) => slotStart < brk.end && slotEnd > brk.start,
        );

        // ج) هل يتعارض مع موعد لنفس الطبيب؟
        const hasDoctorOverlap = allIntervals.some(
          (b) =>
            b.doctor_id === doctor_id && slotStart < b.end && slotEnd > b.start,
        );

        // د) فحص تزامن الكراسي: هل كل كراسي العيادة مشغولة في هذه الفترة؟
        const overlappingIntervals = allIntervals.filter(
          (b) => slotStart < b.end && slotEnd > b.start,
        );

        const occupancyEvents = overlappingIntervals.flatMap((b) => [
          {
            time: Math.max(slotStart, b.start),
            delta: 1,
          },
          {
            time: Math.min(slotEnd, b.end),
            delta: -1,
          },
        ]);

        // عند تساوي الأوقات، ننهي الموعد القديم قبل بدء الجديد
        occupancyEvents.sort((a, b) => a.time - b.time || a.delta - b.delta);

        let activeChairs = 0;
        let peakConcurrent = 0;

        for (const event of occupancyEvents) {
          activeChairs += event.delta;
          peakConcurrent = Math.max(peakConcurrent, activeChairs);
        }

        const chairsFull = peakConcurrent >= totalChairs;

        if (
          !isTooSoon &&
          !isTooFar &&
          !outsideClinicHours &&
          !inClinicBreak &&
          !hasDoctorOverlap &&
          !chairsFull
        ) {
          const slotDateObj = new Date(slotStart);
          const timeString = slotDateObj.toLocaleTimeString("ar-EG", {
            timeZone: "Africa/Cairo",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          });
          availableSlots.push({
            time: timeString,
            iso: slotDateObj.toISOString(),
            duration_minutes: slotDuration,
          });
        }

        currentSlotTime += slotDurationMs;
      }
    }

    return res.status(200).json({
      available: availableSlots.length > 0,
      date,
      total_slots: availableSlots.length,
      slots: availableSlots,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching public slots:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء حساب الأوقات المتاحة" });
  }
};

// ==========================================
// 3. إنشاء طلب حجز عام (POST /public/clinics/:slug/booking-requests)
// يستهلك محرك التعارضات المركزي وفحص الكراسي
// ==========================================
const createPublicBookingRequest = async (req, res) => {
  const slug = req.params.slug || req.params.slugOrId;
  const {
    doctor_id,
    procedure_id,
    requested_date,
    patient_name,
    patient_phone,
    notes,
    cf_turnstile_token,
  } = req.body || {};

  let client;

  try {
    // التحقق من Cloudflare Turnstile إن كان مفعلاً
    const turnstileOk = await verifyTurnstileToken(cf_turnstile_token, req.ip);
    if (!turnstileOk) {
      return res.status(400).json({
        error:
          "فشل التحقق الأمني ضد البوتات، يرجى تحديث الصفحة والمحاولة ثانية.",
      });
    }

    const resolved = await resolveClinic(slug);
    if (!resolved || !resolved.clinic) {
      return res.status(404).json({ error: "العيادة غير موجودة أو معطلة" });
    }
    const { clinic } = resolved;

    const isSubscriptionExpired = Boolean(
      clinic.subscription_ends_at &&
      new Date(clinic.subscription_ends_at) < new Date(),
    );
    if (isSubscriptionExpired) {
      return res.status(403).json({
        error:
          "نعتذر، الحجز الإلكتروني غير متاح حالياً لهذه العيادة، يرجى الاتصال بالعيادة هاتفياً.",
      });
    }

    const bookingSettingsRes = await pool.query(
      `SELECT is_online_booking_enabled, min_advance_hours, max_advance_days
   FROM booking_settings
   WHERE clinic_id = $1`,
      [clinic.id],
    );

    const bookingSettings = bookingSettingsRes.rows[0] || {
      is_online_booking_enabled: true,
      min_advance_hours: 2,
      max_advance_days: 30,
    };

    if (bookingSettings.is_online_booking_enabled === false) {
      return res.status(403).json({
        error: "الحجز الإلكتروني غير متاح لهذه العيادة حاليًا.",
      });
    }

    if (
      !patient_name ||
      typeof patient_name !== "string" ||
      patient_name.trim().length < 2
    ) {
      return res.status(400).json({
        error: "اسم المريض مطلوب ويجب أن يكون حرفين على الأقل",
      });
    }
    if (patient_name.trim().length > 100) {
      return res.status(400).json({
        error: "اسم المريض يجب ألا يتجاوز 100 حرف",
      });
    }
    if (notes != null && typeof notes !== "string") {
      return res.status(400).json({
        error: "صيغة الملاحظات غير صالحة",
      });
    }

    if (typeof notes === "string" && notes.trim().length > 1000) {
      return res.status(400).json({
        error: "الملاحظات يجب ألا تتجاوز 1000 حرف",
      });
    }
    const cleanPhone = normalizeEgyptianPhone(patient_phone);
    if (!cleanPhone) {
      return res.status(400).json({ error: "رقم الهاتف المصري غير صحيح" });
    }

    if (!doctor_id || !isValidUuid(doctor_id)) {
      return res.status(400).json({ error: "يرجى اختيار الطبيب المعالج" });
    }

    let normalizedProcedureId = null;
    if (
      procedure_id &&
      typeof procedure_id === "string" &&
      procedure_id.trim() !== "" &&
      procedure_id !== "null" &&
      procedure_id !== "undefined"
    ) {
      if (!isValidUuid(procedure_id.trim())) {
        return res.status(400).json({ error: "معرّف الخدمة غير صالح" });
      }
      normalizedProcedureId = procedure_id.trim();
    }

    if (!requested_date) {
      return res.status(400).json({ error: "يرجى تحديد وقت الموعد المطلوب" });
    }

    const reqDate = new Date(requested_date);
    if (isNaN(reqDate.getTime())) {
      return res.status(400).json({ error: "موعد الحجز غير صالح" });
    }

    const now = new Date();

    const minAdvanceHours = Number(bookingSettings.min_advance_hours ?? 2);
    const maxAdvanceDays = Number(bookingSettings.max_advance_days ?? 30);

    const minimumBookingTime = new Date(
      now.getTime() + minAdvanceHours * 60 * 60 * 1000,
    );

    const maximumBookingTime = new Date(
      now.getTime() + maxAdvanceDays * 24 * 60 * 60 * 1000,
    );

    if (reqDate <= minimumBookingTime) {
      return res.status(400).json({
        error: `يجب اختيار موعد بعد ${minAdvanceHours} ساعة على الأقل`,
      });
    }

    if (reqDate > maximumBookingTime) {
      return res.status(400).json({
        error: `لا يمكن الحجز قبل أكثر من ${maxAdvanceDays} يومًا`,
      });
    }

    let duration = null;
    if (normalizedProcedureId) {
      const procRes = await pool.query(
        `SELECT duration_minutes FROM procedure_codes WHERE id = $1 AND clinic_id = $2 AND is_active = TRUE;`,
        [normalizedProcedureId, clinic.id],
      );
      if (procRes.rows.length === 0) {
        return res
          .status(404)
          .json({ error: "الخدمة غير موجودة أو غير متاحة حالياً" });
      }
      duration = Number(procRes.rows[0].duration_minutes) || null;
    }
    if (!duration) {
      duration = Number(clinic.default_appointment_duration) || 30;
    }
    duration = Math.min(480, Math.max(5, duration));

    const slotEnd = new Date(reqDate.getTime() + duration * 60 * 1000);

    client = await pool.connect();
    try {
      await client.query("BEGIN");
      // منع طلبات الحجز العامة المتزامنة من تجاوز سعة العيادة في نفس اليوم
      const localDateResult = await client.query(
        `SELECT TO_CHAR(
     ($1::timestamptz AT TIME ZONE 'Africa/Cairo')::date,
     'YYYY-MM-DD'
   ) AS local_date`,
        [reqDate.toISOString()],
      );

      const localDateKey = localDateResult.rows[0].local_date;
      await client.query(
        `SELECT pg_advisory_xact_lock(
     hashtext($1::text),
     hashtext($2::text)
   )`,
        [clinic.id, localDateKey],
      );
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text));`,
        [clinic.id, cleanPhone],
      );

      // 1. منع تكرار طلب حجز معلق لنفس الهاتف
      const pendingCheck = await client.query(
        `SELECT id FROM booking_requests
         WHERE clinic_id = $1 AND patient_phone = $2 AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP
         LIMIT 1;`,
        [clinic.id, cleanPhone],
      );

      if (pendingCheck.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:
            "لديك طلب حجز سابق قيد المراجعة بالفعل، يرجى انتظار تأكيد العيادة.",
        });
      }

      // 2. قفل صف الطبيب
      const docLock = await client.query(
        `SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor' AND is_active = TRUE FOR UPDATE;`,
        [doctor_id, clinic.id],
      );
      if (docLock.rows.length === 0) {
        await client.query("ROLLBACK");
        return res
          .status(404)
          .json({ error: "الطبيب غير متاح حالياً في هذه العيادة" });
      }

      // 3. استدعاء محرك التعارضات المركزي (عطلة العيادة، ساعات العيادة، شيفت الطبيب، تداخل المواعيد، وسعة الكراسي)
      const conflictResult = await validateAppointmentSlot(client, {
        clinic_id: clinic.id,
        doctor_id,
        appointmentDateISO: reqDate.toISOString(),
        durationMinutes: duration,
      });

      if (conflictResult.hasConflict) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: conflictResult.error,
          code: conflictResult.code,
        });
      }

      // 4. فحص التعارض مع طلبات الحجز المعلقة الأخرى
      const pendingConflictRes = await client.query(
        `SELECT id FROM booking_requests
         WHERE clinic_id = $1 AND doctor_id = $2 AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP
           AND requested_date < $4
           AND (requested_date + (duration_minutes * INTERVAL '1 minute')) > $3
         LIMIT 1;`,
        [clinic.id, doctor_id, reqDate.toISOString(), slotEnd.toISOString()],
      );

      if (pendingConflictRes.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "هذا الموعد تم طلب حجزه للتو، يرجى اختيار توقيت آخر",
        });
      }

      const expiry24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const expiresAt = new Date(
        Math.min(expiry24h.getTime(), reqDate.getTime()),
      );

      const chairOccupancyResult = await client.query(
        `
  WITH existing_intervals AS (
    -- المواعيد الموجودة التي تشغل الكراسي
    SELECT
      GREATEST(
        a.appointment_date,
        $1::timestamptz
      ) AS starts_at,
      LEAST(
        a.appointment_date
          + make_interval(
              mins => COALESCE(NULLIF(a.duration_minutes, 0), 30)
            ),
        $2::timestamptz
      ) AS ends_at
    FROM appointments a
    WHERE a.clinic_id = $3
      AND a.status IN ('scheduled', 'arrived', 'in_progress')
      AND a.appointment_date < $2::timestamptz
      AND a.appointment_date
        + make_interval(
            mins => COALESCE(NULLIF(a.duration_minutes, 0), 30)
          ) > $1::timestamptz

    UNION ALL

    -- طلبات الحجز العامة المعلّقة وغير المنتهية
    SELECT
      GREATEST(
        br.requested_date,
        $1::timestamptz
      ) AS starts_at,
      LEAST(
        br.requested_date
          + make_interval(
              mins => COALESCE(NULLIF(br.duration_minutes, 0), 30)
            ),
        $2::timestamptz
      ) AS ends_at
    FROM booking_requests br
    WHERE br.clinic_id = $3
      AND br.status = 'pending'
      AND br.expires_at > CURRENT_TIMESTAMP
      AND br.requested_date < $2::timestamptz
      AND br.requested_date
        + make_interval(
            mins => COALESCE(NULLIF(br.duration_minutes, 0), 30)
          ) > $1::timestamptz
  ),

  events AS (
    SELECT starts_at AS event_at, 1::bigint AS delta
    FROM existing_intervals

    UNION ALL

    SELECT ends_at AS event_at, -1::bigint AS delta
    FROM existing_intervals
  ),

  grouped_events AS (
    SELECT event_at, SUM(delta) AS delta
    FROM events
    GROUP BY event_at
  ),

  occupancy AS (
    SELECT
      event_at,
      SUM(delta) OVER (ORDER BY event_at) AS concurrent_count
    FROM grouped_events
  )

  SELECT COALESCE(MAX(concurrent_count), 0) AS peak_concurrent
  FROM occupancy
  `,
        [reqDate.toISOString(), slotEnd.toISOString(), clinic.id],
      );

      const peakConcurrent = Number(
        chairOccupancyResult.rows[0]?.peak_concurrent || 0,
      );

      const totalChairs = Math.max(1, Number(clinic.total_chairs_count) || 1);

      // لو المواعيد والطلبات الحالية مستهلكة كل الكراسي في أي جزء
      // من مدة الطلب الجديد، نرفض الطلب.
      if (peakConcurrent >= totalChairs) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          error: "لا توجد سعة متاحة بالعيادة في هذا الموعد",
        });
      }

      const insertRes = await client.query(
        `INSERT INTO booking_requests (
          clinic_id,
          doctor_id,
          procedure_code_id,
          patient_name,
          patient_phone,
          requested_date,
          duration_minutes,
          notes,
          expires_at,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
        RETURNING *;`,
        [
          clinic.id,
          doctor_id,
          normalizedProcedureId,
          patient_name.trim(),
          cleanPhone,
          reqDate.toISOString(),
          duration,
          notes?.trim() || null,
          expiresAt.toISOString(),
        ],
      );

      await client.query("COMMIT");

      return res.status(201).json({
        success: true,
        message:
          "تم إرسال طلب الحجز بنجاح! سيقوم فريق العيادة بمراجعته والتواصل معك لتأكيد الموعد.",
        booking_request: {
          id: insertRes.rows[0].id,
          patient_name: insertRes.rows[0].patient_name,
          requested_date: insertRes.rows[0].requested_date,
          expires_at: insertRes.rows[0].expires_at,
        },
      });
    } catch (dbErr) {
      await client.query("ROLLBACK");
      throw dbErr;
    } finally {
      if (client) client.release();
    }
  } catch (error) {
    captureError(error, req);
    console.error("Error creating public booking request:", error.message);
    res.status(500).json({
      error: "حدث خطأ أثناء إرسال طلب الحجز، يرجى المحاولة لاحقاً",
    });
  }
};

// ==========================================
// 4. دوال إدارة الموقع العام لـ ClinicAdmin
// ==========================================
const getMyClinicSiteSettings = async (req, res) => {
  const clinicId = req.user.clinic_id;
  try {
    const [
      clinicRes,
      siteRes,
      bookingRes,
      galleryRes,
      faqsRes,
      testimonialsRes,
    ] = await Promise.all([
      pool.query(
        `SELECT id, name, slug, phone_number, address, bio FROM clinics WHERE id = $1`,
        [clinicId],
      ),
      pool.query(`SELECT * FROM clinic_site WHERE clinic_id = $1`, [clinicId]),
      pool.query(`SELECT * FROM booking_settings WHERE clinic_id = $1`, [
        clinicId,
      ]),
      pool.query(
        `SELECT * FROM clinic_gallery_items WHERE clinic_id = $1 ORDER BY sort_order ASC, created_at DESC`,
        [clinicId],
      ),
      pool.query(
        `SELECT * FROM clinic_faqs WHERE clinic_id = $1 ORDER BY sort_order ASC, created_at ASC`,
        [clinicId],
      ),
      pool.query(
        `SELECT * FROM clinic_testimonials WHERE clinic_id = $1 ORDER BY created_at DESC`,
        [clinicId],
      ),
    ]);

    return res.status(200).json({
      clinic: clinicRes.rows[0] || {},
      site: siteRes.rows[0] || {},
      booking_settings: bookingRes.rows[0] || {
        is_online_booking_enabled: true,
        min_advance_hours: 2,
        max_advance_days: 30,
        booking_instructions: "",
      },
      gallery: galleryRes.rows,
      faqs: faqsRes.rows,
      testimonials: testimonialsRes.rows,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching clinic site settings:", error.message);
    res.status(500).json({ error: "فشل تحميل إعدادات الموقع العام" });
  }
};

const updateMyClinicSiteSettings = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const body = req.body || {};

  const {
    slug,
    address,
    bio,
    logo_public_id,
    cover_public_id,
    theme_color,
    is_published,
    booking_settings,
  } = body;

  const hasField = (key) => Object.prototype.hasOwnProperty.call(body, key);

  const textFields = [
    "slug",
    "address",
    "bio",
    "hero_title",
    "hero_subtitle",
    "logo_url",
    "logo_public_id",
    "cover_url",
    "cover_public_id",
    "whatsapp_number",
    "facebook_url",
    "instagram_url",
    "tiktok_url",
    "google_maps_url",
    "city",
    "area",
    "theme_color",
    "seo_title",
    "seo_description",
  ];

  for (const key of textFields) {
    if (hasField(key) && body[key] != null && typeof body[key] !== "string") {
      return res.status(400).json({
        error: `قيمة الحقل ${key} غير صالحة`,
      });
    }
  }

  // حدود الأطوال حسب أعمدة جدول clinic_site
  for (const [key, max] of Object.entries(SITE_MAX_LENGTHS)) {
    if (typeof body[key] === "string" && body[key].trim().length > max) {
      return res.status(400).json({
        error: `الحقل ${key} يجب ألا يتجاوز ${max} حرف`,
      });
    }
  }

  // الروابط لازم تكون https
  for (const key of SITE_URL_FIELDS) {
    if (
      typeof body[key] === "string" &&
      body[key].trim() !== "" &&
      !isHttpsUrl(body[key])
    ) {
      return res.status(400).json({
        error: `الرابط في الحقل ${key} غير صالح`,
      });
    }
  }

  if (hasField("is_published") && typeof is_published !== "boolean") {
    return res.status(400).json({
      error: "حالة نشر الموقع غير صالحة",
    });
  }

  if (
    booking_settings != null &&
    (typeof booking_settings !== "object" || Array.isArray(booking_settings))
  ) {
    return res.status(400).json({
      error: "إعدادات الحجز غير صالحة",
    });
  }

  if (
    booking_settings &&
    booking_settings.booking_instructions != null &&
    typeof booking_settings.booking_instructions !== "string"
  ) {
    return res.status(400).json({
      error: "تعليمات الحجز غير صالحة",
    });
  }

  for (const key of [logo_public_id, cover_public_id]) {
    if (key && !isClinicPublicAssetKey(key, clinicId)) {
      return res.status(400).json({
        error: "مفتاح الصورة غير صالح لهذه العيادة",
      });
    }
  }

  // تنظيف الـ slug بدري (old_slug في slug_history هو VARCHAR(100)،
  // و resolveClinic بيعامل أي قيمة بشكل UUID كـ id مش slug)
  let cleanSlug = null;
  if (slug && typeof slug === "string") {
    cleanSlug = slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (cleanSlug.length > 100 || isValidUuid(cleanSlug)) {
      return res.status(400).json({
        error: "الرابط المختصر (Slug) غير صالح",
      });
    }
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const currentClinicRes = await client.query(
      `SELECT slug, address, bio FROM clinics WHERE id = $1 FOR UPDATE`,
      [clinicId],
    );
    const currentClinic = currentClinicRes.rows[0] || {};
    const oldSlug = currentClinic.slug;
    const nextAddress = hasField("address")
      ? (body.address?.trim() || null)
      : (currentClinic.address ?? null);
    const nextBio = hasField("bio")
      ? (body.bio?.trim() || null)
      : (currentClinic.bio ?? null);

    // لازم يتجاب oldSite الأول قبل أي استخدام له
    const oldSiteRes = await client.query(
      `SELECT
         hero_title,
         hero_subtitle,
         logo_url,
         logo_public_id,
         cover_url,
         cover_public_id,
         whatsapp_number,
         facebook_url,
         instagram_url,
         tiktok_url,
         google_maps_url,
         city,
         area,
         theme_color,
         seo_title,
         seo_description,
         is_published
       FROM clinic_site
       WHERE clinic_id = $1`,
      [clinicId],
    );

    const oldSite = oldSiteRes.rows[0] || {};
    const oldLogoPublicId = oldSite.logo_public_id;
    const oldCoverPublicId = oldSite.cover_public_id;

    const getSiteText = (key) => {
      if (!hasField(key)) {
        return oldSite[key] ?? null;
      }

      const value = body[key];

      return value == null ? null : value.trim() || null;
    };

    const nextLogoUrl = getSiteText("logo_url");
    const nextCoverUrl = getSiteText("cover_url");

    const nextLogoPublicId = !nextLogoUrl
      ? null
      : hasField("logo_public_id")
        ? getSiteText("logo_public_id")
        : !hasField("logo_url") || nextLogoUrl === oldSite.logo_url
          ? oldLogoPublicId || null
          : null;

    const nextCoverPublicId = !nextCoverUrl
      ? null
      : hasField("cover_public_id")
        ? getSiteText("cover_public_id")
        : !hasField("cover_url") || nextCoverUrl === oldSite.cover_url
          ? oldCoverPublicId || null
          : null;

    const nextSite = {
      hero_title: getSiteText("hero_title"),
      hero_subtitle: getSiteText("hero_subtitle"),
      logo_url: nextLogoUrl,
      logo_public_id: nextLogoPublicId,
      cover_url: nextCoverUrl,
      cover_public_id: nextCoverPublicId,
      whatsapp_number: getSiteText("whatsapp_number"),
      facebook_url: getSiteText("facebook_url"),
      instagram_url: getSiteText("instagram_url"),
      tiktok_url: getSiteText("tiktok_url"),
      google_maps_url: getSiteText("google_maps_url"),
      city: getSiteText("city"),
      area: getSiteText("area"),
      theme_color: hasField("theme_color")
        ? theme_color?.trim() || "#14b8a6"
        : oldSite.theme_color || "#14b8a6",
      seo_title: getSiteText("seo_title"),
      seo_description: getSiteText("seo_description"),
      is_published: hasField("is_published")
        ? is_published
        : (oldSite.is_published ?? true),
    };

    // تحديث الـ slug لو اتغير مع حفظ القديم في slug_history لتحويل 301
    let finalSlug = oldSlug;
    if (cleanSlug && cleanSlug.length >= 3 && cleanSlug !== oldSlug) {
      finalSlug = cleanSlug;
      if (oldSlug) {
        await client.query(
          `INSERT INTO slug_history (clinic_id, old_slug) VALUES ($1, $2) ON CONFLICT (old_slug) DO NOTHING`,
          [clinicId, oldSlug],
        );
      }
    }

    await client.query(
      `UPDATE clinics
       SET slug = $1,
           address = $2,
           bio = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [finalSlug, nextAddress, nextBio, clinicId],
    );

    await client.query(
      `
      INSERT INTO clinic_site (
        clinic_id, hero_title, hero_subtitle, logo_url, logo_public_id,
        cover_url, cover_public_id, whatsapp_number, facebook_url,
        instagram_url, tiktok_url, google_maps_url, city, area,
        theme_color, seo_title, seo_description, is_published, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, CURRENT_TIMESTAMP)
      ON CONFLICT (clinic_id) DO UPDATE SET
        hero_title = EXCLUDED.hero_title,
        hero_subtitle = EXCLUDED.hero_subtitle,
        logo_url = EXCLUDED.logo_url,
        cover_url = EXCLUDED.cover_url,
        logo_public_id = EXCLUDED.logo_public_id,
        cover_public_id = EXCLUDED.cover_public_id,
        whatsapp_number = EXCLUDED.whatsapp_number,
        facebook_url = EXCLUDED.facebook_url,
        instagram_url = EXCLUDED.instagram_url,
        tiktok_url = EXCLUDED.tiktok_url,
        google_maps_url = EXCLUDED.google_maps_url,
        city = EXCLUDED.city,
        area = EXCLUDED.area,
        theme_color = EXCLUDED.theme_color,
        seo_title = EXCLUDED.seo_title,
        seo_description = EXCLUDED.seo_description,
        is_published = EXCLUDED.is_published,
        updated_at = CURRENT_TIMESTAMP;
      `,
      [
        clinicId,
        nextSite.hero_title,
        nextSite.hero_subtitle,
        nextSite.logo_url,
        nextSite.logo_public_id,
        nextSite.cover_url,
        nextSite.cover_public_id,
        nextSite.whatsapp_number,
        nextSite.facebook_url,
        nextSite.instagram_url,
        nextSite.tiktok_url,
        nextSite.google_maps_url,
        nextSite.city,
        nextSite.area,
        nextSite.theme_color,
        nextSite.seo_title,
        nextSite.seo_description,
        nextSite.is_published,
      ],
    );

    if (booking_settings && typeof booking_settings === "object") {
      // الحقول اللي ما اتبعتتش بتفضل بقيمتها الحالية (مش بترجع للافتراضي)
      const oldBookingRes = await client.query(
        `SELECT is_online_booking_enabled, min_advance_hours, max_advance_days, booking_instructions
         FROM booking_settings
         WHERE clinic_id = $1`,
        [clinicId],
      );
      const oldBooking = oldBookingRes.rows[0] || {
        is_online_booking_enabled: true,
        min_advance_hours: 2,
        max_advance_days: 30,
        booking_instructions: null,
      };

      const hasB = (key) =>
        Object.prototype.hasOwnProperty.call(booking_settings, key);

      const readInt = (key, min, max, fallback) => {
        if (!hasB(key)) return fallback;
        const raw = booking_settings[key];
        if (raw === null || raw === "") return fallback;
        const n = Number(raw);
        return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
      };

      const safeMinHours = readInt(
        "min_advance_hours",
        0,
        168,
        oldBooking.min_advance_hours,
      );
      const safeMaxDays = readInt(
        "max_advance_days",
        1,
        365,
        oldBooking.max_advance_days,
      );
      const nextEnabled = hasB("is_online_booking_enabled")
        ? booking_settings.is_online_booking_enabled !== false
        : oldBooking.is_online_booking_enabled;
      const nextInstructions = hasB("booking_instructions")
        ? booking_settings.booking_instructions?.trim() || null
        : oldBooking.booking_instructions;

      await client.query(
        `
        INSERT INTO booking_settings (
          clinic_id, is_online_booking_enabled, min_advance_hours, max_advance_days, booking_instructions, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        ON CONFLICT (clinic_id) DO UPDATE SET
          is_online_booking_enabled = EXCLUDED.is_online_booking_enabled,
          min_advance_hours = EXCLUDED.min_advance_hours,
          max_advance_days = EXCLUDED.max_advance_days,
          booking_instructions = EXCLUDED.booking_instructions,
          updated_at = CURRENT_TIMESTAMP;
        `,
        [clinicId, nextEnabled, safeMinHours, safeMaxDays, nextInstructions],
      );
    }

    await client.query("COMMIT");

    const cleanupReplacedPublicAsset = async (oldKey, newKey, label) => {
      const normalizedNewKey =
        typeof newKey === "string" && newKey.trim() ? newKey.trim() : null;

      if (!oldKey || oldKey === normalizedNewKey) {
        return;
      }

      try {
        await deleteFile(oldKey);
      } catch (cleanupError) {
        console.error(
          `Failed to delete old clinic site ${label}:`,
          cleanupError.message,
        );
      }
    };

    // المقارنة بالقيمة النهائية المحفوظة (nextSite) مش بالـ body الخام
    await cleanupReplacedPublicAsset(
      oldLogoPublicId,
      nextSite.logo_public_id,
      "logo",
    );

    await cleanupReplacedPublicAsset(
      oldCoverPublicId,
      nextSite.cover_public_id,
      "cover",
    );

    return res.status(200).json({
      message: "تم حفظ إعدادات موقع العيادة العام بنجاح",
      slug: finalSlug,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (e) {}
    }
    if (error.code === "23505") {
      return res.status(409).json({
        error: "اسم الرابط المختصر (Slug) مستخدم بالفعل لعيادة أخرى",
      });
    }
    captureError(error, req);
    console.error("Error updating clinic site settings:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء حفظ إعدادات الموقع" });
  } finally {
    if (client) client.release();
  }
};

// رفع صورة للموقع العام (لوجو / غلاف / معرض) إلى Cloudinary
const uploadSiteAsset = async (req, res) => {
  const clinicId = req.user.clinic_id;
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: "يرجى اختيار صورة لرفعها" });
  }

  try {
    const uploaded = await uploadPublicSiteImage({
      buffer: req.file.buffer,
      clinicId: String(clinicId),
    });
    return res.status(201).json({
      message: "تم رفع الصورة بنجاح",
      url: uploaded.url,
      key: uploaded.key,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error uploading site asset:", error.message);
    return res.status(error.status || 500).json({
      error: error.message || "فشل رفع الصورة",
    });
  }
};

// إضافة صورة لمعرض العيادة (بحد أقصى 12 صورة + دعم قبل وبعد)
const addGalleryItem = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const {
    image_url,
    image_public_id,
    before_image_url,
    before_image_public_id,
    caption,
    category,
    sort_order,
  } = req.body || {};

  const cleanCategory =
    category == null || category === "" ? "general" : category;

  const allowedCategories = new Set([
    "before_after",
    "clinic",
    "equipment",
    "general",
  ]);

  if (typeof image_url !== "string" || !image_url.trim()) {
    return res.status(400).json({
      error: "رابط الصورة الأساسية مطلوب",
    });
  }

  if (!isHttpsUrl(image_url)) {
    return res.status(400).json({
      error: "رابط الصورة الأساسية غير صالح",
    });
  }

  if (
    typeof cleanCategory !== "string" ||
    !allowedCategories.has(cleanCategory)
  ) {
    return res.status(400).json({
      error: "نوع عنصر المعرض غير صالح",
    });
  }

  if (before_image_url != null && typeof before_image_url !== "string") {
    return res.status(400).json({
      error: "رابط صورة قبل العلاج غير صالح",
    });
  }

  if (
    typeof before_image_url === "string" &&
    before_image_url.trim() !== "" &&
    !isHttpsUrl(before_image_url)
  ) {
    return res.status(400).json({
      error: "رابط صورة قبل العلاج غير صالح",
    });
  }

  if (caption != null && typeof caption !== "string") {
    return res.status(400).json({
      error: "وصف الصورة غير صالح",
    });
  }

  if (
    cleanCategory === "before_after" &&
    (!before_image_url || !before_image_url.trim())
  ) {
    return res.status(400).json({
      error: "حالات قبل وبعد تتطلب صورة قبل العلاج وصورة بعد العلاج",
    });
  }

  for (const key of [image_public_id, before_image_public_id]) {
    if (key && !isClinicPublicAssetKey(key, clinicId)) {
      return res.status(400).json({
        error: "مفتاح الصورة غير صالح لهذه العيادة",
      });
    }
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // قفل لمنع طلبين متزامنين من تخطي حد الـ 12 صورة
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text));`,
      [clinicId, "clinic_gallery_items"],
    );

    const countRes = await client.query(
      `SELECT COUNT(*)::int AS count FROM clinic_gallery_items WHERE clinic_id = $1`,
      [clinicId],
    );
    if (countRes.rows[0].count >= 12) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error:
          "الحد الأقصى لمعرض العيادة هو 12 صورة. يرجى حذف صورة قديمة أولاً.",
      });
    }

    const result = await client.query(
      `INSERT INTO clinic_gallery_items (
        clinic_id, image_url, image_public_id, before_image_url, before_image_public_id, caption, category, sort_order
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *;`,
      [
        clinicId,
        image_url.trim(),
        image_public_id?.trim() || null,
        cleanCategory === "before_after" ? before_image_url.trim() : null,
        cleanCategory === "before_after"
          ? before_image_public_id?.trim() || null
          : null,
        caption?.trim()?.slice(0, 200) || null,
        cleanCategory,
        Math.max(0, parseInt(sort_order, 10) || 0),
      ],
    );

    await client.query("COMMIT");

    return res.status(201).json({
      message: "تمت إضافة الصورة للمعرض بنجاح",
      item: result.rows[0],
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (e) {}
    }
    captureError(error, req);
    res.status(500).json({ error: "فشل إضافة الصورة للمعرض" });
  } finally {
    if (client) client.release();
  }
};

const deleteGalleryItem = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { id } = req.params;

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: "المعرّف غير صالح" });
  }

  try {
    const delRes = await pool.query(
      `DELETE FROM clinic_gallery_items
       WHERE id = $1 AND clinic_id = $2
       RETURNING image_public_id, before_image_public_id;`,
      [id, clinicId],
    );

    if (delRes.rows.length === 0) {
      return res.status(404).json({
        error: "عنصر المعرض غير موجود",
      });
    }

    const { image_public_id, before_image_public_id } = delRes.rows[0];

    const assetKeys = new Set([image_public_id, before_image_public_id]);

    for (const key of assetKeys) {
      if (typeof key !== "string" || !key.trim()) {
        continue;
      }

      try {
        await deleteFile(key);
      } catch (cleanupError) {
        console.error(
          "Failed to delete clinic gallery asset:",
          cleanupError.message,
        );
      }
    }

    return res.status(200).json({
      message: "تم حذف الصورة من المعرض",
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error deleting clinic gallery item:", error.message);

    return res.status(500).json({
      error: "فشل حذف الصورة",
    });
  }
};

// إدارة الأسئلة الشائعة (FAQs)
const addClinicFaq = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { question, answer } = req.body || {};

  if (
    typeof question !== "string" ||
    typeof answer !== "string" ||
    !question.trim() ||
    !answer.trim()
  ) {
    return res.status(400).json({ error: "السؤال والإجابة مطلوبان" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO clinic_faqs (clinic_id, question, answer)
       VALUES ($1, $2, $3)
       RETURNING *;`,
      [clinicId, question.trim().slice(0, 255), answer.trim()],
    );
    return res.status(201).json({ faq: result.rows[0] });
  } catch (error) {
    captureError(error, req);
    res.status(500).json({ error: "فشل إضافة السؤال الشائع" });
  }
};

const deleteClinicFaq = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { id } = req.params;

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: "المعرّف غير صالح" });
  }

  try {
    await pool.query(
      `DELETE FROM clinic_faqs WHERE id = $1 AND clinic_id = $2`,
      [id, clinicId],
    );
    return res.status(200).json({ message: "تم حذف السؤال" });
  } catch (error) {
    captureError(error, req);
    res.status(500).json({ error: "فشل حذف السؤال" });
  }
};

// إدارة آراء المرضى (Testimonials)
const addClinicTestimonial = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { patient_display_name, rating, comment } = req.body || {};

  if (
    typeof patient_display_name !== "string" ||
    typeof comment !== "string" ||
    !patient_display_name.trim() ||
    !comment.trim()
  ) {
    return res.status(400).json({ error: "اسم المريض والتعليق مطلوبان" });
  }

  try {
    const safeRating = Math.min(5, Math.max(1, parseInt(rating, 10) || 5));
    const result = await pool.query(
      `INSERT INTO clinic_testimonials (clinic_id, patient_display_name, rating, comment)
       VALUES ($1, $2, $3, $4)
       RETURNING *;`,
      [
        clinicId,
        patient_display_name.trim().slice(0, 100),
        safeRating,
        comment.trim(),
      ],
    );
    return res.status(201).json({ testimonial: result.rows[0] });
  } catch (error) {
    captureError(error, req);
    res.status(500).json({ error: "فشل إضافة التقييم" });
  }
};

const deleteClinicTestimonial = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { id } = req.params;

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: "المعرّف غير صالح" });
  }

  try {
    await pool.query(
      `DELETE FROM clinic_testimonials WHERE id = $1 AND clinic_id = $2`,
      [id, clinicId],
    );
    return res.status(200).json({ message: "تم حذف التقييم" });
  } catch (error) {
    captureError(error, req);
    res.status(500).json({ error: "فشل حذف التقييم" });
  }
};

module.exports = {
  getPublicClinicProfile,
  getPublicAvailableSlots,
  createPublicBookingRequest,
  getMyClinicSiteSettings,
  updateMyClinicSiteSettings,
  uploadSiteAsset,
  addGalleryItem,
  deleteGalleryItem,
  addClinicFaq,
  deleteClinicFaq,
  addClinicTestimonial,
  deleteClinicTestimonial,
};
