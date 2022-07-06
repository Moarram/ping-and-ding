// Ping and Ding (Site Monitor)

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * 
config.json
{
  "targets": [
    {
      "name": <str>, // required, unique
      "url": <str>, // required
      "init": {}, // fetch params
      "expect": {
        "status": <num>, // status code
        "headers": {
          <str>: <str> // use "" to accept any value
        },
        "responseTime": <num> // ms
      },
      "responseTimeRetries": <num>, // consecutive RESPONSE_TIME failures before notifying
      "timeout": <num>, // ms
      "truncateBody": <num> // chars of body in result
      "notifierCooldownMins": <num>, // minutes before sending another notification
    }
  ],
  "notifier": {
    "url": <str>, // Slack webhook
    "timeout": <num> // ms
  },
  "defaults": {
    "target": {} // defaults for optional values applied to all targets
  }
}
* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

// Result failure types in order of precedence:
//  TIMEOUT - no response in time
//  STATUS - response had incorrect status code
//  HEADER - response missing header, or incorrect value
//  RESPONSE_TIME - response was slow

// =============================================================================
// Imports

import fetch from 'node-fetch'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// =============================================================================
// Constants

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const iso = new Date().toISOString()
const YYYY = iso.slice(0, 4)
const MM = iso.slice(5, 7)
const DD = iso.slice(8, 10)

const configFilepath = process.argv[2] || 'config.json'
const outputDir = process.argv[3] || 'output'

const LOG_FILEPATH = path.resolve(__dirname, outputDir, 'logs', `${YYYY}-${MM}-${DD}-ping-and-ding.log`)
const WARN_FILEPATH = path.resolve(__dirname, outputDir, 'warns', `${YYYY}-${MM}-${DD}-ping-and-ding-warn.log`)
const DATA_FILEPATH = path.resolve(__dirname, outputDir, 'data', `${YYYY}-${MM}-[name].csv`) // name populated later
const STATE_FILEPATH = path.resolve(__dirname, 'state.json')
const CONFIG_FILEPATH = path.resolve(__dirname, configFilepath)

// =============================================================================
// Functions (no global refs)

// add contents of src to dest, optionally overwriting existing values
function mergeObj(dest, src) {
  Object.entries(src).forEach(([key, val]) => {
    if (val && typeof val === 'object' && key in dest) {
      mergeObj(dest[key], val)
    } else if (!(key in dest)) {
      dest[key] = val
    }
  })
}

// -----------------------------------------------------------------------------

// create all directories from dirpath that are missing
async function ensureDir(dirpath, { logger=console }={}) {
  try {
    await fs.mkdir(dirpath, { recursive: true })
  } catch (err) {
    logger.error(err.message)
  }
}

// check if a filepath exists
async function exists(filepath) {
  try {
    await fs.access(filepath)
    return true
  } catch (err) {
    return false
  }
}

// read data from filepath, logging an error if failed
async function read(filepath, { logger=console }={}) {
  try {
    return await fs.readFile(filepath, { encoding: 'utf-8' })
  } catch (err) {
    logger.error(`Failed to read "${path.parse(filepath).base}"`)
    logger.error(err.message)
    return null
  }
}

// read JSON from filepath, logging an error if failed
async function readJSON(filepath, { logger=console }={}) {
  const data = await read(filepath, logger)
  try {
    return JSON.parse(data)
  } catch (err) {
    logger.error(`Failed to parse "${path.parse(filepath).base}"`)
    logger.error(err.message)
    return null
  }
}

// write data to filepath, logging an error if failed
async function write(filepath, data, { flag='a', logger=console }={}) {
  try {
    await fs.writeFile(filepath, data, { flag, encoding: 'utf-8' })
  } catch (err) {
    logger.error(`Failed to write "${path.parse(filepath).base}"`)
    logger.error(err.message)
  }
}

// -----------------------------------------------------------------------------

