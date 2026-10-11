# Smart QR Attendance

A web-based event attendance application. Student and event records are imported
from Google Sheets, attendees receive a link to a short-lived dynamic QR page,
and an administrator scans the QR code to record attendance in both Google
Sheets and the local SQLite database.

## Contents

- [How the system works](#how-the-system-works)
- [Requirements](#requirements)
- [Setup](#setup)
- [Google Sheets format](#google-sheets-format)
- [End-to-end flows](#end-to-end-flows)
- [HTTP endpoints](#http-endpoints)
- [Database and runtime notes](#database-and-runtime-notes)
- [Troubleshooting](#troubleshooting)

## How the system works

```text
Google Sheet
    |
    | roster sync
    v
Express server -----> SQLite roster and email-send records
    |
    | per student/event email
    v
Attendee receives a link (not a QR PDF attachment)
    |
    | opens their link; page requests a QR
    v
Unique QR token, valid for about 60 seconds
    |
    | administrator scans QR
    v
Server verifies token and writes attendance to Google Sheets and SQLite
```

The QR is generated when its link is opened, and automatically refreshes after
it expires. The emailed link identifies the student and event; it is not itself
the short-lived QR token.

## Requirements

- Node.js with npm.
- A Google Cloud project with the Google Sheets API enabled.
- A Google service account with access to the attendance spreadsheet.
- A Gmail account configured to send mail with an app password, or a compatible
  Gmail sender account.
- An internet-accessible HTTPS deployment for attendees and for administrator
  camera access. Browsers generally require HTTPS to use the camera, except on
  localhost.

## Setup

### 1. Install dependencies

From the project root:

```powershell
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root. Do not commit it or put credentials in
the `public` directory.

```dotenv
PORT=5000

ADMIN_USERNAME=replace-with-admin-username
ADMIN_PASSWORD=replace-with-a-strong-password

EMAIL_USER=sender@gmail.com
EMAIL_APP_PASSWORD=replace-with-gmail-app-password

GOOGLE_SPREADSHEET_ID=spreadsheet-id-from-google-sheets-url
GOOGLE_SHEET_NAME=Sheet1
GOOGLE_SERVICE_ACCOUNT_FILE=C:/secure/path/service-account.json

PUBLIC_BASE_URL=https://attendance.example.com
```

Configuration details:

- `PORT` is optional; the server defaults to `5000`.
- `GOOGLE_SHEET_NAME` is optional; the server defaults to `Sheet1`.
- `GOOGLE_SPREADSHEET_ID` is the ID in the spreadsheet URL between `/d/` and
  `/edit`.
- `GOOGLE_SERVICE_ACCOUNT_FILE` must point to the service-account JSON key
  file. Store that file outside the repository and never commit or expose it.
- For cloud hosts where a local key-file path is unavailable, set
  `GOOGLE_SERVICE_ACCOUNT_JSON` to the complete service-account JSON instead.
  The server prefers this variable when it is set. Add it as a protected
  environment secret in the hosting dashboard; do not commit the JSON.
- `PUBLIC_BASE_URL` should be the externally reachable site origin, without a
  trailing path. Set it in production so links in emails point to the deployed
  website, rather than an internal hostname or local address.
- For Gmail, use an app password where required; do not use or publish an
  account's normal password.

### 3. Configure Google Sheets access

1. Enable the Google Sheets API in the Google Cloud project.
2. Create a service account and download its JSON key to a protected location.
3. Share the spreadsheet with the service account's email address and grant
   **Editor** access. Editor access is needed because check-ins write to the
   sheet.
4. Set the spreadsheet ID and tab name. For local use, configure the
   service-account key file path in `.env`; for cloud hosting, configure the
   complete service-account JSON as a protected `GOOGLE_SERVICE_ACCOUNT_JSON`
   environment variable.

### 4. Prepare the sheet

The first row must contain the column headers described in
[Google Sheets format](#google-sheets-format). Header matching ignores letter
case and surrounding whitespace.

### 5. Start the server

```powershell
node server.js
```

Open `http://localhost:5000` during local development. The health endpoint is
`http://localhost:5000/health`.

There is currently no `start` script or automated test suite configured in
`package.json`; `node server.js` is the direct way to start the application.

## Google Sheets format

Use one row for each student/event combination. A sheet could look like this:

| Attendance ID | Event ID | Name | Email | Event Name | Event Date | Status | Check-in Time | Attendance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STU-001 | EVT-2026-01 | Example Student | student@example.com | Example Event | 2026-10-11 | | | |

Column requirements:

| Header | Required? | Purpose |
| --- | --- | --- |
| `Attendance ID` | Yes | Unique student identifier used to look up a student. |
| `Event ID` | Yes | Event identifier associated with the row. |
| `Status` | Required for scan write-back | Updated to `Present` at check-in. |
| `Check-in Time` | Required for scan write-back | Updated with the check-in timestamp in ISO format. |
| `Name` | No | Used in the email greeting and roster display. |
| `Email` | No for roster import; needed to email the attendee | Recipient address for the dynamic QR link. |
| `Event Name` | No | Used in the email subject/body and roster display; falls back to the Event ID. |
| `Event Date` | No | Imported as event metadata. |
| `Attendance` | No | If present, also updated to `Present` at check-in. |

The application does not require every optional column. However, scanning cannot
write attendance unless both `Status` and `Check-in Time` are present. A row
without an email address is imported but does not receive an email.

## End-to-end flows

### 1. Admin opens the dashboard

1. Visit `/admin.html` and submit the configured admin username and password.
2. On successful credential comparison, the page redirects to
   `/admin-dashboard.html`.
3. The dashboard provides a link to `/generate-qr.html` for syncing the roster
   and emailing dynamic QR links.

### 2. Roster sync and attendee email

1. Opening `/generate-qr.html` without student/event query parameters calls
   `GET /api/roster`.
2. The server reads the configured Google Sheet and imports student and event
   data into SQLite.
3. For each distinct student/event row with an email address, the server builds
   a link of this form:

   ```text
   https://attendance.example.com/generate-qr.html?studentId=STU-001&eventId=EVT-2026-01
   ```

4. The server queues email delivery and sends messages in parallel (up to five
   at a time). It does not attach a QR PDF. The roster page returns after the
   sheet sync rather than waiting for all email providers to respond.
5. Successfully emailed student/event/recipient combinations are recorded in
   SQLite to prevent repeated emails on later syncs.
6. The page reports that emails are being sent in the background. Completed
   counts and delivery errors are written to the server log.

Failed sends are logged and are not recorded as successful, so a later roster
sync can retry them. A change to the recipient email is treated as a new
recipient and can result in a new email.

Roster sync is triggered when the admin opens the QR generation page and also
when a QR is first generated from an emailed link. Only the admin roster page
queues email; an attendee opening a QR link does not start another round of
emails. Timed QR refreshes do not re-sync the entire sheet each minute.

### 3. Attendee opens the dynamic QR link

1. The attendee opens their personalized link.
2. The page reads the `studentId` and `eventId` query parameters and requests a
   QR from `POST /api/qr/generate`.
3. The server synchronizes the roster, validates the student and event, creates
   a unique random token, and returns a QR image and expiration time.
4. The page displays the QR and countdown.
5. When the QR expires (currently after about 60 seconds), the page requests a
   fresh QR automatically. The attendee can keep the link open; each QR is
   short-lived and has a distinct token.

The QR link page hides the manual student/event form. That form remains
available at `/generate-qr.html` without query parameters for admin-side roster
selection and QR generation.

### 4. Admin scans and verifies attendance

1. On the dashboard, the admin starts the camera scanner and scans the
   attendee's current QR.
2. The browser decodes the token and expiration time and posts them to
   `POST /api/qr/verify`.
3. The server rejects malformed, expired, unknown, or already-used tokens.
4. If attendance has not already been recorded, the server finds the matching
   student/event row in Google Sheets and updates `Status` and `Check-in Time`.
   If an `Attendance` column exists, that is also set to `Present`.
5. After a successful Sheets update, attendance is inserted into SQLite and
   the dashboard reports `PRESENT`.
6. Duplicate attendance is rejected. If the sheet cannot be updated, the
   server does not report a successful check-in.

## HTTP endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Serves the homepage. |
| `GET` | `/health` | Returns a basic server health response. |
| `POST` | `/api/admin/login` | Compares the submitted credentials with the admin environment variables. |
| `GET` | `/api/roster` | Syncs the roster from Sheets, emails eligible records, and returns students, events, and email counts. |
| `POST` | `/api/qr/generate` | Creates a unique short-lived QR for a student/event. |
| `POST` | `/api/qr/verify` | Verifies a QR and records a successful check-in. |

## Database and runtime notes

- SQLite is stored at `database/attendance.db`; the server creates the
  application tables when it starts.
- The SQLite database includes students, events, attendance, and QR-link email
  send records.
- Active QR tokens are held in server memory and expire after about 60 seconds.
  Restarting the server invalidates outstanding QR codes.
- Because active tokens are in memory, a multi-instance deployment needs
  shared token storage or sticky routing to ensure generation and verification
  reach the same server instance.
- Google Sheets is read during roster sync and again during check-in write-back.
  The deployed server must have network access to Google's APIs.
- The QR validity period is currently a constant in `server.js` and is set to
  60 seconds.

## Troubleshooting

| Symptom | Checks |
| --- | --- |
| Roster fails to load | Confirm `GOOGLE_SPREADSHEET_ID`, `GOOGLE_SHEET_NAME`, and the Google service-account configuration. Cloud deployments should use `GOOGLE_SERVICE_ACCOUNT_JSON`, not a local machine key-file path. Share the sheet with that service account and check that `Attendance ID` and `Event ID` headers exist. The roster error response and server log provide more detail. |
| Email does not arrive | Confirm `EMAIL_USER` and `EMAIL_APP_PASSWORD`; check the displayed email failure/missing-email counts and the server log. Verify the sheet row has a valid email address. |
| Email link opens the wrong host | Set `PUBLIC_BASE_URL` to the public HTTPS origin and restart the server. |
| QR page says student or event not found | Run a roster sync and verify the link's IDs match the sheet's `Attendance ID` and `Event ID` values. |
| QR cannot be scanned | Ensure the QR has not expired, increase screen brightness, and scan the currently displayed QR. |
| Camera cannot start | Grant camera permission and use HTTPS in deployment; localhost is allowed for local testing. |
| QR is rejected as expired or invalid | Leave the attendee link open to refresh, then scan the latest QR. A server restart also invalidates previously generated tokens. |
| Check-in is rejected due to Sheets | Ensure the service account has Editor access and that `Status` and `Check-in Time` headers exist. Check for duplicate student/event rows in the sheet. |

## Security considerations

- Keep `.env` and the service-account JSON key out of source control. Do not put
  keys or credentials under `public/`.
- Deploy behind HTTPS, use a strong admin password, and protect the hosting
  environment and logs.
- The current admin login is a frontend redirect after a credential comparison;
  it does not establish a server-side session. Static pages and API endpoints
  are not protected by authenticated middleware. Add server-side authentication
  and authorization before using this application where the dashboard or APIs
  must be restricted to administrators.
- Treat attendee QR links as private links because they include student and
  event identifiers.
