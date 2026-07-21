export type Seat = number
export type RoomStatus = 'waiting' | 'playing' | 'paused' | 'finished'

export type PublicPlayer = {
  id: string
  seat: Seat
  nickname: string
  isHost: boolean
  isActive: boolean
  lastSeenAt: string
  online: boolean
  rematchReady: boolean
}

export type PublicGuess = {
  id: string
  playerId: string
  displayWord: string
  similarity: number
  turnNumber: number
  createdAt: string
}

export type LobbyRoom = {
  code: string
  category: string
  difficulty: string
  status: RoomStatus
  maxPlayers: number
  playerCount: number
  updatedAt: string
  destroyAt: string | null
}

export type GameSnapshot = {
  room: {
    code: string
    status: RoomStatus
    category: string
    difficulty: string
    version: number
    currentPlayerId: string | null
    turnDeadline: string | null
    turnNumber: number
    winnerId: string | null
    answer: string | null
    hostPlayerId: string | null
    maxPlayers: number
    pauseReason: string | null
    aiThinking: boolean
  }
  players: PublicPlayer[]
  guesses: PublicGuess[]
  me: { id: string; seat: Seat; isHost: boolean }
  serverNow: string
}

export type Credential = { roomCode: string; playerToken: string }
