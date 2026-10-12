-- تعديل قيد مدة الكشف الافتراضية في جدول العيادات ليدعم حتى 480 دقيقة
ALTER TABLE clinics DROP CONSTRAINT IF EXISTS clinics_default_appointment_duration_check;

ALTER TABLE clinics ADD CONSTRAINT clinics_default_appointment_duration_check 
CHECK (default_appointment_duration >= 5 AND default_appointment_duration <= 480);