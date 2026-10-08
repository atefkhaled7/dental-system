-- إضافة عمود مدة الإجراء بالدقائق لجدول أكواد العلاج
ALTER TABLE procedure_codes 
ADD COLUMN IF NOT EXISTS duration_minutes INT NULL;

-- قيد للتأكد إن المدة لو اتحددت تكون بين 5 دقائق و 8 ساعات (480 دقيقة)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_procedure_duration'
  ) THEN
    ALTER TABLE procedure_codes
    ADD CONSTRAINT check_procedure_duration 
    CHECK (duration_minutes IS NULL OR (duration_minutes >= 5 AND duration_minutes <= 480));
  END IF;
END $$;