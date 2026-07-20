export type HistoryAnchor = { word: string; similarity: number }
export type AiScore = { similarity: number; closerThan: string[]; fartherThan: string[] }
export type ScoreBounds = { min: number; max: number; conflict: boolean }

export function normalizeWord(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function calculateScoreBounds(history: HistoryAnchor[], closerThan: string[], fartherThan: string[]): ScoreBounds {
  const byWord = new Map(history.map((item) => [normalizeWord(item.word), item.similarity]))
  const closerScores = closerThan.map((word) => byWord.get(normalizeWord(word))).filter((score): score is number => score !== undefined)
  const fartherScores = fartherThan.map((word) => byWord.get(normalizeWord(word))).filter((score): score is number => score !== undefined)
  const min = Math.max(0, ...closerScores.map((score) => score + 1))
  const max = Math.min(99, ...fartherScores.map((score) => score - 1))
  return { min, max, conflict: min > max }
}

export function constrainAiScore(history: HistoryAnchor[], score: AiScore): AiScore & { bounds: ScoreBounds } {
  const bounds = calculateScoreBounds(history, score.closerThan, score.fartherThan)
  if (bounds.conflict) return { ...score, bounds }
  return { ...score, similarity: Math.max(bounds.min, Math.min(bounds.max, Math.round(score.similarity))), bounds }
}
