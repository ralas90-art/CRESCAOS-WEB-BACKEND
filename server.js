const express = require("express");
const cors = require("cors");
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
require("dotenv").config();

const db = require("./db");
const worker = require("./worker");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// In-memory rate limiting map for intake requests
const rateLimitMap = new Map();

function applyRateLimit(req, res, next) {
  const ip = (req.headers && req.headers['x-forwarded-for']) || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const maxRequests = 20; // 20 requests per minute

  const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + windowMs };

  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + windowMs;
  } else {
    record.count++;
  }

  rateLimitMap.set(ip, record);

  if (record.count > maxRequests) {
    return res.status(429).json({
      success: false,
      error: "Too many requests. Please try again later."
    });
  }

  next();
}

// Environment Credentials Getter (Read at runtime to support dynamic test overrides)
function getCredentials() {
  return {
    accessToken: process.env.GHL_ACCESS_TOKEN,
    locationId: process.env.GHL_LOCATION_ID,
    pipelineId: process.env.GHL_PIPELINE_ID,
    stageId: process.env.GHL_STAGE_ID
  };
}

// ── Public Diagnostic Funnel Webhook (Canonical Production Endpoint) ─────────
app.options('/api/webhook', (req, res) => res.sendStatus(200));

app.post('/api/webhook', applyRateLimit, async (req, res) => {
  const payload = req.body || {};
  console.log('📥 /api/webhook incoming request:', {
    submissionId: payload.submissionId || payload.submission_id,
    funnelStatus: payload.funnelStatus || payload.funnel_status,
    email: payload.email ? '[PROVIDED]' : '[NONE]',
    language: payload.language
  });

  const submissionId = payload.submissionId || payload.submission_id;
  const email = payload.email ? String(payload.email).trim() : null;

  // 1. Validation Contract (400 Bad Request)
  if (!submissionId || typeof submissionId !== 'string') {
    return res.status(400).json({
      success: false,
      error: "Invalid request payload: 'submissionId' string is required."
    });
  }

  if (!email && payload.funnelStatus === 'completed') {
    return res.status(400).json({
      success: false,
      error: "Invalid request payload: 'email' is required for completed funnel submissions."
    });
  }

  // 2. PHASE 1: Durable Lead Persistence FIRST
  let lead;
  try {
    lead = await db.upsertLead(payload);
  } catch (dbError) {
    console.error('❌ Lead persistence failed:', dbError.message);
    // 500 / 503 HTTP Response Contract on DB persistence failure
    return res.status(500).json({
      success: false,
      error: "Lead persistence failed. Please retry your submission.",
      details: dbError.message
    });
  }

  // 3. PHASE 2/3: Immediate GHL Synchronization Attempt
  const creds = getCredentials();
  if (!creds.accessToken || !creds.locationId) {
    console.warn('⚠️ GHL credentials missing — lead persisted durably in pending state');
    await db.updateSyncStatus(submissionId, {
      ghl_sync_status: 'pending',
      last_error: 'GHL credentials not configured on backend server'
    });
    return res.status(202).json({
      success: true,
      syncStatus: 'pending',
      submissionId,
      message: "Lead received and queued for GHL synchronization."
    });
  }

  try {
    const syncResult = await worker.syncLeadToGHL(lead, creds);
    
    await db.updateSyncStatus(submissionId, {
      ghl_sync_status: 'synced',
      ghl_contact_id: syncResult.contactId,
      ghl_opportunity_id: syncResult.opportunityId,
      last_error: null
    });

    console.log(`✅ Lead ${submissionId} successfully synced to GHL.`);

    // 200 OK Contract: Lead persisted AND GHL sync confirmed
    return res.status(200).json({
      success: true,
      syncStatus: 'synced',
      submissionId,
      contactId: syncResult.contactId,
      opportunityId: syncResult.opportunityId || undefined,
      message: "Lead persisted and synced to GHL."
    });

  } catch (ghlErr) {
    console.warn(`⚠️ Immediate GHL sync failed for ${submissionId}: ${ghlErr.message}`);

    const isPermanent = ghlErr.status && ghlErr.status >= 400 && ghlErr.status < 500 && ghlErr.status !== 429;
    const initialStatus = isPermanent ? 'failed' : 'retry';
    const nextRetryDate = isPermanent ? null : new Date(Date.now() + 60000).toISOString(); // Retry in 1 min

    await db.updateSyncStatus(submissionId, {
      ghl_sync_status: initialStatus,
      retry_count: 1,
      next_retry_at: nextRetryDate,
      last_error: ghlErr.message
    });

    // 202 Accepted Contract: Lead persisted durably, GHL sync pending
    return res.status(202).json({
      success: true,
      syncStatus: 'pending',
      submissionId,
      message: "Lead received and queued for GHL synchronization."
    });
  }
});

// ── Manual or Cron Trigger for Retry Worker ──────────────────────────────────
app.post('/api/cron/retry', async (req, res) => {
  try {
    const creds = getCredentials();
    if (!creds.accessToken || !creds.locationId) {
      return res.status(503).json({ success: false, error: 'GHL credentials not configured' });
    }
    const result = await worker.processPendingRetries(creds);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Periodic Background Retry Worker Interval (Every 60 Seconds) ─────────────
const RETRY_INTERVAL_MS = 60 * 1000;
setInterval(async () => {
  try {
    const creds = getCredentials();
    if (creds.accessToken && creds.locationId) {
      await worker.processPendingRetries(creds);
    }
  } catch (err) {
    console.error('[Background Worker Error]:', err.message);
  }
}, RETRY_INTERVAL_MS);

// ── Health Check Endpoint ───────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

if (require.main === module) {
  app.listen(port, () => {
    console.log(`🚀 Cresca OS Webhook Backend listening on port ${port}`);
  });
}

module.exports = app;
