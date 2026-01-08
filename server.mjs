import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const rootDir = process.cwd()

const loadEnvFile = () => {
  const envPath = path.join(rootDir, '.env')
  if (!fs.existsSync(envPath)) return
  const raw = fs.readFileSync(envPath, 'utf-8')
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) return
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) {
      process.env[key] = value
    }
  })
}

loadEnvFile()

const isProd = process.argv.includes('--prod')
const port = Number(process.env.PORT) || 5173
const saveDir = path.resolve(rootDir, 'saved-images')
const distDir = path.resolve(rootDir, 'dist')
const serverDataDir = path.resolve(rootDir, 'server-data')
const backendTasksDir = path.join(serverDataDir, 'tasks')
const backendImagesDir = path.join(serverDataDir, 'images')
const backendStatePath = path.join(serverDataDir, 'state.json')
const backendCollectionPath = path.join(serverDataDir, 'collection.json')
const backendPassword = process.env.BACKEND_PASSWORD || ''
const backendLogResponse = ['1', 'true', 'yes'].includes(
  String(process.env.BACKEND_LOG_RESPONSE || '').toLowerCase(),
)
const backendLogRequests = ['1', 'true', 'yes'].includes(
  String(process.env.BACKEND_LOG_REQUESTS || '').toLowerCase(),
)
const backendLogOutbound = ['1', 'true', 'yes'].includes(
  String(process.env.BACKEND_LOG_OUTBOUND || '').toLowerCase(),
)

const DEFAULT_BACKEND_CONFIG = {
  apiUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  apiFormat: 'openai',
  apiVersion: 'v1',
  vertexProjectId: '',
  vertexLocation: 'us-central1',
  vertexPublisher: 'google',
  stream: false,
  enableCollection: false,
}

const DEFAULT_GLOBAL_STATS = {
  totalRequests: 0,
  successCount: 0,
  fastestTime: 0,
  slowestTime: 0,
  totalTime: 0,
}

const DEFAULT_TASK_STATS = {
  totalRequests: 0,
  successCount: 0,
  fastestTime: 0,
  slowestTime: 0,
  totalTime: 0,
}

const MIN_CONCURRENCY = 1
const DEFAULT_CONCURRENCY = 2
const MAX_CONCURRENCY = Number.POSITIVE_INFINITY

const BACKEND_LOG_MAX_CHARS = 800

const truncateLogText = (value = '') => {
  if (value.length <= BACKEND_LOG_MAX_CHARS) return value
  return `${value.slice(0, BACKEND_LOG_MAX_CHARS)}...<${value.length}>`
}

const formatLogPayload = (payload) => {
  if (payload === null || payload === undefined) return String(payload)
  if (typeof payload === 'string') {
    if (payload.startsWith('data:image')) {
      return `${payload.slice(0, 60)}...<data:image>`
    }
    return truncateLogText(payload)
  }
  try {
    return JSON.stringify(
      payload,
      (_key, value) => {
        if (typeof value === 'string') {
          if (value.startsWith('data:image')) {
            return `${value.slice(0, 60)}...<data:image>`
          }
          return truncateLogText(value)
        }
        return value
      },
      2,
    )
  } catch {
    return String(payload)
  }
}

const logBackendResponse = (label, payload) => {
  if (!backendLogResponse) return
  console.log(`[backend] ${label}:`, formatLogPayload(payload))
}

const logBackendRequest = (label, payload) => {
  if (!backendLogRequests) return
  console.log(`[backend] ${label}:`, formatLogPayload(payload))
}

const logBackendOutbound = (label, payload) => {
  if (!backendLogOutbound) return
  console.log(`[backend] ${label}:`, formatLogPayload(payload))
}

const describeFetchError = (err) => ({
  name: err?.name,
  message: err?.message,
  code: err?.code || err?.cause?.code,
  errno: err?.errno || err?.cause?.errno,
  type: err?.type || err?.cause?.type,
})

const getExtensionFromType = (contentType = '') => {
  const normalized = contentType.toLowerCase()
  const mapping = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
  }
  const matched = Object.keys(mapping).find((key) => normalized.includes(key))
  return matched ? mapping[matched] : '.bin'
}

const readRequestBody = async (req) => {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const findExistingFile = async (dir, hash) => {
  try {
    const files = await fs.promises.readdir(dir)
    return files.find((name) => name.startsWith(hash)) || null
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
}

const saveImageBuffer = async (buffer, contentType) => {
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex')
  const extension = getExtensionFromType(contentType)
  const fileName = `${fileHash}${extension}`
  const filePath = path.join(saveDir, fileName)

  await fs.promises.mkdir(saveDir, { recursive: true })
  const matched = await findExistingFile(saveDir, fileHash)
  if (matched) {
    return { saved: false, exists: true, fileName: matched }
  }

  await fs.promises.writeFile(filePath, buffer)
  return { saved: true, exists: false, fileName }
}

const saveBackendImageBuffer = async (buffer, contentType) => {
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex')
  const extension = getExtensionFromType(contentType)
  const fileName = `${fileHash}${extension}`
  const filePath = path.join(backendImagesDir, fileName)

  await fs.promises.mkdir(backendImagesDir, { recursive: true })
  const matched = await findExistingFile(backendImagesDir, fileHash)
  if (matched) {
    return { saved: false, exists: true, fileName: matched }
  }

  await fs.promises.writeFile(filePath, buffer)
  return { saved: true, exists: false, fileName }
}

const clampNumber = (value, min, max, fallback) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

const normalizeConcurrency = (value, fallback = DEFAULT_CONCURRENCY) =>
  clampNumber(value, MIN_CONCURRENCY, MAX_CONCURRENCY, fallback)

const createDefaultTaskState = () => ({
  version: 1,
  prompt: '',
  concurrency: DEFAULT_CONCURRENCY,
  enableSound: true,
  results: [],
  uploads: [],
  stats: { ...DEFAULT_TASK_STATS },
})

const readJsonFile = async (filePath, fallback) => {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback
    if (err && err.name === 'SyntaxError') {
      console.warn(`Invalid JSON file, fallback to defaults: ${filePath}`, err)
      return fallback
    }
    throw err
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const writeJsonFileAtomic = async (filePath, data) => {
  const dir = path.dirname(filePath)
  const baseName = path.basename(filePath)
  const payload = JSON.stringify(data, null, 2)
  await fs.promises.mkdir(dir, { recursive: true })

  let tempPath = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nonce = crypto.randomUUID()
    tempPath = path.join(
      dir,
      `.${baseName}.${process.pid}.${Date.now()}.${nonce}.tmp`,
    )
    try {
      await fs.promises.writeFile(tempPath, payload, { encoding: 'utf-8', flag: 'wx' })
      break
    } catch (err) {
      if (err && err.code === 'EEXIST' && attempt < 2) continue
      throw err
    }
  }

  try {
    await fs.promises.rename(tempPath, filePath)
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await fs.promises.mkdir(dir, { recursive: true })
      try {
        await fs.promises.rename(tempPath, filePath)
        return
      } catch (retryErr) {
        if (!retryErr || retryErr.code !== 'ENOENT') {
          throw retryErr
        }
      }
      await fs.promises.writeFile(filePath, payload, { encoding: 'utf-8' })
      return
    }
    if (err && ['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await sleep(30 * (attempt + 1))
        try {
          await fs.promises.rename(tempPath, filePath)
          return
        } catch (retryErr) {
          if (!retryErr || !['EPERM', 'EACCES', 'EBUSY'].includes(retryErr.code)) {
            throw retryErr
          }
        }
      }
      await fs.promises.writeFile(filePath, payload, { encoding: 'utf-8' })
      return
    }
    throw err
  } finally {
    if (tempPath) {
      await fs.promises.unlink(tempPath).catch(() => undefined)
    }
  }
}

const coerceString = (value) => (typeof value === 'string' ? value : '')

const stripBackendTokenFromUrl = (value = '') => {
  if (!value.includes('/api/backend/image/')) return value
  return value.replace(/[?&]token=[^&]+/g, '').replace(/[?&]$/, '')
}

const sanitizeCollectionItem = (value) => {
  if (!value || typeof value !== 'object') return null
  const raw = value
  const id = coerceString(raw.id)
  if (!id) return null
  const prompt = coerceString(raw.prompt)
  const taskId = coerceString(raw.taskId)
  const timestamp =
    typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)
      ? raw.timestamp
      : Date.now()
  const image =
    typeof raw.image === 'string' ? stripBackendTokenFromUrl(raw.image) : undefined
  const localKey = typeof raw.localKey === 'string' ? raw.localKey : undefined
  const sourceSignature =
    typeof raw.sourceSignature === 'string' ? raw.sourceSignature : undefined
  const item = { id, prompt, taskId, timestamp }
  if (image) item.image = image
  if (localKey) item.localKey = localKey
  if (sourceSignature) item.sourceSignature = sourceSignature
  return item
}

