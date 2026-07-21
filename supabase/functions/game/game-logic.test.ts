import { describe, expect, it } from 'vitest'
import { calculateScoreBounds, calibrateSimilarity, constrainSemanticScore, cosineSimilarity, normalizeWord } from './game-logic'

const history = [
  { word: '苹果', similarity: 72 },
  { word: '汽车', similarity: 18 },
  { word: '水果', similarity: 84 },
]

describe('向量评分基础算法', () => {
  it('计算余弦相似度和校准分数', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(calibrateSimilarity(0.5)).toBe(49)
    expect(calibrateSimilarity(0.1)).toBe(0)
    expect(calibrateSimilarity(0.9)).toBe(99)
  })
})

describe('normalizeWord', () => {
  it('统一全角、大小写、空白与标点', () => {
    expect(normalizeWord(' Ａpple！ ')).toBe('apple')
    expect(normalizeWord('苹 果。')).toBe('苹果')
  })
})

describe('语义相对锚点约束', () => {
  it('计算开区间并钳制分数', () => {
    expect(calculateScoreBounds(history, ['苹果'], ['水果'])).toEqual({ min: 73, max: 83, conflict: false })
    expect(constrainSemanticScore(history, { similarity: 95, closerThan: ['苹果'], fartherThan: ['水果'] }).similarity).toBe(83)
  })

  it('识别互相冲突的锚点', () => {
    expect(calculateScoreBounds(history, ['水果'], ['汽车']).conflict).toBe(true)
  })
})
