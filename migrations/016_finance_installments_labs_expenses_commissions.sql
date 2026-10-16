
-- ============================================================================
-- CUROSTA Migration 016
-- Finance, Discounts, Installments, Labs Costing, Expenses & Commissions
-- PostgreSQL 15+ / Neon
-- ============================================================================
-- ============================================================================
-- 0. PRE-FLIGHT: Detect existing cross-clinic references
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.treatment_plans tp
        JOIN public.patients p ON p.id = tp.patient_id
        WHERE tp.clinic_id <> p.clinic_id
    ) THEN
        RAISE EXCEPTION
            'Migration 016 aborted: treatment_plans contains cross-clinic patient references.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.treatment_plan_items tpi
        JOIN public.treatment_plans tp ON tp.id = tpi.plan_id
        WHERE tpi.clinic_id <> tp.clinic_id
    ) THEN
        RAISE EXCEPTION
            'Migration 016 aborted: treatment_plan_items contains cross-clinic plan references.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.treatment_plan_items tpi
        JOIN public.invoices i ON i.id = tpi.invoice_id
        WHERE tpi.invoice_id IS NOT NULL
          AND tpi.clinic_id <> i.clinic_id
    ) THEN
        RAISE EXCEPTION
            'Migration 016 aborted: treatment_plan_items contains cross-clinic invoice references.';
    END IF;
END $$;


-- ============================================================================
-- 1. INVOICES: Discounts, subtotal and notes
-- ============================================================================

ALTER TABLE public.invoices
    ADD COLUMN IF NOT EXISTS subtotal_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS discount_type VARCHAR(20),
    ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS notes TEXT;

-- Preserve the original invoice total for existing invoices.
UPDATE public.invoices
SET subtotal_amount = total_amount
WHERE subtotal_amount = 0
  AND total_amount > 0
  AND discount_value = 0
  AND discount_amount = 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.invoices'::regclass
          AND conname = 'chk_invoices_discount_type'
    ) THEN
        ALTER TABLE public.invoices
            ADD CONSTRAINT chk_invoices_discount_type
            CHECK (
                discount_type IS NULL
                OR discount_type IN ('fixed', 'percentage')
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.invoices'::regclass
          AND conname = 'chk_invoices_discount_amounts'
    ) THEN
        ALTER TABLE public.invoices
            ADD CONSTRAINT chk_invoices_discount_amounts
            CHECK (
                subtotal_amount >= 0
                AND discount_value >= 0
                AND discount_amount >= 0
                AND discount_amount <= subtotal_amount
                AND (
                    discount_type <> 'percentage'
                    OR discount_value <= 100
                )
                AND (
                    discount_type IS NOT NULL
                    OR (
                        discount_value = 0
                        AND discount_amount = 0
                    )
                )
            );
    END IF;
END $$;


-- ============================================================================
-- 2. INVOICE ITEMS: Optional FDI tooth number
-- ============================================================================

ALTER TABLE public.invoice_items
    ADD COLUMN IF NOT EXISTS tooth_number INTEGER NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.invoice_items'::regclass
          AND conname = 'chk_invoice_items_tooth_number'
    ) THEN
        ALTER TABLE public.invoice_items
            ADD CONSTRAINT chk_invoice_items_tooth_number
            CHECK (
                tooth_number IS NULL
                OR tooth_number IN (
                    11,12,13,14,15,16,17,18,
                    21,22,23,24,25,26,27,28,
                    31,32,33,34,35,36,37,38,
                    41,42,43,44,45,46,47,48
                )
            );
    END IF;
END $$;


-- ============================================================================
-- 3. PAYMENTS: Reference number, methods and composite key
-- ============================================================================

ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS reference_number VARCHAR(100) NULL;

ALTER TABLE public.payments
    DROP CONSTRAINT IF EXISTS chk_payment_method;

