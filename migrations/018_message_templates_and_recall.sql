-- ============================================================================
-- Migration 018: Phase 7 — Smart Patient Recall & WhatsApp Marketing Templates
-- Target: Neon PostgreSQL 15+ (Multi-Tenant Strict Isolation)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. تحديث جدول المرضى (patients)
--    - إضافة عمود marketing_opt_out لعدم إزعاج المريض إذا طلب إلغاء الاشتراك
--    - فهرس مركب سريع لتصفية المرضى القابلين للتسويق والاستدعاء اللحظي
-- ============================================================================

ALTER TABLE public.patients
    ADD COLUMN IF NOT EXISTS marketing_opt_out BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_patients_recall_lookup
    ON public.patients (clinic_id, marketing_opt_out, is_active, is_archived);

-- ============================================================================
-- 2. إنشاء جدول قوالب الرسائل (message_templates)
--    - يدعم: reminder_tomorrow, recall_6_months, recall_treatment_plan, recall_no_show, custom
--    - عزل تام لكل عيادة مع الحماية بـ Composite Unique
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.message_templates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id   UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    type        VARCHAR(50) NOT NULL,
    body        TEXT NOT NULL,
    variables   JSONB NOT NULL DEFAULT '["patient_name", "date", "time", "doctor_name", "clinic_name"]'::jsonb,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- منع تكرار اسم القالب في نفس العيادة
    CONSTRAINT uq_message_templates_clinic_name
        UNIQUE (clinic_id, name),

    -- مفتاح مركب لعزل العيادة
    CONSTRAINT uq_message_templates_clinic_id_id
        UNIQUE (clinic_id, id),

    -- أنواع القوالب المعتمدة بنظام Recall
    CONSTRAINT chk_message_template_type CHECK (
        type IN (
            'reminder_tomorrow',       -- تذكير بمواعيد الغد
            'recall_6_months',         -- فحص دوري وتنظيف جير بعد 6 أشهر
            'recall_treatment_plan',   -- خطة علاج غير مكتملة
            'recall_no_show',          -- مريض لم يحضر موعده الأخير
            'custom'                   -- قالب مخصص للعيادة
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_message_templates_clinic_type
    ON public.message_templates (clinic_id, type)
    WHERE is_active = true;

-- ============================================================================
-- 3. إنشاء جدول سجلات الاستدعاء والتذكير (recall_logs)
--    - يمنع تكرار إرسال رسائل متتالية لنفس المريض (Cooldown Period 14-30 يوم)
--    - يوثق الموظف وتاريخ الإرسال ونوع الاستدعاء والموعد المرتبط
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.recall_logs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id      UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
    patient_id     UUID NOT NULL,
    appointment_id UUID NULL,
    recall_type    VARCHAR(50) NOT NULL,
    channel        VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
    sent_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_by        UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
    status         VARCHAR(20) NOT NULL DEFAULT 'sent',
    notes          TEXT NULL,

    -- علاقة مركبة مع المريض بنفس العيادة
    CONSTRAINT fk_recall_logs_patient_same_clinic
        FOREIGN KEY (clinic_id, patient_id)
        REFERENCES public.patients(clinic_id, id) ON DELETE CASCADE,

    -- علاقة مع الموعد إن وجد
CONSTRAINT fk_recall_logs_appointment_same_clinic
    FOREIGN KEY (clinic_id, appointment_id)
    REFERENCES public.appointments(clinic_id, id)
    ON DELETE SET NULL (appointment_id),

    CONSTRAINT chk_recall_logs_channel CHECK (
        channel IN ('whatsapp', 'sms', 'call')
    ),

    CONSTRAINT chk_recall_logs_status CHECK (
        status IN ('sent', 'failed', 'cancelled')
    )
);

CREATE INDEX IF NOT EXISTS idx_recall_logs_patient_cooldown
    ON public.recall_logs (clinic_id, patient_id, recall_type, sent_at DESC);

-- ============================================================================
-- 4. إدراج القوالب الافتراضية الذكية لجميع العيادات الحالية تلقائياً
-- ============================================================================

INSERT INTO public.message_templates (clinic_id, name, type, body, variables)
SELECT 
    c.id,
    'تذكير مواعيد الغد الافتراضي',
    'reminder_tomorrow',
    'تذكير بموعدك في {{clinic_name}} 🔔' || E'\n\n' ||
    'أهلاً بك أ. {{patient_name}}، نذكرك بموعدك غداً:' || E'\n' ||
    '📅 التاريخ: {{date}}' || E'\n' ||
    '⏰ الساعة: {{time}}' || E'\n' ||
    '👨‍⚕️ الطبيب: {{doctor_name}}' || E'\n\n' ||
    'نرجو الحضور قبل الموعد بـ 10 دقائق لتجنب الانتظار. نتشرف بزيارتك ونتمنى لك دوام الصحة والعافية!',
    '["patient_name", "date", "time", "doctor_name", "clinic_name"]'::jsonb
FROM public.clinics c
ON CONFLICT (clinic_id, name) DO NOTHING;

INSERT INTO public.message_templates (clinic_id, name, type, body, variables)
SELECT 
    c.id,
    'استدعاء الفحص الدوري (6 أشهر)',
    'recall_6_months',
    'مرحباً أ. {{patient_name}} من {{clinic_name}} 🦷✨' || E'\n\n' ||
    'مرت أكثر من 6 أشهر على آخر زيارة لك في العيادة. صحة أسنانك تهمنا، وللحفاظ على ابتسامتك ننصحك بعمل جلسة فحص دوري وتنظيف جير وقائي.' || E'\n\n' ||
    'يسعدنا تواصلك معنا لحجز موعدك المناسب في أي وقت يناسبك!',
    '["patient_name", "clinic_name"]'::jsonb
FROM public.clinics c
ON CONFLICT (clinic_id, name) DO NOTHING;

INSERT INTO public.message_templates (clinic_id, name, type, body, variables)
SELECT 
    c.id,
    'استدعاء خطة علاجية متبقية',
    'recall_treatment_plan',
    'أهلاً بك أ. {{patient_name}} من {{clinic_name}} 🌸' || E'\n\n' ||
    'نود تذكيرك بأن لديك خطة علاجية مسجلة ومتبقية لأسنانك لم تكتمل بعد ({{plan_title}}).' || E'\n' ||
    'إكمال خطوات العلاج في موعدها يمنع حدوث أي مضاعفات أو ألم لاحقاً.' || E'\n\n' ||
    'تفضل بالتواصل معنا وسنرتب لك الجلسة القادمة فوراً.',
    '["patient_name", "clinic_name", "plan_title"]'::jsonb
FROM public.clinics c
ON CONFLICT (clinic_id, name) DO NOTHING;

INSERT INTO public.message_templates (clinic_id, name, type, body, variables)
SELECT 
    c.id,
    'متابعة الغياب عن الموعد (No-Show)',
    'recall_no_show',
    'أهلاً بك أ. {{patient_name}} من {{clinic_name}} 🌸' || E'\n\n' ||
    'لاحظنا عدم تمكنك من حضور موعدك الأخير، ونتمنى أن تكون بأفضل حال وألف سلامة عليك.' || E'\n\n' ||
    'إذا كنت ترغب في إعادة جدولة الموعد في وقت آخر يناسبك، يسعدنا الرد على هذه الرسالة وسنساعدك فوراً.',
    '["patient_name", "clinic_name"]'::jsonb
FROM public.clinics c
ON CONFLICT (clinic_id, name) DO NOTHING;

COMMIT;