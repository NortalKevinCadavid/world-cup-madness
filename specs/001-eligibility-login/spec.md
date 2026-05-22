# Feature Specification: Eligibility & Login

**Feature Branch**: `001-eligibility-login`

**Created**: 2026-05-15

**Status**: Draft

**Input**: User description: "Vertical slice covering FR-001 (eligibility-restricted access), FR-002 (rejection of non-approved domains at UI and API), and FR-003 (participant profile provisioning on first eligible login). Anchored to §15.1 'Approved domain login' and 'Rejected domain login' acceptance scenarios."

**Architecture anchors**:

- Implements **FR-001, FR-002, FR-003**
- Satisfies §15.1 scenarios: *Approved domain login*, *Rejected domain login*
- Depends on OD-001 (exact approved domain list) — spec assumes the list is operator-configurable; concrete domains are set per Slice 008 (Configuration)
- Constitution principles in force: II (Security by Design), V (Auditability), VIII (Extensibility & Configuration)

## Clarifications

### Session 2026-05-15

- Q: What set of values does the participant's `participation_status` attribute take? → A: `{active, deactivated}` — two-state enum. `active` is set by the auth-hook on first eligible provisioning; `deactivated` is the only other value and is set exclusively by admin action (Slice 006) when a participant must be excluded mid-tournament (e.g., domain removed from the approved list and business decides to deactivate, or dispute resolution). Future additional statuses (suspended, banned, archived) are deliberately out of scope until a concrete business need is documented; adding them is a non-breaking enum extension.
- Q: On a returning login, if the IdP returns an `email` that differs from the stored `participants.email` for the same authenticated identity, what is the system's behavior? → A: **Audit drift; keep stored email.** The system MUST audit the divergence as a `participant.email_drift` event capturing both the stored email and the IdP-provided email, MUST continue to use the stored email as the source of truth for the eligibility decision and all downstream references, and MUST NOT overwrite `participants.email`. Reconciliation (if business decides to update the stored email) is an admin action governed by Slice 006 and out of scope here. Rationale: prevents an IdP-side email reassignment from silently inheriting another participant's history (account-takeover guard) while preserving operational continuity for legitimate name changes.
- Q: When an admin removes a participant's domain from the approved list while that participant has a valid active session, what is the user-visible behavior? → A: **Block every next authenticated request (read or write).** The participant's existing JWT remains technically valid but every authenticated route MUST call the eligibility predicate as its first check after JWT parse and MUST return `403` with the standard denial response on failure; the next page navigation MUST render the denial screen. Row-level authorization on participant-readable tables MUST also deny reads independently (defense in depth). The JWT itself is NOT server-side revoked. Same behavior applies when the participant's `participation_status` flips to `deactivated` mid-session. Rationale: meets SC-004's one-minute responsiveness target without the operational cost of a JWT-revocation denylist, gives a consistent denial UX, and satisfies FR-002's per-authenticated-session re-verification clause.
- Q: On a returning login, if an optional attribute that was previously populated (e.g., `region`) is now missing from the IdP payload, what happens to the stored value? → A: **Retain the previously stored value.** The refresh routine MUST update only those refreshable attributes that the IdP actually returns in the payload; a missing claim MUST be treated as "no signal" and MUST NOT clear, null, or otherwise modify the stored value. Rationale: IdPs commonly omit optional claims for benign reasons (token-size limits, scope changes, attribute-mapping toggles); treating absence as deletion would cause surprising data loss for participants in downstream features (e.g., future office/region leagues). The "newly available" case (US3.2) continues to populate the attribute as before.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Eligible employee signs in (Priority: P1)

A Nortal employee opens the World Cup Madness application for the first time, authenticates through the corporate identity provider, and is recognized as eligible. The application provisions their participant profile and lands them on the dashboard. On subsequent visits, the same user is recognized immediately and their profile is refreshed without manual steps.

**Why this priority**: Nothing in the rest of the product is reachable without an authenticated, eligible participant. This is the foundation slice for every other vertical.

**Independent Test**: Sign in as a user whose email domain is on the approved list, verify the dashboard renders and that the participant record exists with display name, email, domain, and participation status. Sign out and sign back in — verify the same profile is reused and `last_login_at` updates.

**Acceptance Scenarios**:

1. **Given** a user authenticated through the corporate identity provider with an email domain on the approved list and no existing participant record, **When** they reach the application after the identity callback, **Then** a participant profile MUST be created with display name, email, domain, region (if available), `participation_status = active` (from the two-state enum `{active, deactivated}`), and first-login timestamp, and the user MUST land on the participant dashboard.
2. **Given** an existing eligible participant signing in again, **When** they complete the identity flow, **Then** the existing profile MUST be re-used (no duplicate created), `last_login_at` MUST be updated to the current server time, and the user MUST reach the dashboard within 10 seconds.
3. **Given** an eligible user, **When** any subsequent state-changing request is made, **Then** the server MUST re-verify domain eligibility from the current session identity (not from a cached client claim) before honoring the request.

