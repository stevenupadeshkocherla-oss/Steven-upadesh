const express = require("express");
const cors = require("cors");
require("dotenv").config();

const db = require("./database/db.js");
const QRCode = require("qrcode");
const crypto = require("crypto");
const path = require("path");
const SQLite = require("better-sqlite3");

const app = express();

const PORT = process.env.PORT || 5000;
const attendanceDb = new SQLite(
    path.join(__dirname, "database", "attendance.db"),
    { fileMustExist: false }
);

attendanceDb.pragma("foreign_keys = ON");

/* =========================
   MIDDLEWARE
========================= */

app.use(cors());
app.use(express.json());
app.use(express.static("public"));


/* =========================
   ADMIN LOGIN
========================= */

app.post("/api/admin/login", (req, res) => {

    const { username, password } = req.body;

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


/* =========================
   HOME
========================= */

app.get("/", (req, res) => {

    res.sendFile(
        __dirname + "/public/index.html"
    );

});


/* =========================
   HEALTH CHECK
========================= */

app.get("/health", (req, res) => {

    res.json({
        status: "OK",
        project: "Smart QR Attendance Pipeline",
        timestamp: new Date().toISOString()
    });

});


/* =========================
   DATABASE TEST
========================= */

app.get("/api/db-test", async (req, res) => {

    try {

        const result = await db.query(
            "SELECT NOW()"
        );

        res.json({
            status: "Database Connected",
            time: result.rows[0].now
        });

    } catch (error) {

        console.error(
            "Database Error:",
            error.message
        );

        res.status(500).json({
            status: "Database Connection Failed",
            error: error.message
        });

    }

});


/* =========================
   SECURE QR SYSTEM
========================= */

let currentQR = null;


/*
   Used QR tokens are stored here.

   This prevents the same QR from
   being accepted again.
*/

const usedTokens = new Set();


/* =========================
   GENERATE QR
========================= */

app.post("/api/qr/generate", async (req, res) => {

    try {
        const studentId =
            typeof req.body?.studentId === "string"
                ? req.body.studentId.trim()
                : "";
        const eventId = Number(req.body?.eventId);

        if (!studentId || !Number.isSafeInteger(eventId) || eventId <= 0) {
            return res.status(400).json({
                success: false,
                error: "A valid student ID and event ID are required"
            });
        }

        const student = attendanceDb.prepare(
            "SELECT id FROM students WHERE student_id = ?"
        ).get(studentId);

        if (!student) {
            return res.status(404).json({
                success: false,
                error: "Student ID was not found"
            });
        }

        const event = attendanceDb.prepare(
            "SELECT id FROM events WHERE id = ?"
        ).get(eventId);

        if (!event) {
            return res.status(404).json({
                success: false,
                error: "Event ID was not found"
            });
        }

        /*
           Generate cryptographically
           secure random token.
        */

        const token = crypto
            .randomBytes(32)
            .toString("hex");


        /*
           QR expires after 60 seconds.
        */

        const expiresAt =
            Date.now() + 60 * 1000;

        /*
           QR payload.

           The attendee and event association
           remains on the server.
        */

        const qrData = JSON.stringify({
            token,
            expiresAt
        });


        const qrCode =
            await QRCode.toDataURL(qrData);

        currentQR = {
            token,
            expiresAt,
            studentId: student.id,
            eventId: event.id
        };

        res.json({

            success: true,

            qrCode,

            expiresAt

        });


    } catch (error) {

        console.error(
            "QR Error:",
            error.message
        );

        res.status(500).json({

            success: false,

            error: "QR generation failed"

        });

    }

});


/* =========================
   VERIFY QR
========================= */

app.post("/api/qr/verify", async (req, res) => {

    try {

        const { token, expiresAt } = req.body || {};
        const expiresAtTimestamp = Number(expiresAt);


        /*
           Basic validation
        */

        if (
            typeof token !== "string" ||
            !/^[a-f0-9]{64}$/.test(token) ||
            !Number.isSafeInteger(expiresAtTimestamp)
        ) {

            return res.status(400).json({

                success: false,

                status: "REJECTED",

                reason: "Invalid QR payload"

            });

        }


        /*
           Check whether QR has expired.
        */

        if (Date.now() > expiresAtTimestamp) {

            return res.status(401).json({

                success: false,

                status: "REJECTED",

                reason: "QR code expired"

            });

        }


        /*
           Check whether this is
           the currently generated QR.
        */

        if (
            !currentQR ||
            token !== currentQR.token ||
            expiresAtTimestamp !== currentQR.expiresAt
        ) {

            return res.status(401).json({

                success: false,

                status: "REJECTED",

                reason: "Invalid QR code"

            });

        }


        /*
           Anti-replay protection.
        */

        if (usedTokens.has(token)) {

            return res.status(409).json({

                success: false,

                status: "REJECTED",

                reason: "QR already used"

            });

        }


        const checkedInAt = new Date().toISOString();
        const insertAttendance = attendanceDb.prepare(`
            INSERT INTO attendance (
                student_id,
                event_id,
                status,
                checked_in_at
            )
            VALUES (?, ?, 'PRESENT', ?)
            ON CONFLICT(student_id, event_id) DO NOTHING
        `);
        const insertResult = insertAttendance.run(
            currentQR.studentId,
            currentQR.eventId,
            checkedInAt
        );

        if (insertResult.changes === 0) {
            return res.status(409).json({
                success: false,
                status: "REJECTED",
                reason: "Attendance already recorded"
            });
        }

        usedTokens.add(token);

        return res.json({

            success: true,

            status: "PRESENT",

            message: "QR verified successfully",

            checkInTime:
                checkedInAt

        });


    } catch (error) {

        console.error(
            "QR Verification or attendance persistence error:",
            error.message
        );

        res.status(500).json({

            success: false,

            status: "REJECTED",

            reason: "Attendance could not be saved"

        });

    }

});


/* =========================
   DASHBOARD STATUS
========================= */

app.get("/api/dashboard/status", async (req, res) => {

    try {

        /*
           Basic database connectivity
           status for dashboard.
        */

        await db.query("SELECT NOW()");

        res.json({

            success: true,

            database: "Connected",

            scanner: "Ready",

            security: "Active"

        });

    } catch (error) {

        res.status(500).json({

            success: false,

            database: "Disconnected",

            scanner: "Unavailable",

            security: "Unavailable"

        });

    }

});


/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {

    console.log(
        `Smart QR Attendance Server running on port ${PORT}`
    );

});