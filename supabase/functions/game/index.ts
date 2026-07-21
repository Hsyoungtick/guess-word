import { createClient } from 'npm:@supabase/supabase-js@2'
import { calibrateSimilarity, constrainSemanticScore, cosineSimilarity, normalizeWord, type HistoryAnchor, type SemanticScore } from './game-logic.ts'

type JsonObject = Record<string, unknown>
type Seat = number
type DbRoom = { id: string; code: string; status: 'waiting' | 'playing' | 'finished'; category: string; difficulty: string; answer_ciphertext: string | null; answer_word_id: string | null; current_player_id: string | null; turn_deadline: string | null; turn_number: number; version: number; winner_id: string | null; max_players: number; visibility: 'public' | 'private'; host_player_id: string | null; paused_at: string | null; pause_reason: string | null; ai_request_id: string | null; ai_player_id: string | null }
type DbPlayer = { id: string; room_id: string; seat: string; seat_number: number; nickname: string; token_hash: string; last_seen_at: string; rematch_ready: boolean; is_active: boolean }
type DbGuess = { id: string; player_id: string; display_word: string; normalized_word: string; similarity: number; turn_number: number; created_at: string }
type EmbeddingConfig = { baseUrl: string; apiKey: string; model: string; timeoutMs: number; scoreFloor: number; scoreCeiling: number }

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

function env(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new ApiError(500, 'SERVER_CONFIG', '服务端配置不完整')
  return value
}

const client = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } })
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function allowedOrigins(): string[] {
  return env('ALLOWED_ORIGIN').split(',').map((item) => item.trim()).filter((item) => /^https?:\/\/[^/]+$/.test(item))
}

function corsHeaders(origin: string | null): HeadersInit {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  }
  if (origin && allowedOrigins().includes(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

function assertOrigin(request: Request): string | null {
  const origin = request.headers.get('origin')
  if (origin && !allowedOrigins().includes(origin)) throw new ApiError(403, 'ORIGIN_DENIED', '来源不在允许列表')
  return origin
}

async function requestBody(request: Request): Promise<JsonObject> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'INVALID_CONTENT_TYPE', '请求必须使用 JSON')
  let value: unknown
  try { value = await request.json() } catch { throw new ApiError(400, 'INVALID_JSON', '请求 JSON 无效') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'INVALID_INPUT', '请求内容无效')
  return value as JsonObject
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_INPUT', `${field} 无效`)
  const result = value.trim()
  if (!result || [...result].length > max || /[\p{Cc}\p{Cf}]/u.test(result)) throw new ApiError(400, 'INVALID_INPUT', `${field} 无效`)
  return result
}

function playerName(value: unknown): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result) return ''
  if ([...result].length > 20 || /[\p{Cc}\p{Cf}]/u.test(result) || !/^[\p{L}\p{N} _·.'’-]+$/u.test(result)) throw new ApiError(400, 'INVALID_NICKNAME', '昵称包含不支持的字符')
  return result
}

function guessWord(value: unknown): string {
  const result = text(value, '猜词', 8)
  if ([...result].length < 1 || !/^[\p{L}\p{N}\u4e00-\u9fff]+$/u.test(result)) throw new ApiError(400, 'INVALID_GUESS', '猜词必须是 1 至 8 个字')
  return result
}

function roomCode(value: unknown): string {
  const result = text(value, '房间码', 6)
  if (!/^\d{6}$/.test(result)) throw new ApiError(400, 'INVALID_CODE', '请输入 6 位数字房间码')
  return result
}

function selection(value: unknown, field: string, choices: readonly string[]): string {
  const result = text(value, field, 20)
  if (!choices.includes(result)) throw new ApiError(400, 'INVALID_INPUT', `${field} 无效`)
  return result
}

function toBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(base64)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

async function tokenHash(token: string): Promise<string> {
  return Array.from(await sha256(token), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function createToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return toBase64Url(bytes)
}

async function encryptionKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', await sha256(env('GAME_SECRET')), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function encryptAnswer(answer: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encryptedWithTag = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, await encryptionKey(), encoder.encode(answer)))
  const ciphertext = encryptedWithTag.slice(0, -16)
  const tag = encryptedWithTag.slice(-16)
  return `${toBase64Url(iv)}.${toBase64Url(tag)}.${toBase64Url(ciphertext)}`
}

async function decryptAnswer(payload: string): Promise<string> {
  const [ivValue, tagValue, ciphertextValue] = payload.split('.')
  if (!ivValue || !tagValue || !ciphertextValue) throw new ApiError(500, 'INVALID_CIPHERTEXT', '答案密文损坏')
  try {
    const tag = fromBase64Url(tagValue)
    const ciphertext = fromBase64Url(ciphertextValue)
    const combined = new Uint8Array(ciphertext.length + tag.length)
    combined.set(ciphertext); combined.set(tag, ciphertext.length)
    return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(ivValue), tagLength: 128 }, await encryptionKey(), combined))
  } catch { throw new ApiError(500, 'INVALID_CIPHERTEXT', '答案密文损坏') }
}

