const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Code database (stored in a JSON file on Railway volume, or env var) ──
// CODES env var format: JSON string of code objects
// e.g. [{"code":"SHRINE-A7X2","tier":"casual","expires":"2026-07-24","active":true}]
// Daily usage tracked in memory (resets on server restart, good enough)
const dailyUsage = {}; // { "SHRINE-A7X2": { date: "2026-04-24", count: 0 } }

const TIER_LIMITS = {
  casual: 20,
  active: 40,
  heavy: 80
};

const CODES_FILE = path.join(__dirname, 'codes.json');

function getCodes() {
  try {
    if (fs.existsSync(CODES_FILE)) {
      return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
    }
    // Fall back to env var for initial seed
    return JSON.parse(process.env.SHRINE_CODES || '[]');
  } catch {
    return [];
  }
}

function saveCodes(codes) {
  try {
    fs.writeFileSync(CODES_FILE, JSON.stringify(codes, null, 2));
  } catch (err) {
    console.error('Failed to save codes:', err);
  }
}

function validateCode(code) {
  const codes = getCodes();
  const entry = codes.find(c => c.code === code);
  if (!entry) return { valid: false, reason: 'Invalid code' };
  if (!entry.active) return { valid: false, reason: 'Code deactivated' };
  if (new Date(entry.expires) < new Date()) return { valid: false, reason: 'Code expired' };
  return { valid: true, tier: entry.tier, expires: entry.expires };
}

function checkDailyLimit(code, tier) {
  const today = new Date().toISOString().split('T')[0];
  if (!dailyUsage[code] || dailyUsage[code].date !== today) {
    dailyUsage[code] = { date: today, count: 0 };
  }
  const limit = TIER_LIMITS[tier] || 20;
  if (dailyUsage[code].count >= limit) {
    return { allowed: false, used: dailyUsage[code].count, limit };
  }
  return { allowed: true, used: dailyUsage[code].count, limit };
}

function incrementUsage(code) {
  const today = new Date().toISOString().split('T')[0];
  if (!dailyUsage[code] || dailyUsage[code].date !== today) {
    dailyUsage[code] = { date: today, count: 0 };
  }
  dailyUsage[code].count++;
}

// ── Auth middleware ──
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/validate' || req.path === '/admin/login' || req.path.startsWith('/admin/')) return next();
  if (req.headers['x-shrine-key'] !== process.env.SHRINE_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
});

const ADMIN_KEY = 'k3F9xLm2Qa7pZ8vT';

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
  const { key } = req.body;
  res.json({ valid: key === ADMIN_KEY });
});

// ── Admin: list codes ──
app.get('/admin/codes', requireAdmin, (req, res) => {
  const codes = getCodes();
  const today = new Date().toISOString().split('T')[0];
  res.json(codes.map(c => ({
    ...c,
    todayUsage: dailyUsage[c.code]?.date === today ? dailyUsage[c.code].count : 0,
    limit: TIER_LIMITS[c.tier] || 20
  })));
});

// ── Admin: create code ──
app.post('/admin/codes', requireAdmin, (req, res) => {
  const { code, tier, expires } = req.body;
  if (!code || !tier || !expires) return res.status(400).json({ error: 'Missing fields' });
  const codes = getCodes();
  if (codes.find(c => c.code === code.toUpperCase())) return res.status(400).json({ error: 'Code already exists' });
  codes.push({ code: code.toUpperCase(), tier, expires, active: true });
  saveCodes(codes);
  res.json({ success: true });
});

// ── Admin: update code ──
app.patch('/admin/codes/:code', requireAdmin, (req, res) => {
  const codes = getCodes();
  const idx = codes.findIndex(c => c.code === req.params.code.toUpperCase());
  if (idx === -1) return res.status(404).json({ error: 'Code not found' });
  const { tier, expires, active } = req.body;
  if (tier !== undefined) codes[idx].tier = tier;
  if (expires !== undefined) codes[idx].expires = expires;
  if (active !== undefined) codes[idx].active = active;
  saveCodes(codes);
  res.json({ success: true, code: codes[idx] });
});

// ── Admin: delete code ──
app.delete('/admin/codes/:code', requireAdmin, (req, res) => {
  const codes = getCodes();
  const filtered = codes.filter(c => c.code !== req.params.code.toUpperCase());
  if (filtered.length === codes.length) return res.status(404).json({ error: 'Code not found' });
  saveCodes(filtered);
  res.json({ success: true });
});

// ── Admin: reset daily usage ──
app.post('/admin/reset/:code', requireAdmin, (req, res) => {
  const code = req.params.code.toUpperCase();
  if (dailyUsage[code]) delete dailyUsage[code];
  res.json({ success: true });
});

// ── Validate access code ──
app.post('/validate', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ valid: false, reason: 'No code provided' });
  // Admin code is always valid with unlimited tier
  if (code.trim() === ADMIN_KEY) return res.json({ valid: true, tier: 'admin', expires: '2099-12-31' });
  const result = validateCode(code.trim().toUpperCase());
  res.json(result);
});

// ── Usage check endpoint ──
app.post('/usage', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'No code' });
  if (code.trim() === ADMIN_KEY) return res.json({ used: 0, limit: 9999, tier: 'admin' });
  const validation = validateCode(code.trim().toUpperCase());
  if (!validation.valid) return res.status(403).json({ error: validation.reason });
  const usage = checkDailyLimit(code.trim().toUpperCase(), validation.tier);
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

  // Validate code — admin bypass
  const isAdmin = code && code.trim() === ADMIN_KEY;
  const validation = isAdmin ? { valid: true, tier: 'admin' } : validateCode((code || '').trim().toUpperCase());
  if (!validation.valid) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    sse(res, 'error', { message: `Access denied: ${validation.reason}` });
    return res.end();
  }

  // Check daily limit — skip for admin
  const usage = isAdmin ? { allowed: true, used: 0, limit: 9999 } : checkDailyLimit(code.trim().toUpperCase(), validation.tier);
  if (!usage.allowed) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    sse(res, 'limit', { used: usage.used, limit: usage.limit });
    return res.end();
  }

  if (!isAdmin) incrementUsage(code.trim().toUpperCase());

  const useResponsesAPI = webSearch && !hasImages(messages);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current usage after increment
  sse(res, 'usage', { used: usage.used + 1, limit: usage.limit });

  try {
    if (useResponsesAPI) {
      const convertedMessages = convertMessagesForResponsesAPI(messages);
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model,
          input: convertedMessages,
          tools: [{ type: 'web_search_preview' }],
          tool_choice: 'auto',
          stream: true,
          max_output_tokens: 1024,
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
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'response.web_search_call.in_progress') sse(res, 'searching', {});
            if (evt.type === 'response.web_search_call.completed') sse(res, 'searched', {});
            if (evt.type === 'response.output_text.delta') sse(res, 'delta', { text: evt.delta });
            if (evt.type === 'response.completed') sse(res, 'done', {});
          } catch {}
        }
      }

    } else {
      if (reasoningEffort) sse(res, 'thinking', {});

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          max_completion_tokens: 1024,
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
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') { sse(res, 'done', {}); continue; }
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
