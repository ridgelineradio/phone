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

// Track pending calls: callSid -> { from, timeoutId, slackTs, conferenceRoom }
const pendingCalls = new Map();

let currentCallSid = null; // TODO: this is potentially very awkward.

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
          ],
        },
      ],
    });

    // Set up 3-minute timeout for voicemail
    const timeoutId = setTimeout(
      () => redirectToVoicemail(callSid, from),
      3 * 60 * 1000,
    );

    // Store call state
    pendingCalls.set(callSid, {
      from,
      timeoutId,
      slackTs: result.ts,
      conferenceRoom,
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

      // Place call to the responder
      const responderCall = await client.calls.create({
        to: userPhone,
        from: process.env.TWILIO_NUMBER,
        url: `https://${process.env.HOST}/join-conference?room=${callState.conferenceRoom}`,
      });

      // Redirect original caller to conference
      await client.calls(callSid).update({
        url: `https://${process.env.HOST}/join-conference?room=${callState.conferenceRoom}`,
      });

      console.log(`Connected ${callState.from} with ${userName}`);
    } catch (err) {
      console.error(`Failed to connect calls: ${err.message}`);
    }
  }
});

// Conference join endpoint
app.post("/join-conference", (req, res) => {
  const room = req.query.room;
  const twiml = new VoiceResponse();
  const dial = twiml.dial();
  dial.conference(
    {
      endConferenceOnExit: true,
      beep: false,
    },
    room,
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/join", async (req, res) => {
  const twiml = new VoiceResponse();
  const dial = twiml.dial();
  dial.conference(
    {
      endConferenceOnExit: true,
      record: "record-from-start",
      beep: false,
    },
    "the-room",
  );

  res.type("text/xml");
  res.send(twiml.toString());

  // Redirect the existing call
  await client.calls(currentCallSid).update({
    twiml,
  });
});

// Voicemail endpoint
app.post("/voicemail", (req, res) => {
  const callSid = req.query.callSid;
  const twiml = new VoiceResponse();

  twiml.say(
    "No one is available to take your call. Please leave a message after the beep.",
  );
  twiml.record({
    maxLength: 120,
    transcribe: true,
    transcribeCallback: `https://${process.env.HOST}/voicemail-complete?callSid=${callSid}`,
    recordingStatusCallback: `https://${process.env.HOST}/voicemail-recording?callSid=${callSid}`,
  });
  twiml.say("Thank you for your message. Goodbye.");

  res.type("text/xml");
  res.send(twiml.toString());
});

// Voicemail recording ready webhook
app.post("/voicemail-recording", async (req, res) => {
  res.status(200).send();

  const recordingUrl = req.body.RecordingUrl;
  const callSid = req.query.callSid;
  const from = req.body.From || "Unknown";

  try {
    await slack.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      text: `Voicemail from ${from}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Voicemail Received*\n:voicemail: From: ${from}\n<${recordingUrl}.mp3|Listen to recording>`,
          },
        },
      ],
    });

    console.log(`Posted voicemail from ${from} to Slack`);
  } catch (err) {
    console.error("Failed to post voicemail to Slack:", err.message);
  }
});

// Voicemail transcription webhook
app.post("/voicemail-complete", async (req, res) => {
  res.status(200).send();

  const transcription = req.body.TranscriptionText;
  const callSid = req.query.callSid;

  if (transcription) {
    try {
      await slack.chat.postMessage({
        channel: SLACK_CHANNEL_ID,
        text: `Voicemail transcription`,
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
