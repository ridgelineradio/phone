/*
Copyright 2025 Ridgeline Radio, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the “Software”), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

const express = require("express");
const { createServer } = require("http");
const { WebSocketServer } = require("ws");
const ffmpeg = require("fluent-ffmpeg");
const { PassThrough } = require("stream");
const fs = require("fs");
const path = require("path");

const { MessagingResponse, VoiceResponse } = require("twilio").twiml;
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { WebClient } = require("@slack/web-api");
const Database = require("better-sqlite3");

const ICECAST_URL = process.env.STREAM_URL;
const ALERT_SMS_TO = process.env.ALERT_SMS_TO;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

// Caller directory database (SQLite via better-sqlite3)
const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, "data", "directory.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS directory (
    phone_number TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const lookupNameStmt = db.prepare(
  "SELECT name FROM directory WHERE phone_number = ?",
);
const saveNameStmt = db.prepare(`
  INSERT INTO directory (phone_number, name)
  VALUES (@phone_number, @name)
  ON CONFLICT(phone_number) DO UPDATE SET
    name = excluded.name,
    updated_at = datetime('now')
`);

// Returns the saved name for a phone number, or null if none is known.
function lookupName(phoneNumber) {
  if (!phoneNumber) return null;
  const row = lookupNameStmt.get(phoneNumber);
  return row ? row.name : null;
}

// Inserts or updates the name for a phone number.
function saveName(phoneNumber, name) {
  saveNameStmt.run({ phone_number: phoneNumber, name });
}

// Returns "Name (number)" if a name is known, otherwise the raw number.
function displayCaller(phoneNumber) {
  if (!phoneNumber) return phoneNumber;
  const name = lookupName(phoneNumber);
  return name ? `${name} (${phoneNumber})` : phoneNumber;
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json()); // For Slack JSON payloads

const server = createServer(app);
const wss = new WebSocketServer({ server });
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);
const slack = new WebClient(SLACK_BOT_TOKEN);
const HOLD_SECONDS = 1 * 60;

// Track pending calls: callSid -> { from, timeoutId, slackTs, conferenceRoom }
const pendingCalls = new Map();

app.get("/healthz", (_, res) => res.sendStatus(200));

app.get("/", (_, res) => res.send("Twilio Icecast Stream Server"));

app.post("/voice", async (req, res) => {
  const from = req.body.From;
  const callSid = req.body.CallSid;
  const conferenceRoom = `conf-${callSid}`;

  // Respond with TwiML - play hold music
  const twiml = new VoiceResponse();
  twiml.play("https://ridgelineradio.org/PhoneAnswer.mp3");

  const connect = twiml.connect();
  connect.stream({
    url: `wss://${req.headers.host}/media`,
  });

  res.type("text/xml");
  res.send(twiml.toString());

  // Post to Slack with interactive button
  try {
    const result = await slack.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      text: `Incoming call from ${displayCaller(from)}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Incoming Call*\n:phone: From: ${displayCaller(from)}`,
          },
        },
        {
          type: "actions",
          block_id: "call_actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "I'll take it",
              },
              style: "primary",
              action_id: "take_call",
              value: callSid,
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: lookupName(from) ? "Edit Name" : "Add Name",
              },
              action_id: "add_name",
              value: from,
            },
          ],
        },
      ],
    });

    // Set up 3-minute timeout for voicemail
    const timeoutId = setTimeout(
      () => redirectToVoicemail(callSid, from),
      HOLD_SECONDS * 1000,
    );

    // Store call state
    pendingCalls.set(callSid, {
      from,
      timeoutId,
      slackTs: result.ts,
      conferenceRoom,
      host: req.headers.host,
    });

    console.log(`Posted to Slack for call from ${from}`);
  } catch (err) {
    console.error("Failed to post to Slack:", err.message);
  }
});

// Twilio inbound SMS/MMS webhook -> post to Slack with a Reply button
app.post("/sms", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body || "";
  const numMedia = parseInt(req.body.NumMedia || "0", 10);

  console.log(`Incoming text from ${from}: ${body}`);

  // Ack Twilio immediately with empty TwiML (no auto-reply)
  const twiml = new MessagingResponse();
  res.type("text/xml").send(twiml.toString());

  try {
    const lines = [
      `*Incoming Text*`,
      `:speech_balloon: From: ${displayCaller(from)}`,
    ];
    if (body) {
      lines.push(`\n>${body.replace(/\n/g, "\n>")}`);
    }

    const result = await slack.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      text: `Incoming text from ${displayCaller(from)}: ${body}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: lines.join("\n") },
        },
        {
          type: "actions",
          block_id: "text_actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Reply" },
              style: "primary",
              action_id: "reply_text",
              value: from,
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: lookupName(from) ? "Edit Name" : "Add Name",
              },
              action_id: "add_name",
              value: from,
            },
          ],
        },
      ],
    });

    const mediaUrls = [];
    for (let i = 0; i < numMedia; i++) {
      const url = req.body[`MediaUrl${i}`];
      if (url) mediaUrls.push(url);
    }
    if (mediaUrls.length) {
      await slack.chat.postMessage({
        channel: SLACK_CHANNEL_ID,
        thread_ts: result.ts,
        text: `Attachments:\n${mediaUrls.join("\n")}`,
      });
    }
  } catch (err) {
    console.error("Error posting incoming text to Slack:", err);
  }
});

// Slack interactivity endpoint
app.post("/slack/interactive", async (req, res) => {
  // Acknowledge the request immediately
  res.status(200).send();

  const payload = JSON.parse(req.body.payload);

  // Modal submission
  if (payload.type === "view_submission") {
    // Directory modal: save the caller's name
    if (payload.view.callback_id === "add_name_modal") {
      try {
        const meta = JSON.parse(payload.view.private_metadata || "{}");
        const name = (
          payload.view.state.values.name_block.name_input.value || ""
        ).trim();
        if (!name) return;

        saveName(meta.phone, name);

        await slack.chat.postMessage({
          channel: meta.channel,
          thread_ts: meta.ts,
          text: `:white_check_mark: Saved *${name}* for ${meta.phone}. Future calls and texts will show this name.`,
        });
      } catch (err) {
        console.error("Error saving caller name:", err);
      }
      return;
    }

    // Reply modal: send the SMS reply
    try {
      const meta = JSON.parse(payload.view.private_metadata || "{}");
      const replyText = payload.view.state.values.reply_block.reply_input.value;

      await client.messages.create({
        to: meta.to,
        from: process.env.TWILIO_NUMBER,
        body: replyText,
      });

      await slack.chat.postMessage({
        channel: meta.channel,
        thread_ts: meta.ts,
        text: `:outbox_tray: Reply sent to ${meta.to} by <@${payload.user.id}>:\n>${replyText.replace(/\n/g, "\n>")}`,
      });
    } catch (err) {
      console.error("Error sending SMS reply:", err);
    }
    return;
  }

  const action = payload.actions[0];

  if (action.action_id === "reply_text") {
    const to = action.value;
    const channel = payload.channel.id;
    const ts = payload.message.ts;

    try {
      await slack.views.open({
        trigger_id: payload.trigger_id,
        view: {
          type: "modal",
          callback_id: "reply_text_modal",
          private_metadata: JSON.stringify({ to, channel, ts }),
          title: { type: "plain_text", text: "Reply to Text" },
          submit: { type: "plain_text", text: "Send" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "reply_block",
              label: { type: "plain_text", text: `Reply to ${to}` },
              element: {
                type: "plain_text_input",
                action_id: "reply_input",
                multiline: true,
                placeholder: {
                  type: "plain_text",
                  text: "Type your reply…",
                },
              },
            },
          ],
        },
      });
    } catch (err) {
      console.error("Error opening reply modal:", err);
    }
    return;
  }

  if (action.action_id === "add_name") {
    try {
      await slack.views.open({
        trigger_id: payload.trigger_id,
        view: {
          type: "modal",
          callback_id: "add_name_modal",
          private_metadata: JSON.stringify({
            phone: action.value,
            channel: payload.channel?.id || payload.container?.channel_id,
            ts: payload.message?.ts || payload.container?.message_ts,
          }),
          title: { type: "plain_text", text: "Directory" },
          submit: { type: "plain_text", text: "Save" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "name_block",
              label: {
                type: "plain_text",
                text: `Name for ${action.value}`,
              },
              element: {
                type: "plain_text_input",
                action_id: "name_input",
                initial_value: lookupName(action.value) || "",
                placeholder: { type: "plain_text", text: "e.g. Jane Doe" },
              },
            },
          ],
        },
      });
    } catch (err) {
      console.error("Error opening add name modal:", err);
    }
    return;
  }

  if (action.action_id === "take_call") {
    const callSid = action.value;
    const userId = payload.user.id;
    const userName = payload.user.name;

    const callState = pendingCalls.get(callSid);
    if (!callState) {
      console.log(`Call ${callSid} no longer pending`);
      return;
    }

    // Cancel the voicemail timeout
    clearTimeout(callState.timeoutId);
    pendingCalls.delete(callSid);

    // Update Slack message
    try {
      await slack.chat.update({
        channel: SLACK_CHANNEL_ID,
        ts: callState.slackTs,
        text: `Call from ${callState.from} - ${userName} is taking it`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Call from ${callState.from}*\n:white_check_mark: <@${userId}> is taking the call`,
            },
          },
        ],
      });
    } catch (err) {
      console.error("Failed to update Slack message:", err.message);
    }

    // Get the user's phone number from Slack profile
    try {
      const userInfo = await slack.users.info({ user: userId });
      const userPhone = userInfo.user.profile.phone;

      if (!userPhone) {
        console.error(`No phone number found for user ${userName}`);
        return;
      }

      const host = process.env.HOST || callState.host;

      // Place call to the responder - pass the caller's SID so we can redirect them when volunteer answers
      const responderCall = await client.calls.create({
        to: userPhone,
        from: process.env.TWILIO_NUMBER,
        url: `https://${host}/join-conference?room=${callState.conferenceRoom}&callSid=${callSid}`,
      });

      console.log(`Calling ${userName} to connect with ${callState.from}`);
    } catch (err) {
      console.error(`Failed to connect calls: ${err.message}`);
    }
  }
});

// Conference join endpoint for the volunteer (triggers caller redirect)
app.post("/join-conference", async (req, res) => {
  const room = req.query.room;
  const callSid = req.query.callSid;

  const twiml = new VoiceResponse();
  const dial = twiml.dial();
  dial.conference(
    {
      record: "record-from-start",
      endConferenceOnExit: true,
      beep: false,
      startConferenceOnEnter: true,
      waitUrl: "",
    },
    room,
  );

  res.type("text/xml");
  res.send(twiml.toString());

  // Now that volunteer answered, redirect the original caller to the conference
  if (callSid) {
    try {
      const joinTwiml = new VoiceResponse();
      const joinDial = joinTwiml.dial();
      joinDial.conference(
        {
          record: "record-from-start",
          endConferenceOnExit: true,
          beep: false,
        },
        room,
      );

      await client.calls(callSid).update({
        twiml: joinTwiml.toString(),
      });
    } catch (err) {
      console.error("Failed to redirect caller to conference:", err.message);
    }
  }
});

// Voicemail endpoint
app.post("/voicemail", (req, res) => {
  const callSid = req.query.callSid;
  const from = req.body.From;
  const host = req.headers.host;
  const twiml = new VoiceResponse();

  twiml.say(
    "No one is available to take your call. Please leave a message after the beep.",
  );
  twiml.record({
    maxLength: 120,
    transcribe: true,
    transcribeCallback: `https://${host}/voicemail-complete?callSid=${callSid}&from=${encodeURIComponent(from)}`,
    recordingStatusCallback: `https://${host}/voicemail-recording?callSid=${callSid}&from=${encodeURIComponent(from)}`,
  });
  twiml.say("Thank you for your message. Goodbye.");

  res.type("text/xml");
  res.send(twiml.toString());
});

// Store voicemail message timestamps for threading transcriptions
const voicemailMessages = new Map();

// Voicemail recording ready webhook
app.post("/voicemail-recording", async (req, res) => {
  res.status(200).send();

  const recordingSid = req.body.RecordingSid;
  const callSid = req.query.callSid;
  const from = req.query.from || req.body.From || "Unknown";
  const host = req.headers.host;

  try {
    const result = await slack.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      text: `Voicemail from ${from}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Voicemail Received*\n:incoming_envelope: From: ${from}\n<https://${host}/recording/${recordingSid}|Listen to recording>`,
          },
        },
      ],
    });

    // Store the message timestamp so we can thread the transcription
    voicemailMessages.set(callSid, result.ts);

    console.log(`Posted voicemail from ${from} to Slack`);
  } catch (err) {
    console.error("Failed to post voicemail to Slack:", err.message);
  }
});

// Proxy endpoint to serve recordings with authentication
app.get("/recording/:recordingSid", async (req, res) => {
  const recordingSid = req.params.recordingSid;

  try {
    // Fetch the recording from Twilio with authentication
    const recording = await client.recordings(recordingSid).fetch();

    // Redirect to the media URL with auth credentials embedded
    const authUrl = recording.mediaUrl.replace(
      "https://",
      `https://${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}@`
    );

    // Fetch the actual recording file
    const https = require("https");

    https.get(authUrl, (twilioRes) => {
      res.setHeader("Content-Type", "audio/mpeg");
      twilioRes.pipe(res);
    }).on("error", (err) => {
      console.error("Error fetching recording:", err);
      res.status(500).send("Error fetching recording");
    });
  } catch (err) {
    console.error("Failed to fetch recording:", err.message);
    res.status(500).send("Error fetching recording");
  }
});

// Voicemail transcription webhook
app.post("/voicemail-complete", async (req, res) => {
  res.status(200).send();

  const transcription = req.body.TranscriptionText;
  const callSid = req.query.callSid;

  if (transcription) {
    const parentTs = voicemailMessages.get(callSid);

    try {
      await slack.chat.postMessage({
        channel: SLACK_CHANNEL_ID,
        thread_ts: parentTs, // Thread under the voicemail message
        text: `Transcription: ${transcription}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Transcription:*\n${transcription}`,
            },
          },
        ],
      });

      // Clean up the stored message timestamp
      voicemailMessages.delete(callSid);
    } catch (err) {
      console.error("Failed to post transcription to Slack:", err.message);
    }
  }
});

// Function to redirect call to voicemail
async function redirectToVoicemail(callSid, from) {
  console.log(`Redirecting ${from} to voicemail (no response)`);

  const callState = pendingCalls.get(callSid);
  if (!callState) return;

  pendingCalls.delete(callSid);

  // Update Slack message
  try {
    await slack.chat.update({
      channel: SLACK_CHANNEL_ID,
      ts: callState.slackTs,
      text: `Call from ${from} - sent to voicemail (no response)`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Call from ${from}*\n:clock3: No response - redirected to voicemail`,
          },
        },
      ],
    });
  } catch (err) {
    console.error("Failed to update Slack message:", err.message);
  }

  // Redirect call to voicemail
  try {
    await client.calls(callSid).update({
      url: `https://${process.env.HOST}/voicemail?callSid=${callSid}`,
    });
  } catch (err) {
    console.error("Failed to redirect to voicemail:", err.message);
  }
}

app.post("/twiml", (req, res) => {
  const twiml = `
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/media" />
      </Connect>
    </Response>
  `;
  res.type("text/xml");
  res.send(twiml);
});

wss.on("connection", (ws) => {
  console.log("Twilio connected");

  let streamSid = null;

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      console.log(`Stream started: ${streamSid}`);

      // Start streaming Icecast audio
      const ffmpegStream = new PassThrough();

      ffmpeg(ICECAST_URL)
        .format("s16le")
        .audioFrequency(8000)
        .audioChannels(1)
        .audioCodec("pcm_mulaw")
        .on("error", (err) => console.error("FFmpeg error:", err))
        .pipe(ffmpegStream);

      ffmpegStream.on("data", (chunk) => {
        const payload = chunk.toString("base64");
        const message = {
          event: "media",
          streamSid,
          media: { payload },
        };
        ws.send(JSON.stringify(message));
      });
    }

    if (data.event === "stop") {
      console.log(`Stream stopped: ${streamSid}`);
    }
  });

  ws.on("close", () => {
    console.log("Twilio disconnected");
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