const normalizeCollectionPayload = (payload) => {
  if (!Array.isArray(payload)) return []
  const items = []
  const seen = new Set()
  payload.forEach((entry) => {
    const item = sanitizeCollectionItem(entry)
    if (!item) return
    if (seen.has(item.id)) return
    seen.add(item.id)
    items.push(item)
  })
  return items
}

const loadBackendState = async () => {
  const data = await readJsonFile(backendStatePath, null)
  return {
    config: { ...DEFAULT_BACKEND_CONFIG, ...(data?.config || {}) },
    tasksOrder: Array.isArray(data?.tasksOrder) ? data.tasksOrder : [],
    globalStats: { ...DEFAULT_GLOBAL_STATS, ...(data?.globalStats || {}) },
  }
}

const saveBackendState = async (state) => {
  await writeJsonFileAtomic(backendStatePath, state)
  broadcastSseEvent('state', state)
}

const loadBackendCollection = async () => {
  const data = await readJsonFile(backendCollectionPath, [])
  return normalizeCollectionPayload(data)
}

const saveBackendCollection = async (items) => {
  await writeJsonFileAtomic(backendCollectionPath, items)
}

const getTaskFilePath = (taskId) => path.join(backendTasksDir, `${taskId}.json`)

const loadTaskState = async (taskId) => {
  const data = await readJsonFile(getTaskFilePath(taskId), null)
  if (!data) return null
  return {
    ...createDefaultTaskState(),
    ...data,
    concurrency: normalizeConcurrency(data?.concurrency),
    stats: { ...DEFAULT_TASK_STATS, ...(data?.stats || {}) },
    results: Array.isArray(data?.results) ? data.results : [],
    uploads: Array.isArray(data?.uploads) ? data.uploads : [],
  }
}

const saveTaskState = async (taskId, state) => {
  await writeJsonFileAtomic(getTaskFilePath(taskId), state)
  broadcastSseEvent('task', { taskId, state })
}

const RETRY_DELAY_MS = 1000
const ORPHAN_CLEANUP_DELAY_MS = 1500

let orphanCleanupTimer = null

const collectImageKeysFromTask = (taskState) => {
  const keys = new Set()
  const uploads = Array.isArray(taskState?.uploads) ? taskState.uploads : []
  const results = Array.isArray(taskState?.results) ? taskState.results : []
  uploads.forEach((item) => {
    if (!item?.localKey) return
    keys.add(path.basename(item.localKey))
  })
  results.forEach((item) => {
    if (!item?.localKey) return
    keys.add(path.basename(item.localKey))
  })
  return keys
}

const getRemovedImageKeys = (prevState, nextState) => {
  const prevKeys = collectImageKeysFromTask(prevState)
  const nextKeys = collectImageKeysFromTask(nextState)
  const removed = []
  for (const key of prevKeys) {
    if (!nextKeys.has(key)) removed.push(key)
  }
  return removed
}

