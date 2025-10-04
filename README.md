# Ridgeline Radio Phones

This code runs our telephones.

There are a few novel things here:

1. It was written almost entirely by ChatGPT 4o (and extended by Claude)
1. Using Twilio media streams to serve as on-hold music
1. Slack integration for team call handling with interactive buttons
1. Automatic voicemail system with Slack delivery

The code is otherwise not scalable for any production usage at all beyond
our simple use case.

## Features

* **Slack Integration**: When a call comes in, a message is posted to your Slack channel with an "I'll take it" button
* **Interactive Call Handling**: Team members click the button to answer the call, and the system connects them to the caller
* **Voicemail System**: If no one responds within 3 minutes, the call is automatically redirected to voicemail
* **Voicemail Delivery**: Recorded voicemails are posted to Slack with a link to the recording and transcription

## Deployment

Designed for deployment with Dokku. Build the Dockerfile and deploy to your
favorite container service!

### Slack App Setup

1. Create a new Slack app at https://api.slack.com/apps
2. Enable **Interactivity** and set the Request URL to `https://your-host.com/slack/interactive`
3. Add **Bot Token Scopes**: `chat:write`, `users:read`, `channels:read`
4. Install the app to your workspace
5. Copy the **Bot User OAuth Token** (starts with `xoxb-`) to `SLACK_BOT_TOKEN`
6. Copy the **Signing Secret** to `SLACK_SIGNING_SECRET`
7. Get your channel ID by right-clicking the channel in Slack → View channel details
8. Make sure team members have their phone numbers in their Slack profiles

### Twilio Setup

Configure your Twilio phone number's voice webhook to point to `https://your-host.com/voice`

## Environment Variables

* `ALERT_SMS_TO` - dual purpose texts and calls this number whenever a phone call arrives (legacy - now uses Slack)
* `STREAM_URL` - the URL for your Icecast stream (only tested with AAC+ Icecast)
* `TWILIO_ACCOUNT_SID` - Twilio account SID
* `TWILIO_AUTH_TOKEN` - Twilio auth token
* `TWILIO_NUMBER` - your Twilio phone number that is receiving calls
* `SLACK_BOT_TOKEN` - Slack bot token with permissions for chat:write, users:read, and channels:read
* `SLACK_SIGNING_SECRET` - Slack app signing secret for verifying requests
* `SLACK_CHANNEL_ID` - Slack channel ID where call notifications will be posted
* `HOST` - your application's public hostname (e.g., phone.example.com)

## License

MIT

## Questions?

Please open an issue.
