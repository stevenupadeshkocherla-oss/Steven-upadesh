const express = require("express");
const cors = require("cors");
require("dotenv").config();

const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const { google } = require("googleapis");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const SQLite = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 5000;
const QR_VALIDITY_MS = 60 * 1000;

// Create database directory if missing
const databaseDirectory = path.join(__dirname, "database");

if (!fs.existsSync(databaseDirectory)) {
    fs.mkdirSync(databaseDirectory, { recursive: true });
}

// SQLite database
const attendanceDb = new SQLite(
    path.join(databaseDirectory, "attendance.db")
);

// Create required tables
attendanceDb.exec(`
    CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT UNIQUE NOT NULL,
        name TEXT,
        email TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        event_date TEXT,
        external_id TEXT UNIQUE,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        status TEXT DEFAULT 'PRESENT',
        checked_in_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(student_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS qr_link_emails (
        student_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        email TEXT NOT NULL,
        sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (student_id, event_id, email)
    );
`);

const eventColumns = attendanceDb.prepare("PRAGMA table_info(events)").all();
if (!eventColumns.some((column) => column.name === "external_id")) {
    attendanceDb.exec("ALTER TABLE events ADD COLUMN external_id TEXT");
}

attendanceDb.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external_id
    ON events(external_id)
    WHERE external_id IS NOT NULL
`);

attendanceDb.pragma("foreign_keys = ON");

// Gmail transporter
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_APP_PASSWORD
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Keep generated QR payloads active until they expire or are used
const activeQRs = new Map();
const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
const sheetName = process.env.GOOGLE_SHEET_NAME || "Sheet1";
let sheetsClient;
const qrLinkEmailsInProgress = new Set();

function normalizeHeader(value) {
    return String(value || "").trim().toLowerCase();
}

function quoteSheetName(value) {
    return `'${value.replace(/'/g, "''")}'`;
}

function columnName(index) {
    let column = "";
    let number = index + 1;

    while (number > 0) {
        const remainder = (number - 1) % 26;
        column = String.fromCharCode(65 + remainder) + column;
        number = Math.floor((number - 1) / 26);
    }

    return column;
}

