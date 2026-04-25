const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Supabase ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Daily usage (stored in codes table via usage_data + usage_count) ──
const TIER_LIMITS = { casual: 20, active: 40, heavy: 80 };
const ADMIN_KEY = 'k3F9xLm2Qa7pZ8vT';

// ── Code helpers ──
async function validateCode(code) {
  const { data, error } = await supabase
    .from('codes')
    .select('*')
    .eq('code', code)
    .single();
  if (error || !data) return { valid: false, reason: 'Invalid code' };
  if (!data.active) return { valid: false, reason: 'Code deactivated' };
  if (new Date(data.expires) < new Date()) return { valid: false, reason: 'Code expired' };
  return { valid: true, tier: data.tier, expires: data.expires };
}

async function checkAndIncrement(code, tier) {
  const today = new Date().toISOString().split('T')[0];
  const limit = TIER_LIMITS[tier] || 20;
  const { data } = await supabase.from('codes').select('usage_data, usage_count').eq('code', code).single();

  const currentCount = (data?.usage_data === today) ? (data.usage_count || 0) : 0;
  if (currentCount >= limit) return { allowed: false, used: currentCount, limit };

  const newCount = currentCount + 1;
  await supabase.from('codes').update({ usage_data: today, usage_count: newCount }).eq('code', code);
  return { allowed: true, used: newCount, limit };
}

async function checkDailyLimit(code, tier) {
  const today = new Date().toISOString().split('T')[0];
  const limit = TIER_LIMITS[tier] || 20;
  const { data } = await supabase.from('codes').select('usage_data, usage_count').eq('code', code).single();
  if (!data || data.usage_data !== today) return { allowed: true, used: 0, limit };
  if (data.usage_count >= limit) return { allowed: false, used: data.usage_count, limit };
  return { allowed: true, used: data.usage_count, limit };
}

async function getUsageCount(code) {
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase.from('codes').select('usage_data, usage_count').eq('code', code).single();
  if (!data || data.usage_data !== today) return 0;
  return data.usage_count || 0;
}

// ── Middleware ──
app.use((req, res, next) => {
  const open = ['/', '/validate', '/admin/login'];
  if (open.includes(req.path) || req.path.startsWith('/admin/')) return next();
  if (req.headers['x-shrine-key'] !== process.env.SHRINE_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
});

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin access denied' });
  }
  next();
}

// ── Serve shrine.html ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'shrine.html'));
});

// ── Admin: login ──
app.post('/admin/login', (req, res) => {
  res.json({ valid: req.body.key === ADMIN_KEY });
});

// ── Admin: list codes ──
app.get('/admin/codes', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('codes').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const today = new Date().toISOString().split('T')[0];
  res.json(data.map(c => ({
    ...c,
    todayUsage: c.usage_data === today ? (c.usage_count || 0) : 0,
    limit: TIER_LIMITS[c.tier] || 20
  })));
});

