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

// Check if any message contains an image
function hasImages(messages) {
  return messages.some(msg =>
    Array.isArray(msg.content) && msg.content.some(c => c.type === 'image_url')
  );
}

// Convert Chat Completions message format → Responses API format (text only)
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

// Main chat route
app.post('/chat', async (req, res) => {
  const { model, messages, webSearch, reasoningEffort } = req.body;

  // Use Responses API only when web search is on AND no images in the conversation
  const useResponsesAPI = webSearch && !hasImages(messages);

  try {
    let response, data;

    if (useResponsesAPI) {
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
      // Chat Completions — handles images, and text-only when web search is off
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

