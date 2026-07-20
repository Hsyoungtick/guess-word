export type Seat = 'A' | 'B'
export type RoomStatus = 'waiting' | 'playing' | 'finished'

export type PublicPlayer = {
  id: string
  seat: Seat
  nickname: string
  lastSeenAt: string
  online: boolean
}

export type PublicGuess = {
  id: string
  playerId: string
  displayWord: string
  similarity: number
  hint: string
  turnNumber: number
  createdAt: string
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
  }
  players: PublicPlayer[]
  guesses: PublicGuess[]
  me: { id: string; seat: Seat }
  serverNow: string
}

export type Credential = { roomCode: string; playerToken: string }