// request a resource with expectations and return details about response
async function poke({ name, url, init={}, expect={}, timeout=5000, truncateBody=null, logger=console }) {
  expect = { status: 200, headers: {}, responseTime: 500, ...expect } // defaults

  const result = { name, url, timestamp: null, status: null, responseTime: null }

  let failed = false
  const fail = ({ type, description, ...rest }) => {
    logger.warn(`${type}: ${description}`)
    result.failure = { type, description, ...rest }
    failed = true
  }

  const controller = new AbortController()
  const signal = controller.signal
  const abortTimeout = setTimeout(() => controller.abort(), timeout)

  try {
    if ('body' in init && typeof init.body === 'object') {
      init.body = JSON.stringify(init.body)
    }

    logger.log(`Requesting "${url}"`)
    result.timestamp = new Date().toISOString()
    const t1 = Date.now()
    const response = await fetch(url, { ...init, signal })
    const t2 = Date.now()

    logger.log(`Responded ${response.status} ${response.statusText} after ${t2 - t1}ms`)
    result.status = response.status
    result.responseTime = t2 - t1

    if (response.status !== expect.status) {
      const text = await response.text()
      failed || fail({
        type: 'STATUS',
        description: `Didn't respond with status ${expect.status}`,
        body: (truncateBody && text.length > truncateBody) ? `${text.slice(0, truncateBody)}...[truncated]` : text
      })
    }

    Object.entries(expect.headers).forEach(([key, val]) => {
      if (!(response.headers.has(key) && (val === '' || response.headers.get(key) === val))) {
        failed || fail({
          type: 'HEADER',
          description: (val === '') ? `Missing header "${key}"` : `Missing header "${key}": "${val}"`,
          headers: Object.fromEntries(response.headers.entries())
        })
      }
    })

    if (result.responseTime > expect.responseTime) {
      failed || fail({
        type: 'RESPONSE_TIME',
        description: `Response took longer than ${expect.responseTime}ms`,
      })
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      failed || fail({
        type: 'TIMEOUT',
        description: `Didn't respond within ${timeout}ms`,
      })

    } else {
      logger.error(err.message)
    }

  } finally {
    if ('failure' in result) {
      logger.warn(JSON.stringify(result))
    }

    clearTimeout(abortTimeout)
    return result
  }
}

// -----------------------------------------------------------------------------

// notify notifier of result (from poke function)
async function notify({ result, notifier, logger=console }) {
  try {
    await notifySlack(result, notifier)
    logger.log('Notification sent')

  } catch (err) {
    logger.error('Failed to send notification')
    logger.error(err.message)
  }
}

// notify slack of result (from poke function)
async function notifySlack(result, { url, timeout }) {
  const controller = new AbortController()
  const signal = controller.signal
  const abortTimeout = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: `${result.name} ${result.failure.type} Failure`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                `*${result.name} ${result.failure.type} Failure*`,
                `_${result.failure.description}_`,
                `>URL: *${result.url}*`,
                `>Status: *${result.status}*`,
                `>Response time: *${result.responseTime}${result.responseTime ? 'ms' : ''}*`,
              ].join('\n')
            }
          }
        ]
      }),
      signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw `Responded ${response.status} ${response.statusText} (${text})`
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      throw `Timeout after ${timeout}ms`
    } else {
      throw err
    }

  } finally {
    clearTimeout(abortTimeout)
  }
}

// =============================================================================
// Functions (with global refs)

// log colored message to console and unstyled message to file
const LOGGER = {
  buffer: '',
  log(msg, { tag='INFO', timestamp=null, color=null }={}) {
    const text = `[${timestamp || new Date().toISOString()}][${tag}] ${msg}`
    console.log(color ? `\x1b[${color}m${text}\x1b[0m` : text)
    this.buffer += `${text}\n`
  },
  warn(msg) { this.log(msg, { tag: 'WARN', color: 33 }) },
  error(msg) { this.log(msg, { tag: 'ERROR', color: 31 }) },
  async flush() {
    await write(LOG_FILEPATH, this.buffer)
    this.buffer = ''
  },
}

// -----------------------------------------------------------------------------

// poke a target
async function ping(target) {
  return await poke({ ...target, logger: LOGGER})
}

// notify of result for target
async function ding(target, result) {
  if (!CONFIG.notifier) return

  const prev = Date.parse(STATE.lastNotificationTime[target.name]) || 0
  const elapsed = Date.now() - prev
  const cooldown = target.notifierCooldownMins || 0

  if (elapsed >= cooldown * 60 * 1000) {
    LOGGER.log(`Sending notification...`)
    const success = await notify({ result, notifier: CONFIG.notifier, logger: LOGGER })
    if (success) STATE.lastNotificationTime[target.name] = new Date().toISOString()

  } else {
    LOGGER.log(`Suppressing notification`)
  }
}

