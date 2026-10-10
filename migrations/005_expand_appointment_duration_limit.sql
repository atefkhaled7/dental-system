ALTER TABLE appointments
DROP CONSTRAINT IF EXISTS appointments_duration_minutes_check;

ALTER TABLE appointments
ADD CONSTRAINT appointments_duration_minutes_check
CHECK (duration_minutes >= 5 AND duration_minutes <= 480);