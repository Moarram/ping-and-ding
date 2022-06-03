# Ping and Ding
...

## Installation
Requires [Node.js](https://nodejs.org/en/download/) (14+) and npm (6+)

Clone the repository
```
git clone https://github.com/moarram/ping-and-ding.git
```

Install dependencies
```
cd ping-and-ding
npm install
```

<br>


## Setup

### Slack
...

### Cron
...

<br>


## Usage
By default the script will look for a `config.json` in the same directory as itself and will log results to `output/`, but this can be overridden with the optional command line arguments.

### Once
Run the script and exit.
```
node ping-and-ding.js [config_file] [output_dir]
```

### Repeat
To run the script repeatedly you should use `cron` or some equivalent that calls the script on a schedule to ensure that it will keep working even after the machine restarts.

<br>


## Config
The config file has the following top level structure:
* `targets` - array of targets **(required)**
* `notifier` - notification method **(required)**
* `default` - settings shared across targets

### Target *(Ping!)*
A target describes the resource to request and the expected response signature. It needs a `name` and `url` at minimum, all other fields have built in defaults and are optional.

* `name` - unique, human readable name for the target **(required)**
* `url` - resource to fetch **(required)**
* `init` - initalization object passed directly to `fetch()`
  * `method` - request method such as `GET`, `POST`, etc
  * `headers` - request headers, an object of header key value pairs
  * `body` - request content, objects are automatically stringified
* `expect` - criteria to check in the response
  * `status` - expected response code (fail as STATUS)
  * `headers` - expected headers, an object of header key value pairs, use `""` as the value to only check that the header exists (fail as HEADERS)
  * `responseTime` - expected response time in ms (fail as RESPONSE_TIME)
* `responseTimeRetries` - only notify RESPONSE_TIME failure after this many consecutive retries are all too slow
* `timeout` - abort the request after waiting this many ms for a response (fail as TIMEOUT)
* `truncateBody` - after STATUS failure the logged response body is shortened to this many chars
* `notifierCooldownMins` - max notification rate for this target in minutes

### Notifier *(Ding!)*
The notification is sent by posting to your Slack web-hook. I may add more notification methods in the future, as well as the ability to notify multiple hooks at once.
* `url` - Slack web-hook to send notification **(required)**
* `timeout` - abort the notification attempt after waiting this many ms for response

### Default
Default values are used for fields that individual objects don't specify.
* `target` - default target object

### Examples
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
