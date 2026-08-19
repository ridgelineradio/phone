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

const { MessagingResponse, VoiceResponse } = require("twilio").twiml;
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { WebClient } = require("@slack/web-api");
const fs = require("fs");

const ICECAST_URL = process.env.STREAM_URL;
const ALERT_SMS_TO = process.env.ALERT_SMS_TO;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

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

// Track numbers marked as spam. Calls from these numbers are NOT announced in
// Slack; they go straight to voicemail and only surface once the caller leaves
// a message that is successfully transcribed. Persisted best-effort to disk so
// the list survives process restarts.
const SPAM_STORE_PATH = process.env.SPAM_STORE_PATH || "./spam-numbers.json";
const spamNumbers = new Set();

function loadSpamNumbers() {
  try {
    const raw = fs.readFileSync(SPAM_STORE_PATH, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) arr.forEach((n) => spamNumbers.add(n));
    console.log(`Loaded ${spamNumbers.size} spam number(s) from ${SPAM_STORE_PATH}`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Failed to load spam numbers:", err.message);
    }
  }
}

function saveSpamNumbers() {
  try {
    fs.writeFileSync(SPAM_STORE_PATH, JSON.stringify([...spamNumbers], null, 2));
  } catch (err) {
    console.error("Failed to save spam numbers:", err.message);
  }
}

function isSpam(from) {
  return Boolean(from) && spamNumbers.has(from);
}

loadSpamNumbers();

// Build the voicemail TwiML (say + record with transcription callbacks).
function buildVoicemailTwiml({ callSid, from, host }) {
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
  return twiml;
}

app.get("/healthz", (_, res) => res.sendStatus(200));

app.get("/", (_, res) => res.send("Twilio Icecast Stream Server"));

app.post("/voice", async (req, res) => {
  const from = req.body.From;
  const callSid = req.body.CallSid;
  const conferenceRoom = `conf-${callSid}`;

  // Known spam numbers are never announced in Slack. Send them straight to
  // voicemail; nothing posts until they leave a successfully transcribed message.
  if (isSpam(from)) {
    console.log(
      `Spam number ${from} - routing to voicemail, suppressing Slack notification`,
    );
    const vmTwiml = buildVoicemailTwiml({
      callSid,
      from,
      host: req.headers.host,
    });
    res.type("text/xml");
    res.send(vmTwiml.toString());
    return;
  }

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
      text: `Incoming call from ${from}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Incoming Call*\n:phone: From: ${from}`,
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
                text: "Mark as spam",
              },
              style: "danger",
              action_id: "mark_spam",
              value: callSid,
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

// Slack interactivity endpoint
app.post("/slack/interactive", async (req, res) => {
  // Acknowledge the request immediately
  res.status(200).send();

  const payload = JSON.parse(req.body.payload);
  const action = payload.actions[0];

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

  if (action.action_id === "mark_spam") {
    const callSid = action.value;
    const userId = payload.user.id;
    const userName = payload.user.name;

    const callState = pendingCalls.get(callSid);
    const from = callState ? callState.from : null;

    if (!from) {
      console.log(`Cannot mark spam: call ${callSid} no longer pending`);
      return;
    }

    // Remember the number so future calls are silenced until transcribed.
    spamNumbers.add(from);
    saveSpamNumbers();
    console.log(`Marked ${from} as spam (by ${userName})`);

    // This call no longer needs the "take it" timeout.
    clearTimeout(callState.timeoutId);
    pendingCalls.delete(callSid);

    // Update the Slack message to reflect the decision.
    try {
      await slack.chat.update({
        channel: SLACK_CHANNEL_ID,
        ts: callState.slackTs,
        text: `Call from ${from} marked as spam`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Call from ${from}*\n:no_entry: Marked as spam by <@${userId}>. Future calls from this number won't post here until the caller leaves a transcribed message.`,
            },
          },
        ],
      });
    } catch (err) {
      console.error("Failed to update Slack message:", err.message);
    }

    // Send the current spam caller to voicemail now.
    try {
      const host = process.env.HOST || callState.host;
      await client.calls(callSid).update({
        url: `https://${host}/voicemail?callSid=${callSid}`,
      });
    } catch (err) {
      console.error("Failed to redirect spam caller to voicemail:", err.message);
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
  const twiml = buildVoicemailTwiml({ callSid, from, host });

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

  // Spam numbers stay silent until a transcription is available.
  if (isSpam(from)) {
    console.log(
      `Suppressing voicemail-recording Slack post for spam number ${from}`,
    );
    return;
  }

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
  const from = req.query.from || req.body.From || "Unknown";
  const recordingSid = req.body.RecordingSid;
  const host = req.headers.host;

  if (!transcription) return;

  // Spam calls were never announced. Now that the caller has left a message and
  // it transcribed successfully, post a single self-contained message.
  if (isSpam(from)) {
    const listen = recordingSid
      ? `\n<https://${host}/recording/${recordingSid}|Listen to recording>`
      : "";
    try {
      await slack.chat.postMessage({
        channel: SLACK_CHANNEL_ID,
        text: `Voicemail from ${from} (marked as spam)`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Voicemail from ${from}* :no_entry: _(marked as spam)_${listen}\n\n*Transcription:*\n${transcription}`,
            },
          },
        ],
      });
      console.log(`Posted transcribed spam voicemail from ${from} to Slack`);
    } catch (err) {
      console.error("Failed to post spam voicemail to Slack:", err.message);
    }
    return;
  }

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