const extractBackendImageKeyFromUrl = (value) => {
  if (typeof value !== 'string') return ''
  const match = value.match(/\/api\/backend\/image\/([^?]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

const getCollectionImageKey = (item) => {
  const localKey = typeof item?.localKey === 'string' ? item.localKey : ''
  const imageKey = extractBackendImageKeyFromUrl(item?.image)
  const key = localKey || imageKey
  return key ? path.basename(String(key)) : ''
}

const collectImageKeysFromCollection = (items) => {
  const keys = new Set()
  if (!Array.isArray(items)) return keys
  items.forEach((item) => {
    const key = getCollectionImageKey(item)
    if (!key) return
    keys.add(key)
  })
  return keys
}

const listTaskIds = async () => {
  try {
    const entries = await fs.promises.readdir(backendTasksDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.basename(entry.name, '.json'))
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }
}

const collectAllReferencedImageKeys = async () => {
  const keys = new Set()
  const taskIds = await listTaskIds()
  for (const taskId of taskIds) {
    const taskState = await loadTaskState(taskId)
    if (!taskState) continue
    const taskKeys = collectImageKeysFromTask(taskState)
    taskKeys.forEach((key) => keys.add(key))
  }
  const collectionItems = await loadBackendCollection()
  const collectionKeys = collectImageKeysFromCollection(collectionItems)
  collectionKeys.forEach((key) => keys.add(key))
  return keys
}

const cleanupUnusedImages = async (removedKeys = []) => {
  if (!removedKeys.length) return
  const referencedKeys = await collectAllReferencedImageKeys()
  for (const key of removedKeys) {
    const safeKey = path.basename(String(key))
    if (!safeKey || referencedKeys.has(safeKey)) continue
    const filePath = path.join(backendImagesDir, safeKey)
    await fs.promises.unlink(filePath).catch(() => undefined)
  }
}

const cleanupOrphanedImages = async () => {
  let entries = []
  try {
    entries = await fs.promises.readdir(backendImagesDir, { withFileTypes: true })
  } catch (err) {
    if (err && err.code === 'ENOENT') return
    throw err
  }
  const referencedKeys = await collectAllReferencedImageKeys()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (referencedKeys.has(entry.name)) continue
    const filePath = path.join(backendImagesDir, entry.name)
    await fs.promises.unlink(filePath).catch(() => undefined)
  }
}

const scheduleOrphanCleanup = () => {
  if (orphanCleanupTimer) return
  orphanCleanupTimer = setTimeout(() => {
    orphanCleanupTimer = null
    cleanupOrphanedImages().catch((err) => {
      console.warn('清理后端图片缓存失败:', err)
    })
  }, ORPHAN_CLEANUP_DELAY_MS)
}

const MIN_BASE64_LENGTH = 256
const BASE64_CONTENT_REGEX = /^[A-Za-z0-9+/]+={0,2}$/
const INLINE_IMAGE_DATA_REGEX =
  /(?:data:|[a-z0-9.+-]+:)?image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/i

const normalizeBase64Payload = (value) => {
  const compact = value.replace(/\s+/g, '')
  if (compact.length < MIN_BASE64_LENGTH) return null
  if (!BASE64_CONTENT_REGEX.test(compact)) return null
  return compact
}

const normalizeImageUrl = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  const imagePrefixMatch = trimmed.match(
    /^(?:[a-z0-9.+-]+:)?(image\/[a-z0-9.+-]+;base64,)([\s\S]+)$/i
  )
  if (imagePrefixMatch) {
    const payload = normalizeBase64Payload(imagePrefixMatch[2])
    if (!payload) return null
    return `data:${imagePrefixMatch[1]}${payload}`
  }
  const base64Payload = normalizeBase64Payload(trimmed)
  if (base64Payload) {
    return `data:image/png;base64,${base64Payload}`
  }
  return null
}

const extractImageFromText = (text = '') => {
  if (!text) return null
  const mdImageRegex = /!\[[\s\S]*?\]\(([\s\S]*?)\)/
  const match = text.match(mdImageRegex)
  if (match && match[1]) {
    const normalized = normalizeImageUrl(match[1])
    if (normalized) return normalized
  }
  const inlineMatch = text.match(INLINE_IMAGE_DATA_REGEX)
  if (inlineMatch) {
    const normalized = normalizeImageUrl(inlineMatch[0])
    if (normalized) return normalized
  }
  return normalizeImageUrl(text)
}

const parseMarkdownImage = (text = '') => extractImageFromText(text)

const extractImageFromGeminiPart = (part) => {
  if (!part) return null
  const inlineData = part.inline_data || part.inlineData
  const fileData = part.file_data || part.fileData
  if (inlineData?.data) {
    const mimeType = inlineData.mime_type || inlineData.mimeType || 'image/png'
    const payload = normalizeBase64Payload(String(inlineData.data))
    if (payload) {
      return `data:${mimeType};base64,${payload}`
    }
  }
  if (fileData?.file_uri || fileData?.fileUri) {
    const uri = fileData.file_uri || fileData.fileUri
    const normalized = normalizeImageUrl(uri)
    if (normalized) return normalized
  }
  if (typeof part.text === 'string') {
    const imageUrl = parseMarkdownImage(part.text)
    if (imageUrl) return imageUrl
  }
  return null
}

const extractImageFromGeminiCandidates = (candidates = []) => {
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const image = extractImageFromGeminiPart(part)
        if (image) return image
      }
    }
  }
  return null
}

const extractImageFromMessage = (message) => {
  if (!message) return null
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part?.type === 'image_url') {
        const url = part?.image_url?.url || part?.image_url
        if (url) {
          const normalized = normalizeImageUrl(url)
          if (normalized) return normalized
        }
      }
      if (part?.type === 'text' && typeof part.text === 'string') {
        const imageUrl = parseMarkdownImage(part.text)
        if (imageUrl) return imageUrl
      }
    }
  }
  if (typeof message.content === 'string') {
    const imageUrl = parseMarkdownImage(message.content)
    if (imageUrl) return imageUrl
  }
  if (typeof message.reasoning_content === 'string') {
    const imageUrl = parseMarkdownImage(message.reasoning_content)
    if (imageUrl) return imageUrl
  }
  return null
}

const resolveImageFromResponse = (data) => {
  const resultUrl = data?.resultUrl ?? data?.result_url
  if (typeof resultUrl === 'string') {
    const normalized = normalizeImageUrl(resultUrl)
    if (normalized) return normalized
  }
  if (Array.isArray(data?.candidates)) {
    const image = extractImageFromGeminiCandidates(data.candidates)
    if (image) return image
  }
  const fromDataArray = data?.data?.[0]
  if (fromDataArray) {
    if (typeof fromDataArray === 'string') {
      const normalized = normalizeImageUrl(fromDataArray)
      if (normalized) return normalized
    }
    if (fromDataArray.url) {
      const normalized = normalizeImageUrl(fromDataArray.url)
      if (normalized) return normalized
    }
    if (fromDataArray.b64_json) {
      const normalized = normalizeImageUrl(fromDataArray.b64_json)
      if (normalized) return normalized
    }
  }
  return extractImageFromMessage(data?.choices?.[0]?.message)
}

const parseDataUrl = (dataUrl = '') => {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
  if (!match) return null
  return { contentType: match[1], buffer: Buffer.from(match[2], 'base64') }
}

const getMimeFromFilename = (fileName = '') => {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  return 'application/octet-stream'
}

const activeControllers = new Map()
const retryTimers = new Map()

const clearRetryTimer = (subTaskId) => {
  const timer = retryTimers.get(subTaskId)
  if (timer) {
    clearTimeout(timer)
    retryTimers.delete(subTaskId)
  }
}

const abortActiveController = (subTaskId) => {
  const controller = activeControllers.get(subTaskId)
  if (controller) {
    controller.abort()
    activeControllers.delete(subTaskId)
  }
}

const updateStats = (stats, type, duration, count = 1) => {
  const next = { ...stats }
  if (type === 'request') {
    const increment =
      typeof count === 'number' && Number.isFinite(count)
        ? Math.max(0, Math.floor(count))
        : 1
    next.totalRequests += increment
  }
  if (type === 'success') {
    next.successCount += 1
    if (typeof duration === 'number') {
      next.totalTime += duration
      next.fastestTime = next.fastestTime === 0 ? duration : Math.min(next.fastestTime, duration)
      next.slowestTime = Math.max(next.slowestTime, duration)
    }
  }
  return next
}