// read ping-and-ding config from filepath, logging error if invalid
async function readConfig(filepath) {
  const config = await readJSON(filepath, { logger: LOGGER })
  try {
    if (!config || typeof config !== 'object') throw 'Config missing'
    if (!('targets' in config || Array.isArray(config.targets))) throw 'Config must have "targets" array'
    const usedNames = new Set()
    config.targets.forEach(target => {
      if (typeof target !== 'object') throw 'Each target must be an object'
      if (!('name' in target && typeof target.name === 'string')) throw 'Each target must have a unique "name" string'
      if (!('url' in target && typeof target.url === 'string')) throw 'Each target must have a "url" string'
      if (usedNames.has(target.name)) throw `Target name "${target.name}" not unique`
      usedNames.add(target.name)
    })
    if ('notifier' in config && !('url' in config.notifier)) throw 'Notifier must have a "url" string'
    return config
  } catch (err) {
    LOGGER.error(`INVALID CONFIG! ${err}`)
    await LOGGER.flush()
    return null
  }
}

// write ping-and-ding result timestamp, response time, and status code to file
async function writeData(name, result) {
  const filepath = DATA_FILEPATH.replace('[name]', name)
  const line = [
    result.timestamp,
    result.responseTime || -1,
    result.status || 0,
  ]
  if (!(await exists(filepath))) {
    await write(filepath, '"Timestamp","Response Time","Status Code"\n', { logger: LOGGER })
  }
  await write(filepath, `${line.join(',')}\n`, { logger: LOGGER })
}

// write ping-and-ding failure result to file
async function writeWarn(result) {
  await write(WARN_FILEPATH, `${JSON.stringify(result)}\n`, { logger: LOGGER })
}

// =============================================================================
// Main

// create missing directories
for (let filepath of [LOG_FILEPATH, WARN_FILEPATH, DATA_FILEPATH]) {
  await ensureDir(path.parse(filepath).dir, { logger: LOGGER })
}

// -----------------------------------------------------------------------------

// read config from file
const CONFIG = await readConfig(CONFIG_FILEPATH)
if (!CONFIG) process.exit(1)

const DEFAULTS = {
  target: {
    init: {},
    expect: {
      status: 200,
      headers: {},
      responseTime: 1000,
    },
    responseTimeRetries: 0,
    timeout: 5 * 1000,
    notifierCooldownMins: 0,
    truncateBody: 1000,
  },
  notifier: {
    timeout: 10 * 1000,
  },
}

// apply defaults to config
const configDefaultTarget = CONFIG?.defaults?.target || {}
for (let target of CONFIG.targets) {
  mergeObj(target, configDefaultTarget)
  mergeObj(target, DEFAULTS.target)
}
const configDefaultNotifier = CONFIG?.defaults?.notifier || {}
if ('notifier' in CONFIG) {
  mergeObj(CONFIG.notifier, configDefaultNotifier)
  mergeObj(CONFIG.notifier, DEFAULTS.notifier)
}

// -----------------------------------------------------------------------------

// read previous state from file
let lastState = {}
if (await exists(STATE_FILEPATH)) {
  lastState = await readJSON(STATE_FILEPATH, { logger: LOGGER })
}
const STATE = { lastNotificationTime: {}, ...lastState }

// -----------------------------------------------------------------------------

// ping and ding each target
for (let target of CONFIG.targets) {
  let result = await ping(target)
  await writeData(target.name, result)

  if ('failure' in result) {
    await writeWarn(result)

    // special case, try again for response time
    if (result.failure.type === 'RESPONSE_TIME' && target.responseTimeRetries) {
      LOGGER.log(`Retrying ${target.responseTimeRetries} times...`)
      let responseTimeFailures = 1

      for (let i = 0; i < target.responseTimeRetries; i++) {
        result = await ping(target)
        await writeData(target.name, result)

        if ('failure' in result) {
          await writeWarn(result)

          if (result.failure.type === 'RESPONSE_TIME' && target.responseTimeRetries) {
            responseTimeFailures += 1
          } else {
            await ding(target, result)
            break
          }

        } else {
          break
        }
      }

      if (target.responseTimeRetries && responseTimeFailures > target.responseTimeRetries) {
        await ding(target, result)
      }

    } else {
      await ding(target, result)
    }
  }
  await LOGGER.flush()
}

// cleanup
await write(STATE_FILEPATH, JSON.stringify(STATE), { flag: 'w', logger: LOGGER })
await LOGGER.flush()
