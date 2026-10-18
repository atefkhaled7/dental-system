-- ============================================================================
-- Migration 017: Phase 6 — Interactive 5-Surface Dental Chart & Pediatric FDI (51–85)
-- Target: Neon PostgreSQL 15+ (Multi-Tenant Strict Isolation)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. تحديث جدول أسنان المريض (patient_teeth)
--    - إضافة مفتاح مركب (clinic_id, id) للعزل الصارم مع جدول الأسطح
--    - إضافة عمود dentition ('permanent' | 'deciduous')
--    - توسيع قيد أرقام الأسنان FDI ليشمل الأسنان اللبنية للأطفال (51–85)
--    - توسيع الحالات المعتمدة لتشمل كسر السن (fracture) والسيلانت (sealant)
-- ============================================================================

ALTER TABLE public.patient_teeth
    ADD COLUMN IF NOT EXISTS dentition VARCHAR(20) NOT NULL DEFAULT 'permanent';

-- ضبط قيمة dentition تلقائياً لأي بيانات سابقة إن وجدت
UPDATE public.patient_teeth
SET dentition = CASE
    WHEN tooth_number >= 51 THEN 'deciduous'
    ELSE 'permanent'
END;

-- مفتاح مركب لعزل العيادة عند الربط بجدول الأسطح
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_patient_teeth_clinic_id_id'
    ) THEN
        ALTER TABLE public.patient_teeth
            ADD CONSTRAINT uq_patient_teeth_clinic_id_id UNIQUE (clinic_id, id);
    END IF;
END $$;

-- استبدال قيد رقم السن القديم بقيد FDI الشامل (دائم 11-48 + لبني 51-85)
ALTER TABLE public.patient_teeth
    DROP CONSTRAINT IF EXISTS patient_teeth_tooth_number_check;

ALTER TABLE public.patient_teeth
    ADD CONSTRAINT patient_teeth_tooth_number_check CHECK (
        tooth_number BETWEEN 11 AND 18 OR
        tooth_number BETWEEN 21 AND 28 OR
        tooth_number BETWEEN 31 AND 38 OR
        tooth_number BETWEEN 41 AND 48 OR
        tooth_number BETWEEN 51 AND 55 OR
        tooth_number BETWEEN 61 AND 65 OR
        tooth_number BETWEEN 71 AND 75 OR
        tooth_number BETWEEN 81 AND 85
    );

-- قيد توافق نوع التسنين (dentition) مع رقم السن
ALTER TABLE public.patient_teeth
    DROP CONSTRAINT IF EXISTS chk_patient_teeth_dentition;

ALTER TABLE public.patient_teeth
    ADD CONSTRAINT chk_patient_teeth_dentition CHECK (
        (dentition = 'permanent' AND tooth_number BETWEEN 11 AND 48) OR
        (dentition = 'deciduous' AND tooth_number BETWEEN 51 AND 85)
    );

-- قيد الحالات الـ 9 المعتمدة للسن
ALTER TABLE public.patient_teeth
    DROP CONSTRAINT IF EXISTS chk_patient_teeth_condition;

ALTER TABLE public.patient_teeth
    ADD CONSTRAINT chk_patient_teeth_condition CHECK (
        condition IN (
            'sound',     -- سليم
            'caries',    -- تسوس
            'filled',    -- حشو
            'rct',       -- علاج جذور / عصب
            'crown',     -- تاج / تركيبة
            'missing',   -- مخلوع / مفقود
            'implant',   -- زراعة
            'fracture',  -- كسر
            'sealant'    -- سيلانت وقائي
        )
    );