async function getSheetsClient() {
    if (sheetsClient) {
        return sheetsClient;
    }

    const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
    if (!keyFile || !spreadsheetId) {
        throw new Error("Google Sheets configuration is missing.");
    }

    const auth = new google.auth.GoogleAuth({
        keyFile,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    sheetsClient = google.sheets({ version: "v4", auth });
    return sheetsClient;
}

async function readSheetRows() {
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${quoteSheetName(sheetName)}!A:Z`
    });
    const rows = response.data.values || [];

    if (rows.length === 0) {
        throw new Error("The configured Google Sheet is empty.");
    }

    const headerIndexes = new Map(
        rows[0].map((header, index) => [normalizeHeader(header), index])
    );

    for (const requiredHeader of ["attendance id", "event id"]) {
        if (!headerIndexes.has(requiredHeader)) {
            throw new Error(`The Google Sheet is missing the "${requiredHeader}" column.`);
        }
    }

    return { sheets, rows, headerIndexes };
}

async function syncRosterFromSheet() {
    const { rows, headerIndexes } = await readSheetRows();
    const getCell = (row, header) => {
        const index = headerIndexes.get(header);
        return index === undefined ? "" : String(row[index] || "").trim();
    };
    const students = new Map();
    const events = new Map();

    for (const row of rows.slice(1)) {
        const studentId = getCell(row, "attendance id");
        const eventId = getCell(row, "event id");

        if (!studentId || !eventId) {
            continue;
        }

        students.set(studentId, {
            studentId,
            name: getCell(row, "name"),
            email: getCell(row, "email")
        });
        events.set(eventId, {
            externalId: eventId,
            name: getCell(row, "event name") || eventId,
            eventDate: getCell(row, "event date")
        });
    }

    const importRecords = attendanceDb.transaction(() => {
        const upsertStudent = attendanceDb.prepare(`
            INSERT INTO students (student_id, name, email)
            VALUES (?, ?, ?)
            ON CONFLICT(student_id) DO UPDATE SET
                name = excluded.name,
                email = excluded.email
        `);
        const findEvent = attendanceDb.prepare(
            "SELECT id FROM events WHERE external_id = ?"
        );
        const insertEvent = attendanceDb.prepare(`
            INSERT INTO events (name, event_date, external_id)
            VALUES (?, ?, ?)
        `);
        const updateEvent = attendanceDb.prepare(`
            UPDATE events
            SET name = ?, event_date = ?
            WHERE id = ?
        `);

        for (const student of students.values()) {
            upsertStudent.run(student.studentId, student.name, student.email);
        }

        for (const event of events.values()) {
            const existing = findEvent.get(event.externalId);
            if (existing) {
                updateEvent.run(event.name, event.eventDate, existing.id);
            } else {
                insertEvent.run(event.name, event.eventDate, event.externalId);
            }
        }
    });

    importRecords();

    return {
        rows,
        headerIndexes
    };
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

async function emailDynamicQrLinks(rows, headerIndexes, origin) {
    const emailSync = {
        sent: 0,
        alreadySent: 0,
        pending: 0,
        missingEmail: 0,
        failed: 0
    };
    const getCell = (row, header) => {
        const index = headerIndexes.get(header);
        return index === undefined ? "" : String(row[index] || "").trim();
    };
    const records = new Map();

    for (const row of rows.slice(1)) {
        const studentId = getCell(row, "attendance id");
        const eventId = getCell(row, "event id");
        if (studentId && eventId) {
            records.set(`${studentId}\u0000${eventId}`, {
                studentId,
                eventId,
                studentName: getCell(row, "name"),
                eventName: getCell(row, "event name") || eventId,
                email: getCell(row, "email")
            });
        }
    }

    for (const record of records.values()) {
        if (!record.email) {
            emailSync.missingEmail += 1;
            continue;
        }

        const alreadySent = attendanceDb.prepare(`
            SELECT 1
            FROM qr_link_emails
            WHERE student_id = ? AND event_id = ? AND email = ?
        `).get(record.studentId, record.eventId, record.email);
        if (alreadySent) {
            emailSync.alreadySent += 1;
            continue;
        }

        const emailKey = `${record.studentId}\u0000${record.eventId}\u0000${record.email}`;
        if (qrLinkEmailsInProgress.has(emailKey)) {
            emailSync.pending += 1;
            continue;
        }

        qrLinkEmailsInProgress.add(emailKey);
        try {
            if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
                throw new Error("Email delivery configuration is missing.");
            }

            const qrPageUrl = new URL("/generate-qr.html", origin);
            qrPageUrl.searchParams.set("studentId", record.studentId);
            qrPageUrl.searchParams.set("eventId", record.eventId);
            const studentName = record.studentName || "Student";
            const eventName = record.eventName;
            const escapedStudentName = escapeHtml(studentName);
            const escapedEventName = escapeHtml(eventName);
            const escapedQrPageUrl = escapeHtml(qrPageUrl.toString());

            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: record.email,
                subject: `Your attendance QR link for ${eventName}`,
                text: `Hello ${studentName},\n\nUse this link to view your dynamic attendance QR code for ${eventName}:\n${qrPageUrl}\n\nThe QR code refreshes automatically and is valid only briefly after each refresh.`,
                html: `<p>Hello ${escapedStudentName},</p><p>Use the link below to view your dynamic attendance QR code for <strong>${escapedEventName}</strong>:</p><p><a href="${escapedQrPageUrl}">Open your attendance QR code</a></p><p>The QR code refreshes automatically and is valid only briefly after each refresh.</p>`
            });

            attendanceDb.prepare(`
                INSERT INTO qr_link_emails (student_id, event_id, email)
                VALUES (?, ?, ?)
                ON CONFLICT(student_id, event_id, email) DO NOTHING
            `).run(record.studentId, record.eventId, record.email);
            emailSync.sent += 1;
        } catch (error) {
            emailSync.failed += 1;
            console.error(
                `Dynamic QR link email failed for student ${record.studentId}, event ${record.eventId}:`,
                error.message
            );
        } finally {
            qrLinkEmailsInProgress.delete(emailKey);
        }
    }

    return emailSync;
}

async function syncRosterAndEmailDynamicQrLinks(origin) {
    const { rows, headerIndexes } = await syncRosterFromSheet();
    return emailDynamicQrLinks(rows, headerIndexes, origin);
}

async function writeAttendanceToSheet(qr, checkedInAt) {
    const { sheets, rows, headerIndexes } = await readSheetRows();
    const studentIdIndex = headerIndexes.get("attendance id");
    const eventIdIndex = headerIndexes.get("event id");
    const statusIndex = headerIndexes.get("status");
    const checkInIndex = headerIndexes.get("check-in time");
    const attendanceIndex = headerIndexes.get("attendance");

    if (statusIndex === undefined || checkInIndex === undefined) {
        throw new Error("The Google Sheet needs Status and Check-in Time columns.");
    }

    const matches = [];
    for (let index = 1; index < rows.length; index += 1) {
        const row = rows[index];
        if (
            String(row[studentIdIndex] || "").trim() === qr.studentCode &&
            String(row[eventIdIndex] || "").trim() === qr.eventCode
        ) {
            matches.push(index);
        }
    }

    const sheetRange = quoteSheetName(sheetName);
    if (matches.length > 1) {
        throw new Error("The sheet has duplicate student and event rows.");
    }

    if (matches.length === 1) {
        const sheetRow = matches[0] + 1;
        const updates = [
            {
                range: `${sheetRange}!${columnName(statusIndex)}${sheetRow}`,
                values: [["Present"]]
            },
            {
                range: `${sheetRange}!${columnName(checkInIndex)}${sheetRow}`,
                values: [[checkedInAt]]
            }
        ];

        if (attendanceIndex !== undefined) {
            updates.push({
                range: `${sheetRange}!${columnName(attendanceIndex)}${sheetRow}`,
                values: [["Present"]]
            });
        }

        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
                valueInputOption: "RAW",
                data: updates
            }
        });
        return;
    }

    const newRow = Array(rows[0].length).fill("");
    const nameIndex = headerIndexes.get("name");
    const emailIndex = headerIndexes.get("email");
    if (nameIndex !== undefined) {
        newRow[nameIndex] = qr.studentName;
    }
    if (emailIndex !== undefined) {
        newRow[emailIndex] = qr.studentEmail;
    }
    newRow[studentIdIndex] = qr.studentCode;
    newRow[eventIdIndex] = qr.eventCode;
    newRow[statusIndex] = "Present";
    newRow[checkInIndex] = checkedInAt;
    if (attendanceIndex !== undefined) {
        newRow[attendanceIndex] = "Present";
    }

    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetRange}!A:Z`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [newRow] }
    });
}

