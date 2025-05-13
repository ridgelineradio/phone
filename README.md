# Ridgeline Radio Phones

This code runs our telephones.

There are only two novel things here:

1. It was written almost entirely by ChatGPT 4o
1. Using Twilio media streams to serve as on-hold music.

The code is otherwise not scalable for any production usage at all beyond
our simple use case.

## Deployment

Designed for deployment with Dokku. Build the Dockerfile and deploy to your
favorite container service!

## Environment Variables

* `ALERT_SMS_TO` - dual purpose texts and calls this number whenever a phone call arrives
* `STREAM_URL` - the URL for your Icecast stream (only tested with AAC+ Icecast)
* `TWILIO_ACCOUNT_SID` - Twilio account SID
* `TWILIO_AUTH_TOKEN` - Twilio auth token
* `TWILIO_NUMBER` - your Twilio phone number that is receiving calls

## License

MIT

## Questions?

Please open an issue.
