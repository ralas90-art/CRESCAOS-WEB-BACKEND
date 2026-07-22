const db = require('./db');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const GHL_BASE = 'https://services.leadconnectorhq.com';
const MAX_RETRIES = 5;

// Helper to calculate exponential backoff with jitter
function calculateBackoffMs(retryCount) {
  const baseMs = Math.pow(3, retryCount) * 60 * 1000; // 3m, 9m, 27m, 81m...
  const jitterMs = Math.floor(Math.random() * 30000); // 0-30s jitter
  return Math.min(baseMs + jitterMs, 24 * 60 * 60 * 1000); // Cap at 24h
}

async function executeGHLRequest(method, path, body, token) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const responseText = await res.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch (e) {
    data = { rawText: responseText };
  }

  if (!res.ok) {
    const error = new Error(`GHL ${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
    error.status = res.status;
    error.retryAfterHeader = res.headers.get('retry-after');
    error.ghlData = data;
    throw error;
  }

  return data;
}

async function syncLeadToGHL(lead, credentials) {
  const { accessToken, locationId, pipelineId, stageId } = credentials;

  // 1. Upsert GHL Contact
  const nameParts = (lead.name || '').trim().split(' ');
  const firstName = nameParts[0] || 'Diagnostic';
  const lastName = nameParts.slice(1).join(' ') || 'Lead';

  const tags = [];
  if (lead.funnel_status === 'partial') {
    tags.push('cresca:diagnostic_partial');
  } else {
    tags.push('cresca:diagnostic_completed');
  }

  if (lead.language === 'es') tags.push('cresca:lang_es');
  else tags.push('cresca:lang_en');

  if (lead.service) tags.push(`cresca:service_${lead.service}`);

  const contactBody = {
    locationId,
    firstName,
    lastName,
    tags,
    source: lead.source || 'Diagnostic Funnel',
    ...(lead.email && { email: lead.email }),
    ...(lead.phone && { phone: lead.phone })
  };

  console.log(`[Worker] Syncing contact for submission ${lead.submission_id}...`);
  const contactResult = await executeGHLRequest('POST', '/contacts/upsert', contactBody, accessToken);
  const contactId = contactResult.contact?.id || contactResult.id;

  if (!contactId) {
    throw new Error('GHL contact upsert response did not return a valid contact ID');
  }

  let opportunityId = lead.ghl_opportunity_id || null;

  // 2. Additional steps ONLY for completed funnels
  if (lead.funnel_status === 'completed') {
    // 2a. Build & post diagnostic note with Ambiguous Timeout Idempotency Check
    let noteText = `Source: ${lead.source || 'Diagnostic Funnel'}\n`;
    if (lead.service) noteText += `Service Interest: ${lead.service}\n`;
    if (lead.name) noteText += `Contact Name: ${lead.name}\n`;
    if (lead.language) noteText += `Language: ${lead.language}\n`;
    if (lead.score !== null) noteText += `Diagnostic Score: ${lead.score}/100 (${lead.score_tier || 'N/A'})\n`;
    if (lead.monthly_loss) noteText += `Est. Monthly Loss: $${Number(lead.monthly_loss).toLocaleString()}\n`;

    const tracking = [];
    if (lead.utm_source) tracking.push(`UTM Source: ${lead.utm_source}`);
    if (lead.utm_medium) tracking.push(`UTM Medium: ${lead.utm_medium}`);
    if (lead.utm_campaign) tracking.push(`UTM Campaign: ${lead.utm_campaign}`);
    if (lead.utm_content) tracking.push(`UTM Content: ${lead.utm_content}`);
    if (lead.utm_term) tracking.push(`UTM Term: ${lead.utm_term}`);
    if (lead.source_page) tracking.push(`Source Page: ${lead.source_page}`);
    if (tracking.length > 0) noteText += `\n--- Attribution ---\n${tracking.join('\n')}`;

    try {
      // Check existing notes to prevent duplicates in case of prior timeout
      const existingNotes = await executeGHLRequest('GET', `/contacts/${contactId}/notes`, null, accessToken);
      const noteAlreadyExists = existingNotes && existingNotes.notes && existingNotes.notes.some(n => 
        n.body && (n.body.includes(lead.submission_id) || n.body.includes(`Diagnostic Score: ${lead.score}/100`))
      );

      if (!noteAlreadyExists) {
        await executeGHLRequest('POST', `/contacts/${contactId}/notes`, { userId: '', body: noteText }, accessToken);
        console.log(`[Worker] Note attached to contact ${contactId}`);
      } else {
        console.log(`[Worker] Note already exists for contact ${contactId} — skipping duplicate note creation.`);
      }
    } catch (noteErr) {
      console.warn(`[Worker] Note creation failed (non-critical): ${noteErr.message}`);
    }

    // 2b. Ambiguous Timeout Idempotent Opportunity Creation
    if (pipelineId && stageId && !opportunityId) {
      try {
        const existingOpps = await executeGHLRequest('GET', `/opportunities/search?location_id=${locationId}&contact_id=${contactId}`, null, accessToken);
        if (existingOpps && existingOpps.opportunities && existingOpps.opportunities.length > 0) {
          const match = existingOpps.opportunities.find(o => o.pipelineId === pipelineId);
          if (match) {
            opportunityId = match.id;
            console.log(`[Worker] Ambiguous timeout recovery: Found existing opportunity ${opportunityId} for contact ${contactId}`);
          }
        }
      } catch (searchErr) {
        console.warn(`[Worker] Opportunity search error: ${searchErr.message}`);
      }

      if (!opportunityId) {
        const oppTitle = `DIAGNOSTIC: ${lead.name || 'New Lead'}`;
        const oppBody = {
          pipelineId,
          pipelineStageId: stageId,
          locationId,
          name: oppTitle,
          contactId,
          monetaryValue: lead.monthly_loss ? Number(lead.monthly_loss) : 0,
          status: 'open'
        };

        const oppResult = await executeGHLRequest('POST', '/opportunities/', oppBody, accessToken);
        opportunityId = oppResult.opportunity?.id || oppResult.id;
        console.log(`[Worker] Opportunity ${opportunityId} created for contact ${contactId}`);
      }
    }
  }

  return { contactId, opportunityId };
}

async function processPendingRetries(envCredentials) {
  // ATOMIC CLAIM: Uses claimPendingRetries with stuck processing recovery (>15 mins)
  const pendingLeads = await db.claimPendingRetries(10);
  if (pendingLeads.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  console.log(`[Worker] Atomically claimed ${pendingLeads.length} pending lead retries...`);
  let succeeded = 0;
  let failed = 0;

  for (const lead of pendingLeads) {
    try {
      const syncResult = await module.exports.syncLeadToGHL(lead, envCredentials);
      await db.updateSyncStatus(lead.submission_id, {
        ghl_sync_status: 'synced',
        ghl_contact_id: syncResult.contactId,
        ghl_opportunity_id: syncResult.opportunityId,
        last_error: null
      });
      succeeded++;
      console.log(`[Worker] ✅ Lead ${lead.submission_id} synced successfully.`);
    } catch (err) {
      failed++;
      const currentRetry = (lead.retry_count || 0) + 1;
      const isPermanent4xx = err.status && err.status >= 400 && err.status < 500 && err.status !== 429;

      if (isPermanent4xx || currentRetry >= MAX_RETRIES) {
        console.error(`[Worker] ❌ Lead ${lead.submission_id} permanently failed: ${err.message}`);
        await db.updateSyncStatus(lead.submission_id, {
          ghl_sync_status: 'failed',
          retry_count: currentRetry,
          last_error: `Permanent failure (${err.status || 'MAX_RETRIES'}): ${err.message}`
        });
      } else {
        let backoffMs = calculateBackoffMs(currentRetry);
        if (err.retryAfterHeader) {
          const parsedSec = parseInt(err.retryAfterHeader, 10);
          if (!isNaN(parsedSec)) backoffMs = Math.max(parsedSec * 1000, 1000);
        }

        const nextRetryDate = new Date(Date.now() + backoffMs).toISOString();
        console.warn(`[Worker] ⚠️ Lead ${lead.submission_id} scheduled for retry ${currentRetry}/${MAX_RETRIES} at ${nextRetryDate}`);

        await db.updateSyncStatus(lead.submission_id, {
          ghl_sync_status: 'retry',
          retry_count: currentRetry,
          next_retry_at: nextRetryDate,
          last_error: err.message
        });
      }
    }
  }

  return { processed: pendingLeads.length, succeeded, failed };
}

module.exports = {
  syncLeadToGHL,
  processPendingRetries,
  calculateBackoffMs
};