function parseEmbeddingConfig(): EmbeddingConfig {
  let parsed: unknown
  try { parsed = JSON.parse(env('EMBEDDING_CONFIG')) } catch { throw new ApiError(500, 'EMBEDDING_CONFIG_INVALID', '向量服务配置无效') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(500, 'EMBEDDING_CONFIG_INVALID', '向量服务配置无效')
  const value = parsed as JsonObject
  if (typeof value.baseUrl !== 'string' || !/^https:\/\//.test(value.baseUrl) || typeof value.apiKey !== 'string' || !value.apiKey || typeof value.model !== 'string' || !value.model) throw new ApiError(500, 'EMBEDDING_CONFIG_INVALID', '向量服务配置无效')
  const scoreFloor = typeof value.scoreFloor === 'number' ? value.scoreFloor : 0.2
  const scoreCeiling = typeof value.scoreCeiling === 'number' ? value.scoreCeiling : 0.8
  if (scoreFloor < -1 || scoreCeiling > 1 || scoreFloor >= scoreCeiling) throw new ApiError(500, 'EMBEDDING_CONFIG_INVALID', '向量分数校准区间无效')
  return { baseUrl: value.baseUrl.replace(/\/$/, ''), apiKey: value.apiKey, model: value.model, timeoutMs: typeof value.timeoutMs === 'number' ? Math.min(60000, Math.max(1000, value.timeoutMs)) : 10000, scoreFloor, scoreCeiling }
}

async function embed(inputs: string[]): Promise<{ vectors: number[][]; config: EmbeddingConfig }> {
  const config = parseEmbeddingConfig()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  let response: Response
  try {
    response = await fetch(`${config.baseUrl}/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model: config.model, input: inputs, encoding_format: 'float' }), signal: controller.signal })
  } catch { throw new ApiError(502, 'EMBEDDING_UNAVAILABLE', '向量服务暂时无法响应') } finally { clearTimeout(timeout) }
  if (!response.ok) throw new ApiError(502, 'EMBEDDING_UNAVAILABLE', '向量服务暂时无法响应')
  const raw = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }> }
  const vectors = [...(raw.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((item) => item.embedding)
  const dimension = vectors[0]?.length ?? 0
  if (vectors.length !== inputs.length || dimension === 0 || vectors.some((vector) => !vector || vector.length !== dimension || vector.some((value) => !Number.isFinite(value)))) throw new ApiError(502, 'EMBEDDING_INVALID_RESPONSE', '向量服务返回无效')
  return { vectors: vectors as number[][], config }
}

async function claimWord(category: string, difficulty: string): Promise<{ id: string; word: string }> {
  const { data, error } = await client.rpc('claim_word', { p_category: category, p_difficulty: difficulty })
  const selected = Array.isArray(data) ? data[0] : data
  if (error || !selected?.word_id || typeof selected.answer !== 'string') throw new ApiError(503, 'WORD_BANK_EMPTY', '当前词库暂无可用词语')
  return { id: selected.word_id, word: selected.answer }
}

async function scoreGuess(answer: string, history: HistoryAnchor[], newGuess: string): Promise<SemanticScore> {
  const words = [answer, ...history.map((item) => item.word), newGuess]
  const { vectors, config } = await embed(words)
  const answerVector = vectors[0]
  const ranked = words.slice(1).map((word, index) => ({ word, similarity: cosineSimilarity(answerVector, vectors[index + 1]) })).sort((left, right) => left.similarity - right.similarity)
  const newIndex = ranked.findIndex((item) => normalizeWord(item.word) === normalizeWord(newGuess))
  const score = constrainSemanticScore(history, {
    similarity: calibrateSimilarity(ranked[newIndex].similarity, config.scoreFloor, config.scoreCeiling),
    closerThan: ranked.slice(0, newIndex).map((item) => item.word),
    fartherThan: ranked.slice(newIndex + 1).map((item) => item.word),
  })
  if (score.bounds.conflict) throw new ApiError(502, 'EMBEDDING_ANCHOR_CONFLICT', '向量排序与历史分数冲突')
  return score
}

async function roomByCode(code: string): Promise<DbRoom> {
  const { data, error } = await client.from('rooms').select('*').eq('code', code).single()
  if (error || !data) throw new ApiError(404, 'ROOM_NOT_FOUND', '房间不存在')
  return data as DbRoom
}

async function authenticate(code: string, token: string): Promise<{ room: DbRoom; player: DbPlayer }> {
  if (token.length < 40 || token.length > 100) throw new ApiError(401, 'UNAUTHORIZED', '玩家凭证无效')
  const room = await roomByCode(code)
  const { data } = await client.from('players').select('*').eq('room_id', room.id).eq('token_hash', await tokenHash(token)).maybeSingle()
  if (!data || !(data as DbPlayer).is_active) throw new ApiError(401, 'UNAUTHORIZED', '玩家凭证无效')
  return { room, player: data as DbPlayer }
}

async function snapshot(code: string, token: string) {
  const { player } = await authenticate(code, token)
  const { error: syncError } = await client.rpc('sync_room_state', { p_code: code })
  if (syncError) throw new ApiError(503, 'ROOM_SYNC_FAILED', '房间状态同步失败')
  const room = await roomByCode(code)
  const [{ data: playerRows }, { data: guessRows }] = await Promise.all([
    client.from('players').select('id,room_id,seat,seat_number,nickname,last_seen_at,rematch_ready,is_active').eq('room_id', room.id).order('seat_number'),
    client.from('guesses').select('id,player_id,display_word,similarity,turn_number,created_at').eq('room_id', room.id).order('created_at'),
  ])
  const now = new Date()
  const answer = room.status === 'finished' && room.answer_ciphertext ? await decryptAnswer(room.answer_ciphertext) : null
  return { room: { code: room.code, status: room.paused_at ? 'paused' : room.status, category: room.category, difficulty: room.difficulty, version: Number(room.version), currentPlayerId: room.current_player_id, turnDeadline: room.turn_deadline, turnNumber: Number(room.turn_number), winnerId: room.winner_id, answer, hostPlayerId: room.host_player_id, maxPlayers: room.max_players, pauseReason: room.pause_reason, semanticThinking: Boolean(room.ai_request_id) }, players: ((playerRows ?? []) as DbPlayer[]).filter((item) => item.is_active).map((item) => ({ id: item.id, seat: Number(item.seat_number), nickname: item.nickname, isHost: item.id === room.host_player_id, isActive: item.is_active, lastSeenAt: item.last_seen_at, online: now.getTime() - new Date(item.last_seen_at).getTime() <= 30000, rematchReady: item.rematch_ready })), guesses: ((guessRows ?? []) as DbGuess[]).map((item) => ({ id: item.id, playerId: item.player_id, displayWord: item.display_word, similarity: item.similarity, turnNumber: Number(item.turn_number), createdAt: item.created_at })), me: { id: player.id, seat: Number((playerRows as DbPlayer[] | null)?.find((item) => item.id === player.id)?.seat_number || 0), isHost: player.id === room.host_player_id }, serverNow: now.toISOString() }
}

async function createRoom(input: JsonObject) {
  const nickname = playerName(input.nickname)
  const category = selection(input.category, '词库', ['随机', '生活', '自然', '文化', '科技'])
  const difficulty = selection(input.difficulty, '难度', ['简单', '普通', '困难', '极难'])
  const playerToken = createToken()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000
    const code = String(random).padStart(6, '0')
    const { data: room, error } = await client.from('rooms').insert({ code, category, difficulty, max_players: 8, visibility: 'public' }).select('id').single()
    if (error) continue
    const { data: player, error: playerError } = await client.from('players').insert({ room_id: room.id, seat: 'A', seat_number: 1, ...(nickname ? { nickname } : {}), token_hash: await tokenHash(playerToken) }).select('id').single()
    if (playerError) throw new ApiError(500, 'CREATE_FAILED', '创建玩家失败')
    const { error: hostError } = await client.from('rooms').update({ host_player_id: player.id }).eq('id', room.id)
    if (hostError) throw new ApiError(500, 'CREATE_FAILED', '创建房主失败')
    const { error: eventError } = await client.rpc('touch_room_event', { p_code: code, p_version: 1 })
    if (eventError) throw new ApiError(500, 'CREATE_FAILED', '创建房间事件失败')
    return { roomCode: code, playerToken, playerId: player.id }
  }
  throw new ApiError(503, 'CODE_EXHAUSTED', '暂时无法分配房间码')
}

async function joinRoom(input: JsonObject) {
  const code = roomCode(input.roomCode); const nickname = playerName(input.nickname)
  const playerToken = createToken()
  const { data: playerId, error } = await client.rpc('join_room', { p_code: code, p_nickname: nickname, p_token_hash: await tokenHash(playerToken) })
  if (error || !playerId) {
    const message = error?.message || ''
    if (message.includes('ROOM_NOT_FOUND')) throw new ApiError(404, 'ROOM_NOT_FOUND', '房间不存在')
    if (message.includes('ROOM_NOT_WAITING')) throw new ApiError(409, 'ROOM_STARTED', '对局已经开始')
    throw new ApiError(409, 'ROOM_FULL', '房间已满')
  }
  return { roomCode: code, playerToken, playerId }
}

async function start(input: JsonObject, code: string) {
  const token = text(input.playerToken, '玩家令牌', 100)
  const { room, player } = await authenticate(code, token)
  if (player.id !== room.host_player_id) throw new ApiError(403, 'HOST_ONLY', '仅房主可以开始')
  if (room.status !== 'waiting') return snapshot(code, token)
  const selected = await claimWord(room.category, room.difficulty)
  const { error } = await client.rpc('start_game', { p_code: code, p_token_hash: await tokenHash(token), p_answer_ciphertext: await encryptAnswer(selected.word), p_answer_word_id: selected.id })
  if (error) throw new ApiError(409, 'START_CONFLICT', '开始状态冲突')
  return snapshot(code, token)
}

async function guess(input: JsonObject, code: string) {
  const token = text(input.playerToken, '玩家令牌', 100); const requestId = text(input.requestId, 'requestId', 36); const displayWord = guessWord(input.guess)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new ApiError(400, 'INVALID_REQUEST_ID', 'requestId 必须是 UUID')
  if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) throw new ApiError(400, 'INVALID_VERSION', '缺少权威版本')
  const expectedVersion = Number(input.expectedVersion)
  const { player } = await authenticate(code, token)
  const { error: syncError } = await client.rpc('sync_room_state', { p_code: code })
  if (syncError) throw new ApiError(503, 'ROOM_SYNC_FAILED', '房间状态同步失败')
  const room = await roomByCode(code)
  const { data: prior } = await client.from('guesses').select('id').eq('room_id', room.id).eq('request_id', requestId).maybeSingle()
  if (prior) return snapshot(code, token)
  const normalized = normalizeWord(displayWord)
  if (!normalized) throw new ApiError(400, 'INVALID_GUESS', '猜词不能为空')
  if (room.status !== 'playing' || room.current_player_id !== player.id) throw new ApiError(409, 'NOT_YOUR_TURN', '现在不是你的回合')
  if (Number(room.version) !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', '房间状态已变化')
  if (!room.turn_deadline || new Date(room.turn_deadline).getTime() <= Date.now()) throw new ApiError(409, 'TURN_EXPIRED', '本回合已超时')
  if (!room.answer_ciphertext) throw new ApiError(500, 'ANSWER_MISSING', '对局答案缺失')
  const hash = await tokenHash(token)
  const { data: lockedVersion, error: lockError } = await client.rpc('begin_guess', { p_code: code, p_token_hash: hash, p_request_id: requestId, p_expected_version: expectedVersion })
  if (lockError) throw new ApiError(409, 'GUESS_CONFLICT', '回合状态已变化')
  let committed = false
  try {
    const [{ data: repeated }, { data: rows }] = await Promise.all([
      client.from('guesses').select('similarity').eq('room_id', room.id).eq('normalized_word', normalized).order('created_at').limit(1).maybeSingle(),
      client.from('guesses').select('display_word,similarity').eq('room_id', room.id).order('created_at'),
    ])
    const answer = await decryptAnswer(room.answer_ciphertext)
    let similarity = repeated?.similarity ?? 100
    if (!repeated && normalizeWord(answer) !== normalized) {
      const history = ((rows ?? []) as Array<{ display_word: string; similarity: number }>).map((item) => ({ word: item.display_word, similarity: item.similarity }))
      similarity = (await scoreGuess(answer, history, displayWord)).similarity
    }
    const { error } = await client.rpc('commit_guess', { p_code: code, p_token_hash: hash, p_request_id: requestId, p_expected_version: Number(lockedVersion), p_normalized_word: normalized, p_display_word: displayWord, p_similarity: similarity })
    if (error) throw new ApiError(409, 'GUESS_CONFLICT', '提交状态冲突')
    committed = true
    return snapshot(code, token)
  } finally {
    if (!committed) await client.rpc('cancel_guess', { p_code: code, p_token_hash: hash, p_request_id: requestId })
  }
}

async function timeout(input: JsonObject, code: string) {
  const token = text(input.playerToken, '玩家令牌', 100)
  if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) throw new ApiError(400, 'INVALID_VERSION', '缺少权威版本')
  const { error } = await client.rpc('process_timeout', { p_code: code, p_token_hash: await tokenHash(token), p_expected_version: Number(input.expectedVersion) })
  if (error) throw new ApiError(409, 'TIMEOUT_CONFLICT', '超时状态冲突')
  return snapshot(code, token)
}

async function heartbeat(input: JsonObject, code: string) {
  const token = text(input.playerToken, '玩家令牌', 100)
  const { error } = await client.rpc('heartbeat_room', { p_code: code, p_token_hash: await tokenHash(token) })
  if (error) throw new ApiError(409, 'HEARTBEAT_CONFLICT', '保活状态冲突')
  return snapshot(code, token)
}

async function rematch(input: JsonObject, code: string) {
  const token = text(input.playerToken, '玩家令牌', 100)
  const { error } = await client.rpc('request_rematch', { p_code: code, p_token_hash: await tokenHash(token) })
  if (error) throw new ApiError(409, 'REMATCH_CONFLICT', '再来一局状态冲突')
  return snapshot(code, token)
}

async function leave(input: JsonObject, code: string) {
  const token = text(input.playerToken, '玩家令牌', 100)
  const { error } = await client.rpc('leave_room', { p_code: code, p_token_hash: await tokenHash(token) })
  if (error) throw new ApiError(409, 'LEAVE_CONFLICT', '离开房间状态冲突')
  return { left: true }
}

async function resume(input: JsonObject, code: string) {
  const token = text(input.playerToken, '玩家令牌', 100)
  const { error } = await client.rpc('resume_room', { p_code: code, p_token_hash: await tokenHash(token) })
  if (error) throw new ApiError(409, 'RESUME_CONFLICT', '浏览器恢复记录已失效')
  return snapshot(code, token)
}

async function lobby() {
  const { data, error } = await client.rpc('list_public_rooms')
  if (error) throw new ApiError(503, 'LOBBY_UNAVAILABLE', '房间大厅暂时不可用')
  return (data || []).map((room: JsonObject) => ({ code: room.code, category: room.category, difficulty: room.difficulty, status: room.status, maxPlayers: room.max_players, playerCount: room.player_count, updatedAt: room.updated_at, destroyAt: room.destroy_at ?? null }))
}

async function route(request: Request): Promise<unknown> {
  const url = new URL(request.url)
  const marker = '/game/'
  const path = url.pathname.includes(marker) ? url.pathname.slice(url.pathname.indexOf(marker) + marker.length) : url.pathname.endsWith('/game') ? '' : url.pathname.replace(/^\/+/, '')
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent)
  if (request.method === 'GET' && segments.length === 1 && segments[0] === 'rooms') return lobby()
  if (request.method === 'POST' && segments.length === 1 && segments[0] === 'rooms') return createRoom(await requestBody(request))
  if (request.method === 'POST' && segments.join('/') === 'rooms/join') return joinRoom(await requestBody(request))
  if (segments[0] !== 'rooms' || !segments[1]) throw new ApiError(404, 'NOT_FOUND', '接口不存在')
  const code = roomCode(segments[1]); const action = segments[2]
  if (request.method === 'GET' && !action) {
    const authorization = request.headers.get('authorization')
    if (!authorization?.startsWith('Bearer ')) throw new ApiError(401, 'UNAUTHORIZED', '缺少玩家凭证')
    return snapshot(code, authorization.slice(7))
  }
  if (request.method !== 'POST' || !action) throw new ApiError(404, 'NOT_FOUND', '接口不存在')
  const input = await requestBody(request)
  if (action === 'start') return start(input, code)
  if (action === 'guess') return guess(input, code)
  if (action === 'timeout') return timeout(input, code)
  if (action === 'heartbeat') return heartbeat(input, code)
  if (action === 'rematch') return rematch(input, code)
  if (action === 'leave') return leave(input, code)
  if (action === 'resume') return resume(input, code)
  throw new ApiError(404, 'NOT_FOUND', '接口不存在')
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin')
  try {
    assertOrigin(request)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) })
    const data = await route(request)
    return Response.json({ ok: true, data }, { headers: corsHeaders(origin) })
  } catch (error: unknown) {
    const apiError = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL_ERROR', '服务器内部错误')
    return Response.json({ ok: false, error: { code: apiError.code, message: apiError.message } }, { status: apiError.status, headers: corsHeaders(origin) })
  }
})
