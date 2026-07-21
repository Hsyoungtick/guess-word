export type HistoryAnchor = { word: string; similarity: number }
export type SemanticScore = { similarity: number; closerThan: string[]; fartherThan: string[] }
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

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) throw new Error('向量维度不一致')
  let dot = 0; let leftNorm = 0; let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm === 0 || rightNorm === 0) throw new Error('向量不能为空')
  return dot / Math.sqrt(leftNorm * rightNorm)
}

export function calibrateSimilarity(value: number, floor = 0.45, ceiling = 0.86, gamma = 1.85): number {
  if (floor >= ceiling) throw new Error('校准区间无效')
  if (gamma <= 0) throw new Error('分数曲线无效')
  const normalized = Math.max(0, Math.min(1, (value - floor) / (ceiling - floor)))
  const curved = normalized ** gamma
  return Math.max(0, Math.min(99, Math.round(curved * 99)))
}

export function constrainSemanticScore(history: HistoryAnchor[], score: SemanticScore): SemanticScore & { bounds: ScoreBounds } {
  const bounds = calculateScoreBounds(history, score.closerThan, score.fartherThan)
  if (bounds.conflict) return { ...score, bounds }
  return { ...score, similarity: Math.max(bounds.min, Math.min(bounds.max, Math.round(score.similarity))), bounds }
}
