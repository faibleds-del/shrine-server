const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Simple secret check
app.use((req, res, next) => {
  if (req.path === '/') return next(); // allow serving the HTML
  if (req.headers['x-shrine-key'] !== process.env.SHRINE_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
});

// Serve shrine.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'shrine.html'));
});

// Proxy to OpenAI
app.post('/chat', async (req, res) => {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Shrine server running');
});