// ── Admin: create code ──
app.post('/admin/codes', requireAdmin, async (req, res) => {
  const { code, tier, expires } = req.body;
  if (!code || !tier || !expires) return res.status(400).json({ error: 'Missing fields' });
  const { error } = await supabase.from('codes').insert({ code: code.toUpperCase(), tier, expires, active: true });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ── Admin: update code ──
app.patch('/admin/codes/:code', requireAdmin, async (req, res) => {
  const { tier, expires, active } = req.body;
  const updates = {};
  if (tier !== undefined) updates.tier = tier;
  if (expires !== undefined) updates.expires = expires;
  if (active !== undefined) updates.active = active;
  const { error } = await supabase.from('codes').update(updates).eq('code', req.params.code.toUpperCase());
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Admin: delete code ──
app.delete('/admin/codes/:code', requireAdmin, async (req, res) => {
  const { error } = await supabase.from('codes').delete().eq('code', req.params.code.toUpperCase());
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Admin: reset daily usage ──
app.post('/admin/reset/:code', requireAdmin, async (req, res) => {
  const code = req.params.code.toUpperCase();
  await supabase.from('codes').update({ usage_data: null, usage_count: 0 }).eq('code', code);
  res.json({ success: true });
});

// ── Validate access code ──
app.post('/validate', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ valid: false, reason: 'No code provided' });
  if (code.trim() === ADMIN_KEY) return res.json({ valid: true, tier: 'admin', expires: '2099-12-31' });
  const result = await validateCode(code.trim().toUpperCase());
  res.json(result);
});

// ── Usage check ──
app.post('/usage', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'No code' });
  if (code.trim() === ADMIN_KEY) return res.json({ used: 0, limit: 9999, tier: 'admin' });
  const validation = await validateCode(code.trim().toUpperCase());
  if (!validation.valid) return res.status(403).json({ error: validation.reason });
  const usage = await checkDailyLimit(code.trim().toUpperCase(), validation.tier);
  res.json({ used: usage.used, limit: usage.limit, tier: validation.tier });
});

// ── Helpers ──
function hasImages(messages) {
  return messages.some(msg =>
    Array.isArray(msg.content) && msg.content.some(c => c.type === 'image_url')
  );
}

function convertMessagesForResponsesAPI(messages) {
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return {
        role: msg.role,
        content: [{ type: msg.role === 'assistant' ? 'output_text' : 'input_text', text: msg.content }]
      };
    }
    if (Array.isArray(msg.content)) {
      return {
        role: msg.role,
        content: msg.content.map(c => {
          if (c.type === 'text') return { type: 'input_text', text: c.text };
          return c;
        })
      };
    }
    return msg;
  });
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Chat endpoint ──
app.post('/chat', async (req, res) => {
  const { model, messages, webSearch, reasoningEffort, code } = req.body;

  const isAdmin = code && code.trim() === ADMIN_KEY;
  const validation = isAdmin ? { valid: true, tier: 'admin' } : await validateCode((code || '').trim().toUpperCase());

  if (!validation.valid) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    sse(res, 'error', { message: `Access denied: ${validation.reason}` });
    return res.end();
  }

  const usage = isAdmin ? { allowed: true, used: 0, limit: 9999 } : await checkAndIncrement(code.trim().toUpperCase(), validation.tier);

  if (!usage.allowed) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    sse(res, 'limit', { used: usage.used, limit: usage.limit });
    return res.end();
  }

  const useResponsesAPI = webSearch && !hasImages(messages);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const usagePayload = { used: usage.used, limit: usage.limit };

  try {
    if (useResponsesAPI) {
      const convertedMessages = convertMessagesForResponsesAPI(messages);
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model, input: convertedMessages,
          tools: [{ type: 'web_search_preview' }],
          tool_choice: 'auto', stream: true, max_output_tokens: 1024,
          ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {})
        })
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'response.web_search_call.in_progress') sse(res, 'searching', {});
            if (evt.type === 'response.web_search_call.completed') sse(res, 'searched', {});
            if (evt.type === 'response.output_text.delta') sse(res, 'delta', { text: evt.delta });
            if (evt.type === 'response.completed') {
              sse(res, 'usage', usagePayload);
              sse(res, 'done', {});
            }
          } catch {}
        }
      }

    } else {
      if (reasoningEffort) sse(res, 'thinking', {});

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model, messages, stream: true, max_completion_tokens: 1024,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
        })
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') {
            sse(res, 'usage', usagePayload);
            sse(res, 'done', {});
            continue;
          }
          try {
            const evt = JSON.parse(raw);
            const delta = evt.choices?.[0]?.delta?.content;
            if (delta) sse(res, 'delta', { text: delta });
          } catch {}
        }
      }
    }

  } catch (err) {
    sse(res, 'error', { message: err.message });
  } finally {
    res.end();
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Shrine server running');
});
