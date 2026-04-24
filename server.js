const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  if (req.path === '/') return next();
  if (req.headers['x-shrine-key'] !== process.env.SHRINE_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'shrine.html'));
});

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

app.post('/chat', async (req, res) => {
  const { model, messages, webSearch, reasoningEffort } = req.body;
  const useResponsesAPI = webSearch && !hasImages(messages);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

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