ALTER TABLE public.payments
    ADD CONSTRAINT chk_payment_method
    CHECK (
        payment_method IN (
            'cash',
            'card',
            'bank_transfer',
            'vodafone_cash',
            'instapay',
            'cheque',
            'online',
            'other'
        )
    );

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.payments'::regclass
          AND conname = 'uq_payments_clinic_id_id'
    ) THEN
        ALTER TABLE public.payments
            ADD CONSTRAINT uq_payments_clinic_id_id
            UNIQUE (clinic_id, id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.treatment_plans'::regclass
          AND conname = 'uq_treatment_plans_clinic_id_id'
    ) THEN
        ALTER TABLE public.treatment_plans
            ADD CONSTRAINT uq_treatment_plans_clinic_id_id
            UNIQUE (clinic_id, id);
    END IF;
END $$;


-- ============================================================================
-- 4. EXISTING TREATMENT PLANS: Enforce same-clinic relationships
-- ============================================================================

-- Remove the original single-column foreign keys so the new compound
-- constraints define the intended delete behavior without duplication.

ALTER TABLE public.treatment_plans
    DROP CONSTRAINT IF EXISTS treatment_plans_patient_id_fkey;

ALTER TABLE public.treatment_plan_items
    DROP CONSTRAINT IF EXISTS treatment_plan_items_plan_id_fkey;

ALTER TABLE public.treatment_plan_items
    DROP CONSTRAINT IF EXISTS treatment_plan_items_invoice_id_fkey;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.treatment_plans'::regclass
          AND conname = 'fk_treatment_plans_patient_same_clinic'
    ) THEN
        ALTER TABLE public.treatment_plans
            ADD CONSTRAINT fk_treatment_plans_patient_same_clinic
            FOREIGN KEY (clinic_id, patient_id)
            REFERENCES public.patients(clinic_id, id)
            ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.treatment_plan_items'::regclass
          AND conname = 'fk_treatment_plan_items_plan_same_clinic'
    ) THEN
        ALTER TABLE public.treatment_plan_items
            ADD CONSTRAINT fk_treatment_plan_items_plan_same_clinic
            FOREIGN KEY (clinic_id, plan_id)
            REFERENCES public.treatment_plans(clinic_id, id)
            ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.treatment_plan_items'::regclass
          AND conname = 'fk_treatment_plan_items_invoice_same_clinic'
    ) THEN
        ALTER TABLE public.treatment_plan_items
            ADD CONSTRAINT fk_treatment_plan_items_invoice_same_clinic
            FOREIGN KEY (clinic_id, invoice_id)
            REFERENCES public.invoices(clinic_id, id)
            ON DELETE SET NULL (invoice_id);
    END IF;
END $$;


-- ============================================================================
-- 5. INSTALLMENTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.installments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id           UUID NOT NULL
                        REFERENCES public.clinics(id) ON DELETE CASCADE,
    patient_id          UUID NOT NULL,
    invoice_id          UUID NOT NULL,
    treatment_plan_id   UUID NULL,
    installment_number  INTEGER NOT NULL,
    title               VARCHAR(150) NULL,
    amount              NUMERIC(10,2) NOT NULL,
    paid_amount         NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    due_date            DATE NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
    payment_id          UUID NULL,
    paid_at             TIMESTAMPTZ NULL,
    notes               TEXT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_installment_number
        CHECK (installment_number > 0),

    CONSTRAINT chk_installment_amount
        CHECK (amount > 0),

    CONSTRAINT chk_installment_paid_amount
        CHECK (paid_amount >= 0 AND paid_amount <= amount),

    CONSTRAINT chk_installment_status
        CHECK (
            status IN (
                'pending',
                'partially_paid',
                'paid',
                'cancelled'
            )
        ),

    CONSTRAINT chk_installment_paid_status
        CHECK (status <> 'paid' OR paid_amount = amount),

    CONSTRAINT uq_installments_invoice_number
        UNIQUE (clinic_id, invoice_id, installment_number),

    CONSTRAINT fk_installments_patient_same_clinic
        FOREIGN KEY (clinic_id, patient_id)
        REFERENCES public.patients(clinic_id, id)
        ON DELETE CASCADE,

    CONSTRAINT fk_installments_invoice_same_clinic
        FOREIGN KEY (clinic_id, invoice_id)
        REFERENCES public.invoices(clinic_id, id)
        ON DELETE CASCADE,

    CONSTRAINT fk_installments_plan_same_clinic
        FOREIGN KEY (clinic_id, treatment_plan_id)
        REFERENCES public.treatment_plans(clinic_id, id)
        ON DELETE SET NULL (treatment_plan_id),

    CONSTRAINT fk_installments_payment_same_clinic
        FOREIGN KEY (clinic_id, payment_id)
        REFERENCES public.payments(clinic_id, id)
        ON DELETE SET NULL (payment_id)
);

