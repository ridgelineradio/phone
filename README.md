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
* **Inbound Texts**: Incoming SMS/MMS are posted to Slack with a "Reply" button that opens a modal for replying to the sender directly from Slack
* **Caller Directory**: Every incoming call and text includes an "Add Name" button. Click it to open a Slack modal, enter the caller's name, and save it. Once saved, future calls and texts from that number show the name (e.g. `Jane Doe (+15551234567)`) instead of just the raw number. The button reads "Edit Name" when a name is already on file.
* **Outbound Calls and Texts**: A `/phone` slash command lets team members text or call any number from the station number without leaving Slack. Calls ring your own phone first, then dial the recipient with the station number as caller ID.

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
9. (Optional, for outbound calls and texts) Create a **Slash Command** named `/phone` with the Request URL `https://your-host.com/slack/commands`, which adds the `commands` scope. Reinstall the app if Slack asks you to.

### `/phone` Slash Command

Once the slash command is configured, anyone in the workspace can text or call from the station number:

```
/phone text <number> <message>   Send a text to <number> from the station number
/phone call <number>             Call <number>, ringing your own phone first
/phone help                      Show usage
```

Numbers can be 10 digits (US), 11 digits starting with 1, or full international format starting with `+`. For `text`, the number must not contain spaces; the rest of the line is the message.

**How a call works:** the app looks up your phone number from your Slack profile (the same **Phone** field used for taking incoming calls) and rings it from the station number. When you pick up, you hear "Connecting you to…" and only then is the recipient dialed, with the station number as their caller ID. If you never answer, the recipient is not called and the channel message is updated to say so. When the call ends, the channel message is updated with the outcome: the call length, or that the recipient did not answer.

Every text and call is recorded in the Slack channel (`SLACK_CHANNEL_ID`) so the team can see what was sent: texts show up with the same **Reply** and **Add Name** buttons as inbound texts, and land in the existing conversation thread when that number texted recently.

Requests to `/slack/commands` are verified against the app's **Signing Secret**, so `SLACK_SIGNING_SECRET` must be set or the command is rejected. The `users:read` scope (already listed above) is needed to read your profile phone number.

### Twilio Setup

Configure your Twilio phone number's voice webhook ("A call comes in") to point to `https://your-host.com/voice`

Configure your Twilio phone number's messaging webhook ("A message comes in") to point to `POST https://your-host.com/sms`. Inbound texts and MMS are posted to your Slack channel with a **Reply** button; clicking it opens a Slack modal where a team member can reply directly to the sender's number. This uses the same Interactivity Request URL (`/slack/interactive`) and the `chat:write` scope already configured above.

Consecutive texts from the same number within a look-back window (default 15 minutes, configurable via `TEXT_THREAD_WINDOW_MINUTES`) are grouped into the same Slack thread instead of creating a new top-level message. An operator reply refreshes that window so an active back-and-forth stays together.

## Caller Directory (database)

The app remembers caller names in a small SQLite database (via
[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)). The only data
stored is a mapping of phone number → name.

**Why SQLite?** This is a single, low-volume instance with a tiny data set
(number → name) and no need for an external database service. `better-sqlite3`'s
synchronous API keeps this single-file app readable, and the database lives on
disk with no extra infrastructure to run.

The database path is configurable via the `DB_PATH` environment variable and
defaults to `./data/directory.db`. The directory is created automatically at
startup. A `directory` table (`phone_number`, `name`, `created_at`,
`updated_at`) is created if it does not already exist.

### Dokku persistence

The database lives on the container filesystem, which Dokku wipes on every
redeploy. To persist caller names across deploys, mount a persistent storage
directory into the container at `/app/data`:

```
dokku storage:ensure-directory phone-data
dokku storage:mount phone /var/lib/dokku/data/storage/phone-data:/app/data
```

Make sure `DB_PATH` points inside the mounted directory. The default
(`/app/data/directory.db`) already does, so no additional configuration is
needed when using the mount above.

## Environment Variables

* `ALERT_SMS_TO` - dual purpose texts and calls this number whenever a phone call arrives (legacy - now uses Slack)
* `STREAM_URL` - the URL for your Icecast stream (only tested with AAC+ Icecast)
* `TWILIO_ACCOUNT_SID` - Twilio account SID
* `TWILIO_AUTH_TOKEN` - Twilio auth token
* `TWILIO_NUMBER` - your Twilio phone number that is receiving calls
* `SLACK_BOT_TOKEN` - Slack bot token with permissions for chat:write, users:read, and channels:read
* `SLACK_SIGNING_SECRET` - Slack app signing secret for verifying requests; required for the `/phone` slash command
* `SLACK_CHANNEL_ID` - Slack channel ID where call notifications will be posted
* `TEXT_THREAD_WINDOW_MINUTES` - optional; look-back window in minutes for grouping consecutive texts from the same number into one Slack thread (default 15)
* `HOST` - your application's public hostname (e.g., phone.example.com)
* `DB_PATH` - path to the SQLite caller-directory database (default `./data/directory.db`); point this inside a persistent mount on Dokku

## License

MIT

## Questions?

Please open an issue.
