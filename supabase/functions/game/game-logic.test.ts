import { describe, expect, it } from 'vitest'
import { calculateScoreBounds, constrainAiScore, normalizeWord } from './game-logic'

const history = [
  { word: '苹果', similarity: 72 },
  { word: '汽车', similarity: 18 },
  { word: '水果', similarity: 84 },
]

describe('normalizeWord', () => {
  it('统一全角、大小写、空白与标点', () => {
    expect(normalizeWord(' Ａpple！ ')).toBe('apple')
    expect(normalizeWord('苹 果。')).toBe('苹果')
  })
})

describe('AI 相对锚点约束', () => {
  it('计算开区间并钳制分数', () => {
    expect(calculateScoreBounds(history, ['苹果'], ['水果'])).toEqual({ min: 73, max: 83, conflict: false })
    expect(constrainAiScore(history, { similarity: 95, closerThan: ['苹果'], fartherThan: ['水果'] }).similarity).toBe(83)
  })

  it('识别互相冲突的锚点', () => {
    expect(calculateScoreBounds(history, ['水果'], ['汽车']).conflict).toBe(true)
  })
})
