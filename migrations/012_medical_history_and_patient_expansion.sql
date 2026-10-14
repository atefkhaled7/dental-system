-- Migration 012: Patient Expansion & Medical History & Allergies

-- 1. إضافة الأعمدة الجديدة لجدول patients
ALTER TABLE public.patients
ADD COLUMN IF NOT EXISTS address TEXT NULL,
ADD COLUMN IF NOT EXISTS email VARCHAR(150) NULL,
ADD COLUMN IF NOT EXISTS emergency_contact_name VARCHAR(100) NULL,
ADD COLUMN IF NOT EXISTS emergency_contact_phone VARCHAR(20) NULL,
ADD COLUMN IF NOT EXISTS guardian_name VARCHAR(100) NULL,
ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(20) NULL,
ADD COLUMN IF NOT EXISTS guardian_relation VARCHAR(50) NULL,
ADD COLUMN IF NOT EXISTS referral_source VARCHAR(50) NULL,
ADD COLUMN IF NOT EXISTS referral_note TEXT NULL;

-- 2. إنشاء جدول التاريخ الطبي patient_medical_history
CREATE TABLE IF NOT EXISTS public.patient_medical_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    answers JSONB NOT NULL DEFAULT '{}'::jsonb,
    alert_level VARCHAR(20) NOT NULL DEFAULT 'none', -- 'none', 'moderate', 'critical'
    notes TEXT NULL,
    reviewed_at TIMESTAMPTZ NULL,
    reviewed_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_patient_medical_history UNIQUE (clinic_id, patient_id)
);

CREATE INDEX IF NOT EXISTS idx_pmh_clinic_id ON public.patient_medical_history(clinic_id);
CREATE INDEX IF NOT EXISTS idx_pmh_patient_id ON public.patient_medical_history(patient_id);
CREATE INDEX IF NOT EXISTS idx_pmh_alert_level ON public.patient_medical_history(clinic_id, alert_level);

-- 3. إنشاء جدول حساسية المريض patient_allergies
CREATE TABLE IF NOT EXISTS public.patient_allergies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    category VARCHAR(50) NOT NULL DEFAULT 'medication', -- 'medication', 'food', 'latex', 'other'
    substance VARCHAR(100) NOT NULL, -- مثل: بنسلين، سلفا، لاتكس، أسبرين
    reaction VARCHAR(255) NULL,       -- مثل: طفح جلدي، تورم، صدمة تحسسية
    severity VARCHAR(20) NOT NULL DEFAULT 'moderate', -- 'mild', 'moderate', 'severe'
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_allergies_clinic_patient ON public.patient_allergies(clinic_id, patient_id);
