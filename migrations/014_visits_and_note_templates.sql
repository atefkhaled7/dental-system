-- ============================================================================
-- Migration 014: Clinical Visits, Procedures & Note Templates
-- Multi-Tenant Isolation & Clinical Integrity Hardened
-- Compatible with PostgreSQL 15+ (Neon DB)
-- ============================================================================

-- 1. جدول سجل الزيارات السريرية والفحص (visits)
CREATE TABLE IF NOT EXISTS public.visits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    patient_id UUID NOT NULL,
    appointment_id UUID UNIQUE NULL,
    doctor_id UUID NOT NULL,
    visit_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    -- السجل الطبي والتشخيص السريري
    chief_complaint TEXT NULL,
    diagnosis TEXT NULL,
    procedure_notes TEXT NULL,
    anesthesia_notes TEXT NULL,
    post_op_instructions TEXT NULL,
    
    -- حالة السجل (مسودة قابلة للتعديل أو نهائي مغلق قانونياً)
    status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
    finalized_at TIMESTAMPTZ NULL,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- قيود العزل التام للمستأجر (Tenant Composite Foreign Keys)
    CONSTRAINT fk_visits_patient_same_clinic 
        FOREIGN KEY (clinic_id, patient_id) 
        REFERENCES patients(clinic_id, id) ON DELETE RESTRICT,

    CONSTRAINT fk_visits_appointment_same_clinic 
        FOREIGN KEY (clinic_id, appointment_id) 
        REFERENCES appointments(clinic_id, id) 
        ON DELETE SET NULL (appointment_id),

    CONSTRAINT fk_visits_doctor_same_clinic 
        FOREIGN KEY (clinic_id, doctor_id) 
        REFERENCES users(clinic_id, id) ON DELETE RESTRICT,

    -- قيد فريد لتمكين ربط الجداول التابعة بالعيادة والزيارة معاً
    CONSTRAINT uq_visits_clinic_id_id UNIQUE (clinic_id, id),

    -- التحقق من اتساق وقت الإغلاق النهائي للسجل
    CONSTRAINT chk_visits_finalized_status CHECK (
        (status = 'final' AND finalized_at IS NOT NULL) OR 
        (status = 'draft' AND finalized_at IS NULL)
    )
);

-- فهارس جدول الزيارات (تم تجنب تكرار فهرس appointment_id لوجود قيد UNIQUE)
CREATE INDEX IF NOT EXISTS idx_visits_clinic_patient 
    ON public.visits(clinic_id, patient_id, visit_date DESC);

CREATE INDEX IF NOT EXISTS idx_visits_clinic_doctor 
    ON public.visits(clinic_id, doctor_id, visit_date DESC);

CREATE INDEX IF NOT EXISTS idx_visits_clinic_drafts 
    ON public.visits(clinic_id, status) WHERE status = 'draft';


-- 2. جدول الإجراءات السريرية المنجزة أثناء الزيارة (visit_procedures)
CREATE TABLE IF NOT EXISTS public.visit_procedures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    visit_id UUID NOT NULL,
    procedure_code_id UUID NULL,
    
    procedure_name VARCHAR(255) NOT NULL,
    tooth_number SMALLINT NULL,
    surface VARCHAR(10) NULL,             -- Mesial, Distal, Occlusal, Incisal, Buccal, Lingual (e.g. 'MOD')
    notes TEXT NULL,
    cost NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (cost >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- قيود العلاقات المركبة
    CONSTRAINT fk_vp_visit_same_clinic 
        FOREIGN KEY (clinic_id, visit_id) 
        REFERENCES visits(clinic_id, id) ON DELETE CASCADE,

    CONSTRAINT fk_vp_procedure_code_same_clinic 
        FOREIGN KEY (clinic_id, procedure_code_id) 
        REFERENCES procedure_codes(clinic_id, id) 
        ON DELETE SET NULL (procedure_code_id),

    -- التحقق السريري الصارم من أرقام الأسنان وفق معيار FDI (ISO 3950)
    CONSTRAINT chk_vp_tooth_number CHECK (
        tooth_number IS NULL OR (
            -- الأسنان الدائمة للبالغين (Permanent Teeth)
            tooth_number BETWEEN 11 AND 18 OR  -- الربع الأول (علوي يمين)
            tooth_number BETWEEN 21 AND 28 OR  -- الربع الثاني (علوي يسار)
            tooth_number BETWEEN 31 AND 38 OR  -- الربع الثالث (سفلي يسار)
            tooth_number BETWEEN 41 AND 48 OR  -- الربع الرابع (سفلي يمين)
            -- الأسنان اللبنية للأطفال (Deciduous Teeth)
            tooth_number BETWEEN 51 AND 55 OR  -- الربع الخامس (علوي يمين)
            tooth_number BETWEEN 61 AND 65 OR  -- الربع السادس (علوي يسار)
            tooth_number BETWEEN 71 AND 75 OR  -- الربع السابع (سفلي يسار)
            tooth_number BETWEEN 81 AND 85     -- الربع الثامن (سفلي يمين)
        )
    )
);

-- فهارس جدول الإجراءات
CREATE INDEX IF NOT EXISTS idx_vp_clinic_visit 
    ON public.visit_procedures(clinic_id, visit_id);

CREATE INDEX IF NOT EXISTS idx_vp_clinic_tooth 
    ON public.visit_procedures(clinic_id, tooth_number) 
    WHERE tooth_number IS NOT NULL;


-- 3. جدول قوالب الملاحظات السريرية الجاهزة (note_templates)
CREATE TABLE IF NOT EXISTS public.note_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    doctor_id UUID NULL,                  -- NULL تعني القالب عام على مستوى العيادة كلها
    
    title VARCHAR(150) NOT NULL,
    category VARCHAR(50) NOT NULL DEFAULT 'general',
    chief_complaint TEXT NULL,
    diagnosis TEXT NULL,
    procedure_notes TEXT NULL,
    anesthesia_notes TEXT NULL,
    post_op_instructions TEXT NULL,
    
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_templates_doctor_same_clinic 
        FOREIGN KEY (clinic_id, doctor_id) 
        REFERENCES users(clinic_id, id) ON DELETE CASCADE
);

-- فهارس قوالب الملاحظات
CREATE INDEX IF NOT EXISTS idx_templates_lookup 
    ON public.note_templates(clinic_id, category, is_active);

-- منع تكرار عنوان القالب الخاص بالطبيب نفسه
CREATE UNIQUE INDEX IF NOT EXISTS uq_templates_private_title
    ON public.note_templates (clinic_id, doctor_id, title)
    WHERE doctor_id IS NOT NULL;

-- منع تكرار عنوان القوالب العامة داخل العيادة
CREATE UNIQUE INDEX IF NOT EXISTS uq_templates_public_title
    ON public.note_templates (clinic_id, title)
    WHERE doctor_id IS NULL;