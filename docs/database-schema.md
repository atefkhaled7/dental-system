## Database Schema — Current Neon Structure

**Source of truth:** The current Neon schema snapshot supplied by the project owner. This section describes the database structure, not necessarily every business rule enforced by the application code. When reviewing schema-dependent changes, do not assume an older baseline or migration matches the current database.

### 1. Clinics, Users & Tenant Isolation

- **`clinics`** — Main clinic/tenant record.

  - Important columns: `id`, `name`, `slug`, `subdomain`, `phone_number`, `address`, `bio`, `is_active`, `default_appointment_duration`, `subscription_plan`, `subscription_status`, `subscription_starts_at`, `subscription_ends_at`.
  - Constraints: `slug` UNIQUE, `subdomain` UNIQUE, default appointment duration between 5 and 240 minutes.
  - `is_active` controls clinic activation.

- **`users`** — Clinic staff and platform administrators.

  - Important columns: `id`, `clinic_id`, `name`, `email`, `password`, `role`, `is_active`, `token_version`.
  - Roles: `SuperAdmin`, `ClinicAdmin`, `Doctor`, `Receptionist`.
  - `SuperAdmin` must have `clinic_id = NULL`; other roles require a clinic.
  - `email` is globally UNIQUE. `(clinic_id, id)` is also UNIQUE for composite tenant-aware foreign keys.
  - `is_active` represents account activation; `token_version` supports token invalidation logic.

- **`schema_migrations`** — Migration history: `id`, `name`, `applied_at`. Migration `name` is UNIQUE.

### 2. Patients & Clinical Records

- **`patients`** — Patient information.

  - Important columns: `id`, `clinic_id`, `name`, `phone_number`, `gender`, `date_of_birth`, `medical_alerts`, `is_active`, `is_archived`.
  - Gender is nullable; allowed values are `Male`, `Female`, `Other`.
  - Patient phone number is UNIQUE within a clinic: `(clinic_id, phone_number)`.
  - Both `is_active` and `is_archived` exist; check application logic before changing their behavior.

- **`appointments`** — Scheduled and completed patient visits.

  - Important columns: `id`, `clinic_id`, `patient_id`, `doctor_id`, `appointment_date`, `duration_minutes`, `status`, `notes`.
  - Allowed statuses: `scheduled`, `completed`, `no_show`, `cancelled`.
  - Duration must be between 5 and 480 minutes.
  - Composite FKs enforce that the patient and doctor belong to the same clinic.
  - A partial UNIQUE index prevents two scheduled appointments for the same clinic, doctor and exact start time. Overlapping intervals with different start times still require application-level conflict checks.

- **`doctor_availability`** — Weekly doctor shifts.

  - Important columns: `id`, `clinic_id`, `doctor_id`, `day_of_week`, `start_time`, `end_time`, `is_active`.
  - `day_of_week` ranges from 0 to 6; `start_time` must be before `end_time`.
  - Indexed by clinic, doctor and weekday for active shifts.

- **`doctor_leaves`** — Doctor leave dates.

  - Important columns: `id`, `clinic_id`, `doctor_id`, `leave_date`, `notes`.
  - UNIQUE constraint on `(clinic_id, doctor_id, leave_date)`.

- **`procedure_codes`** — Clinic-specific services and treatment procedures.

  - Important columns: `id`, `clinic_id`, `code`, `description`, `default_price`, `duration_minutes`, `is_active`.
  - `(clinic_id, code)` is UNIQUE; price cannot be negative.
  - Duration can be NULL or between 5 and 480 minutes.

- **`treatment_plans`** — Patient treatment plans.

  - Important columns: `id`, `clinic_id`, `patient_id`, `title`, `status`, `notes`.
  - Allowed statuses: `active`, `completed`, `cancelled`.

- **`treatment_plan_items`** — Individual plan procedures.

  - Important columns: `id`, `clinic_id`, `plan_id`, `tooth_number`, `diagnosis`, `procedure_name`, `estimated_cost`, `status`, `invoice_id`, `completed_at`.
  - Allowed statuses: `planned`, `in_progress`, `completed`.
  - Estimated cost must be nonnegative. Optional tooth numbers use the supported FDI tooth-number set.
  - Deleting a plan cascades to its items; deleting a linked invoice sets `invoice_id` to NULL.

- **`patient_teeth`** — Current tooth condition records.

  - Important columns: `id`, `clinic_id`, `patient_id`, `tooth_number`, `condition`, `notes`, `updated_at`.
  - UNIQUE constraint on `(clinic_id, patient_id, tooth_number)`.

- **`tooth_history`** — Historical tooth records.

  - Important columns: `id`, `clinic_id`, `patient_id`, `tooth_number`, `condition`, `procedure_name`, `notes`, `created_by`, `created_at`.

- **`patient_images`** — Patient images and dental X-rays.

  - Important columns: `id`, `clinic_id`, `patient_id`, `tooth_number`, `category`, `file_url`, `file_name`, `mime_type`, `file_size`, `description`, `is_archived`, `uploaded_by`.
  - Allowed categories: `xray_periapical`, `xray_panoramic`, `photo_before`, `photo_after`, `other`.
  - `is_archived` is an archive flag; do not assume archived files are physically deleted.

