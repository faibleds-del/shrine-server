const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Secret check — allow / without key
app.use((req, res, next) => {
  if (req.path === '/') return next();
  if (req.headers['x-shrine-key'] !== process.env.SHRINE_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
});

// Serve shrine.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'shrine.html'));
});

// Convert Chat Completions message format → Responses API format
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
          if (c.type === 'image_url') return {
            type: 'input_image',
            source: { type: 'base64', media_type: c.image_url.url.split(';')[0].split(':')[1], data: c.image_url.url.split(',')[1] }
          };
          return c;
        })
      };
    }
    return msg;
  });
}

// Main chat route
app.post('/chat', async (req, res) => {
  const { model, messages, webSearch, reasoningEffort } = req.body;

  try {
    let response, data;

    if (webSearch) {
      // Responses API — supports web_search_preview with tool_choice auto
      const convertedMessages = convertMessagesForResponsesAPI(messages);
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: model,
          input: convertedMessages,
          tools: [{ type: 'web_search_preview' }],
          tool_choice: 'auto',
          max_output_tokens: 2048,
          ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {})
        })
      });
    } else {
      // Chat Completions API
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          max_completion_tokens: 2048,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
        })
      });
    }

    data = await response.json();
    res.status(response.status).json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Shrine server running');
});

