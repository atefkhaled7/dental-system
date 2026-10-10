# Curosta — Backend Development Guide

## 1. Project Overview

Curosta is a multi-tenant dental clinic management SaaS.

The backend is responsible for authentication, authorization, clinic and staff management, patient records, appointments, treatment plans, invoices, payments, laboratory orders, public booking, and audit logging.

**Primary goal:** Maintain a reliable, secure, and financially consistent system for real dental clinics without unnecessary rewrites or overengineering.

## 2. Technology Stack

* Node.js with Express.js.
* PostgreSQL hosted on Neon.
* JWT authentication.
* Vercel deployment.
* CommonJS modules using `require()` and `module.exports`.
* Sentry-based error monitoring when `SENTRY_DSN` is configured.

Before introducing a new library, framework, architectural pattern, or external service, inspect the existing project and explain why the addition is necessary.

Do not assume dependencies or infrastructure exist simply because they are common in other projects.

## 3. Important References

* **Database schema:** Read `docs/database-schema.md` before making schema-dependent changes. It contains a summary of the current Neon schema.
* **Migrations:** Inspect the existing migration directory, naming convention, migration runner, and `schema_migrations` tracking before creating or executing a migration.
* **Main server configuration:** `server.js`.
* **Database connection:** `db.js`.
* **Backend implementation:** Inspect the existing `controllers/`, `routes/`, `middleware/`, and `utils/` directories before changing related functionality.

The live Neon schema is the reference for the actual database structure. The schema document and migration files are documentation/history and may become outdated.

If code, documentation, migrations, and the live schema disagree, identify the discrepancy before making changes that depend on it.

Never invent a directory path, npm script, database column, relationship, or helper function. Inspect the repository first.

## 4. Database and Tenant Isolation

Curosta uses `clinic_id` to separate clinic-owned data.

Rules:

* For authenticated clinic operations, derive the clinic identity from the authenticated user, normally `req.user.clinic_id`, rather than trusting `clinic_id` from request input.
* Apply clinic scoping to tenant-specific reads and writes.
* Validate that referenced patients, doctors, appointments, invoices, procedures, and other records belong to the correct clinic.
* Use existing composite foreign keys and constraints correctly. Do not assume that every foreign key independently enforces clinic ownership.
* Respect the SuperAdmin role and its global operations where explicitly authorized.
* Use parameterized SQL for all externally supplied values.
* Never build SQL values by concatenating user input. When dynamic SQL is necessary, use trusted, explicitly controlled column names and parameterized values.
* Prefer selecting the columns actually needed in new read queries. Do not refactor existing working queries solely for stylistic consistency.
* Preserve existing constraints and indexes unless a demonstrated issue requires a change.

### Important Data Rules

* `is_active` and `is_archived` represent different concepts. Never interchange them without verifying the existing workflow.
* Financial records must not be silently deleted to correct mistakes. Use appropriate, auditable cancellation, reversal, or refund workflows.
* A status or column existing in the database does not prove its complete business workflow is implemented.
* Preserve tenant boundaries and existing foreign-key deletion policies.

Refer to `docs/database-schema.md` for the current table summary, important columns, constraints, relationships, and database rules.

## 5. Authentication and Authorization

The supported roles are:

* `SuperAdmin`
* `ClinicAdmin`
* `Doctor`
* `Receptionist`

The current schema allows `SuperAdmin` accounts to have `clinic_id = NULL`; other user roles require a clinic.

Rules:

* Enforce authorization in the backend. Hiding a button or page in the frontend is not sufficient.
* Check that the authenticated user may perform the requested operation on the specific target record.
* A doctor must not manage another doctor's shifts, leave, or other restricted records merely because both belong to the same clinic.
* Validate clinic ownership for referenced records where required.
* Preserve the existing JWT and `token_version` invalidation mechanism. Inspect the current authentication middleware before changing token behavior.
* Respect existing account activation and subscription behavior.

Do not invent new role permissions. If a business permission is unclear and cannot be determined from the existing implementation or requirements, ask before deciding.

## 6. Financial Integrity

Financial correctness is a high priority.

When changing invoices or payments:

* Preserve consistency between invoice totals, payments, outstanding balances, and reported revenue.
* Enforce monetary validation on the backend, not only through frontend form constraints.
* Prevent overpayment and incorrect balance updates, including concurrent requests.
* Use database transactions and appropriate row locking when required to keep dependent financial operations consistent.
* Handle payment and invoice state transitions according to the existing business rules.
* Preserve an auditable history when correcting financial mistakes.
* Do not assume that `refunded`, `cancelled`, or `needs_review` means the associated workflow is complete. Verify the actual implementation.
* Check dashboard calculations and exports when changing the underlying financial logic.

Do not alter financial rules or introduce new payment behavior without understanding the current implementation first.

## 7. Appointments and Public Booking

Appointment availability and booking requests must remain consistent.

Rules:

* Use the existing appointment status values and database constraints.
* Check doctor availability, leave dates, service duration, existing appointments, and relevant pending booking requests.
* Handle overlapping bookings and concurrent requests correctly.
* Revalidate availability when approving a public booking request; do not rely exclusively on previously displayed slots.
* Keep slot generation and booking submission consistent regarding minimum notice periods and service duration.
* Respect booking-request expiration and ensure expired requests no longer block availability.
* Do not create appointments that represent visits that never happened.
* Preserve correct links between appointments, patients, doctors, invoices, and clinic records.

### Duration Limits

