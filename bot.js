import dotenv from 'dotenv';
import axios from 'axios';
import WebSocket from 'ws';

dotenv.config();

// Configuration
const BASE_URL = process.env.URL;
const WS_URL = process.env.WS_URL;
const ACCESS_TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.CHANNEL;
const LLM_URL = process.env.LLM_URL;
const LLM_KEY = process.env.LLM_KEY;
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT;

// Conversation memory
const conversationMemory = [];
const MAX_MEMORY = process.env.MAX_MEMORY;

const SYSTEM_PROMPT_AUTO = process.env.SYSTEM_PROMPT_AUTO;
const autoMemory = [];
const MAX_AUTO_MEMORY = process.env.MAX_MEMORY;

// Function to add a message to the conversation memory
function addToMemory(username, message) {
    conversationMemory.push(`${username}: ${message}`);
    if (conversationMemory.length > MAX_MEMORY) {
        conversationMemory.shift();
    }
}

// Function to get the conversation history as a string
function getConversationHistory() {
    return conversationMemory.join('\n');
}

// Function to send a note to the channel
async function sendNoteToChannel(text, replyId = null) {
    try {
        const payload = {
            channelId: CHANNEL_ID,
            text: text
        };
        if (replyId) {
            payload.replyId = replyId;
        }
        const response = await axios.post(`${BASE_URL}/api/notes/create`, payload, {
            headers: {
                'Authorization': `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log('Note sent:', text);
        addToMemory(process.env.BOT_USERNAME, text);
    } catch (error) {
        console.error('Error sending note:', error.response ? error.response.data : error.message);
    }
}

// Function to reply
async function sendReply(text, replyId, isDirectMessage) {
    try {
        const payload = {
            channelId: CHANNEL_ID,
            text: text,
            replyId: replyId,
            visibility: isDirectMessage ? 'specified' : 'home'
        };
        const response = await axios.post(`${BASE_URL}/api/notes/create`, payload, {
            headers: {
                'Authorization': `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log('Replied:', text);
        addToMemory(process.env.BOT_USERNAME, text);
    } catch (error) {
        console.error('Error sending reply:', error.response ? error.response.data : error.message);
    }
}

// Function to process message with AI API
async function processWithAI(message, quotedMessage = null) {
    try {
        const conversationContext = getConversationHistory();
        let prompt = `${SYSTEM_PROMPT}\n\nConversation history:\n${conversationContext}\n\n`;
        
        if (quotedMessage) {
            prompt += `Quoted message: "${quotedMessage}"\n\n`;
        }
        
        prompt += `User: ${message}\n${process.env.BOT_USERNAME}:`;

        const response = await axios.post(LLM_URL, {
            model: process.env.LLM_MODEL,
            messages: [
                { role: "system", content: prompt },
                { role: "user", content: message }
            ],
            max_tokens: process.env.MAX_TOKEN
        }, {
            headers: {
                'Authorization': `Bearer ${LLM_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('Error processing with AI:', error);
        return null;
    }
}

// Connect to Misskey streaming API
const ws = new WebSocket(`${WS_URL}/streaming?i=${ACCESS_TOKEN}`);
let pingInterval;

ws.on('open', () => {
    console.log('Connected to Misskey streaming API');
    ws.send(JSON.stringify({
        type: 'connect',
        body: {
            channel: 'main',
            id: '111111'
        }
    }));
    pingInterval = startPingInterval(ws);
});

// Object to store incoming messages
const incomingMessages = new Map();

// Cooldown duration in milliseconds
const COOLDOWN_DURATION = 2000; // 2 seconds

// Function to process messages after cooldown
function processMessageAfterCooldown(messageId) {
  setTimeout(() => {
    const messages = incomingMessages.get(messageId) || [];
    if (messages.length > 0) {
      // Sort messages to prioritize replies over mentions
      messages.sort((a, b) => {
        if (a.type === 'reply') return -1;
        if (b.type === 'reply') return 1;
        return 0;
      });

      const message = messages[0]; // Take the first message (prioritized)
      processMessage(message);
    }
    incomingMessages.delete(messageId);
  }, COOLDOWN_DURATION);
}

// Function to process a single message
async function processMessage(message) {
    const note = message.body.body;
    console.log('Processing note:', note.text);
  
    // Check if the note is a reply to the bot or mentions the bot
    const isReplyToBot = note.reply && note.reply.userId === process.env.BOT_USER_ID;
    const isMentionToBot = note.text.includes(`@${process.env.BOT_USERNAME}`);
  
    if (isReplyToBot || isMentionToBot) {
      addToMemory(note.user.username, note.text);
  
      let quotedMessage = null;
      if (isReplyToBot) {
        quotedMessage = note.reply.text;
      }
  
      // Process the note with AI
      const response = await processWithAI(note.text, quotedMessage);
  
      // Check if the original message is a direct message
      const isDirectMessage = note.visibility === 'specified';
  
      // Send the response as a reply
      if (response !== null) {
        await sendReply(response, note.id, isDirectMessage);
      }
    }
}

ws.on('message', async (data) => {
  const stringData = data.toString('utf-8');

  try {
    const message = JSON.parse(stringData);
    if (message.type === 'pong') {
        //received pong
    } else if (message.type === 'channel' && (message.body.type === 'mention' || message.body.type === 'reply')) {
      const note = message.body.body;
      const messageId = note.id;

      // Store the message
      if (!incomingMessages.has(messageId)) {
        incomingMessages.set(messageId, []);
        processMessageAfterCooldown(messageId);
      }
      incomingMessages.get(messageId).push({
        type: message.body.type,
        body: message.body
      });
    }
  } catch (error) {
    console.error('Error parsing message:', error);
  }
});

ws.on('error', (error) => {
    console.error('WebSocket error:', error);
});

ws.on('close', () => {
    console.log('Disconnected from Misskey streaming API');
    clearInterval(pingInterval);
    setTimeout(connectWebSocket, 5000); // Try to reconnect after 5 seconds
});

// Function to add a message to the auto conversation memory
function addToAutoMemory(username, message) {
    autoMemory.push(`${username}: ${message}`);
    if (autoMemory.length > MAX_AUTO_MEMORY) {
        autoMemory.shift();
    }
}

// Function to get the auto conversation history as a string
function getAutoConversationHistory() {
    return autoMemory.join('\n');
}

// Function to process auto message with AI API
async function processAutoWithAI(message) {
    try {
        const conversationContext = getAutoConversationHistory();
        let prompt = `${SYSTEM_PROMPT_AUTO}\n\nYour previous posts:\n${conversationContext}\n\n${message}`;

        const response = await axios.post(LLM_URL, {
            model: process.env.LLM_MODEL,
            messages: [
                { role: "system", content: prompt },
                { role: "user", content: message }
            ],
            max_tokens: 500
        }, {
            headers: {
                'Authorization': `Bearer ${LLM_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('Error processing auto message with AI:', error);
        return null;
    }
}

// Function to send an auto message
async function sendAutoMessage() {
    const response = await processAutoWithAI('AUTO');
    if (response !== null) {
        await sendNoteToChannel(response);
        addToAutoMemory(process.env.BOT_USERNAME, response);
    }
}

// Function to schedule the next auto message
function scheduleNextAutoMessage() {
    const minDelay = 30 * 60 * 1000; // 30 minutes
    const maxDelay = 4 * 60 * 60 * 1000; // 4 hours
    const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    
    setTimeout(() => {
        sendAutoMessage();
        scheduleNextAutoMessage();
    }, delay);

    console.log('Next auto message in ' + delay / 60000 + ' minutes');
}

// Start the auto message scheduling
scheduleNextAutoMessage();

function startPingInterval(ws) {
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      } else {
        clearInterval(pingInterval);
      }
    }, 60000); // Send a ping every minute
  
    return pingInterval;
  }

console.log(process.env.BOT_USERNAME + ' is running...');