const updateGlobalStats = async (type, duration, count) => {
  const state = await loadBackendState()
  const stats = updateStats(state.globalStats, type, duration, count)
  await saveBackendState({ ...state, globalStats: stats })
}

const buildMessagesForTask = async (taskState) => {
  const content = []
  if (taskState.prompt) {
    content.push({ type: 'text', text: taskState.prompt })
  }
  const uploads = Array.isArray(taskState.uploads) ? taskState.uploads : []
  for (const upload of uploads) {
    if (!upload?.localKey) continue
    const filePath = path.join(backendImagesDir, upload.localKey)
    try {
      const buffer = await fs.promises.readFile(filePath)
      const mime = upload.type || getMimeFromFilename(upload.localKey)
      const base64 = buffer.toString('base64')
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${base64}` },
      })
    } catch (err) {
      console.warn('读取上传图片失败:', err)
    }
  }
  return [{ role: 'user', content }]
}

const API_VERSION_REGEX = /^v1(?:beta1|beta)?$/i
const apiMarkerSegments = new Set(['projects', 'locations', 'publishers', 'models'])
const isVersionSegment = (value) => API_VERSION_REGEX.test(String(value || ''))

const DEFAULT_API_BASES = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com',
  vertex: 'https://aiplatform.googleapis.com',
}

const ensureProtocol = (value) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`

const resolveApiUrl = (apiUrl, apiFormat) => {
  const trimmed = String(apiUrl || '').trim()
  if (trimmed) return trimmed
  return DEFAULT_API_BASES[apiFormat] || DEFAULT_API_BASES.openai
}

const normalizeApiBase = (apiUrl = '') => {
  const cleaned = String(apiUrl).trim().replace(/\/+$/, '')
  if (!cleaned) {
    return { origin: '', segments: [], host: '' }
  }
  try {
    const url = new URL(ensureProtocol(cleaned))
    return {
      origin: `${url.protocol}//${url.host}`,
      segments: url.pathname.split('/').filter(Boolean),
      host: url.host.toLowerCase(),
    }
  } catch {
    return { origin: cleaned, segments: [], host: '' }
  }
}

const extractVertexProjectId = (apiUrl = '') => {
  const { segments } = normalizeApiBase(apiUrl)
  const index = segments.indexOf('projects')
  if (index < 0) return null
  const candidate = segments[index + 1]
  if (!candidate) return null
  if (apiMarkerSegments.has(candidate)) return null
  if (API_VERSION_REGEX.test(candidate)) return null
  return candidate
}

const inferApiVersionFromUrl = (apiUrl = '') => {
  const cleaned = String(apiUrl).trim()
  if (!cleaned) return null
  try {
    const url = new URL(ensureProtocol(cleaned))
    const segments = url.pathname.split('/').filter(Boolean)
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i]
      if (API_VERSION_REGEX.test(segment)) return segment
    }
    return null
  } catch {
    const segments = cleaned.split('/').filter(Boolean)
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i]
      if (API_VERSION_REGEX.test(segment)) return segment
    }
    return null
  }
}

const resolveApiVersion = (apiUrl, apiVersion, fallback) => {
  const inferred = inferApiVersionFromUrl(apiUrl)
  if (inferred) return inferred
  const trimmed = String(apiVersion || '').trim()
  return trimmed || fallback
}

const buildGeminiContentsFromMessages = (messages = []) => {
  const parts = []
  messages.forEach((message) => {
    const content = Array.isArray(message.content) ? message.content : []
    content.forEach((part) => {
      if (part?.type === 'text' && typeof part.text === 'string') {
        parts.push({ text: part.text })
      }
      if (part?.type === 'image_url') {
        const url = part?.image_url?.url || part?.image_url
        if (!url) return
        const parsed = parseDataUrl(url)
        if (parsed?.buffer) {
          parts.push({
            inline_data: {
              mime_type: parsed.contentType || 'image/png',
              data: parsed.buffer.toString('base64'),
            },
          })
        } else if (typeof url === 'string') {
          parts.push({ file_data: { file_uri: url } })
        }
      }
    })
  })
  return [{ role: 'user', parts }]
}

