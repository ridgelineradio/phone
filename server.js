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

const ICECAST_URL = process.env.STREAM_URL;
const ALERT_SMS_TO = process.env.ALERT_SMS_TO;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const server = createServer(app);
const wss = new WebSocketServer({ server });
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

let currentCallSid = null; // TODO: this is potentially very awkward.

app.get("/", (_, res) => res.send("Twilio Icecast Stream Server"));

app.post("/voice", async (req, res) => {
  const from = req.body.From;

  // Send an SMS alert
  try {
    await client.messages.create({
      body: `${from} is calling Ridgeline!`,
      from: process.env.TWILIO_NUMBER,
      to: ALERT_SMS_TO,
    });
  } catch (err) {
    console.error("Failed to send SMS:", err.message);
  }

  // Respond with TwiML
  const twiml = new VoiceResponse();

  // Say or Play a message (optional)
  twiml.play("https://ridgelineradio.org/PhoneAnswer.mp3");

  //
  // const dial = twiml.dial();
  // dial.conference({
  //   waitUrl: '/twiml', // This plays your Icecast stream to the caller
  //   startConferenceOnEnter: true,
  //   endConferenceOnExit: true,
  //   record: 'do-not-record',
  // }, 'ridgeline-room');
  const connect = twiml.connect();
  connect.stream({
    url: `wss://${req.headers.host}/media`,
  });

  res.type("text/xml");
  res.send(twiml.toString());

  // Call Jake
  try {
    await new Promise((res) => setTimeout(res, 5000));
    currentCallSid = req.body.CallSid;
    const call = await client.calls.create({
      to: process.env.ALERT_SMS_TO,
      from: process.env.TWILIO_NUMBER,
      url: `https://${req.headers.host}/join`,
    });
    console.log(`Call SID: ${call.sid}`);
  } catch (err) {
    console.error(`Error making call: ${err.message}`);
  }
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