### User Story 2 - Ineligible domain is rejected (Priority: P1)

A user authenticates successfully through the corporate identity flow but their verified email domain is not on the approved Nortal domain list. They are denied access at the UI and cannot bypass the denial by calling the API directly. No participant profile is created. The denied attempt is recorded for security review.

**Why this priority**: This is a hard product constraint (FR-002) and a Constitution Principle II non-negotiable. Slipping on this principle exposes the prediction pool to outside-Nortal access.

**Independent Test**: Authenticate as a user whose email domain is NOT on the approved list. Verify the UI shows a clear access-denied state. Capture the session token (or API credential) from that flow and directly call any participant-data endpoint. Verify the API returns an access-denied response and that no participant record exists. Verify a denied-access audit event was written.

**Acceptance Scenarios**:

1. **Given** a user whose verified email domain is NOT in the approved-domain configuration, **When** they complete the identity callback, **Then** the application MUST deny access, MUST NOT create or update any participant profile, and MUST display a clear denial message without leaking information about other accounts or domains.
2. **Given** the same ineligible user with a valid identity-provider session, **When** they bypass the UI and call a participant-data API endpoint directly with their session token, **Then** the API MUST reject the request with the same denial regardless of route, and the rejection MUST NOT depend on UI gating.
3. **Given** an ineligible-domain access attempt (UI or API), **When** the rejection is issued, **Then** an audit event MUST be recorded with timestamp, source (UI / API), attempted identity, attempted domain, and reason, and no other side-effect MUST occur.

### User Story 3 - Returning user with changed attributes (Priority: P2)

An eligible participant signs back in and one of their identity-provider attributes has changed (e.g., display name, region). The application refreshes the corresponding profile fields without creating a duplicate and without losing existing predictions, scoring history, or audit trail.

**Why this priority**: Returning logins are the dominant path during the tournament. Stale or duplicated profiles would corrupt the leaderboard and audit history.

**Independent Test**: Sign in as an eligible participant, edit their display name in the identity provider, sign in again. Verify the existing profile's display name updated, the participant ID is unchanged, and prior predictions / audit records still reference the same participant.

**Acceptance Scenarios**:

1. **Given** an existing participant whose corporate display name has changed at the identity provider, **When** they sign in again, **Then** the participant record MUST be updated in place (same participant ID), and any historical prediction or audit record MUST remain linked to that participant.
2. **Given** a participant whose region attribute is newly available at the identity provider after their initial sign-in, **When** they sign in again, **Then** the region field MUST be populated without overwriting unrelated profile fields.
3. **Given** a participant whose region attribute was previously populated but is no longer present in the identity provider's payload on a subsequent sign-in, **When** they sign in again, **Then** the stored region value MUST remain unchanged (missing claim is not a delete signal — see Clarifications 2026-05-15), and no other refreshable attribute MUST be inadvertently modified.

### Edge Cases