### 3. Invoices & Payments

- **`invoices`** — Patient invoices.

  - Important columns: `id`, `clinic_id`, `patient_id`, `appointment_id`, `total_amount`, `status`, `is_archived`, `created_at`, `updated_at`.
  - `appointment_id` is nullable.
  - Allowed statuses: `unpaid`, `partially_paid`, `paid`, `cancelled`.
  - `total_amount` cannot be negative.
  - Composite FKs enforce that linked patients and appointments belong to the same clinic.
  - There is no `doctor_id` column in the current schema.

- **`invoice_items`** — Invoice line items.

  - Important columns: `id`, `clinic_id`, `invoice_id`, `procedure_code_id`, `description`, `quantity`, `unit_price`, `total_price`.
  - Quantity must be greater than zero; unit and total prices cannot be negative.
  - Composite FKs link items to invoices and procedures within the same clinic.

- **`payments`** — Payment transactions.

  - Important columns: `id`, `clinic_id`, `invoice_id`, `amount`, `payment_method`, `status`, `paid_at`, `created_by`, `provider`, `provider_order_id`, `provider_transaction_id`, `expires_at`, `notes`.
  - Amount must be greater than zero.
  - Payment methods: `cash`, `card`, `bank_transfer`, `vodafone_cash`, `other`, `online`.
  - Payment statuses: `pending`, `paid`, `failed`, `cancelled`, `refunded`, `expired`, `needs_review`.
  - Composite FK ensures the linked invoice belongs to the same clinic.
  - A partial UNIQUE index protects non-NULL `provider_transaction_id` values per provider.
  - The existence of a `refunded` status does not, by itself, mean the refund workflow is fully implemented.

### 4. Lab Orders & Public Booking

- **`lab_orders`** — Dental laboratory cases.

  - Important columns: `id`, `clinic_id`, `appointment_id`, `patient_id`, `doctor_id`, `lab_name`, `design_software`, `case_number`, `status`, `sent_at`, `expected_at`, `ready_at`, `received_at`, `notes`, `lab_notes`.
  - Allowed statuses: `sent_to_lab`, `ready`, `received`, `cancelled`.
  - `expected_at` must be NULL or greater than/equal to `sent_at`.
  - `(clinic_id, case_number)` is UNIQUE.
  - Composite FKs protect the clinic ownership of linked patients, doctors and appointments.

- **`booking_requests`** — Public booking requests submitted by patients.

  - Important columns: `id`, `clinic_id`, `doctor_id`, `procedure_code_id`, `patient_name`, `patient_phone`, `requested_date`, `duration_minutes`, `status`, `notes`, `expires_at`.
  - Allowed statuses: `pending`, `approved`, `rejected`, `expired`.
  - Duration must be between 5 and 480 minutes.
  - Pending, unexpired requests are relevant to slot-conflict checks.
  - The doctor and procedure FKs are not composite clinic-aware FKs in the current schema; application logic must validate clinic ownership.

### 5. Audit Logs

- **`audit_logs`** — Records administrative and other audited actions.

  - Important columns: `id`, `clinic_id`, `user_id`, `action`, `entity_type`, `entity_id`, `description`, `metadata`, `created_at`.
  - `metadata` is JSONB.
  - Deleting a clinic cascades to its audit logs; deleting a user sets `user_id` to NULL.
  - Indexed by `(clinic_id, created_at DESC)`.

### 6. Important Database Rules

1. **Clinic isolation:** Most business records contain `clinic_id`. Always derive tenant identity from the authenticated user where appropriate, and validate that referenced records belong to the same clinic. Do not assume every FK enforces tenant ownership: some relations use composite `(clinic_id, id)` FKs, while others use a single ID only.

2. **Soft delete and archive:** The schema contains `clinics.is_active`, `users.is_active`, `patients.is_active`, `patients.is_archived`, `invoices.is_archived`, and `patient_images.is_archived`. Preserve existing application behavior and verify which flag each workflow uses before changing it.

3. **Deletion policies:** Some relations use `ON DELETE CASCADE`, while financial records and selected clinic-owned relationships use `ON DELETE RESTRICT`. Check the actual FK before proposing deletes or changing deletion behavior.

4. **Duration limits differ by purpose:** `clinics.default_appointment_duration` allows 5–240 minutes, while `procedure_codes`, `booking_requests`, and `appointments` support up to 480 minutes. Keep validation and fallback behavior consistent.

5. **Money:** Store and calculate invoice/payment amounts using the existing numeric database types. Preserve payment/invoice consistency, prevent overpayment, and use auditable correction or refund workflows rather than silently deleting financial history.

6. **Time handling:** Most operational timestamps use `timestamp with time zone`. However, `patient_teeth.updated_at` and `tooth_history.created_at` are `timestamp without time zone`. Review timezone behavior before changing date logic.

7. **Schema changes:** The Neon schema is the current reference. Update migrations and this documentation when schema changes are applied; do not mark a migration complete merely because its file exists.

8. **Do not infer behavior from schema alone:** Role authorization, expiry processing, audit coverage, payment transitions, soft-delete semantics and booking conflict checks must also be verified against the current application code.