const buildGeminiRequest = (config) => {
  const apiFormat = config?.apiFormat || 'openai'
  const format = apiFormat === 'vertex' ? 'vertex' : 'gemini'
  const apiUrl = resolveApiUrl(config?.apiUrl, format)
  const baseInfo = normalizeApiBase(apiUrl)
  const baseOrigin = baseInfo.origin || String(apiUrl || '').replace(/\/+$/, '')
  const versionFallback = format === 'vertex' ? 'v1beta1' : 'v1beta'
  const version = resolveApiVersion(apiUrl, config?.apiVersion, versionFallback)
  const hasVersion = Boolean(inferApiVersionFromUrl(apiUrl))
  const segments = [...baseInfo.segments]

  if (!hasVersion && version) {
    const markerIndex = segments.findIndex((segment) => apiMarkerSegments.has(segment))
    if (markerIndex >= 0) {
      segments.splice(markerIndex, 0, version)
    } else {
      segments.push(version)
    }
  }

  const modelValue = String(config?.model || '').trim()
  if (!modelValue) {
    throw new Error('模型名称未配置')
  }

  const modelSegments = modelValue.split('/').filter(Boolean)
  const modelHasProjectPath = modelSegments.includes('projects')
  const geminiModelIsPath = modelSegments[0] === 'models'
  const normalizedModel = geminiModelIsPath ? modelSegments.slice(1).join('/') : modelValue

  const applyModelPath = () => {
    const modelIndex = segments.indexOf('models')
    if (geminiModelIsPath) {
      if (modelIndex >= 0 && modelSegments[0] === 'models') {
        segments.splice(modelIndex + 1)
        segments.push(...modelSegments.slice(1))
      } else {
        segments.push(...modelSegments)
      }
      return
    }
    if (modelIndex >= 0) {
      segments.splice(modelIndex + 1)
      segments.push(modelValue)
    } else {
      segments.push('models', modelValue)
    }
  }

  const ensureMarkerValue = (marker, value) => {
    const idx = segments.indexOf(marker)
    if (idx === -1) {
      if (!value) return false
      segments.push(marker, value)
      return true
    }
    const next = segments[idx + 1]
    if (!next || apiMarkerSegments.has(next) || isVersionSegment(next)) {
      if (!value) return false
      segments.splice(idx + 1, 0, value)
      return true
    }
    return true
  }

  if (format === 'vertex') {
    const projectId =
      String(config?.vertexProjectId || '').trim() ||
      extractVertexProjectId(apiUrl) ||
      ''
    const location = String(config?.vertexLocation || '').trim() || 'us-central1'
    const publisher = String(config?.vertexPublisher || '').trim() || 'google'
    const hasProjectsMarker = segments.includes('projects')
    const useVertexMarkers = Boolean(projectId || hasProjectsMarker || modelHasProjectPath)

    if (modelHasProjectPath) {
      segments.push(...modelSegments)
    } else if (useVertexMarkers) {
      if (projectId) {
        ensureMarkerValue('projects', projectId)
      }
      if (segments.includes('projects') || projectId) {
        ensureMarkerValue('locations', location)
        ensureMarkerValue('publishers', publisher)
      }
      if (segments.includes('projects') || projectId) {
        ensureMarkerValue('models', normalizedModel)
      } else {
        applyModelPath()
      }
    } else {
      applyModelPath()
    }
  } else {
    applyModelPath()
  }

  const suffix = config?.stream ? ':streamGenerateContent' : ':generateContent'
  let url = `${baseOrigin}${segments.length ? `/${segments.join('/')}` : ''}${suffix}`
  const headers = {
    'Content-Type': 'application/json',
    Connection: 'close',
  }
  const isOfficial =
    format === 'vertex'
      ? baseInfo.host === 'aiplatform.googleapis.com'
      : baseInfo.host === 'generativelanguage.googleapis.com'
  if (isOfficial) {
    url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(config?.apiKey || '')}`
  } else {
    headers.Authorization = `Bearer ${config?.apiKey || ''}`
  }
  return { url, headers }
}

const readGeminiStream = async (response) => {
  const reader = response.body?.getReader()
  if (!reader) {
    return response.json()
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let lastJson = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      newlineIndex = buffer.indexOf('\n')
      if (!line) continue
      const cleaned = line.replace(/^data:\s*/i, '').trim()
      if (!cleaned || cleaned === '[DONE]') continue
      try {
        lastJson = JSON.parse(cleaned)
      } catch {
        // ignore
      }
    }
  }

  const tail = decoder.decode()
  if (tail) buffer += tail
  const remainder = buffer.trim()
  if (remainder) {
    const cleaned = remainder.replace(/^data:\s*/i, '').trim()
    if (cleaned && cleaned !== '[DONE]') {
      try {
        lastJson = JSON.parse(cleaned)
      } catch {
        // ignore
      }
    }
  }

  return lastJson
}

const readResponseError = async (response) => {
  const fallback = response.statusText || `HTTP ${response.status}`
  try {
    const text = await response.text()
    if (!text) return fallback
    try {
      const data = JSON.parse(text)
      return data?.error?.message || data?.message || text
    } catch {
      return text
    }
  } catch {
    return fallback
  }
}

const requestImageUrl = async (config, messages, signal) => {
  if (!config?.apiKey) {
    throw new Error('API Key 未配置')
  }
  if (!config?.model) {
    throw new Error('模型名称未配置')
  }

  const apiFormat = config?.apiFormat || 'openai'
  const apiUrl = resolveApiUrl(config?.apiUrl, apiFormat === 'vertex' ? 'vertex' : apiFormat)

  if (apiFormat !== 'openai') {
    const requestInfo = {
      url: '',
      model: config.model,
      stream: Boolean(config.stream),
      format: apiFormat,
    }
    let response
    let data
    try {
      const contents = buildGeminiContentsFromMessages(messages)
      const built = buildGeminiRequest(config)
      requestInfo.url = built.url
      logBackendOutbound('api-request', requestInfo)
      response = await fetch(built.url, {
        method: 'POST',
        headers: built.headers,
        body: JSON.stringify({ contents }),
        signal,
      })
      data = config.stream ? await readGeminiStream(response) : await response.json()
    } catch (err) {
      logBackendOutbound('api-request-error', {
        ...requestInfo,
        error: describeFetchError(err),
      })
      throw err
    }

    logBackendOutbound('api-response', { ...requestInfo, status: response.status })
    if (!response.ok) {
      const message =
        data?.error?.message ||
        (typeof data === 'string' ? data : '') ||
        response.statusText
      logBackendResponse('json-error', { status: response.status, message })
      throw new Error(message)
    }

    const imageUrl = resolveImageFromResponse(data)
    if (!imageUrl) {
      logBackendResponse('json-response', data)
    }
    return imageUrl
  }

  const baseInfo = normalizeApiBase(apiUrl)
  const basePath = baseInfo.origin
    ? `${baseInfo.origin}${baseInfo.segments.length ? `/${baseInfo.segments.join('/')}` : ''}`
    : String(apiUrl || '').replace(/\/+$/, '')
  const version = resolveApiVersion(apiUrl, config.apiVersion, 'v1')
  const hasVersion = Boolean(inferApiVersionFromUrl(apiUrl))
  const openAiBase = hasVersion ? basePath : `${basePath}/${version}`
  const chatUrl = openAiBase.endsWith('/chat/completions')
    ? openAiBase
    : `${openAiBase}/chat/completions`
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'x-api-key': config.apiKey,
    'Content-Type': 'application/json',
    Connection: 'close',
  }

  if (config.stream) {
    const requestInfo = {
      url: chatUrl,
      model: config.model,
      stream: true,
    }
    logBackendOutbound('api-request', requestInfo)
    let response
    try {
      response = await fetch(requestInfo.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config.model, messages, stream: true }),
        signal,
      })
    } catch (err) {
      logBackendOutbound('api-request-error', {
        ...requestInfo,
        error: describeFetchError(err),
      })
      throw err
    }
    logBackendOutbound('api-response', { ...requestInfo, status: response.status })
    if (!response.ok) {
      const message = await readResponseError(response)
      logBackendResponse('stream-error', { status: response.status, message })
      throw new Error(message)
    }
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let generatedText = ''
    let pending = ''
    const consumeLine = (line) => {
      const cleaned = line.replace(/\r$/, '')
      if (!cleaned.startsWith('data:')) return
      const payload = cleaned.slice(5).trimStart()
      if (!payload || payload === '[DONE]') return
      try {
        const json = JSON.parse(payload)
        const delta = json.choices?.[0]?.delta
        if (delta?.content) generatedText += delta.content
        if (delta?.reasoning_content) generatedText += delta.reasoning_content
      } catch {
        // ignore chunk parse errors
      }
    }
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        let newlineIndex = pending.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = pending.slice(0, newlineIndex)
          pending = pending.slice(newlineIndex + 1)
          consumeLine(line)
          newlineIndex = pending.indexOf('\n')
        }
      }
      const tail = decoder.decode()
      if (tail) pending += tail
    }
    if (pending) {
      consumeLine(pending)
    }
    const imageUrl = parseMarkdownImage(generatedText)
    if (!imageUrl) {
      logBackendResponse('stream-response', generatedText)
    }
    return imageUrl
  }

  const requestInfo = {
    url: chatUrl,
    model: config.model,
    stream: false,
  }
  logBackendOutbound('api-request', requestInfo)
  let response
  try {
    response = await fetch(requestInfo.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, messages, stream: false }),
      signal,
    })
  } catch (err) {
    logBackendOutbound('api-request-error', {
      ...requestInfo,
      error: describeFetchError(err),
    })
    throw err
  }
  logBackendOutbound('api-response', { ...requestInfo, status: response.status })
  if (!response.ok) {
    const message = await readResponseError(response)
    logBackendResponse('json-error', { status: response.status, message })
    throw new Error(message)
  }
  const data = await response.json()
  const imageUrl = resolveImageFromResponse(data)
  if (!imageUrl) {
    logBackendResponse('json-response', data)
  }
  return imageUrl
}

const downloadImageBuffer = async (imageUrl) => {
  if (!imageUrl) return null
  if (imageUrl.startsWith('data:image')) {
    const parsed = parseDataUrl(imageUrl)
    if (!parsed) return null
    return parsed
  }
  if (!/^https?:\/\//i.test(imageUrl)) {
    return null
  }
  let response
  try {
    response = await fetch(imageUrl, { headers: { Connection: 'close' } })
  } catch (err) {
    logBackendOutbound('image-download-error', {
      url: imageUrl,
      error: describeFetchError(err),
    })
    throw err
  }
  if (!response.ok) {
    logBackendOutbound('image-download-response', {
      url: imageUrl,
      status: response.status,
    })
    throw new Error(response.statusText)
  }
  const arrayBuffer = await response.arrayBuffer()
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  return { buffer: Buffer.from(arrayBuffer), contentType }
}

const scheduleRetry = (taskId, subTaskId) => {
  if (retryTimers.has(subTaskId)) return
  const timer = setTimeout(async () => {
    retryTimers.delete(subTaskId)
    const taskState = await loadTaskState(taskId)
    if (!taskState) return
    const resultIndex = taskState.results.findIndex((item) => item.id === subTaskId)
    if (resultIndex === -1) return
    const current = taskState.results[resultIndex]
    if (current?.autoRetry === false) return
    if (current.status !== 'loading') return
    void runSubTask(taskId, subTaskId)
  }, RETRY_DELAY_MS)
  retryTimers.set(subTaskId, timer)
}

const runSubTask = async (taskId, subTaskId, options = {}) => {
  const countRequest = options.countRequest !== false
  if (activeControllers.has(subTaskId)) return
  clearRetryTimer(subTaskId)
  const controller = new AbortController()
  activeControllers.set(subTaskId, controller)

  const taskState = await loadTaskState(taskId)
  if (!taskState) {
    activeControllers.delete(subTaskId)
    return
  }

  const resultIndex = taskState.results.findIndex((item) => item.id === subTaskId)
  if (resultIndex === -1) {
    activeControllers.delete(subTaskId)
    return
  }

  const currentResult = taskState.results[resultIndex]
  const startTime =
    typeof currentResult?.startTime === 'number' && Number.isFinite(currentResult.startTime)
      ? currentResult.startTime
      : Date.now()
  taskState.results[resultIndex] = {
    ...currentResult,
    status: 'loading',
    error: currentResult?.error,
    startTime,
    endTime: undefined,
    duration: undefined,
    autoRetry: currentResult?.autoRetry !== false,
    savedLocal: false,
  }
  if (countRequest) {
    taskState.stats = updateStats(taskState.stats, 'request')
  }
  await saveTaskState(taskId, taskState)
  if (countRequest) {
    await updateGlobalStats('request')
  }

  try {
    const backendState = await loadBackendState()
    const messages = await buildMessagesForTask(taskState)
    const imageUrl = await requestImageUrl(backendState.config, messages, controller.signal)
    if (!imageUrl) {
      throw new Error('未在响应中找到图片数据')
    }
    const downloaded = await downloadImageBuffer(imageUrl)
    if (!downloaded) {
      throw new Error('图片下载失败')
    }
    const saved = await saveBackendImageBuffer(downloaded.buffer, downloaded.contentType)
    const endTime = Date.now()
    const duration = endTime - startTime

    const freshState = await loadTaskState(taskId)
    if (!freshState) return
    const freshIndex = freshState.results.findIndex((item) => item.id === subTaskId)
    if (freshIndex === -1) return
    freshState.results[freshIndex] = {
      ...freshState.results[freshIndex],
      status: 'success',
      error: undefined,
      localKey: saved.fileName,
      sourceUrl: `/api/backend/image/${encodeURIComponent(saved.fileName)}`,
      savedLocal: false,
      autoRetry: false,
      endTime,
      duration,
    }
    freshState.stats = updateStats(freshState.stats, 'success', duration)
    await saveTaskState(taskId, freshState)
    await updateGlobalStats('success', duration)
  } catch (err) {
    if (controller.signal.aborted) {
      return
    }
    const errorMessage = err?.message || '未知错误'
    const freshState = await loadTaskState(taskId)
    if (!freshState) return
    const freshIndex = freshState.results.findIndex((item) => item.id === subTaskId)
    if (freshIndex === -1) return
    const current = freshState.results[freshIndex]
    const shouldRetry = current?.autoRetry !== false
    if (shouldRetry) {
      freshState.results[freshIndex] = {
        ...current,
        status: 'loading',
        error: `${errorMessage} (1s后重试...)`,
        retryCount: (current.retryCount || 0) + 1,
        autoRetry: true,
      }
      await saveTaskState(taskId, freshState)
      scheduleRetry(taskId, subTaskId)
    } else {
      freshState.results[freshIndex] = {
        ...current,
        status: 'error',
        error: errorMessage,
        endTime: Date.now(),
        autoRetry: false,
      }
      await saveTaskState(taskId, freshState)
    }
  } finally {
    activeControllers.delete(subTaskId)
  }
}

const startGeneration = async (taskId) => {
  const taskState = (await loadTaskState(taskId)) || createDefaultTaskState()
  const previousState = {
    ...taskState,
    results: Array.isArray(taskState.results) ? [...taskState.results] : [],
    uploads: Array.isArray(taskState.uploads) ? [...taskState.uploads] : [],
  }
  taskState.results.forEach((result) => {
    abortActiveController(result.id)
    clearRetryTimer(result.id)
  })
  const concurrency = normalizeConcurrency(taskState.concurrency)
  const startTime = Date.now()
  taskState.results = Array.from({ length: concurrency }).map(() => ({
    id: crypto.randomUUID(),
    status: 'loading',
    retryCount: 0,
    startTime,
    autoRetry: true,
    savedLocal: false,
  }))
  taskState.stats = updateStats(taskState.stats, 'request', undefined, concurrency)
  await saveTaskState(taskId, taskState)
  await updateGlobalStats('request', undefined, concurrency)
  const removedKeys = getRemovedImageKeys(previousState, taskState)
  await cleanupUnusedImages(removedKeys)
  scheduleOrphanCleanup()
  taskState.results.forEach((result) => {
    void runSubTask(taskId, result.id, { countRequest: false })
  })
  return taskState
}

const retrySubTask = async (taskId, subTaskId) => {
  const taskState = await loadTaskState(taskId)
  if (!taskState) return null
  const resultIndex = taskState.results.findIndex((item) => item.id === subTaskId)
  if (resultIndex === -1) return taskState
  const startTime = Date.now()
  const current = taskState.results[resultIndex]
  const removedKey = current?.localKey
  clearRetryTimer(subTaskId)
  taskState.results[resultIndex] = {
    ...current,
    status: 'loading',
    error: undefined,
    retryCount: current.retryCount || 0,
    startTime,
    endTime: undefined,
    duration: undefined,
    localKey: undefined,
    sourceUrl: undefined,
    autoRetry: true,
    savedLocal: false,
  }
  await saveTaskState(taskId, taskState)
  if (removedKey) {
    await cleanupUnusedImages([removedKey])
  }
  scheduleOrphanCleanup()
  void runSubTask(taskId, subTaskId)
  return taskState
}

const normalizeStopMode = (mode) => (mode === 'abort' ? 'abort' : 'pause')

const stopSubTask = async (taskId, subTaskId, mode = 'pause') => {
  const taskState = await loadTaskState(taskId)
  if (!taskState) return null
  const resolvedMode = normalizeStopMode(mode)
  const shouldAbort = resolvedMode === 'abort'
  const targets = subTaskId
    ? taskState.results.filter((item) => item.id === subTaskId)
    : taskState.results

  targets.forEach((target) => {
    if (shouldAbort) {
      abortActiveController(target.id)
    }
    clearRetryTimer(target.id)
  })

  const nextResults = taskState.results.map((item) => {
    if (subTaskId && item.id !== subTaskId) return item
    if (item.status !== 'loading') return item
    return {
      ...item,
      status: 'error',
      error: shouldAbort ? '已停止' : '已暂停重试',
      autoRetry: false,
      endTime: shouldAbort ? Date.now() : item.endTime,
    }
  })
  const nextState = { ...taskState, results: nextResults }
  await saveTaskState(taskId, nextState)
  return nextState
}

const app = express()

app.use(express.json({ limit: '50mb' }))
if (backendLogRequests) {
  app.use((req, res, next) => {
    const start = Date.now()
    res.on('finish', () => {
      logBackendRequest('http', {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - start,
      })
    })
    next()
  })
}

void cleanupOrphanedImages().catch((err) => {
  console.warn('启动时清理后端图片缓存失败:', err)
})

const backendTokens = new Set()
const sseClients = new Set()

const sendSseEvent = (res, event, data) => {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

const broadcastSseEvent = (event, data) => {
  for (const res of sseClients) {
    try {
      sendSseEvent(res, event, data)
    } catch (err) {
      sseClients.delete(res)
    }
  }
}

const requireBackendAuth = (req, res, next) => {
  const headerToken = req.headers['x-backend-token']
  const queryToken = req.query?.token
  const token = Array.isArray(headerToken)
    ? headerToken[0]
    : (headerToken || queryToken)
  if (!token || !backendTokens.has(token)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

app.post('/api/backend/auth', async (req, res) => {
  if (!backendPassword) {
    res.status(500).json({ error: 'BACKEND_PASSWORD not set' })
    return
  }
  const { password } = req.body || {}
  if (!password || password !== backendPassword) {
    res.status(401).json({ error: 'Invalid password' })
    return
  }
  const token = crypto.randomBytes(16).toString('hex')
  backendTokens.add(token)
  res.json({ token })
})

app.get('/api/backend/stream', requireBackendAuth, async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  res.write('retry: 2000\n\n')
  sseClients.add(res)
  req.on('close', () => {
    sseClients.delete(res)
  })
  try {
    const state = await loadBackendState()
    sendSseEvent(res, 'state', state)
  } catch (err) {
    console.warn('初始化事件流状态失败:', err)
  }
})

app.get('/api/backend/state', requireBackendAuth, async (_req, res) => {
  try {
    const state = await loadBackendState()
    res.json(state)
  } catch (err) {
    console.error('backend state error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.patch('/api/backend/state', requireBackendAuth, async (req, res) => {
  try {
    const current = await loadBackendState()
    const next = { ...current }
    if (req.body?.config) {
      next.config = { ...DEFAULT_BACKEND_CONFIG, ...req.body.config }
    }
    if (Array.isArray(req.body?.tasksOrder)) {
      next.tasksOrder = Array.from(new Set(req.body.tasksOrder.filter((id) => typeof id === 'string')))
    }
    if (req.body?.globalStats) {
      next.globalStats = { ...DEFAULT_GLOBAL_STATS, ...req.body.globalStats }
    }
    await saveBackendState(next)
    res.json(next)
  } catch (err) {
    console.error('backend state write error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

app.get('/api/backend/collection', requireBackendAuth, async (_req, res) => {
  try {
    const items = await loadBackendCollection()
    res.json(items)
  } catch (err) {
    console.error('backend collection read error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.put('/api/backend/collection', requireBackendAuth, async (req, res) => {
  try {
    const previous = await loadBackendCollection()
    const items = normalizeCollectionPayload(req.body)
    await saveBackendCollection(items)
    const prevKeys = collectImageKeysFromCollection(previous)
    const nextKeys = collectImageKeysFromCollection(items)
    const removedKeys = []
    for (const key of prevKeys) {
      if (!nextKeys.has(key)) removedKeys.push(key)
    }
    await cleanupUnusedImages(removedKeys)
    scheduleOrphanCleanup()
    res.json(items)
  } catch (err) {
    console.error('backend collection write error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

app.get('/api/backend/task/:id', requireBackendAuth, async (req, res) => {
  try {
    const taskId = req.params.id
    const taskState = await loadTaskState(taskId)
    if (!taskState) {
      const backendState = await loadBackendState()
      if (backendState.tasksOrder.includes(taskId)) {
        const next = createDefaultTaskState()
        await saveTaskState(taskId, next)
        res.json(next)
        return
      }
      res.status(404).json({ error: 'Not Found' })
      return
    }
    res.json(taskState)
  } catch (err) {
    console.error('backend task read error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.put('/api/backend/task/:id', requireBackendAuth, async (req, res) => {
  try {
    const payload = req.body || {}
    const previous = await loadTaskState(req.params.id)
    const next = {
      ...createDefaultTaskState(),
      ...payload,
      concurrency: normalizeConcurrency(payload?.concurrency),
      stats: { ...DEFAULT_TASK_STATS, ...(payload?.stats || {}) },
      results: Array.isArray(payload?.results) ? payload.results : [],
      uploads: Array.isArray(payload?.uploads) ? payload.uploads : [],
    }
    await saveTaskState(req.params.id, next)
    if (previous) {
      const removedKeys = getRemovedImageKeys(previous, next)
      await cleanupUnusedImages(removedKeys)
    }
    scheduleOrphanCleanup()
    res.json(next)
  } catch (err) {
    console.error('backend task write error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

app.patch('/api/backend/task/:id', requireBackendAuth, async (req, res) => {
  try {
    const payload = req.body || {}
    const current = (await loadTaskState(req.params.id)) || createDefaultTaskState()
    const next = {
      ...current,
      prompt: typeof payload.prompt === 'string' ? payload.prompt : current.prompt,
      concurrency: normalizeConcurrency(payload?.concurrency, current.concurrency || DEFAULT_CONCURRENCY),
      enableSound: typeof payload.enableSound === 'boolean' ? payload.enableSound : current.enableSound,
      uploads: Array.isArray(payload?.uploads) ? payload.uploads : current.uploads,
    }
    await saveTaskState(req.params.id, next)
    const removedKeys = getRemovedImageKeys(current, next)
    await cleanupUnusedImages(removedKeys)
    scheduleOrphanCleanup()
    res.json(next)
  } catch (err) {
    console.error('backend task patch error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

app.delete('/api/backend/task/:id', requireBackendAuth, async (req, res) => {
  try {
    const existing = await loadTaskState(req.params.id)
    const removedKeys = existing ? Array.from(collectImageKeysFromTask(existing)) : []
    if (existing?.results) {
      existing.results.forEach((result) => {
        const controller = activeControllers.get(result.id)
        if (controller) {
          controller.abort()
          activeControllers.delete(result.id)
        }
        clearRetryTimer(result.id)
      })
    }
    await fs.promises.unlink(getTaskFilePath(req.params.id)).catch(() => undefined)
    const state = await loadBackendState()
    const next = {
      ...state,
      tasksOrder: state.tasksOrder.filter((id) => id !== req.params.id),
    }
    await saveBackendState(next)
    await cleanupUnusedImages(removedKeys)
    await cleanupOrphanedImages()
    res.json({ ok: true })
  } catch (err) {
    console.error('backend task delete error:', err)
    res.status(500).json({ error: 'Delete Error' })
  }
})

app.post('/api/backend/task/:id/generate', requireBackendAuth, async (req, res) => {
  try {
    const state = await startGeneration(req.params.id)
    res.json(state)
  } catch (err) {
    console.error('backend generate error:', err)
    res.status(500).json({ error: 'Generate Error' })
  }
})

app.post('/api/backend/task/:id/retry', requireBackendAuth, async (req, res) => {
  try {
    const { subTaskId } = req.body || {}
    if (!subTaskId) {
      res.status(400).json({ error: 'Missing subTaskId' })
      return
    }
    const state = await retrySubTask(req.params.id, subTaskId)
    if (!state) {
      res.status(404).json({ error: 'Not Found' })
      return
    }
    res.json(state)
  } catch (err) {
    console.error('backend retry error:', err)
    res.status(500).json({ error: 'Retry Error' })
  }
})

app.post('/api/backend/task/:id/stop', requireBackendAuth, async (req, res) => {
  try {
    const { subTaskId, mode } = req.body || {}
    const state = await stopSubTask(req.params.id, subTaskId, mode)
    if (!state) {
      res.status(404).json({ error: 'Not Found' })
      return
    }
    res.json(state)
  } catch (err) {
    console.error('backend stop error:', err)
    res.status(500).json({ error: 'Stop Error' })
  }
})

app.post(
  '/api/backend/upload',
  requireBackendAuth,
  express.raw({ type: '*/*', limit: '50mb' }),
  async (req, res) => {
    try {
      const buffer = req.body
      if (!buffer || !buffer.length) {
        res.status(400).json({ error: 'Empty Body' })
        return
      }
      const contentType = req.headers['content-type'] || 'application/octet-stream'
      const result = await saveBackendImageBuffer(buffer, contentType)
      res.json({
        key: result.fileName,
        url: `/api/backend/image/${encodeURIComponent(result.fileName)}`,
      })
    } catch (err) {
      console.error('backend upload error:', err)
      res.status(500).json({ error: 'Upload Error' })
    }
  },
)

app.get('/api/backend/image/:key', requireBackendAuth, async (req, res) => {
  try {
    const safeName = path.basename(req.params.key)
    const filePath = path.join(backendImagesDir, safeName)
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Not Found' })
      return
    }
    res.sendFile(filePath)
  } catch (err) {
    console.error('backend image error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.delete('/api/backend/image/:key', requireBackendAuth, async (req, res) => {
  try {
    const safeName = path.basename(req.params.key)
    if (!safeName) {
      res.status(400).json({ error: 'Missing Key' })
      return
    }
    const filePath = path.join(backendImagesDir, safeName)
    await fs.promises.unlink(filePath).catch(() => undefined)
    res.json({ ok: true })
  } catch (err) {
    console.error('backend image delete error:', err)
    res.status(500).json({ error: 'Delete Error' })
  }
})

app.post('/api/save-image', async (req, res) => {
  try {
    const buffer = await readRequestBody(req)
    if (!buffer.length) {
      res.status(400).json({ error: 'Empty Body' })
      return
    }

    const typeHeader = req.headers['x-image-type']
    const contentType = Array.isArray(typeHeader)
      ? typeHeader[0]
      : (typeHeader || req.headers['content-type'] || '')

    const result = await saveImageBuffer(buffer, String(contentType))
    res.json(result)
  } catch (err) {
    console.error('save-image error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

if (isProd) {
  app.use(express.static(distDir))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
} else {
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: 'custom',
  })

  app.use(vite.middlewares)
  app.get('*', async (req, res) => {
    try {
      const templatePath = path.join(rootDir, 'index.html')
      const template = await fs.promises.readFile(templatePath, 'utf-8')
      const html = await vite.transformIndexHtml(req.originalUrl, template)
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html)
    } catch (err) {
      vite.ssrFixStacktrace(err)
      res.status(500).end(err.message)
    }
  })
}

app.listen(port, () => {
  console.log(`[server] http://localhost:${port} (${isProd ? 'prod' : 'dev'})`)
})