- A user authenticates through the corporate identity provider, but the identity payload is missing the email or domain claim → access MUST be denied; no profile created.
- The approved-domain configuration changes between two requests in the same browser session (whether the user has signed in again or merely reused an existing session) → the next request's eligibility decision MUST use the current configuration, not a cached value from session start; every authenticated request re-evaluates eligibility against the live configuration.
- A previously-eligible participant's domain is removed from the approved list mid-tournament → their existing predictions and audit history MUST be preserved, but new sessions MUST be denied. Their *currently active* session MUST be denied on its next authenticated request (read or write) — the predicate re-evaluation produces a `403` and the next navigation renders the denial screen; the JWT itself is not server-side revoked (see Clarifications 2026-05-15). The policy for how to treat their existing predictions is governed by Slice 008 configuration and must not silently delete data.
- The identity provider returns a session that authenticates the user but cannot be verified server-side (e.g., signature mismatch) → access MUST be denied even if the email domain is on the approved list.
- A user attempts to sign in while the application's domain configuration store is temporarily unreachable → access MUST be denied by default (fail-closed), not granted.
- A user with two corporate identities under different approved domains signs in with each → two distinct participant profiles MUST be created (one per verified identity), and the application MUST NOT merge them silently.
- A returning user authenticates with the same identity (same `sub` / authenticated identifier) but the identity provider returns a different email than the one stored on the participant record → the system MUST write a `participant.email_drift` audit event capturing both addresses, MUST keep the stored email unchanged, MUST use the stored email as the source of truth for the eligibility decision, and MUST NOT block the sign-in if eligibility evaluated against the stored email still passes (see Clarifications 2026-05-15).
- A direct API call presents a forged or expired token → rejection MUST occur before any participant lookup, and the rejection MUST be audited.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST restrict all participant-data read and write paths to authenticated users whose verified email domain matches the configured approved-domain list (implements architecture FR-001).
- **FR-002**: System MUST validate eligibility at the server boundary (database row-level policy plus server-side handler) on every authenticated request — read or state-changing — by calling the eligibility predicate against the current session identity (not a cached claim) and the live approved-domain configuration. A previously-eligible session that loses eligibility mid-flight (domain removed, participant deactivated) MUST be denied with a `403`-equivalent response on its next request and MUST render the standard denial screen on the next page navigation; row-level authorization MUST independently deny reads. UI-only gating MUST NOT be the sole enforcement (architecture FR-002, Constitution Principle II; see Clarifications 2026-05-15 for the mid-session removal behavior).
- **FR-003**: System MUST create a participant profile on the first successful eligible sign-in, capturing display name, email, domain, region (if available), `participation_status` (initialized to `active`; allowed values are exactly `{active, deactivated}` — see Clarifications 2026-05-15), first-login timestamp, and last-login timestamp (architecture FR-003).
- **FR-004**: System MUST refresh an existing participant's mutable profile attributes on subsequent eligible sign-ins without creating duplicates and without altering the participant identifier. The set of refreshable attributes is exactly `{display_name, region, last_login_at}`; `email`, `domain`, `participation_status`, `first_login_at`, and the participant identifier MUST NOT be modified by a returning sign-in. If the identity provider's email claim diverges from the stored email for the same authenticated identity, see Clarifications 2026-05-15 (audit-only policy).
- **FR-005**: System MUST reject login, registration, and API access attempts from non-approved domains with the same denial behavior regardless of entry path (UI, deep link, direct API).
- **FR-006**: System MUST record every denied-access attempt to the audit trail (Slice 007) with timestamp, source (UI / API / token kind), attempted identity, attempted domain, and reason.
- **FR-007**: System MUST treat the approved-domain list as live configuration sourced from Slice 008, with changes taking effect for new eligibility evaluations within 1 minute of save.
- **FR-008**: System MUST fail closed when the eligibility-decision data is unavailable — access MUST be denied rather than granted by default.
- **FR-009**: System MUST NOT capture identity attributes outside the enumerated FR-003 list; no HR, payroll, or performance attributes may be stored.

### Key Entities

- **Participant**: Represents a Nortal employee or collaborator who has been verified as eligible at least once. Attributes: stable participant identifier, display name, email, domain, optional region, `participation_status` ∈ `{active, deactivated}`, first-login timestamp, last-login timestamp. Owned by the application; lifecycle bound to the corporate identity boundary. State transitions: `active` is the initial state set by the auth flow; the only allowed transition is `active → deactivated` via admin action (Slice 006). `deactivated → active` reactivation is an admin action governed by Slice 006 policy and is out of scope for this slice.
- **Approved Domain (configuration reference)**: A corporate domain string that grants eligibility when matched against a verified email. Managed in Slice 008 (Configuration); referenced read-only by this slice.
- **Access Decision Event (audit reference)**: A record emitted to the audit trail for every grant and every denial. Includes outcome, source, attempted identity, attempted domain, and reason. Written by this slice into Slice 007's append-only audit log.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of access attempts from non-approved domains are denied at both UI and API paths, verified by automated tests that exercise each surface.
- **SC-002**: An eligible returning user reaches the participant dashboard within 10 seconds of completing the identity callback under normal load.
- **SC-003**: 100% of first-time eligible sign-ins result in a participant profile with all required attributes (display name, email, domain, participation status, first-login timestamp) populated.
- **SC-004**: Approved-domain configuration changes take effect for the next eligibility evaluation on **every** authenticated request — including in-flight sessions — within 1 minute, without a code deploy.
- **SC-005**: Zero duplicate participant profiles created across at least 1,000 simulated returning sign-ins for the same identity.
- **SC-006**: 100% of denied access attempts produce a corresponding audit event retrievable within 5 seconds.

## Assumptions

- Nortal operates a corporate identity provider that exposes a verifiable email and domain claim per authenticated user. This slice integrates with that provider; it does not build authentication primitives from scratch.
- The exact set of approved domains is open (OD-001) and will be configured through Slice 008 before launch. This spec assumes "operator-configurable list of one or more domain strings" without prejudicing which domains are eventually approved.
- Participant identifiers are stable across the tournament and are independent of the identity provider's internal user identifier (so the IdP can be replaced without breaking historical predictions).
- Region is an optional attribute that may not be present for every identity payload; absence MUST NOT block eligibility.
- This slice does not implement role-based admin authorization; that lives in Slice 006 (Admin Overrides & Recalculation) and Slice 008 (Configuration). Eligibility here is purely the participant-domain check.
