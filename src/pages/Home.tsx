import { FormEvent, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Copy, Radio, RotateCcw, Sparkles, Trophy, UserRound } from 'lucide-react'
import { createRoom, joinRoom, requestRematch, startGame, submitGuess } from '../api'
import { useOnlineGame, type NetworkState } from '../hooks/useOnlineGame'
import type { Credential, PublicGuess, PublicPlayer, Seat } from '../types'

const categories = ['随机', '生活', '自然', '文化', '科技'] as const
const difficulties = ['简单', '普通', '困难'] as const
const STORAGE_KEY = 'word-duel-credential'

function loadCredential(): Credential | null {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as Credential | null } catch { return null }
}

function parseRoomCode(value: string) {
  const input = value.trim()
  try {
    const url = new URL(input)
    return (url.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  } catch {
    const queryCode = input.match(/[?&]room=([A-Z0-9]{6})/i)?.[1]
    return (queryCode || input).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  }
}

function Presence({ player, network, isMe }: { player?: PublicPlayer; network: NetworkState; isMe: boolean }) {
  const unstable = isMe && network !== 'online'
  const state = !player ? 'empty' : unstable ? 'unstable' : player.online ? 'online' : 'offline'
  const labels = { empty: '等待加入', unstable: '网络波动', online: '在线', offline: '离线' }
  return <span className={`presence ${state}`}><i />{labels[state]}</span>
}

function PlayerPanel({ player, seat, active, guesses, me, network }: { player?: PublicPlayer; seat: Seat; active: boolean; guesses: PublicGuess[]; me: boolean; network: NetworkState }) {
  const mine = player ? guesses.filter((item) => item.playerId === player.id) : []
  const best = Math.max(0, ...mine.map((item) => item.similarity))
  return <aside className={`player-panel player-${seat === 'A' ? 1 : 2} ${active ? 'is-active' : ''}`}>
    <div className="player-tag">玩家 {seat}{me ? ' · 你' : ''}</div><div className="avatar"><UserRound size={28} /></div>
    <h2>{player?.nickname || '空席位'}</h2><Presence player={player} network={network} isMe={me} />
    <p className="player-status">{active ? '正在调频' : player ? '等待回合' : '等待信号接入'}</p>
    <div className="player-stats"><div><span>最佳信号</span><strong>{best}%</strong></div><div><span>猜测次数</span><strong>{mine.length}</strong></div></div>
  </aside>
}

export default function Home() {
  const [credential, setCredential] = useState<Credential | null>(loadCredential)
  const { snapshot, setSnapshot, network, error: syncError } = useOnlineGame(credential)
  const [nickname, setNickname] = useState('')
  const [roomCode, setRoomCode] = useState(new URLSearchParams(location.search).get('room')?.toUpperCase() || '')
  const [category, setCategory] = useState<(typeof categories)[number]>('随机')
  const [difficulty, setDifficulty] = useState<(typeof difficulties)[number]>('普通')
  const [guess, setGuess] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [copyStatus, setCopyStatus] = useState('')
  const [seconds, setSeconds] = useState(30)

  const players = snapshot?.players || []
  const me = players.find((item) => item.id === snapshot?.me.id)
  const current = players.find((item) => item.id === snapshot?.room.currentPlayerId)
  const latest = snapshot?.guesses.at(-1)
  const inviteUrl = snapshot ? `${location.origin}${location.pathname}?room=${snapshot.room.code}` : ''
  const sortedHistory = useMemo(() => [...(snapshot?.guesses || [])].reverse(), [snapshot?.guesses])

  useEffect(() => {
    if (!snapshot?.room.turnDeadline) { setSeconds(30); return }
    const serverOffset = new Date(snapshot.serverNow).getTime() - Date.now()
    const tick = () => setSeconds(Math.max(0, Math.ceil((new Date(snapshot.room.turnDeadline!).getTime() - (Date.now() + serverOffset)) / 1000)))
    tick(); const id = window.setInterval(tick, 250); return () => window.clearInterval(id)
  }, [snapshot?.room.turnDeadline, snapshot?.serverNow])

  function saveCredential(value: Credential) { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); setCredential(value) }
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setBusy(true); setActionError('')
    try { return await action() } catch (reason) { setActionError(reason instanceof Error ? reason.message : '操作失败') } finally { setBusy(false) }
  }
  function leave() { localStorage.removeItem(STORAGE_KEY); setCredential(null); history.replaceState(null, '', location.pathname) }

  async function create(event: FormEvent) {
    event.preventDefault(); const result = await run(() => createRoom({ nickname, category, difficulty }))
    if (result) saveCredential(result as Credential)
  }
  async function join(event: FormEvent) {
    event.preventDefault()
    if (!nickname.trim()) { setActionError('请先输入你的昵称'); return }
    if (roomCode.length !== 6) { setActionError('请输入有效的邀请链接或 6 位房间码'); return }
    const result = await run(() => joinRoom({ nickname, roomCode }))
    if (result) saveCredential(result as Credential)
  }
  async function copyInvite() {
    setCopyStatus('')
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setCopyStatus('邀请链接已复制')
    } catch {
      const input = document.createElement('textarea')
      input.value = inviteUrl
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.appendChild(input)
      input.select()
      const copied = document.execCommand('copy')
      input.remove()
      setCopyStatus(copied ? '邀请链接已复制' : `请手动复制：${inviteUrl}`)
    }
  }
  async function command(action: () => Promise<typeof snapshot>) { const value = await run(action); if (value) setSnapshot(value) }
  async function sendGuess(event: FormEvent) {
    event.preventDefault(); if (!credential || !snapshot || !guess.trim()) return
    const word = guess.trim(); setGuess(''); await command(() => submitGuess(credential, word, snapshot.room.version))
  }

  return <main className="app-shell"><div className="noise" aria-hidden="true" />
    <header className="topbar"><a className="brand" href="#top"><span className="brand-mark"><Radio size={22} /></span><span>词频对决</span></a><div className="broadcast"><i /> AI 语义频道 · ONLINE</div></header>
    {!credential ? <section className="setup-stage" id="top"><div className="title-block"><p className="eyebrow">远程双人 · AI 猜词对战</p><h1>对上<span>词频</span><br />一猜定胜负</h1><p className="intro">创建频道并分享六位码。服务端掌控每个 30 秒回合，刷新也不会丢失战局。</p></div>
      <div className="control-console"><div className="console-header"><span>在线调频台</span><span className="console-code">NET-02</span></div>
        <label className="name-field coral lobby-name"><span>你的昵称</span><input maxLength={20} value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="输入昵称" /></label>
        <form onSubmit={create}><fieldset><legend>创建房间 · 选择词库频道</legend><div className="choice-row">{categories.map((item) => <button type="button" className={category === item ? 'selected' : ''} onClick={() => setCategory(item)} key={item}>{item}</button>)}</div></fieldset>
          <fieldset><legend>信号干扰强度</legend><div className="difficulty-row">{difficulties.map((item, index) => <button type="button" className={difficulty === item ? 'selected' : ''} onClick={() => setDifficulty(item)} key={item}><span>{item}</span><i>{'●'.repeat(index + 1)}</i></button>)}</div></fieldset>
          <button disabled={busy || !nickname.trim()} className="start-button" type="submit"><span>创建私人频道</span><ArrowRight size={23} /></button></form>
        <div className="join-divider"><span>或使用邀请频道</span></div><form className="join-form" onSubmit={join}><input aria-label="房间码或邀请链接" value={roomCode} onChange={(e) => setRoomCode(parseRoomCode(e.target.value))} onPaste={(e) => { const code = parseRoomCode(e.clipboardData.getData('text')); if (code) { e.preventDefault(); setRoomCode(code) } }} placeholder="粘贴邀请链接或 6 位房间码" /><button type="submit" disabled={busy}>{busy ? '加入中…' : '加入'}</button></form>
        {(actionError || syncError) && <p className="error-message">{actionError || syncError}</p>}<p className="privacy-note">玩家凭证仅保存在本机，目标答案与 AI 密钥只留在服务端</p></div><div className="dial-art" aria-hidden="true"><span>0</span><span>50</span><span>100</span><div className="needle" /></div></section>
    : !snapshot ? <section className="loading-stage"><Radio className="loading-radio" size={44} /><h1>正在连接频道</h1><p>{syncError || '同步服务端权威状态…'}</p><button className="quit-button" onClick={leave}>返回大厅</button></section>
    : snapshot.room.status === 'waiting' ? <section className="waiting-stage"><div className="channel-card"><p className="eyebrow">PRIVATE CHANNEL</p><h1>{snapshot.room.code}</h1><p>{snapshot.room.category}频道 · {snapshot.room.difficulty}干扰</p><button type="button" onClick={() => void copyInvite()}><Copy size={17} />{copyStatus === '邀请链接已复制' ? '已复制' : '复制邀请链接'}</button>{copyStatus && <p className="copy-status" role="status">{copyStatus}</p>}</div>
      <div className="waiting-players"><PlayerPanel player={players.find((p) => p.seat === 'A')} seat="A" active={false} guesses={[]} me={me?.seat === 'A'} network={network} /><div className="versus">VS</div><PlayerPanel player={players.find((p) => p.seat === 'B')} seat="B" active={false} guesses={[]} me={me?.seat === 'B'} network={network} /></div>
      <p className="waiting-note">{players.length < 2 ? '等待另一位玩家接入频道…' : me?.seat === 'A' ? '信号已就绪，可以开始出题' : '等待房主开始对局'}</p>
      {me?.seat === 'A' && <button className="start-button waiting-start" disabled={busy || players.length < 2} onClick={() => credential && command(() => startGame(credential))}><span>{busy ? 'AI 正在出题…' : '房主开始对决'}</span><ArrowRight /></button>}{actionError && <p className="error-message">{actionError}</p>}<button className="quit-button" onClick={leave}>退出房间</button></section>
    : <section className="game-stage"><div className="game-meta"><span>第 {snapshot.room.turnNumber} 回合</span><span>{snapshot.room.category}频道</span><span className={`network-${network}`}>{network === 'online' ? '已连接' : network === 'connecting' ? '连接中' : network === 'unstable' ? '网络波动' : '离线'}</span></div>
      <div className="arena"><PlayerPanel player={players.find((p) => p.seat === 'A')} seat="A" active={snapshot.room.status === 'playing' && current?.seat === 'A'} guesses={snapshot.guesses} me={me?.seat === 'A'} network={network} />
        <section className="tuning-console"><div className="turn-banner">{snapshot.room.status === 'playing' ? <>轮到 {current?.nickname}<span className={`timer ${seconds <= 8 ? 'urgent' : ''}`}>{seconds}s</span></> : '本局信号已锁定'}</div>
          <div className={`score-display ${(latest?.similarity || 0) >= 80 ? 'hot' : ''}`}><span className="score-label">最新语义关联度</span><strong>{latest?.similarity || 0}<small>%</small></strong><div className="meter"><i style={{ width: `${latest?.similarity || 0}%` }} /></div><div className="meter-ticks"><span>微弱</span><span>接近</span><span>命中</span></div></div>
          <p className="hint"><Sparkles size={17} />{latest?.hint || 'AI 已锁定目标词，等待第一条信号'}</p>
          {snapshot.room.status === 'playing' ? <form className="guess-form" onSubmit={sendGuess}><label htmlFor="guess">{snapshot.room.currentPlayerId === me?.id ? '输入你的猜测' : `等待 ${current?.nickname} 发射信号`}</label><div><input id="guess" disabled={busy || snapshot.room.currentPlayerId !== me?.id || seconds <= 0} maxLength={20} value={guess} onChange={(e) => setGuess(e.target.value)} placeholder="一个中文词语" /><button disabled={busy || snapshot.room.currentPlayerId !== me?.id || !guess.trim()}>发射</button></div><p>倒计时和回合归属由服务端判定</p></form>
          : <div className="winner-card"><Trophy size={42} /><p>本局胜者</p><h2>{players.find((p) => p.id === snapshot.room.winnerId)?.nickname}</h2><strong>成功锁定：{snapshot.room.answer}</strong><button disabled={busy} onClick={() => credential && command(() => requestRematch(credential))}><RotateCcw size={18} />确认再来一局</button><small>双方确认后返回等候房</small></div>}{actionError && <p className="error-message">{actionError}</p>}</section>
        <PlayerPanel player={players.find((p) => p.seat === 'B')} seat="B" active={snapshot.room.status === 'playing' && current?.seat === 'B'} guesses={snapshot.guesses} me={me?.seat === 'B'} network={network} /></div>
      <section className="history-board"><div className="history-heading"><div><span>公开波段</span><h2>猜测记录</h2></div><span>共 {sortedHistory.length} 次信号</span></div>{sortedHistory.length ? <div className="history-list">{sortedHistory.map((item) => { const player = players.find((p) => p.id === item.playerId); return <div className={`history-item p${player?.seat === 'A' ? 1 : 2}`} key={item.id}><span className="history-player">{player?.nickname}</span><strong>{item.displayWord}</strong><span className="history-hint">{item.hint}</span><b>{item.similarity}%</b></div> })}</div> : <div className="empty-history">频道还很安静，第一条猜测会出现在这里。</div>}</section><button className="quit-button" onClick={leave}>退出房间（席位保留）</button></section>}
  </main>
}