// Home page
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health check
app.get("/health", (req, res) => {
    res.json({
        success: true,
        status: "OK",
        project: "Smart QR Attendance"
    });
});

// Admin login
app.post("/api/admin/login", (req, res) => {
    const { username, password } = req.body || {};

    if (
        username === process.env.ADMIN_USERNAME &&
        password === process.env.ADMIN_PASSWORD
    ) {
        return res.json({
            success: true,
            message: "Admin login successful"
        });
    }

    return res.status(401).json({
        success: false,
        error: "Invalid username or password"
    });
});

// Import the latest student and event roster from Google Sheets
app.get("/api/roster", async (req, res) => {
    try {
        const origin = process.env.PUBLIC_BASE_URL ||
            `${req.protocol}://${req.get("host")}`;
        const emailSync = await syncRosterAndEmailDynamicQrLinks(origin);

        return res.json({
            success: true,
            emailSync,
            students: attendanceDb.prepare(`
                SELECT student_id AS studentId, name
                FROM students
                ORDER BY student_id
            `).all(),
            events: attendanceDb.prepare(`
                SELECT external_id AS eventId, name
                FROM events
                WHERE external_id IS NOT NULL
                ORDER BY external_id
            `).all()
        });
    } catch (error) {
        console.error("Google Sheets roster sync error:", error.message);
        return res.status(503).json({
            success: false,
            error: "Could not load the roster from Google Sheets. Check the sheet configuration and service-account access."
        });
    }
});