-- ============================================================================
-- 2. إنشاء جدول الأسطح الخمسة للسن (tooth_surfaces)
--    - الأسطح: M (أنسي), O (إطباقي), D (وحشي), B (شفوي/شدقي), L (لساني/حنكي), I (قاطع)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tooth_surfaces (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id       UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
    tooth_record_id UUID NOT NULL,
    surface         VARCHAR(5) NOT NULL,
    condition       VARCHAR(50) NOT NULL DEFAULT 'sound',
    material        VARCHAR(50) NULL,
    notes           TEXT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- منع تكرار نفس السطح لنفس السن
    CONSTRAINT uq_tooth_surfaces_record_surface
        UNIQUE (tooth_record_id, surface),

    -- عزل العيادات الصارم (Composite Foreign Key)
    CONSTRAINT fk_tooth_surfaces_record_same_clinic
        FOREIGN KEY (clinic_id, tooth_record_id)
        REFERENCES public.patient_teeth(clinic_id, id) ON DELETE CASCADE,

    -- التحقق من رمز السطح التشريحي
    CONSTRAINT chk_tooth_surface_code CHECK (
        surface IN ('M', 'O', 'D', 'B', 'L', 'I')
    ),

    -- التحقق من حالة السطح
    CONSTRAINT chk_tooth_surface_condition CHECK (
        condition IN (
            'sound',
            'caries',
            'filled',
            'rct',
            'crown',
            'missing',
            'implant',
            'fracture',
            'sealant'
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_tooth_surfaces_clinic_record
    ON public.tooth_surfaces (clinic_id, tooth_record_id);

-- ============================================================================
-- 3. تحديث جدول السجل الزمني للأسنان (tooth_history)
--    - دعم الأسنان اللبنية (51–85)
--    - إضافة surface و material لتوثيق تغييرات الأسطح والمواد في الـ Timeline
-- ============================================================================

ALTER TABLE public.tooth_history
    ADD COLUMN IF NOT EXISTS surface  VARCHAR(10) NULL,
    ADD COLUMN IF NOT EXISTS material VARCHAR(50) NULL;

ALTER TABLE public.tooth_history
    DROP CONSTRAINT IF EXISTS tooth_history_tooth_number_check;

ALTER TABLE public.tooth_history
    ADD CONSTRAINT tooth_history_tooth_number_check CHECK (
        tooth_number BETWEEN 11 AND 18 OR
        tooth_number BETWEEN 21 AND 28 OR
        tooth_number BETWEEN 31 AND 38 OR
        tooth_number BETWEEN 41 AND 48 OR
        tooth_number BETWEEN 51 AND 55 OR
        tooth_number BETWEEN 61 AND 65 OR
        tooth_number BETWEEN 71 AND 75 OR
        tooth_number BETWEEN 81 AND 85
    );

ALTER TABLE public.tooth_history
    DROP CONSTRAINT IF EXISTS chk_tooth_history_condition;

ALTER TABLE public.tooth_history
    ADD CONSTRAINT chk_tooth_history_condition CHECK (
        condition IN (
            'sound',
            'caries',
            'filled',
            'rct',
            'crown',
            'missing',
            'implant',
            'fracture',
            'sealant'
        )
    );

-- ============================================================================
-- 4. تحديث جدول الخدمات (procedure_codes)
--    - إضافة عمود resulting_condition للربط التلقائي مع الشارت عند إتمام العلاج
-- ============================================================================

ALTER TABLE public.procedure_codes
    ADD COLUMN IF NOT EXISTS resulting_condition VARCHAR(50) NULL;

ALTER TABLE public.procedure_codes
    DROP CONSTRAINT IF EXISTS chk_procedure_resulting_condition;

ALTER TABLE public.procedure_codes
    ADD CONSTRAINT chk_procedure_resulting_condition CHECK (
        resulting_condition IS NULL OR resulting_condition IN (
            'sound',
            'caries',
            'filled',
            'rct',
            'crown',
            'missing',
            'implant',
            'fracture',
            'sealant'
        )
    );

-- ============================================================================
-- 5. تحديث جدول بنود خطة العلاج (treatment_plan_items)
--    - دعم الأسنان اللبنية (51–85)
--    - إضافة procedure_code_id و surface و resulting_condition و material
--      للربط التلقائي مع الشارت عند تحويل البند إلى completed
-- ============================================================================

ALTER TABLE public.treatment_plan_items
    ADD COLUMN IF NOT EXISTS procedure_code_id   UUID NULL,
    ADD COLUMN IF NOT EXISTS surface             VARCHAR(10) NULL,
    ADD COLUMN IF NOT EXISTS resulting_condition VARCHAR(50) NULL,
    ADD COLUMN IF NOT EXISTS material            VARCHAR(50) NULL;

-- ربط كود الإجراء بنفس العيادة (Composite Foreign Key)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_tpi_procedure_code_same_clinic'
    ) THEN
        ALTER TABLE public.treatment_plan_items
            ADD CONSTRAINT fk_tpi_procedure_code_same_clinic
            FOREIGN KEY (clinic_id, procedure_code_id)
            REFERENCES public.procedure_codes(clinic_id, id)
            ON DELETE SET NULL (procedure_code_id);
    END IF;
END $$;

-- توسيع قيد رقم السن في خطة العلاج ليشمل الأسنان اللبنية (51–85)
ALTER TABLE public.treatment_plan_items
    DROP CONSTRAINT IF EXISTS treatment_plan_items_tooth_number_check;

ALTER TABLE public.treatment_plan_items
    ADD CONSTRAINT treatment_plan_items_tooth_number_check CHECK (
        tooth_number IS NULL OR (
            tooth_number BETWEEN 11 AND 18 OR
            tooth_number BETWEEN 21 AND 28 OR
            tooth_number BETWEEN 31 AND 38 OR
            tooth_number BETWEEN 41 AND 48 OR
            tooth_number BETWEEN 51 AND 55 OR
            tooth_number BETWEEN 61 AND 65 OR
            tooth_number BETWEEN 71 AND 75 OR
            tooth_number BETWEEN 81 AND 85
        )
    );

ALTER TABLE public.treatment_plan_items
    DROP CONSTRAINT IF EXISTS chk_tpi_resulting_condition;

ALTER TABLE public.treatment_plan_items
    ADD CONSTRAINT chk_tpi_resulting_condition CHECK (
        resulting_condition IS NULL OR resulting_condition IN (
            'sound',
            'caries',
            'filled',
            'rct',
            'crown',
            'missing',
            'implant',
            'fracture',
            'sealant'
        )
    );
ALTER TABLE public.treatment_plan_items
    DROP CONSTRAINT IF EXISTS chk_tpi_surface;

ALTER TABLE public.treatment_plan_items
    ADD CONSTRAINT chk_tpi_surface
    CHECK (
        surface IS NULL OR
        (
            surface <> ''
            AND surface ~ '^[MODBLI]+$'
        )
    );
COMMIT;