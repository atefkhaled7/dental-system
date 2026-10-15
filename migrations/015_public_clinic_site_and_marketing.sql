-- ============================================================================
-- Migration 015: Public Clinic Website (Lean), Gallery, FAQs, Testimonials & Slug History
-- Enhanced Clinical Presence & Multi-Tenant SEO Architecture
-- ============================================================================

-- 1. جدول هوية وإعدادات موقع العيادة العام (clinic_site)
CREATE TABLE IF NOT EXISTS public.clinic_site (
    clinic_id UUID PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
    hero_title VARCHAR(200) NULL,
    hero_subtitle TEXT NULL,
    logo_url TEXT NULL,
    cover_url TEXT NULL,
    logo_public_id TEXT NULL,
    cover_public_id TEXT NULL,
    whatsapp_number VARCHAR(30) NULL,
    facebook_url TEXT NULL,
    instagram_url TEXT NULL,
    tiktok_url TEXT NULL,
    google_maps_url TEXT NULL,
    city VARCHAR(100) NULL,
    area VARCHAR(100) NULL,
    theme_color VARCHAR(20) NOT NULL DEFAULT '#14b8a6',
    seo_title VARCHAR(200) NULL,
    seo_description TEXT NULL,
    is_published BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. جدول معرض صور العيادة وحالات قبل وبعد (clinic_gallery_items - بحد أقصى 12 صورة)
CREATE TABLE IF NOT EXISTS public.clinic_gallery_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,                -- الصورة الأساسية (أو صورة "بعد" في حالات التجميل)
    before_image_url TEXT NULL,             -- صورة "قبل" (اختيارية لتشغيل سلايدر المقارنة التفاعلي)
    image_public_id TEXT NULL,
before_image_public_id TEXT NULL,
    caption VARCHAR(200) NULL,
    category VARCHAR(50) NOT NULL DEFAULT 'general',
    sort_order INT NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_gallery_category 
        CHECK (category IN ('before_after', 'clinic', 'equipment', 'general')),

    CONSTRAINT chk_gallery_before_after
CHECK (
    category <> 'before_after'
    OR NULLIF(BTRIM(before_image_url), '') IS NOT NULL
)  
);

CREATE INDEX IF NOT EXISTS idx_gallery_clinic_order 
    ON public.clinic_gallery_items(clinic_id, sort_order ASC, created_at DESC);

-- 3. جدول آراء وتقييمات المرضى المختارة للعرض العام (clinic_testimonials)
CREATE TABLE IF NOT EXISTS public.clinic_testimonials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    patient_display_name VARCHAR(100) NOT NULL,
    rating SMALLINT NOT NULL DEFAULT 5 CHECK (rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    is_visible BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- فهرس مركب يسرع جلب الآراء الظاهرة مرتبة بدون فرز في الذاكرة
CREATE INDEX IF NOT EXISTS idx_testimonials_clinic 
    ON public.clinic_testimonials(clinic_id, sort_order ASC, created_at DESC) 
    WHERE is_visible = true;

-- 4. جدول الأسئلة الشائعة للعيادة (clinic_faqs)
CREATE TABLE IF NOT EXISTS public.clinic_faqs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    question VARCHAR(255) NOT NULL,
    answer TEXT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    is_visible BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_faqs_clinic 
    ON public.clinic_faqs(clinic_id, sort_order ASC) 
    WHERE is_visible = true;

-- 5. جدول إعدادات الحجز الإلكتروني العام (booking_settings)
CREATE TABLE IF NOT EXISTS public.booking_settings (
    clinic_id UUID PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
    is_online_booking_enabled BOOLEAN NOT NULL DEFAULT true,
    min_advance_hours INT NOT NULL DEFAULT 2 CHECK (min_advance_hours >= 0 AND min_advance_hours <= 168),
    max_advance_days INT NOT NULL DEFAULT 30 CHECK (max_advance_days >= 1 AND max_advance_days <= 365),
    booking_instructions TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. جدول سجل الروابط القديمة لدعم التحويل التلقائي 301 (slug_history)
-- يحمي أكواد الـ QR المطبوعة وحملات التسويق إذا غيرت العيادة اسمها أو رابطها
CREATE TABLE IF NOT EXISTS public.slug_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    old_slug VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);


