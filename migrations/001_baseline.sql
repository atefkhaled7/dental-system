--
-- PostgreSQL database dump
--

-- Dumped from database version 18.6 (4e955f5)
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: appointments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appointments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clinic_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    doctor_id uuid NOT NULL,
    appointment_date timestamp with time zone NOT NULL,
    status character varying(30) DEFAULT 'scheduled'::character varying NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    duration_minutes integer DEFAULT 30 NOT NULL,
    CONSTRAINT appointments_duration_minutes_check CHECK (((duration_minutes >= 5) AND (duration_minutes <= 240))),
    CONSTRAINT chk_appointment_status CHECK (((status)::text = ANY ((ARRAY['scheduled'::character varying, 'completed'::character varying, 'no_show'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clinic_id uuid NOT NULL,
    user_id uuid,
    action character varying(50) NOT NULL,
    entity_type character varying(30) NOT NULL,
    entity_id uuid,
    description text NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: clinics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clinics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(150) NOT NULL,
    subdomain character varying(50),
    phone_number character varying(20),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    default_appointment_duration integer DEFAULT 30 NOT NULL,
    subscription_plan character varying(30) DEFAULT 'trial'::character varying,
    subscription_status character varying(30) DEFAULT 'trial'::character varying,
    subscription_starts_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    subscription_ends_at timestamp with time zone DEFAULT (CURRENT_TIMESTAMP + '14 days'::interval),
    CONSTRAINT clinics_default_appointment_duration_check CHECK (((default_appointment_duration >= 5) AND (default_appointment_duration <= 240)))
);


--
-- Name: invoice_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clinic_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    procedure_code_id uuid,
    description character varying(255) NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    unit_price numeric(10,2) NOT NULL,
    total_price numeric(10,2) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT chk_invoice_item_quantity CHECK ((quantity > 0)),
    CONSTRAINT chk_invoice_item_total CHECK ((total_price >= (0)::numeric)),
    CONSTRAINT chk_invoice_item_unit_price CHECK ((unit_price >= (0)::numeric))
);


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clinic_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    appointment_id uuid,
    total_amount numeric(10,2) DEFAULT 0 NOT NULL,
    status character varying(30) DEFAULT 'unpaid'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_archived boolean DEFAULT false,
    CONSTRAINT chk_invoice_status CHECK (((status)::text = ANY ((ARRAY['unpaid'::character varying, 'partially_paid'::character varying, 'paid'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT chk_invoice_total CHECK ((total_amount >= (0)::numeric))
);


--
-- Name: lab_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lab_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clinic_id uuid NOT NULL,
    appointment_id uuid,
    patient_id uuid NOT NULL,
    doctor_id uuid NOT NULL,
    lab_name character varying(150),
    design_software character varying(50),
    case_number character varying(50),
    status character varying(30) DEFAULT 'sent_to_lab'::character varying NOT NULL,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expected_at timestamp with time zone,
    ready_at timestamp with time zone,
    received_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    lab_notes text,
    CONSTRAINT chk_lab_dates CHECK (((expected_at IS NULL) OR (expected_at >= sent_at))),
    CONSTRAINT chk_lab_order_status CHECK (((status)::text = ANY ((ARRAY['sent_to_lab'::character varying, 'ready'::character varying, 'received'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: patient_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_images (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clinic_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    tooth_number integer,
    category character varying(50) DEFAULT 'other'::character varying NOT NULL,
    file_url text NOT NULL,
    file_name character varying(255) NOT NULL,
    mime_type character varying(100) NOT NULL,
    file_size integer NOT NULL,
    description text,
    is_archived boolean DEFAULT false NOT NULL,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT patient_images_category_check CHECK (((category)::text = ANY ((ARRAY['xray_periapical'::character varying, 'xray_panoramic'::character varying, 'photo_before'::character varying, 'photo_after'::character varying, 'other'::character varying])::text[]))),
    CONSTRAINT patient_images_tooth_number_check CHECK (((tooth_number IS NULL) OR (tooth_number = ANY (ARRAY[11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48]))))
);


--
-- Name: patient_teeth; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_teeth (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clinic_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    tooth_number integer NOT NULL,
    condition character varying(50) DEFAULT 'sound'::character varying NOT NULL,
    notes text,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT patient_teeth_tooth_number_check CHECK (((tooth_number >= 11) AND (tooth_number <= 48)))
);


--
-- Name: patients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clinic_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    phone_number character varying(20) NOT NULL,
    gender character varying(10),
    date_of_birth date,
    medical_alerts text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_archived boolean DEFAULT false,
    CONSTRAINT chk_patient_gender CHECK (((gender IS NULL) OR ((gender)::text = ANY ((ARRAY['Male'::character varying, 'Female'::character varying, 'Other'::character varying])::text[]))))
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clinic_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    amount numeric(10,2) NOT NULL,
    payment_method character varying(30) NOT NULL,
    notes text,
    paid_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    status character varying(20) DEFAULT 'paid'::character varying NOT NULL,
    provider character varying(50) DEFAULT NULL::character varying,
    provider_order_id character varying(255) DEFAULT NULL::character varying,
    provider_transaction_id character varying(255) DEFAULT NULL::character varying,
    expires_at timestamp with time zone,
    created_by uuid,
    CONSTRAINT chk_payment_amount CHECK ((amount > (0)::numeric)),
    CONSTRAINT chk_payment_method CHECK (((payment_method)::text = ANY ((ARRAY['cash'::character varying, 'card'::character varying, 'bank_transfer'::character varying, 'other'::character varying, 'online'::character varying, 'vodafone_cash'::character varying])::text[]))),
    CONSTRAINT payments_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'refunded'::character varying, 'expired'::character varying, 'needs_review'::character varying])::text[])))
);


--
-- Name: procedure_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.procedure_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clinic_id uuid NOT NULL,
    code character varying(50) NOT NULL,
    description character varying(255) NOT NULL,
    default_price numeric(10,2) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT chk_procedure_price CHECK ((default_price >= (0)::numeric))
);


--
-- Name: tooth_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tooth_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clinic_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    tooth_number integer NOT NULL,
    condition character varying(50) NOT NULL,
    procedure_name character varying(255),
    notes text,
    created_by uuid,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tooth_history_tooth_number_check CHECK (((tooth_number >= 11) AND (tooth_number <= 48)))
);


--
-- Name: treatment_plan_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.treatment_plan_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clinic_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    tooth_number integer,
    diagnosis text,
    procedure_name character varying(255) NOT NULL,
    estimated_cost numeric(10,2) DEFAULT 0.00 NOT NULL,
    status character varying(50) DEFAULT 'planned'::character varying NOT NULL,
    invoice_id uuid,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT treatment_plan_items_estimated_cost_check CHECK ((estimated_cost >= (0)::numeric)),
    CONSTRAINT treatment_plan_items_status_check CHECK (((status)::text = ANY ((ARRAY['planned'::character varying, 'in_progress'::character varying, 'completed'::character varying])::text[]))),
    CONSTRAINT treatment_plan_items_tooth_number_check CHECK (((tooth_number IS NULL) OR (tooth_number = ANY (ARRAY[11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48]))))
);


--
-- Name: treatment_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.treatment_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clinic_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT treatment_plans_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'completed'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clinic_id uuid,
    name character varying(100) NOT NULL,
    email character varying(150) NOT NULL,
    password character varying(255) NOT NULL,
    role character varying(30) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    token_version INT NOT NULL DEFAULT 1,
    CONSTRAINT chk_superadmin_clinic CHECK (((((role)::text = 'SuperAdmin'::text) AND (clinic_id IS NULL)) OR (((role)::text <> 'SuperAdmin'::text) AND (clinic_id IS NOT NULL)))),
    CONSTRAINT chk_users_role CHECK (((role)::text = ANY ((ARRAY['SuperAdmin'::character varying, 'ClinicAdmin'::character varying, 'Doctor'::character varying, 'Receptionist'::character varying])::text[])))
);


--
-- Name: appointments appointments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: clinics clinics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinics
    ADD CONSTRAINT clinics_pkey PRIMARY KEY (id);


--
-- Name: clinics clinics_subdomain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinics
    ADD CONSTRAINT clinics_subdomain_key UNIQUE (subdomain);


--
-- Name: invoice_items invoice_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: lab_orders lab_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_orders
    ADD CONSTRAINT lab_orders_pkey PRIMARY KEY (id);


--
-- Name: patient_images patient_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_images
    ADD CONSTRAINT patient_images_pkey PRIMARY KEY (id);


--
-- Name: patient_teeth patient_teeth_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_teeth
    ADD CONSTRAINT patient_teeth_pkey PRIMARY KEY (id);


--
-- Name: patients patients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: procedure_codes procedure_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procedure_codes
    ADD CONSTRAINT procedure_codes_pkey PRIMARY KEY (id);


--
-- Name: tooth_history tooth_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tooth_history
    ADD CONSTRAINT tooth_history_pkey PRIMARY KEY (id);


--
-- Name: treatment_plan_items treatment_plan_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plan_items
    ADD CONSTRAINT treatment_plan_items_pkey PRIMARY KEY (id);


--
-- Name: treatment_plans treatment_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plans
    ADD CONSTRAINT treatment_plans_pkey PRIMARY KEY (id);


--
-- Name: patients unique_patient_phone_per_clinic; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT unique_patient_phone_per_clinic UNIQUE (clinic_id, phone_number);


--
-- Name: patient_teeth unique_patient_tooth; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_teeth
    ADD CONSTRAINT unique_patient_tooth UNIQUE (clinic_id, patient_id, tooth_number);


--
-- Name: procedure_codes unique_procedure_code_per_clinic; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procedure_codes
    ADD CONSTRAINT unique_procedure_code_per_clinic UNIQUE (clinic_id, code);


--
-- Name: appointments uq_appointments_clinic_id_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT uq_appointments_clinic_id_id UNIQUE (clinic_id, id);


--
-- Name: invoices uq_invoices_clinic_id_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT uq_invoices_clinic_id_id UNIQUE (clinic_id, id);


--
-- Name: lab_orders uq_lab_case_number_per_clinic; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_orders
    ADD CONSTRAINT uq_lab_case_number_per_clinic UNIQUE (clinic_id, case_number);


--
-- Name: patients uq_patients_clinic_id_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT uq_patients_clinic_id_id UNIQUE (clinic_id, id);


--
-- Name: procedure_codes uq_procedure_codes_clinic_id_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procedure_codes
    ADD CONSTRAINT uq_procedure_codes_clinic_id_id UNIQUE (clinic_id, id);


--
-- Name: users uq_users_clinic_id_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT uq_users_clinic_id_id UNIQUE (clinic_id, id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_appointments_clinic_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appointments_clinic_date ON public.appointments USING btree (clinic_id, appointment_date);


--
-- Name: idx_appointments_clinic_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appointments_clinic_status ON public.appointments USING btree (clinic_id, status);


--
-- Name: idx_appointments_doctor_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appointments_doctor_date ON public.appointments USING btree (clinic_id, doctor_id, appointment_date);


--
-- Name: idx_appointments_patient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appointments_patient ON public.appointments USING btree (clinic_id, patient_id);


--
-- Name: idx_audit_logs_clinic_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_clinic_created ON public.audit_logs USING btree (clinic_id, created_at DESC);


--
-- Name: idx_invoice_items_clinic_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_items_clinic_invoice ON public.invoice_items USING btree (clinic_id, invoice_id);


--
-- Name: idx_invoices_clinic_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_clinic_status ON public.invoices USING btree (clinic_id, status);


--
-- Name: idx_invoices_patient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_patient ON public.invoices USING btree (clinic_id, patient_id);


--
-- Name: idx_lab_orders_clinic_expected; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lab_orders_clinic_expected ON public.lab_orders USING btree (clinic_id, expected_at);


--
-- Name: idx_lab_orders_clinic_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lab_orders_clinic_status ON public.lab_orders USING btree (clinic_id, status);


--
-- Name: idx_lab_orders_doctor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lab_orders_doctor ON public.lab_orders USING btree (clinic_id, doctor_id);


--
-- Name: idx_lab_orders_patient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lab_orders_patient ON public.lab_orders USING btree (clinic_id, patient_id);


--
-- Name: idx_patient_images_clinic_patient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patient_images_clinic_patient ON public.patient_images USING btree (clinic_id, patient_id, is_archived, created_at DESC);


--
-- Name: idx_patient_images_tooth; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patient_images_tooth ON public.patient_images USING btree (clinic_id, patient_id, tooth_number);


--
-- Name: idx_patient_teeth_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patient_teeth_lookup ON public.patient_teeth USING btree (clinic_id, patient_id);


--
-- Name: idx_patients_clinic_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patients_clinic_id ON public.patients USING btree (clinic_id);


--
-- Name: idx_patients_clinic_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patients_clinic_name ON public.patients USING btree (clinic_id, name);


--
-- Name: idx_patients_clinic_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patients_clinic_phone ON public.patients USING btree (clinic_id, phone_number);


--
-- Name: idx_payments_clinic_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_clinic_invoice ON public.payments USING btree (clinic_id, invoice_id);


--
-- Name: idx_payments_invoice_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_invoice_status ON public.payments USING btree (invoice_id, clinic_id, status);


--
-- Name: idx_payments_provider_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_provider_order ON public.payments USING btree (provider, provider_order_id);


--
-- Name: idx_payments_provider_tx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_provider_tx ON public.payments USING btree (provider, provider_transaction_id);


--
-- Name: idx_procedure_codes_clinic_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_procedure_codes_clinic_id ON public.procedure_codes USING btree (clinic_id);


--
-- Name: idx_tooth_history_timeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tooth_history_timeline ON public.tooth_history USING btree (clinic_id, patient_id, tooth_number, created_at DESC);


--
-- Name: idx_treatment_plan_items_clinic_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treatment_plan_items_clinic_plan ON public.treatment_plan_items USING btree (clinic_id, plan_id);


--
-- Name: idx_treatment_plan_items_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treatment_plan_items_invoice ON public.treatment_plan_items USING btree (clinic_id, invoice_id);


--
-- Name: idx_treatment_plans_clinic_patient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treatment_plans_clinic_patient ON public.treatment_plans USING btree (clinic_id, patient_id);


--
-- Name: idx_users_clinic_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_clinic_id ON public.users USING btree (clinic_id);


--
-- Name: idx_users_clinic_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_clinic_role ON public.users USING btree (clinic_id, role);


--
-- Name: uq_payments_provider_tx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payments_provider_tx ON public.payments USING btree (provider, provider_transaction_id) WHERE (provider_transaction_id IS NOT NULL);


--
-- Name: uq_scheduled_appointment; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_scheduled_appointment ON public.appointments USING btree (clinic_id, doctor_id, appointment_date) WHERE ((status)::text = 'scheduled'::text);


--
-- Name: appointments appointments_clinic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics(id) ON DELETE RESTRICT;


--
-- Name: audit_logs audit_logs_clinic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics(id) ON DELETE CASCADE;


--
-- Name: audit_logs audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: appointments fk_appointments_doctor_same_clinic; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT fk_appointments_doctor_same_clinic FOREIGN KEY (clinic_id, doctor_id) REFERENCES public.users(clinic_id, id) ON DELETE RESTRICT;


--
-- Name: appointments fk_appointments_patient_same_clinic; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT fk_appointments_patient_same_clinic FOREIGN KEY (clinic_id, patient_id) REFERENCES public.patients(clinic_id, id) ON DELETE RESTRICT;


--
-- Name: invoice_items fk_invoice_items_invoice_same_clinic; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT fk_invoice_items_invoice_same_clinic FOREIGN KEY (clinic_id, invoice_id) REFERENCES public.invoices(clinic_id, id) ON DELETE RESTRICT;


--
-- Name: invoice_items fk_invoice_items_procedure_same_clinic; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT fk_invoice_items_procedure_same_clinic FOREIGN KEY (clinic_id, procedure_code_id) REFERENCES public.procedure_codes(clinic_id, id) ON DELETE RESTRICT;


--
-- Name: invoices fk_invoices_appointment_same_clinic; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT fk_invoices_appointment_same_clinic FOREIGN KEY (clinic_id, appointment_id) REFERENCES public.appointments(clinic_id, id) ON DELETE RESTRICT;


--
-- Name: invoices fk_invoices_patient_same_clinic; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT fk_invoices_patient_same_clinic FOREIGN KEY (clinic_id, patient_id) REFERENCES public.patients(clinic_id, id) ON DELETE RESTRICT;


--
-- Name: lab_orders fk_lab_orders_appointment_same_clinic; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_orders
    ADD CONSTRAINT fk_lab_orders_appointment_same_clinic FOREIGN KEY (clinic_id, appointment_id) REFERENCES public.appointments(clinic_id, id) ON DELETE RESTRICT;


--
-- Name: lab_orders fk_lab_orders_doctor_same_clinic; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_orders
    ADD CONSTRAINT fk_lab_orders_doctor_same_clinic FOREIGN KEY (clinic_id, doctor_id) REFERENCES public.users(clinic_id, id) ON DELETE RESTRICT;


--
-- Name: lab_orders fk_lab_orders_patient_same_clinic; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_orders
    ADD CONSTRAINT fk_lab_orders_patient_same_clinic FOREIGN KEY (clinic_id, patient_id) REFERENCES public.patients(clinic_id, id) ON DELETE RESTRICT;


--
-- Name: payments fk_payments_invoice_same_clinic; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT fk_payments_invoice_same_clinic FOREIGN KEY (clinic_id, invoice_id) REFERENCES public.invoices(clinic_id, id) ON DELETE RESTRICT;


--
-- Name: invoices invoices_clinic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics(id) ON DELETE RESTRICT;


--
-- Name: lab_orders lab_orders_clinic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_orders
    ADD CONSTRAINT lab_orders_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics(id) ON DELETE RESTRICT;


--
-- Name: patient_images patient_images_clinic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_images
    ADD CONSTRAINT patient_images_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics(id) ON DELETE CASCADE;


--
-- Name: patient_images patient_images_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_images
    ADD CONSTRAINT patient_images_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;


--
-- Name: patient_images patient_images_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_images
    ADD CONSTRAINT patient_images_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: patient_teeth patient_teeth_clinic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_teeth
    ADD CONSTRAINT patient_teeth_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics(id) ON DELETE CASCADE;


--
-- Name: patient_teeth patient_teeth_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_teeth
    ADD CONSTRAINT patient_teeth_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;


--
-- Name: patients patients_clinic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics(id) ON DELETE RESTRICT;


--
-- Name: payments payments_clinic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics(id) ON DELETE RESTRICT;


--
-- Name: payments payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: procedure_codes procedure_codes_clinic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procedure_codes
    ADD CONSTRAINT procedure_codes_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics(id) ON DELETE RESTRICT;


--
-- Name: tooth_history tooth_history_clinic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tooth_history
    ADD CONSTRAINT tooth_history_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics(id) ON DELETE CASCADE;


--
-- Name: tooth_history tooth_history_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tooth_history
    ADD CONSTRAINT tooth_history_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: tooth_history tooth_history_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tooth_history
    ADD CONSTRAINT tooth_history_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;


--
-- Name: treatment_plan_items treatment_plan_items_clinic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plan_items
    ADD CONSTRAINT treatment_plan_items_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics(id) ON DELETE CASCADE;


--
-- Name: treatment_plan_items treatment_plan_items_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plan_items
    ADD CONSTRAINT treatment_plan_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE SET NULL;


--
-- Name: treatment_plan_items treatment_plan_items_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plan_items
    ADD CONSTRAINT treatment_plan_items_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.treatment_plans(id) ON DELETE CASCADE;


--
-- Name: treatment_plans treatment_plans_clinic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plans
    ADD CONSTRAINT treatment_plans_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics(id) ON DELETE CASCADE;


--
-- Name: treatment_plans treatment_plans_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plans
    ADD CONSTRAINT treatment_plans_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;


--
-- Name: users users_clinic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--