CREATE INDEX IF NOT EXISTS idx_installments_clinic_due_status
    ON public.installments (clinic_id, status, due_date);

CREATE INDEX IF NOT EXISTS idx_installments_clinic_invoice
    ON public.installments (clinic_id, invoice_id);

CREATE INDEX IF NOT EXISTS idx_installments_clinic_patient
    ON public.installments (clinic_id, patient_id);


-- ============================================================================
-- 6. LABS: Dental laboratory directory
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.labs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id       UUID NOT NULL
                    REFERENCES public.clinics(id) ON DELETE CASCADE,
    name            VARCHAR(150) NOT NULL,
    phone           VARCHAR(30) NULL,
    contact_person  VARCHAR(100) NULL,
    specialties     TEXT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_labs_clinic_name
        UNIQUE (clinic_id, name),

    CONSTRAINT uq_labs_clinic_id_id
        UNIQUE (clinic_id, id)
);


-- ============================================================================
-- 7. LAB ORDERS: Work details and laboratory costs
-- ============================================================================

ALTER TABLE public.lab_orders
    ADD COLUMN IF NOT EXISTS lab_id UUID NULL,
    ADD COLUMN IF NOT EXISTS work_type VARCHAR(120) NULL,
    ADD COLUMN IF NOT EXISTS tooth_numbers VARCHAR(100) NULL,
    ADD COLUMN IF NOT EXISTS shade VARCHAR(50) NULL,
    ADD COLUMN IF NOT EXISTS cost NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid';

-- Required as the target key for same-clinic foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_orders_clinic_id_id
    ON public.lab_orders (clinic_id, id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.lab_orders'::regclass
          AND conname = 'chk_lab_orders_financials'
    ) THEN
        ALTER TABLE public.lab_orders
            ADD CONSTRAINT chk_lab_orders_financials
            CHECK (
                cost >= 0
                AND paid_amount >= 0
                AND paid_amount <= cost
                AND payment_status IN (
                    'unpaid',
                    'partially_paid',
                    'paid'
                )
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.lab_orders'::regclass
          AND conname = 'fk_lab_orders_lab_same_clinic'
    ) THEN
        ALTER TABLE public.lab_orders
            ADD CONSTRAINT fk_lab_orders_lab_same_clinic
            FOREIGN KEY (clinic_id, lab_id)
            REFERENCES public.labs(clinic_id, id)
            ON DELETE SET NULL (lab_id);
    END IF;
END $$;


-- ============================================================================
-- 8. EXPENSES: Clinic operating expenses
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.expenses (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id       UUID NOT NULL
                    REFERENCES public.clinics(id) ON DELETE CASCADE,
    category        VARCHAR(100) NOT NULL,
    title           VARCHAR(200) NOT NULL,
    amount          NUMERIC(10,2) NOT NULL,
    payment_method  VARCHAR(30) NOT NULL DEFAULT 'cash',
    expense_date    DATE NOT NULL DEFAULT CURRENT_DATE,
    vendor_name     VARCHAR(150) NULL,
    lab_order_id    UUID NULL,
    notes           TEXT NULL,
    created_by      UUID NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_expenses_amount
        CHECK (amount > 0),

    CONSTRAINT chk_expenses_payment_method
        CHECK (
            payment_method IN (
                'cash',
                'card',
                'bank_transfer',
                'vodafone_cash',
                'instapay',
                'cheque',
                'other'
            )
        ),

    CONSTRAINT uq_expenses_clinic_id_id
        UNIQUE (clinic_id, id),

    CONSTRAINT fk_expenses_lab_order_same_clinic
        FOREIGN KEY (clinic_id, lab_order_id)
        REFERENCES public.lab_orders(clinic_id, id)
        ON DELETE SET NULL (lab_order_id),

    CONSTRAINT fk_expenses_created_by_same_clinic
        FOREIGN KEY (clinic_id, created_by)
        REFERENCES public.users(clinic_id, id)
        ON DELETE SET NULL (created_by)
);

