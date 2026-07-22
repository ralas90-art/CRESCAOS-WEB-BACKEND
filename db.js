let createClient;
try {
  createClient = require('@supabase/supabase-js').createClient;
} catch (e) {
  createClient = null;
}

// In-memory local store used ONLY during non-production testing/development
const localStore = new Map();

class DiagnosticLeadDB {
  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    this.isProduction = process.env.NODE_ENV === 'production';
    this.isProductionFailClosed = false;

    if (this.supabaseUrl && this.supabaseKey && createClient) {
      this.supabase = createClient(this.supabaseUrl, this.supabaseKey, {
        auth: { persistSession: false }
      });
      console.log('⚡ Supabase Client initialized for diagnostic_leads');
    } else {
      if (this.isProduction) {
        console.error('🚨 CRITICAL FATAL: Supabase environment variables missing in NODE_ENV=production. Fail-closed enforced.');
        this.isProductionFailClosed = true;
        this.supabase = null;
      } else {
        console.log('ℹ️ Non-production environment — Resilient local fallback store active');
        this.supabase = null;
      }
    }
  }

  checkProductionFailClosed() {
    if (this.isProduction && (!this.supabase || this.isProductionFailClosed)) {
      const err = new Error('Database service unavailable: Supabase credentials missing or unconfigured in production.');
      err.status = 503;
      throw err;
    }
  }

  sanitizeError(errorMsg) {
    if (!errorMsg) return '';
    let text = typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg);
    text = text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
    text = text.replace(/pit-[a-zA-Z0-9_-]+/gi, 'pit-[REDACTED]');
    return text.slice(0, 1000);
  }

  normalizeEmail(email) {
    return email ? String(email).trim().toLowerCase() : null;
  }

  normalizePhone(phone) {
    return phone ? String(phone).trim() : null;
  }

  async upsertLead(payload) {
    this.checkProductionFailClosed();

    const submissionId = payload.submissionId || payload.submission_id;
    if (!submissionId) {
      throw new Error('submissionId is required for lead persistence');
    }

    const email = this.normalizeEmail(payload.email);
    const phone = this.normalizePhone(payload.phone);
    const funnelStatus = payload.funnelStatus || payload.funnel_status || 'partial';
    const now = new Date().toISOString();

    const record = {
      submission_id: submissionId,
      email,
      phone,
      name: payload.name || payload.firstName || null,
      language: payload.language || 'en',
      funnel_status: funnelStatus,
      source: payload.source || 'Diagnostic Funnel',
      source_page: payload.source_page || payload.sourcePage || null,
      landing_page: payload.landing_page || payload.landingPage || null,
      referrer: payload.referrer || null,
      utm_source: payload.utm_source || null,
      utm_medium: payload.utm_medium || null,
      utm_campaign: payload.utm_campaign || null,
      utm_content: payload.utm_content || null,
      utm_term: payload.utm_term || null,
      service: payload.service || null,
      diagnostic_answers: payload.answers || payload.diagnostic_answers || {},
      score: payload.score !== undefined ? Number(payload.score) : null,
      score_tier: payload.score_tier || payload.tier || null,
      monthly_loss: payload.monthlyLoss !== undefined ? Number(payload.monthlyLoss) : null,
      consent: payload.consent !== false,
      updated_at: now
    };

    if (funnelStatus === 'completed') {
      record.completed_at = now;
    }

    if (this.supabase) {
      const { data, error } = await this.supabase
        .from('diagnostic_leads')
        .upsert(record, { onConflict: 'submission_id' })
        .select()
        .single();

      if (error) {
        console.error('Database Upsert Error:', error.message);
        const dbErr = new Error(`Database error: ${error.message}`);
        dbErr.status = 500;
        throw dbErr;
      }
      return data;
    } else {
      const existing = localStore.get(submissionId) || {
        id: `local-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        created_at: now,
        ghl_sync_status: 'pending',
        retry_count: 0
      };

      const updated = {
        ...existing,
        ...record,
        ghl_contact_id: existing.ghl_contact_id || null,
        ghl_opportunity_id: existing.ghl_opportunity_id || null
      };

      localStore.set(submissionId, updated);
      return updated;
    }
  }

  async getLeadBySubmissionId(submissionId) {
    this.checkProductionFailClosed();

    if (this.supabase) {
      const { data, error } = await this.supabase
        .from('diagnostic_leads')
        .select('*')
        .eq('submission_id', submissionId)
        .single();
      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } else {
      return localStore.get(submissionId) || null;
    }
  }

  async updateSyncStatus(submissionId, updates) {
    this.checkProductionFailClosed();

    const sanitizedError = this.sanitizeError(updates.last_error);
    const now = new Date().toISOString();

    const patch = {
      updated_at: now,
      ...(updates.ghl_sync_status && { ghl_sync_status: updates.ghl_sync_status }),
      ...(updates.ghl_contact_id && { ghl_contact_id: updates.ghl_contact_id }),
      ...(updates.ghl_opportunity_id && { ghl_opportunity_id: updates.ghl_opportunity_id }),
      ...(updates.retry_count !== undefined && { retry_count: updates.retry_count }),
      ...(updates.next_retry_at !== undefined && { next_retry_at: updates.next_retry_at }),
      ...(sanitizedError && { last_error: sanitizedError }),
      ...(updates.ghl_sync_status === 'synced' && { synced_at: now })
    };

    if (this.supabase) {
      const { data, error } = await this.supabase
        .from('diagnostic_leads')
        .update(patch)
        .eq('submission_id', submissionId)
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      const existing = localStore.get(submissionId);
      if (existing) {
        const updated = { ...existing, ...patch };
        localStore.set(submissionId, updated);
        return updated;
      }
      return null;
    }
  }

  // Atomic Queue Claiming with Stuck Processing Recovery (>15 mins)
  async claimPendingRetries(limit = 10) {
    this.checkProductionFailClosed();
    const nowIso = new Date().toISOString();
    const fifteenMinsAgoMs = Date.now() - 15 * 60 * 1000;

    if (this.supabase) {
      // Call atomic Postgres RPC claim function
      const { data, error } = await this.supabase.rpc('claim_pending_diagnostic_leads', { p_limit: limit });
      if (error) {
        console.error('Supabase claim RPC error, falling back to atomic query:', error.message);
        // Fallback atomic query
        const { data: rows } = await this.supabase
          .from('diagnostic_leads')
          .select('*')
          .in('ghl_sync_status', ['pending', 'retry'])
          .or(`next_retry_at.is.null,next_retry_at.lte.${nowIso}`)
          .order('created_at', { ascending: true })
          .limit(limit);

        if (!rows || rows.length === 0) return [];
        const claimed = [];
        for (const row of rows) {
          const { data: updated } = await this.supabase
            .from('diagnostic_leads')
            .update({ ghl_sync_status: 'processing', updated_at: nowIso })
            .eq('id', row.id)
            .eq('ghl_sync_status', row.ghl_sync_status) // Atomic optimistic lock
            .select()
            .single();
          if (updated) claimed.push(updated);
        }
        return claimed;
      }
      return data || [];
    } else {
      // Atomic local store claim with stuck recovery (>15m)
      const claimed = [];
      for (const [subId, lead] of localStore.entries()) {
        const isStuckProcessing = lead.ghl_sync_status === 'processing' && 
          new Date(lead.updated_at || lead.created_at).getTime() < fifteenMinsAgoMs;

        const isEligibleRetry = ['pending', 'retry'].includes(lead.ghl_sync_status) &&
          (!lead.next_retry_at || new Date(lead.next_retry_at) <= new Date());

        if (isEligibleRetry || isStuckProcessing) {
          lead.ghl_sync_status = 'processing';
          lead.updated_at = nowIso;
          localStore.set(subId, lead);
          claimed.push({ ...lead });
          if (claimed.length >= limit) break;
        }
      }
      return claimed;
    }
  }

  // Alias for backward compatibility
  async getPendingRetries(limit = 10) {
    return this.claimPendingRetries(limit);
  }

  clearLocalStore() {
    localStore.clear();
  }
}

module.exports = new DiagnosticLeadDB();
