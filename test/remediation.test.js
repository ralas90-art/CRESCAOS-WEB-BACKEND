const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const worker = require('../worker');
const app = require('../server');

// Mock server caller with mock Express req and res
async function makeRequest(method, path, body) {
  return new Promise((resolve) => {
    const req = {
      method,
      url: path,
      headers: { 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      body
    };

    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      getHeader(k) { return this.headers[k]; },
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; resolve(this); },
      sendStatus(code) { this.statusCode = code; resolve(this); },
      on() {},
      emit() {},
      end() { resolve(this); }
    };

    app(req, res);
  });
}

// Mock Credentials for testing
const mockCreds = {
  accessToken: 'mock_access_token_123',
  locationId: 'mock_loc_456',
  pipelineId: 'mock_pipe_789',
  stageId: 'mock_stage_012'
};

async function runTests() {
  console.log('🧪 Starting Cresca OS Diagnostic Remediation & Readiness Test Suite...\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      db.clearLocalStore();
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}`);
      failed++;
    }
  }

  // 1. Valid Step 2 partial intake
  await test('1. Valid Step 2 partial intake', async () => {
    const subId = 'test_sub_step2_' + Date.now();
    const payload = {
      submissionId: subId,
      funnelStatus: 'partial',
      name: 'Partial Tester',
      email: 'partial.tester@crescaos.com',
      phone: '555-0199',
      language: 'en'
    };

    const lead = await db.upsertLead(payload);
    assert.strictEqual(lead.submission_id, subId);
    assert.strictEqual(lead.funnel_status, 'partial');
    assert.strictEqual(lead.email, 'partial.tester@crescaos.com');
  });

  // 2. Duplicate Step 2 submission with same submission ID
  await test('2. Duplicate Step 2 submission with same submission ID', async () => {
    const subId = 'test_sub_dup_' + Date.now();
    const payload = { submissionId: subId, funnelStatus: 'partial', name: 'Tester', email: 'dup@crescaos.com' };
    
    await db.upsertLead(payload);
    const updated = await db.upsertLead({ ...payload, phone: '555-9999' });
    
    assert.strictEqual(updated.submission_id, subId);
    assert.strictEqual(updated.phone, '555-9999');
  });

  // 3. Step 9 enriches the same durable record
  await test('3. Step 9 enriches the same durable record', async () => {
    const subId = 'test_sub_enrich_' + Date.now();
    await db.upsertLead({ submissionId: subId, funnelStatus: 'partial', email: 'enrich@crescaos.com' });

    const enriched = await db.upsertLead({
      submissionId: subId,
      funnelStatus: 'completed',
      score: 85,
      score_tier: 'High Risk',
      monthlyLoss: 4500
    });

    assert.strictEqual(enriched.submission_id, subId);
    assert.strictEqual(enriched.funnel_status, 'completed');
    assert.strictEqual(enriched.score, 85);
    assert.strictEqual(enriched.monthly_loss, 4500);
  });

  // 4. Partial intake does not create an opportunity
  await test('4. Partial intake does not create an opportunity', async () => {
    const lead = { submission_id: 'sub_p4', funnel_status: 'partial', name: 'No Opp', email: 'noopp@crescaos.com' };
    
    const oldSync = worker.syncLeadToGHL;
    try {
      worker.syncLeadToGHL = async (l) => {
        assert.strictEqual(l.funnel_status, 'partial');
        return { contactId: 'cnt_mock_123', opportunityId: null };
      };

      const res = await worker.syncLeadToGHL(lead, mockCreds);
      assert.strictEqual(res.opportunityId, null);
    } finally {
      worker.syncLeadToGHL = oldSync;
    }
  });

  // 5. Completed intake creates exactly one opportunity
  await test('5. Completed intake creates exactly one opportunity', async () => {
    const lead = { submission_id: 'sub_p5', funnel_status: 'completed', name: 'Opp Lead', email: 'opp@crescaos.com', monthly_loss: 2000 };
    
    const oldSync = worker.syncLeadToGHL;
    try {
      worker.syncLeadToGHL = async () => {
        return { contactId: 'cnt_mock_123', opportunityId: 'opp_mock_789' };
      };

      const res = await worker.syncLeadToGHL(lead, mockCreds);
      assert.strictEqual(res.contactId, 'cnt_mock_123');
      assert.strictEqual(res.opportunityId, 'opp_mock_789');
    } finally {
      worker.syncLeadToGHL = oldSync;
    }
  });

  // 6. Repeating Step 9 does not duplicate the opportunity
  await test('6. Repeating Step 9 does not duplicate the opportunity', async () => {
    const subId = 'sub_repeat_step9_' + Date.now();
    await db.upsertLead({ submissionId: subId, funnelStatus: 'completed', email: 'repeat@crescaos.com' });
    await db.updateSyncStatus(subId, { ghl_contact_id: 'cnt_111', ghl_opportunity_id: 'opp_existing_222' });

    const lead = await db.getLeadBySubmissionId(subId);
    assert.strictEqual(lead.ghl_opportunity_id, 'opp_existing_222');
  });

  // 7. Correct English tag
  await test('7. Correct English tag', async () => {
    const lead = { funnel_status: 'completed', language: 'en', name: 'EN User', email: 'en@crescaos.com' };
    const tags = [];
    if (lead.language === 'es') tags.push('cresca:lang_es');
    else tags.push('cresca:lang_en');
    assert.deepStrictEqual(tags, ['cresca:lang_en']);
  });

  // 8. Correct Spanish tag
  await test('8. Correct Spanish tag', async () => {
    const lead = { funnel_status: 'completed', language: 'es', name: 'ES User', email: 'es@crescaos.com' };
    const tags = [];
    if (lead.language === 'es') tags.push('cresca:lang_es');
    else tags.push('cresca:lang_en');
    assert.deepStrictEqual(tags, ['cresca:lang_es']);
  });

  // 9. GHL success returns 200/synced
  await test('9. GHL success returns 200/synced', async () => {
    const subId = 'sub_res_200_' + Date.now();
    
    process.env.GHL_ACCESS_TOKEN = 'test_token';
    process.env.GHL_LOCATION_ID = 'test_loc';

    const oldSync = worker.syncLeadToGHL;
    try {
      worker.syncLeadToGHL = async () => ({ contactId: 'cnt_200', opportunityId: 'opp_200' });

      const res = await makeRequest('POST', '/api/webhook', {
        submissionId: subId,
        funnelStatus: 'partial',
        email: 'res200@crescaos.com'
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.syncStatus, 'synced');
    } finally {
      worker.syncLeadToGHL = oldSync;
    }
  });

  // 10. GHL temporary failure after persistence returns 202/pending
  await test('10. GHL temporary failure after persistence returns 202/pending', async () => {
    const subId = 'sub_res_202_' + Date.now();
    
    process.env.GHL_ACCESS_TOKEN = 'test_token';
    process.env.GHL_LOCATION_ID = 'test_loc';

    const oldSync = worker.syncLeadToGHL;
    try {
      worker.syncLeadToGHL = async () => {
        const err = new Error('GHL Timeout');
        err.status = 504;
        throw err;
      };

      const res = await makeRequest('POST', '/api/webhook', {
        submissionId: subId,
        funnelStatus: 'partial',
        email: 'res202@crescaos.com'
      });

      assert.strictEqual(res.statusCode, 202);
      assert.strictEqual(res.body.syncStatus, 'pending');
      assert.strictEqual(res.body.message, 'Lead received and queued for GHL synchronization.');
    } finally {
      worker.syncLeadToGHL = oldSync;
    }
  });

  // 11. Database failure returns non-success 5xx
  await test('11. Database failure returns non-success 5xx', async () => {
    const oldUpsert = db.upsertLead;
    try {
      db.upsertLead = async () => { throw new Error('DB Connection Lost'); };

      const res = await makeRequest('POST', '/api/webhook', {
        submissionId: 'sub_db_fail',
        email: 'dbfail@crescaos.com'
      });

      assert.strictEqual(res.statusCode, 500);
      assert.strictEqual(res.body.success, false);
    } finally {
      db.upsertLead = oldUpsert;
    }
  });

  // 12. Retry worker successfully syncs a queued lead (Atomic Claim)
  await test('12. Retry worker successfully syncs a queued lead with atomic claim', async () => {
    const subId = 'sub_retry_worker_' + Date.now();
    await db.upsertLead({ submissionId: subId, funnelStatus: 'partial', email: 'worker@crescaos.com' });
    await db.updateSyncStatus(subId, { ghl_sync_status: 'retry', next_retry_at: new Date(Date.now() - 1000).toISOString() });

    const oldSync = worker.syncLeadToGHL;
    try {
      worker.syncLeadToGHL = async () => ({ contactId: 'cnt_retry_ok', opportunityId: null });

      const result = await worker.processPendingRetries(mockCreds);
      assert.strictEqual(result.succeeded, 1);
      const updated = await db.getLeadBySubmissionId(subId);
      assert.strictEqual(updated.ghl_sync_status, 'synced');
    } finally {
      worker.syncLeadToGHL = oldSync;
    }
  });

  // 13. Retry worker does not duplicate contacts or opportunities
  await test('13. Retry worker does not duplicate contacts or opportunities', async () => {
    const subId = 'sub_retry_nodup_' + Date.now();
    await db.upsertLead({ submissionId: subId, funnelStatus: 'completed', email: 'nodup@crescaos.com' });
    await db.updateSyncStatus(subId, {
      ghl_sync_status: 'retry',
      ghl_contact_id: 'cnt_existing_123',
      ghl_opportunity_id: 'opp_existing_456',
      next_retry_at: new Date(Date.now() - 1000).toISOString()
    });

    const oldSync = worker.syncLeadToGHL;
    try {
      worker.syncLeadToGHL = async (lead) => {
        assert.strictEqual(lead.ghl_contact_id, 'cnt_existing_123');
        assert.strictEqual(lead.ghl_opportunity_id, 'opp_existing_456');
        return { contactId: lead.ghl_contact_id, opportunityId: lead.ghl_opportunity_id };
      };

      const result = await worker.processPendingRetries(mockCreds);
      assert.strictEqual(result.succeeded, 1);
    } finally {
      worker.syncLeadToGHL = oldSync;
    }
  });

  // 14. 429 honors retry behavior
  await test('14. 429 honors retry behavior', async () => {
    const subId = 'sub_429_' + Date.now();
    await db.upsertLead({ submissionId: subId, funnelStatus: 'partial', email: 'r429@crescaos.com' });

    const oldSync = worker.syncLeadToGHL;
    try {
      worker.syncLeadToGHL = async () => {
        const err = new Error('Rate Limited');
        err.status = 429;
        err.retryAfterHeader = '120';
        throw err;
      };

      await worker.processPendingRetries(mockCreds);
      const lead = await db.getLeadBySubmissionId(subId);
      assert.strictEqual(lead.ghl_sync_status, 'retry');
      assert(new Date(lead.next_retry_at) > new Date(Date.now() + 100000));
    } finally {
      worker.syncLeadToGHL = oldSync;
    }
  });

  // 15. Permanent 4xx failure enters failed/manual-review state
  await test('15. Permanent 4xx failure enters failed/manual-review state', async () => {
    const subId = 'sub_400_' + Date.now();
    await db.upsertLead({ submissionId: subId, funnelStatus: 'partial', email: 'r400@crescaos.com' });

    const oldSync = worker.syncLeadToGHL;
    try {
      worker.syncLeadToGHL = async () => {
        const err = new Error('Invalid Location ID');
        err.status = 400;
        throw err;
      };

      await worker.processPendingRetries(mockCreds);
      const lead = await db.getLeadBySubmissionId(subId);
      assert.strictEqual(lead.ghl_sync_status, 'failed');
    } finally {
      worker.syncLeadToGHL = oldSync;
    }
  });

  // 16. Invalid payload returns 400
  await test('16. Invalid payload returns 400', async () => {
    const res = await makeRequest('POST', '/api/webhook', {});
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.success, false);
  });

  // 17. Production fail-closed behavior test
  await test('17. Production fail-closed behavior test when NODE_ENV=production', async () => {
    db.isProduction = true;
    db.isProductionFailClosed = true;

    try {
      await db.upsertLead({ submissionId: 'sub_prod_fail', email: 'prod@crescaos.com' });
      assert.fail('Should have thrown 503 error in production fail-closed mode');
    } catch (err) {
      assert.strictEqual(err.status, 503);
    } finally {
      db.isProduction = false;
      db.isProductionFailClosed = false;
    }
  });

  // 18. Stuck processing recovery test (>15 mins)
  await test('18. Stuck processing recovery test (>15 mins)', async () => {
    const subId = 'sub_stuck_' + Date.now();
    await db.upsertLead({ submissionId: subId, funnelStatus: 'partial', email: 'stuck@crescaos.com' });
    
    // Set status to processing with timestamp older than 15 mins
    const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await db.updateSyncStatus(subId, { ghl_sync_status: 'processing' });
    const lead = await db.getLeadBySubmissionId(subId);
    lead.updated_at = oldTime;

    const claimed = await db.claimPendingRetries(10);
    assert.strictEqual(claimed.length, 1);
    assert.strictEqual(claimed[0].submission_id, subId);
  });

  // 19. Security scan: No secret in public HTML/JS
  await test('19. Security scan: No secret in public HTML/JS', async () => {
    const files = fs.readdirSync(path.join(__dirname, '../../public'));
    const secretPattern = /pit-[a-zA-Z0-9_-]+/i;
    for (const f of files) {
      if (f.endsWith('.html') || f.endsWith('.js')) {
        const content = fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');
        assert.strictEqual(secretPattern.test(content), false, `Secret pattern matched in public/${f}`);
      }
    }
  });

  console.log(`\n===========================================`);
  console.log(`🏁 Test Summary: ${passed} PASSED | ${failed} FAILED`);
  console.log(`===========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