CREATE INDEX IF NOT EXISTS idx_expenses_clinic_date
    ON public.expenses (clinic_id, expense_date DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_clinic_category
    ON public.expenses (clinic_id, category);


-- ============================================================================
-- 9. STAFF COMPENSATION: Doctor salary and commission settings
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.staff_compensation (
    user_id          UUID PRIMARY KEY,
    clinic_id        UUID NOT NULL
                     REFERENCES public.clinics(id) ON DELETE CASCADE,
    base_salary      NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    commission_type  VARCHAR(30) NOT NULL DEFAULT 'collected',
    commission_rate  NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    notes            TEXT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_staff_compensation_base_salary
        CHECK (base_salary >= 0),

    CONSTRAINT chk_staff_compensation_commission_type
        CHECK (
            commission_type IN (
                'collected',
                'invoiced',
                'after_lab_cost'
            )
        ),

    CONSTRAINT chk_staff_compensation_commission_rate
        CHECK (commission_rate >= 0 AND commission_rate <= 100),

    CONSTRAINT fk_staff_compensation_user_same_clinic
        FOREIGN KEY (clinic_id, user_id)
        REFERENCES public.users(clinic_id, id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_staff_compensation_clinic
    ON public.staff_compensation (clinic_id);


-- ============================================================================
-- 10. COMMISSION PAYOUTS: Salary and commission payment history
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.commission_payouts (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id            UUID NOT NULL
                         REFERENCES public.clinics(id) ON DELETE CASCADE,
    doctor_id             UUID NOT NULL,
    period_start          DATE NOT NULL,
    period_end            DATE NOT NULL,
    gross_basis_amount    NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    lab_deduction_amount  NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    commission_rate       NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    commission_amount     NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    base_salary_amount    NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    total_payout          NUMERIC(10,2) NOT NULL,
    payment_method        VARCHAR(30) NOT NULL DEFAULT 'cash',
    expense_id            UUID NULL,
    notes                 TEXT NULL,
    paid_by               UUID NULL,
    paid_at               TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_commission_payout_period
        CHECK (period_end >= period_start),

    CONSTRAINT chk_commission_payout_amounts
        CHECK (
            gross_basis_amount >= 0
            AND lab_deduction_amount >= 0
            AND commission_amount >= 0
            AND base_salary_amount >= 0
            AND total_payout > 0
        ),

    CONSTRAINT chk_commission_payout_rate
        CHECK (commission_rate >= 0 AND commission_rate <= 100),

    CONSTRAINT chk_commission_payout_method
        CHECK (
            payment_method IN (
                'cash',
                'card',
                'bank_transfer',
                'vodafone_cash',
                'instapay',
                'cheque',
                'other'
            )
        ),

    CONSTRAINT fk_commission_payouts_doctor_same_clinic
        FOREIGN KEY (clinic_id, doctor_id)
        REFERENCES public.users(clinic_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_commission_payouts_expense_same_clinic
        FOREIGN KEY (clinic_id, expense_id)
        REFERENCES public.expenses(clinic_id, id)
        ON DELETE SET NULL (expense_id),

    CONSTRAINT fk_commission_payouts_paid_by_same_clinic
        FOREIGN KEY (clinic_id, paid_by)
        REFERENCES public.users(clinic_id, id)
        ON DELETE SET NULL (paid_by)
);

CREATE INDEX IF NOT EXISTS idx_commission_payouts_clinic_doctor
    ON public.commission_payouts (clinic_id, doctor_id, paid_at DESC);


-- ============================================================================
-- DONE
-- ============================================================================
