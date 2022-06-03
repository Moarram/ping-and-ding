# Ping and Ding
...

<br>

**Example RESPONSE_TIME Failure**<br>
*Response took longer than 30ms*<br>
> URL: **http://example.com**<br>
> Status: **200**<br>
> Response time: **51ms**

<br>


## Installation
Requires [Node.js](https://nodejs.org/en/download/) (14+) and npm (6+)

Clone the repository
```
$ git clone https://github.com/moarram/ping-and-ding.git
```

Install dependencies
```
$ cd ping-and-ding
$ npm install
```

<br>


## Setup

### Slack
To receive notifications we need to set up a [Slack web-hook](https://slack.com/help/articles/115005265063-Incoming-webhooks-for-Slack). The steps are as follows:

1.  First, [create a new Slack app](https://api.slack.com/apps/new). Choose to create "from scratch" when prompted. Name the app and choose a workspace, then click "Create App".

1.  Under "Add features and functionality", choose "Incoming Webhooks" and toggle "Activate Incoming Webhooks" on. Scroll down and click "Add New Webhook to Workspace".

1.  Choose a channel to receive the notifications. Copy the webhook URL from the bottom of the "Incoming Webhooks" page. Paste this into your config file as the notifier url.

To send a test notification, edit a target in the config file to expect something that won't happen, such as `status: 0` and run the script. You should receive a notification in the Slack channel you chose.

### Cron
To call the script on a schedule we can use `cron`. This is the standard task scheduling utility on Linux systems, but equivalent tools exist for Windows.

Open the crontab file for editing (you might need sudo)
```
$ crontab -e
```

Add the following line, substituting your path to `ping-and-ding.js`. This will call the script each minute (use `*/5 * * * *` for every 5 minutes, `0 * * * *` for every hour).
```
* * * * * node /your/path/to/ping-and-ding.js
```

<br>


## Usage
By default the script will look for a `config.json` in the same directory as itself and will log results to `output/`, but this can be overridden with the optional command line arguments.

Run the script and exit.
```
node ping-and-ding.js [config_file] [output_dir]
```

To run the script repeatedly you should use `cron` or some equivalent that calls the script on a schedule to ensure that it will keep working even after the machine restarts.

<br>


## Config
The config is a JSON file with the following top level structure:
* `targets` - array of targets **(required)**
* `notifier` - notification method **(required)**
* `default` - settings shared across targets

### Target
*Ping!* A target describes the resource to request and the expected response signature. It needs a `name` and `url` at minimum, all other fields have built in defaults and are optional.

* `name` - unique, human readable name for the target **(required)**
* `url` - resource to fetch **(required)**
* `init` - initalization object passed directly to `fetch()`
  * `method` - request method such as `GET`, `POST`, etc
  * `headers` - request headers, an object of header key value pairs
  * `body` - request content, objects are automatically stringified
* `expect` - criteria to check in the response
  * `status` - expected response code (fail as STATUS)
  * `headers` - expected headers, an object of header key value pairs, to only check if the header exists use `""` as the value (fail as HEADERS)
  * `responseTime` - expected response time in ms (fail as RESPONSE_TIME)
* `responseTimeRetries` - only notify RESPONSE_TIME failure after this many consecutive retries are all too slow
* `timeout` - abort the request after waiting this many ms for a response (fail as TIMEOUT)
* `truncateBody` - after STATUS failure the logged response body is shortened to this many chars
* `notifierCooldownMins` - max notification rate for this target in minutes

### Notifier
*Ding!* The notification is sent by posting to your Slack web-hook. I may add more notification methods in the future.
* `url` - Slack web-hook to send notification **(required)**
* `timeout` - abort the notification attempt after waiting this many ms for response

### Default
Default values are used for fields that individual objects don't specify.
* `target` - default target object

### Example
The following example config will send a `GET` request to `example.com` and expects a response code of `200 OK` within `300ms`. If these conditions are not met, or no response is received in `1000ms`, a notification will be sent to the provided Slack web-hook url.
```
{
  "targets": [
    {
      "name": "Example",
      "url": "http://example.com",
      "expect": {
        "status": 200,
        "responseTime": 300
      },
      "timeout": 1000,
    }
  ],
  "notifier": {
    "url": "https://hooks.slack.com/..."
  },
}
```

<br>


## Results
Besides the terminal output and the notifications, various results are also logged in the `outputs/` directory.

### Data
The `data/` directory holds a CSV file for each target, named `YYYY-MM-<name>.csv` where `<name>` is the unique target name.

The CSV file has the following columns:
* Timestamp - `YYYY-MM-DDTHH:mm:ss.sssZ` (simplified extended ISO format)
* Response Time - In milliseconds, `-1` if no response received
* Status Code - `0` if no response received

### Logs
The `logs/` directory has a log file for each day, named `YYYY-MM-DD-ping-and-ding.log`.

Each line is a single log entry with the following information:
* Timestamp - `[YYYY-MM-DDTHH:mm:ss.sssZ]` (simplified extended ISO format)
* Level - One of the following tags
  * `[INFO]` - General information
  * `[WARN]` - Monitored site has an issue (response doesn't meet expected criteria)
  * `[ERROR]` - Script has an issue (cause for concern)
* Message - Either a short string or a JSON object with additional information

Example log entry
```
[2022-06-02T22:44:31.738Z][INFO] Responded 200 OK after 141ms
```

### Warns
The `warns/` directory has a log file for each day a response doesn't meet expected criteria, named `YYYY-MM-DD-ping-and-ding-warn.log`.

Each line has a JSON object describing the offending request, response, and failure reason. `STATUS` failure includes a `body` field (limited in length by `truncateBody`). `HEADERS` failure includes a `headers` field listing all the headers on the response.

Example warn entry, after being formatted for readability
```
{
  "name": "Example",
  "url": "http://example.com",
  "timestamp": "2022-06-02T22:44:31.597Z",
  "status": 200,
  "responseTime": 141,
  "failure": {
    "type": "RESPONSE_TIME",
    "description": "Response took longer than 100ms"
  }
}
```
