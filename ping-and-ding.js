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
//  HEADERS - response missing header, or incorrect value
//  RESPONSE_TIME - response was slow

// =============================================================================

import fetch from 'node-fetch'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// =============================================================================

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

// add contents of src to dest, optionally overwriting existing values
function mergeObj(dest, src, { overwrite=false }={}) {
  Object.entries(src).forEach(([key, val]) => {
    if (val && typeof val === 'object' && key in dest) {
      mergeObj(dest[key], val, { overwrite })
    } else if (!(key in dest) || overwrite) {
      dest[key] = val
    }
  })
}

// -----------------------------------------------------------------------------

async function ensureDir(dirpath) {
  try {
    await fs.mkdir(dirpath, { recursive: true })
  } catch (err) {
    LOGGER.error(err.message)
  }
}

async function exists(filepath) {
  try {
    await fs.access(filepath)
    return true
  } catch (err) {
    return false
  }
}

async function read(filepath) {
  try {
    return await fs.readFile(filepath, { encoding: 'utf-8' })
  } catch (err) {
    LOGGER.error(`Failed to read "${path.parse(filepath).base}"`)
    LOGGER.error(err.message)
    return null
  }
}

async function write(filepath, data, flag='a') {
  try {
    await fs.writeFile(filepath, data, { flag, encoding: 'utf-8' })
  } catch (err) {
    LOGGER.error(`Failed to write "${path.parse(filepath).base}"`)
    LOGGER.error(err.message)
  }
}

// -----------------------------------------------------------------------------

async function readJSON(filepath) {
  const data = await read(filepath)
  try {
    return JSON.parse(data)
  } catch (err) {
    LOGGER.error(`Failed to parse "${path.parse(filepath).base}"`)
    LOGGER.error(err.message)
    return null
  }
}

async function writeData(name, result) {
  const filepath = DATA_FILEPATH.replace('[name]', name)
  const line = [
    result.timestamp,
    result.responseTime || -1,
    result.status || 0,
  ]
  if (!(await exists(filepath))) {
    await write(filepath, '"Timestamp","Response Time","Status Code"\n')
  }
  await write(filepath, `${line.join(',')}\n`)
}

async function writeWarn(result) {
  await write(WARN_FILEPATH, `${JSON.stringify(result)}\n`)
}

// -----------------------------------------------------------------------------

async function poke({ name, url, init={}, expect={}, timeout=5000, truncateBody=null }) {
  expect = { status: 200, headers: {}, responseTime: 500, ...expect } // defaults

  const result = { name, url, timestamp: null, status: null, responseTime: null }
  
  let failed = false
  const fail = ({ type, description, ...rest }) => {
    LOGGER.warn(`${type}: ${description}`)
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

    LOGGER.log(`Requesting "${url}"`)
    result.timestamp = new Date().toISOString()
    const t1 = Date.now()
    const response = await fetch(url, { ...init, signal })
    const t2 = Date.now()
    
    LOGGER.log(`Responded ${response.status} ${response.statusText} after ${t2 - t1}ms`)
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
      LOGGER.error(err.message)
    }

  } finally {
    if ('failure' in result) {
      LOGGER.warn(JSON.stringify(result))
    }

    clearTimeout(abortTimeout)
    return result
  }
}

// -----------------------------------------------------------------------------

async function notify(target, result) {
  if (!CONFIG.notifier) return
  
  const notifier = { ...CONFIG.notifier }

  const prev = Date.parse(STATE.lastNotificationTime[target.url]) || 0
  const elapsed = Date.now() - prev
  const cooldown = target.notifierCooldownMins || 0

  if (elapsed >= cooldown * 60 * 1000) {
    LOGGER.log(`Sending notification...`)
    
    try {
      await notifySlack(result, notifier)
      STATE.lastNotificationTime[target.url] = new Date().toISOString()
      LOGGER.log('Notification sent')

    } catch (err) {
      LOGGER.error('Failed to send notification')
      LOGGER.error(err.message)
    }

  } else {
    LOGGER.log(`Suppressing notification`)
  }
}

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

for (let filepath of [LOG_FILEPATH, WARN_FILEPATH, DATA_FILEPATH]) {
  await ensureDir(path.parse(filepath).dir)
}

// -----------------------------------------------------------------------------

const CONFIG = await readJSON(CONFIG_FILEPATH)
try {
  if (!CONFIG || typeof CONFIG !== 'object') throw 'Config missing'
  if (!('targets' in CONFIG || Array.isArray(CONFIG.targets))) throw 'Config must have "targets" array'
  const usedNames = new Set()
  CONFIG.targets.forEach(target => {
    if (typeof target !== 'object') throw 'Each target must be an object'
    if (!('name' in target && typeof target.name === 'string')) throw 'Each target must have a unique "name" string'
    if (!('url' in target && typeof target.url === 'string')) throw 'Each target must have a "url" string'
    if (usedNames.has(target.name)) throw `Target name "${target.name}" not unique`
    usedNames.add(target.name)
  })
  if (!('notifier' in CONFIG)) throw 'Must have "notifier" object'
  if ('notifier' in CONFIG && !('url' in CONFIG.notifier)) throw 'Notifier must have a "url" string'
} catch (err) {
  LOGGER.error(`INVALID CONFIG! ${err}`)
  await LOGGER.flush()
  process.exit(1)
}

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

// Apply defaults to config
const targetConfig = CONFIG?.defaults?.target || {}
for (let target of CONFIG.targets) {
  mergeObj(target, targetConfig)
  mergeObj(target, DEFAULTS.target)
}
const notifierConfig = CONFIG?.defaults?.notifier || {}
if ('notifier' in CONFIG) {
  mergeObj(CONFIG.notifier, notifierConfig)
  mergeObj(CONFIG.notifier, DEFAULTS.notifier)
}
// if ('notifiers' in CONFIG) {
//   for (let notifier of CONFIG.notifiers) {
//     mergeObj(notifier, notifierConfig)
//     mergeObj(notifier, DEFAULTS.notifier)
//   }
// }

// -----------------------------------------------------------------------------

let lastState = {}
if (await exists(STATE_FILEPATH)) {
  lastState = await readJSON(STATE_FILEPATH)
}
const STATE = { lastNotificationTime: {}, ...lastState }

for (let target of CONFIG.targets) {
  let result = await poke(target)
  await writeData(target.name, result)
  
  if ('failure' in result) {
    await writeWarn(result)

    if (result.failure.type === 'RESPONSE_TIME' && target.responseTimeRetries) {
      LOGGER.log(`Retrying ${target.responseTimeRetries} times...`)
      let responseTimeFailures = 1

      for (let i = 0; i < target.responseTimeRetries; i++) {
        result = await poke(target)
        await writeData(target.name, result)

        if ('failure' in result) {
          await writeWarn(result)

          if (result.failure.type === 'RESPONSE_TIME' && target.responseTimeRetries) {
            responseTimeFailures += 1
          } else {
            await notify(target, result)
            break
          }

        } else {
          break
        }
      }

      if (target.responseTimeRetries && responseTimeFailures > target.responseTimeRetries) {
        await notify(target, result)
      }
      
    } else {
      await notify(target, result)
    }
  }
  await LOGGER.flush()
}

await write(STATE_FILEPATH, JSON.stringify(STATE), 'w')
await LOGGER.flush()
