// Ping and Ding (Site Monitor)

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * 
config.json
{
  "notificationUrl": <str>, // slack web-hook
  "notificationTimeout": <num>, // ms
  "targets": [
    {
      "name": <str>, // required, unique
      "url": <str>, // required, unique
      "init": {}, // fetch params
      "expectedStatus": <num>,
      "expectedHeaders": {
        <str>: <str> // use "" for any value
      },
      "maxResponseTime": <num>, // ms
      "timeout": <num>, // ms
      "retries": <num>, // consecutive RESPONSE_TIME failures before reporting
      "truncateBody": <num>, // chars of body in result
      "notificationCooldownMinutes": <num> // minutes before sending another notification
    }
  ]
}
* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

// Result failure types:
//  TIMEOUT - no response in time
//  STATUS - response had incorrect status code
//  HEADERS - response missing header, or incorrect value
//  RESPONSE_TIME - response was slow

// =============================================================================

import fetch from 'node-fetch'
import * as fs from 'fs/promises'
import path from 'path'
import { exit } from 'process'
import { fileURLToPath } from 'url'

// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const iso = new Date().toISOString()
const YYYY = iso.slice(0, 4)
const MM = iso.slice(5, 7)
const DD = iso.slice(8, 10)

const LOG_FILEPATH = path.join(__dirname, 'output', 'logs', `${YYYY}-${MM}-${DD}-ping-and-ding.log`)
const WARN_FILEPATH = path.join(__dirname, 'output', 'warns', `${YYYY}-${MM}-${DD}-ping-and-ding-warn.log`)
const DATA_FILEPATH = path.join(__dirname, 'output', 'data', `${YYYY}-${MM}-[name].csv`) // name populated later
const STATE_FILEPATH = path.join(__dirname, 'state.json')
const CONFIG_FILEPATH = path.join(__dirname, 'config.json')

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

async function poke({ name, url, init={}, expectedStatus=200, expectedHeaders={}, maxResponseTime=500, timeout=5000, truncateBody=null }) {
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
    LOGGER.log(`Requesting "${url}"`)
    result.timestamp = new Date().toISOString()
    const t1 = Date.now()
    const response = await fetch(url, { ...init, signal })
    const t2 = Date.now()
    
    LOGGER.log(`Responded ${response.status} ${response.statusText} after ${t2 - t1}ms`)
    result.status = response.status
    result.responseTime = t2 - t1

    if (response.status !== expectedStatus) {
      const text = await response.text()
      failed || fail({
        type: 'STATUS',
        description: `Didn't respond with status ${expectedStatus}`,
        body: (truncateBody && text.length > truncateBody) ? `${text.slice(0, truncateBody)}...` : text
      })
    }

    Object.entries(expectedHeaders).forEach(([key, val]) => {
      if (!(response.headers.has(key) && (val === '' || response.headers.get(key) === val))) {
        failed || fail({
          type: 'HEADER',
          description: (val === '') ? `Missing header "${key}"` : `Missing header "${key}": "${val}"`,
          headers: Object.fromEntries(response.headers.entries())
        })
      }
    })

    if (result.responseTime > maxResponseTime) {
      failed || fail({
        type: 'RESPONSE_TIME',
        description: `Response took longer than ${maxResponseTime}ms`,
      })
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      failed || fail({
        type: 'TIMEOUT',
        description: `Didn't respond within ${timeout}ms`,
      })

    } else {
      LOGGER.error(err.stack)
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
  const prev = Date.parse(STATE.lastNotificationTime[target.url]) || 0
  const elapsed = Date.now() - prev
  const cooldown = target.notificationCooldownMins || 0

  if (elapsed >= cooldown * 60 * 1000) {
    LOGGER.log(`Sending notification...`)
    
    try {
      await notifySlack(result, {
        url: CONFIG.notificationUrl,
        timeout: CONFIG.notificationTimeout || 10 * 1000,
      })
      STATE.lastNotificationTime[target.url] = new Date().toISOString()
      LOGGER.log('Notification sent')

    } catch (err) {
      LOGGER.error('Failed to send notification')
      LOGGER.error(err)
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

// -----------------------------------------------------------------------------

async function readJSON(filepath) {
  const data = await read(filepath)
  try {
    return JSON.parse(data)
  } catch (err) {
    LOGGER.error(`Failed to parse "${path.parse(filepath).base}"`)
    LOGGER.error(err.stack)
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

async function ensureDir(dirpath) {
  try {
    await fs.mkdir(dirpath, { recursive: true })
  } catch (err) {
    LOGGER.error(err.stack)
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
    if (err.code !== 'ENOENT') {
      LOGGER.error(`Failed to read "${path.parse(filepath).base}"`)
      LOGGER.error(err.stack)
    }
    return null
  }
}

async function write(filepath, data, flag='a') {
  try {
    await fs.writeFile(filepath, data, { flag, encoding: 'utf-8' })
  } catch (err) {
    LOGGER.error(`Failed to write "${path.parse(filepath).base}"`)
    LOGGER.error(err.stack)
  }
}

// =============================================================================

for (let filepath of [LOG_FILEPATH, WARN_FILEPATH, DATA_FILEPATH]) {
  await ensureDir(path.parse(filepath).dir)
}

const CONFIG = await readJSON(CONFIG_FILEPATH)
try {
  if (typeof CONFIG !== 'object') throw 'config missing'
  if (!('notificationUrl' in CONFIG)) throw 'config must have "notificationUrl" string'
  if (!('targets' in CONFIG || Array.isArray(CONFIG.targets))) throw 'config must have "targets" array'
  const usedNames = new Set()
  const usedUrls = new Set()
  CONFIG.targets.forEach(target => {
    if (typeof target !== 'object') throw 'each target must be an object'
    if (!('name' in target || typeof target.name !== 'string')) throw 'each target must have a unique "name" string'
    if (usedNames.has(target.name)) throw `target name "${target.name}" not unique`
    usedNames.add(target.name)
    if (!('url' in target || typeof target.url !== 'string')) throw 'each target must have a unique "url" string'
    if (usedUrls.has(target.url)) throw `target url "${target.url}" not unique`
    usedUrls.add(target.url)
  })
} catch (err) {
  LOGGER.error(`Invalid config: ${err}`)
  await LOGGER.flush()
  exit(1)
}

const STATE = {
  lastNotificationTime: {},
  ...await readJSON(STATE_FILEPATH),
}

// -----------------------------------------------------------------------------

for (let target of CONFIG.targets) {
  let result = await poke(target)
  await writeData(target.name, result)
  
  if ('failure' in result) {
    await writeWarn(result)

    if (result.failure.type === 'RESPONSE_TIME' && target.retries) {
      LOGGER.log(`Retrying ${target.retries} times...`)
      let responseTimeFailures = 1

      for (let i = 0; i < target.retries; i++) {
        result = await poke(target)
        await writeData(target.name, result)

        if ('failure' in result) {
          await writeWarn(result)

          if (result.failure.type === 'RESPONSE_TIME' && target.retries) {
            responseTimeFailures += 1
          } else {
            await notify(target, result)
          }
        }
      }

      if (target.retries && target.retries < responseTimeFailures) {
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