// Generate a unique, time-limited QR for a student and event
app.post("/api/qr/generate", async (req, res) => {
    try {
        if (req.body?.syncRoster !== false) {
            try {
                const origin = process.env.PUBLIC_BASE_URL ||
                    `${req.protocol}://${req.get("host")}`;
                await syncRosterAndEmailDynamicQrLinks(origin);
            } catch (error) {
                console.error("Google Sheets roster sync error:", error.message);
                return res.status(503).json({
                    success: false,
                    error: "Could not load the roster from Google Sheets. Check the sheet configuration and service-account access."
                });
            }
        }

        const studentId = typeof req.body?.studentId === "string"
            ? req.body.studentId.trim()
            : "";
        const eventCode = String(req.body?.eventId ?? "").trim();

        if (!studentId || !eventCode) {
            return res.status(400).json({
                success: false,
                error: "Enter a valid Student ID and Event ID"
            });
        }

        const student = attendanceDb.prepare(`
            SELECT id, student_id, name, email
            FROM students
            WHERE student_id = ?
        `).get(studentId);

        if (!student) {
            return res.status(404).json({
                success: false,
                error: "Student ID was not found"
            });
        }

        const event = attendanceDb.prepare(`
            SELECT id, external_id
            FROM events
            WHERE external_id = ?
               OR CAST(id AS TEXT) = ?
            ORDER BY CASE WHEN external_id = ? THEN 0 ELSE 1 END
            LIMIT 1
        `).get(eventCode, eventCode, eventCode);

        if (!event) {
            return res.status(404).json({
                success: false,
                error: "Event ID was not found"
            });
        }

        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = Date.now() + QR_VALIDITY_MS;
        const qrPayload = JSON.stringify({ token, expiresAt });
        const qrCode = await QRCode.toDataURL(qrPayload);

        for (const [activeToken, qr] of activeQRs) {
            if (qr.expiresAt < Date.now()) {
                activeQRs.delete(activeToken);
            }
        }

        activeQRs.set(token, {
            token,
            expiresAt,
            studentId: student.id,
            eventId: event.id,
            studentCode: student.student_id,
            studentName: student.name || "",
            studentEmail: student.email || "",
            eventCode: event.external_id || eventCode
        });

        return res.json({
            success: true,
            qrCode,
            expiresAt
        });
    } catch (error) {
        console.error("QR generation error:", error.message);

        return res.status(500).json({
            success: false,
            error: "QR generation failed. Check the server configuration and logs."
        });
    }
});

// Verify a generated QR and record attendance
app.post("/api/qr/verify", async (req, res) => {
    try {
        const { token, expiresAt } = req.body || {};
        const expiry = Number(expiresAt);

        if (
            typeof token !== "string" ||
            !/^[a-f0-9]{64}$/.test(token) ||
            !Number.isSafeInteger(expiry)
        ) {
            return res.status(400).json({
                success: false,
                status: "REJECTED",
                reason: "Invalid QR payload"
            });
        }

        if (Date.now() > expiry) {
            return res.status(401).json({
                success: false,
                status: "REJECTED",
                reason: "QR code expired"
            });
        }

        const qr = activeQRs.get(token);

        if (!qr || expiry !== qr.expiresAt) {
            return res.status(401).json({
                success: false,
                status: "REJECTED",
                reason: "Invalid QR code"
            });
        }

        const existingAttendance = attendanceDb.prepare(`
            SELECT id
            FROM attendance
            WHERE student_id = ? AND event_id = ?
        `).get(qr.studentId, qr.eventId);

        if (existingAttendance) {
            activeQRs.delete(token);
            return res.status(409).json({
                success: false,
                status: "REJECTED",
                reason: "Attendance already recorded"
            });
        }

        const checkedInAt = new Date().toISOString();

        try {
            await writeAttendanceToSheet(qr, checkedInAt);
        } catch (error) {
            console.error("Google Sheets attendance sync error:", error.message);
            return res.status(502).json({
                success: false,
                status: "REJECTED",
                reason: "Google Sheets could not be updated. Attendance was not recorded; check service-account edit access and retry."
            });
        }

        const result = attendanceDb.prepare(`
            INSERT INTO attendance (
                student_id,
                event_id,
                status,
                checked_in_at
            )
            VALUES (?, ?, 'PRESENT', ?)
            ON CONFLICT(student_id, event_id) DO NOTHING
        `).run(
            qr.studentId,
            qr.eventId,
            checkedInAt
        );

        if (result.changes === 0) {
            activeQRs.delete(token);
            return res.status(409).json({
                success: false,
                status: "REJECTED",
                reason: "Attendance already recorded"
            });
        }

        activeQRs.delete(token);

        return res.json({
            success: true,
            status: "PRESENT",
            message: "Attendance recorded successfully",
            checkInTime: checkedInAt
        });

    } catch (error) {
        console.error("QR verification error:", error.message);

        return res.status(500).json({
            success: false,
            status: "REJECTED",
            reason: "Attendance could not be saved"
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Smart QR Attendance Server running on port ${PORT}`);
});