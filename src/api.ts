import type { Credential, GameSnapshot } from './types'

type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: { message: string } }
const functionBase = (import.meta.env.VITE_SUPABASE_FUNCTION_URL || '').replace(/\/+$/, '')
const legacyBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')
const API_BASE = functionBase || legacyBase
const API_PREFIX = functionBase ? '' : '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE) throw new Error('游戏服务地址未配置')
  let response: Response
  try {
    response = await fetch(`${API_BASE}${API_PREFIX}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new Error('无法连接游戏服务器，请检查网络')
  }
  let result: ApiResponse<T>
  try { result = await response.json() as ApiResponse<T> } catch { throw new Error('游戏服务器返回了无效响应') }
  if (!response.ok || 'error' in result) throw new Error('error' in result ? result.error.message : '请求失败')
  return result.data
}

export async function createRoom(input: { nickname: string; category: string; difficulty: string }) {
  return request<Credential & { playerId: string }>('/rooms', { method: 'POST', body: JSON.stringify(input) })
}

export async function joinRoom(input: { nickname: string; roomCode: string }) {
  return request<Credential & { playerId: string }>('/rooms/join', { method: 'POST', body: JSON.stringify(input) })
}

export async function getSnapshot(credential: Credential) {
  return request<GameSnapshot>(`/rooms/${credential.roomCode}`, { headers: { authorization: `Bearer ${credential.playerToken}` } })
}

function command(path: string, credential: Credential, extra: Record<string, unknown> = {}) {
  return request<GameSnapshot>(`/rooms/${credential.roomCode}/${path}`, {
    method: 'POST', body: JSON.stringify({ playerToken: credential.playerToken, ...extra }),
  })
}

export const startGame = (credential: Credential) => command('start', credential)
export const submitGuess = (credential: Credential, guess: string, expectedVersion: number) =>
  command('guess', credential, { guess, expectedVersion, requestId: crypto.randomUUID() })
export const processTimeout = (credential: Credential, expectedVersion: number) => command('timeout', credential, { expectedVersion })
export const heartbeat = (credential: Credential) => command('heartbeat', credential)
export const requestRematch = (credential: Credential) => command('rematch', credential)