The current database schema uses different duration limits for different purposes:

* `clinics.default_appointment_duration`: 5–240 minutes.
* `procedure_codes.duration_minutes`: nullable, otherwise 5–480 minutes.
* `booking_requests.duration_minutes`: 5–480 minutes.
* `appointments.duration_minutes`: 5–480 minutes.

Do not change these limits independently. Keep validation, slot calculation, appointment creation, and database constraints consistent.

### Timezone

Clinic scheduling uses Cairo local time (`Africa/Cairo`).

* Follow the existing timezone conversion helpers and conventions.
* Do not rely on the server's local timezone for clinic scheduling.
* Review timestamp types and existing frontend/backend date handling before modifying date logic.
* Test date-sensitive changes using the intended Cairo timezone.

## 8. Coding Conventions

* Use camelCase for JavaScript variables and functions.
* Use snake_case for database column names.
* Use `const` by default and `let` when reassignment is needed. Do not introduce `var`.
* Follow the existing CommonJS module style.
* Reuse existing validation helpers and middleware where appropriate.
* Keep changes focused on the requested issue.
* Prefer small, understandable changes over unnecessary abstractions or large rewrites.

### Async Operations and Transactions

* Follow the error-handling style already used by the relevant route and controller.
* Many existing controllers handle errors with `try/catch`; do not introduce `asyncHandler`, `AppError`, or a new error-handling architecture unless the project already uses it or there is a concrete reason to change it.
* Use transactions for operations involving dependent writes that must succeed or fail together.
* Ensure transactions are committed or rolled back correctly and database clients are released.
* Avoid adding transactions to unrelated operations without a demonstrated need.

### SQL and Validation

* Use parameterized queries.
* Reuse existing UUID and other validation helpers where appropriate.
* Return appropriate HTTP errors for invalid inputs and known database conflicts.
* Do not expose raw SQL errors, credentials, stack traces, or other internal details to API clients.
* Avoid broad validation rewrites for hypothetical inputs that are already constrained by established frontend controls, unless backend data integrity, authorization, or another real security boundary requires validation.

## 9. API and Error Handling

The current API routes use the `/api/` prefix. Do not introduce `/api/v1/` or change route URLs unless versioning is an explicitly approved requirement.

Existing response shapes vary between endpoints. Preserve the response contract expected by the current frontend unless a response change is specifically required and all affected consumers are accounted for.

### Error Monitoring

* Reuse `captureError` from the existing error-tracking utility.
* Unexpected server errors caught inside controllers should be reported through `captureError` before returning the generic server-error response.
* Handle expected validation errors and known database conflicts, such as duplicate-key violations, according to the existing endpoint behavior rather than reporting every expected rejection as an unexpected server failure.
* Avoid reporting the same error twice when it is already captured by another layer.
* Preserve the Sentry initialization and current configuration.
* Consider errors handled inside local `catch` blocks separately from errors that reach the global Express error handler.
* Do not log sensitive patient, authentication, or financial information unnecessarily.

Do not claim error monitoring is functional solely because the capture function exists; verify it when testing changes to monitoring.

## 10. Migrations and Schema Changes

* Never modify an old migration that has already been applied. Create a new, correctly numbered migration following the project's existing convention.
* Inspect the current schema and existing migration history before designing a schema change.
* Keep migrations consistent with the actual migration runner and `schema_migrations` table.
* Never invent a migration command. Check `package.json` and the existing migration scripts first.
* Do not execute a migration against Neon or modify production data without explicit authorization.
* After a schema change, update `docs/database-schema.md` when relevant.
* Check whether the change requires new constraints, indexes, foreign keys, or changes to existing queries.

A migration file being present does not mean it has been executed successfully.

## 11. Testing and Verification

Before modifying code, inspect the relevant controller, routes, middleware, related database constraints, and frontend/backend contract when necessary.

After making a change:

* Run the relevant existing tests.
* Run the available lint and build scripts when practical.
* Test the specific affected workflow, not only syntax.
* For booking changes, test availability, submission, conflict handling, and approval where relevant.
* For financial changes, test balances, status transitions, and concurrent operations where relevant.
* For permission changes, verify both allowed and forbidden access.
* For schema changes, verify the migration and the resulting database structure.
* Clearly distinguish tests actually executed from tests that could not be run because the database, credentials, or required environment was unavailable.

Never claim that an operation or test succeeded unless the result confirms it.

## 12. How to Work on This Project

The project owner is building both the backend and frontend and prefers practical, minimal fixes over theoretical perfection.

Follow these rules:

1. Read the relevant source files before suggesting or implementing a change.
2. Fix confirmed, meaningful defects rather than inventing hypothetical edge cases.
3. Do not modify code that is already correct just to make it look different.
4. Do not expand the scope of a fix without a concrete reason.
5. Preserve existing business logic and API contracts unless they are the source of the defect.
6. If a missing requirement, schema detail, business rule, or architecture decision is essential and cannot be established from the repository, ask the project owner before guessing.
7. Do not ask questions about information that can be obtained directly from the existing code or configuration.
8. When fixing a defect, identify the exact code to replace and provide the replacement where appropriate.
9. Explain the reason for a change briefly, focusing on its real impact.
10. If the code is already correct for the requested task, say so and do not make unnecessary changes.

**Priority order:** data integrity, financial correctness, tenant isolation, authorization, core workflows, reliable error handling, then maintainability and performance improvements.

The goal is a stable, maintainable clinic SaaS—not unnecessary architectural complexity.
