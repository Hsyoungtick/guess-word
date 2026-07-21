import { FormEvent, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Copy, Radio, RotateCcw, Trophy, UserRound } from 'lucide-react'
import { createRoom, joinRoom, leaveRoom, listRooms, requestRematch, resumeRoom, startGame, submitGuess } from '../api'
import { useOnlineGame, type NetworkState } from '../hooks/useOnlineGame'
import type { Credential, LobbyRoom, PublicGuess, PublicPlayer } from '../types'

const categories = ['随机', '生活', '自然', '文化', '科技'] as const
const difficulties = ['简单', '普通', '困难', '极难'] as const
const STORAGE_KEY = 'word-duel-credential'
const ROOM_RECORD_KEY = 'word-duel-room-record'

type RoomRecord = { credential: Credential; nickname: string }

function scoreColor(value: number) {
  return `hsl(${Math.max(0, Math.min(100, value)) * 1.2} 78% 46%)`
}

function loadRoomRecord(): RoomRecord | null {
  try {
    const saved = JSON.parse(localStorage.getItem(ROOM_RECORD_KEY) || 'null') as RoomRecord | null
    if (saved?.credential) return saved
    const credential = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as Credential | null
    return credential ? { credential, nickname: '玩家' } : null
  } catch { return null }
}

function loadCredential(): Credential | null {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as Credential | null } catch { return null }
}

function parseRoomCode(value: string) {
  const input = value.trim()
  try {
    const url = new URL(input)
    return (url.searchParams.get('room') || '').replace(/[^0-9]/g, '').slice(0, 6)
  } catch {
    const queryCode = input.match(/[?&]room=(\d{6})/i)?.[1]
    return (queryCode || input).replace(/[^0-9]/g, '').slice(0, 6)
  }
}

function Presence({ player, network, isMe }: { player?: PublicPlayer; network: NetworkState; isMe: boolean }) {
  const unstable = isMe && network !== 'online'
  const state = !player ? 'empty' : unstable ? 'unstable' : player.online ? 'online' : 'offline'
  const labels = { empty: '等待加入', unstable: '网络波动', online: '在线', offline: '离线' }
  return <span className={`presence ${state}`}><i />{labels[state]}</span>
}

function PlayerPanel({ player, active, guesses, me, network }: { player?: PublicPlayer; active: boolean; guesses: PublicGuess[]; me: boolean; network: NetworkState }) {
  const mine = player ? guesses.filter((item) => item.playerId === player.id) : []
  const best = Math.max(0, ...mine.map((item) => item.similarity))
  return <aside className={`player-panel player-seat-${player?.seat || 0} ${active ? 'is-active' : ''}`}>
    <div className="player-tag">玩家 {player?.seat || '—'}{player?.isHost ? ' · 房主' : ''}{me ? ' · 你' : ''}</div><div className="avatar"><UserRound size={24} /></div>
    <h2>{player?.nickname || '空席位'}</h2><Presence player={player} network={network} isMe={me} />
    <p className="player-status">{active ? '正在调频' : player ? '等待回合' : '等待信号接入'}</p>
    <div className="player-stats"><div><span>最佳信号</span><strong style={{ color: scoreColor(best) }}>{best}%</strong></div><div><span>猜测次数</span><strong>{mine.length}</strong></div></div>
  </aside>
}

function LobbyCard({ room, onJoin, now }: { room: LobbyRoom; onJoin: (room: LobbyRoom) => void; now: number }) {
  const canJoin = (room.status === 'waiting' || room.status === 'paused') && room.playerCount < room.maxPlayers
  const destroySeconds = room.playerCount === 0 && room.destroyAt ? Math.max(0, Math.ceil((new Date(room.destroyAt).getTime() - now) / 1000)) : null
  return <article className="lobby-card"><div><span className="room-code">{room.code}</span><span className={`room-status ${room.status}`}>{room.status === 'waiting' ? '等待中' : room.status === 'playing' ? '进行中' : '暂停中'}</span>{destroySeconds !== null && <span className="destroy-countdown">{Math.floor(destroySeconds / 60)}:{String(destroySeconds % 60).padStart(2, '0')}</span>}</div><h3>{room.category} · {room.difficulty}</h3><p>{room.playerCount}/{room.maxPlayers} 位玩家</p><button disabled={!canJoin} onClick={() => onJoin(room)}>{canJoin ? '加入房间' : '不可加入'}<ArrowRight size={16} /></button></article>
}

export default function Home() {
  const [credential, setCredential] = useState<Credential | null>(loadCredential)
  const [roomRecord, setRoomRecord] = useState<RoomRecord | null>(loadRoomRecord)
  const [locationKey, setLocationKey] = useState(() => location.search)
  const inRoom = Boolean(credential && parseRoomCode(new URLSearchParams(locationKey).get('room') || '') === credential.roomCode)
  const { snapshot, setSnapshot, network, error: syncError } = useOnlineGame(credential, inRoom)

  useEffect(() => {
    const onPopState = () => setLocationKey(location.search)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (!credential || inRoom) return
    const record = roomRecord || { credential, nickname: '玩家' }
    localStorage.setItem(ROOM_RECORD_KEY, JSON.stringify(record))
    localStorage.removeItem(STORAGE_KEY)
    setRoomRecord(record)
    setCredential(null)
    setSnapshot(null)
    void leaveRoom(credential).catch(() => undefined)
  }, [credential, inRoom, roomRecord, setSnapshot])
  const [nickname, setNickname] = useState('')
  const [roomCode, setRoomCode] = useState(parseRoomCode(new URLSearchParams(location.search).get('room') || ''))
  const [category, setCategory] = useState<(typeof categories)[number]>('随机')
  const [difficulty, setDifficulty] = useState<(typeof difficulties)[number]>('普通')
  const [guess, setGuess] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [copyStatus, setCopyStatus] = useState('')
  const [lobbyRooms, setLobbyRooms] = useState<LobbyRoom[]>([])
  const [lobbyError, setLobbyError] = useState('')
  const [seconds, setSeconds] = useState(60)
  const [lobbyNow, setLobbyNow] = useState(() => Date.now())
  const [historySort, setHistorySort] = useState<'time' | 'score'>('time')

  const players = snapshot?.players || []
  const me = players.find((item) => item.id === snapshot?.me.id)
  const current = players.find((item) => item.id === snapshot?.room.currentPlayerId)
  const latest = snapshot?.guesses.at(-1)
  const rematchReadyCount = players.filter((player) => player.rematchReady).length
  const inviteUrl = snapshot ? `${location.origin}${location.pathname}?room=${snapshot.room.code}` : ''
  const sortedHistory = useMemo(() => {
    const guesses = [...(snapshot?.guesses || [])]
    return historySort === 'score' ? guesses.sort((a, b) => b.similarity - a.similarity || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) : guesses.reverse()
  }, [historySort, snapshot?.guesses])

  useEffect(() => {
    if (!snapshot?.room.turnDeadline) { setSeconds(60); return }
    const serverOffset = new Date(snapshot.serverNow).getTime() - Date.now()
    const tick = () => setSeconds(Math.max(0, Math.ceil((new Date(snapshot.room.turnDeadline!).getTime() - (Date.now() + serverOffset)) / 1000)))
    tick(); const id = window.setInterval(tick, 250); return () => window.clearInterval(id)
  }, [snapshot?.room.turnDeadline, snapshot?.serverNow])

  useEffect(() => {
    if (inRoom) return
    let disposed = false
    const refreshLobby = async () => { try { const rooms = await listRooms(); if (!disposed) { setLobbyRooms(rooms); setLobbyError('') } } catch (reason) { if (!disposed) setLobbyError(reason instanceof Error ? reason.message : '大厅加载失败') } }
    void refreshLobby(); const id = window.setInterval(() => void refreshLobby(), 5000); const clock = window.setInterval(() => setLobbyNow(Date.now()), 1000)
    return () => { disposed = true; window.clearInterval(id); window.clearInterval(clock) }
  }, [inRoom])

  function saveCredential(value: Credential, nicknameValue = nickname) {
    const record = { credential: value, nickname: nicknameValue || '玩家' }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); localStorage.setItem(ROOM_RECORD_KEY, JSON.stringify(record)); setCredential(value); setRoomRecord(record); history.pushState(null, '', `${location.pathname}?room=${value.roomCode}`); window.dispatchEvent(new PopStateEvent('popstate'))
  }
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> { setBusy(true); setActionError(''); try { return await action() } catch (reason) { setActionError(reason instanceof Error ? reason.message : '操作失败') } finally { setBusy(false) } }
  function goHome() {
    if (credential && inRoom) { void exitToLobby(); return }
    history.pushState(null, '', location.pathname)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  async function returnToRoom() {
    if (!roomRecord) return
    const value = await run(() => resumeRoom(roomRecord.credential))
    if (value) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(roomRecord.credential))
      setCredential(roomRecord.credential)
      setSnapshot(value)
      history.pushState(null, '', `${location.pathname}?room=${roomRecord.credential.roomCode}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }
  }
  async function exitToLobby() {
    if (credential) await leaveRoom(credential).catch(() => undefined)
    if (credential) {
      const record = { credential, nickname: me?.nickname || '玩家' }
      localStorage.setItem(ROOM_RECORD_KEY, JSON.stringify(record)); setRoomRecord(record)
    }
    localStorage.removeItem(STORAGE_KEY); setCredential(null); setSnapshot(null)
    history.pushState(null, '', location.pathname); window.dispatchEvent(new PopStateEvent('popstate'))
  }
  async function create(event: FormEvent) { event.preventDefault(); const result = await run(() => createRoom({ nickname: nickname.trim() || undefined, category, difficulty })); if (result) saveCredential(result as Credential) }
  async function join(event: FormEvent) { event.preventDefault(); if (roomCode.length !== 6) { setActionError('请输入 6 位数字房间码'); return }; const result = await run(() => joinRoom({ nickname: nickname.trim() || undefined, roomCode })); if (result) saveCredential(result as Credential) }
  async function joinLobby(room: LobbyRoom) { setRoomCode(room.code); const result = await run(() => joinRoom({ nickname: nickname.trim() || undefined, roomCode: room.code })); if (result) saveCredential(result as Credential) }
  async function copyInvite() { setCopyStatus(''); try { await navigator.clipboard.writeText(inviteUrl); setCopyStatus('邀请链接已复制') } catch { setCopyStatus(`请手动复制：${inviteUrl}`) } }
  async function command(action: () => Promise<typeof snapshot>) { const value = await run(action); if (value) setSnapshot(value) }
  async function sendGuess(event: FormEvent) { event.preventDefault(); if (!credential || !snapshot || !guess.trim() || snapshot.room.currentPlayerId !== me?.id) return; const word = [...guess.trim()].slice(0, 8).join(''); setGuess(''); await command(() => submitGuess(credential, word, snapshot.room.version)) }

  const setup = <section className="setup-stage" id="top"><div className="title-block"><p className="eyebrow">远程多人 · 向量语义猜词对战</p><h1>对上<span>词频</span><br />一猜定胜负</h1><p className="intro">创建公开房间，最多 8 位玩家轮流猜词。昵称可留空，系统会随机生成“玩家ABCDEF”格式昵称。</p></div><div className="control-console"><div className="console-header"><span>在线调频台</span><span className="console-code">NET-08</span></div><label className="name-field coral lobby-name"><span>你的昵称（可选）</span><input maxLength={20} value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="默认随机生成 玩家ABCDEF" /></label><form onSubmit={create}><fieldset><legend>创建房间 · 选择词库频道</legend><div className="choice-row">{categories.map((item) => <button type="button" className={category === item ? 'selected' : ''} onClick={() => setCategory(item)} key={item}>{item}</button>)}</div></fieldset><fieldset><legend>信号干扰强度</legend><div className="difficulty-row">{difficulties.map((item, index) => <button type="button" className={difficulty === item ? 'selected' : ''} onClick={() => setDifficulty(item)} key={item}><span>{item}</span><i>{'●'.repeat(index + 1)}</i></button>)}</div></fieldset><button disabled={busy} className="start-button" type="submit"><span>创建公开房间</span><ArrowRight size={23} /></button></form><div className="join-divider"><span>或使用六位数字房码</span></div><form className="join-form" onSubmit={join}><input aria-label="六位数字房间码或邀请链接" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={roomCode} onChange={(e) => setRoomCode(parseRoomCode(e.target.value))} onPaste={(e) => { const code = parseRoomCode(e.clipboardData.getData('text')); if (code) { e.preventDefault(); setRoomCode(code) } }} placeholder="000000" /><button type="submit" disabled={busy}>{busy ? '加入中…' : '加入'}</button></form>{(actionError || syncError) && <p className="error-message">{actionError || syncError}</p>}<p className="privacy-note">目标答案与向量服务密钥只留在服务端</p></div><div className="dial-art" aria-hidden="true"><span>0</span><span>50</span><span>100</span><div className="needle" /></div></section>

  if (!inRoom) return <main className="app-shell"><div className="noise" aria-hidden="true" /><header className="topbar"><button className="brand" onClick={goHome}><span className="brand-mark"><Radio size={22} /></span><span>词频对决</span></button><div className="broadcast"><i /> ONLINE LOBBY</div></header>{roomRecord && !inRoom && <section className="resume-banner"><span>浏览器记录：房间 {roomRecord.credential.roomCode}</span><button onClick={() => void returnToRoom()}>返回房间 <ArrowRight size={16} /></button></section>}{setup}<section className="lobby-section"><div className="history-heading"><div><span>PUBLIC CHANNELS</span><h2>在线房间大厅</h2></div><span>{lobbyRooms.length} 个房间</span></div>{lobbyError && <p className="error-message">{lobbyError}</p>}{lobbyRooms.length ? <div className="lobby-grid">{lobbyRooms.map((room) => <LobbyCard key={room.code} room={room} onJoin={joinLobby} now={lobbyNow} />)}</div> : <div className="empty-history">当前没有可加入的公开房间。</div>}</section></main>

  if (!snapshot) return <main className="app-shell"><div className="noise" aria-hidden="true" /><header className="topbar"><button className="brand" onClick={goHome}><span className="brand-mark"><Radio size={22} /></span><span>词频对决</span></button></header><section className="loading-stage"><Radio className="loading-radio" size={44} /><h1>正在连接频道</h1><p>{syncError || '同步服务端权威状态…'}</p></section></main>

  const playerGrid = <div className="player-grid">{players.map((player) => <PlayerPanel key={player.id} player={player} active={snapshot.room.status === 'playing' && current?.id === player.id} guesses={snapshot.guesses} me={me?.id === player.id} network={network} />)}</div>
  return <main className="app-shell"><div className="noise" aria-hidden="true" /><header className="topbar"><button className="brand" onClick={goHome}><span className="brand-mark"><Radio size={22} /></span><span>词频对决</span></button><div className="broadcast"><i /> {snapshot.room.code} · {network === 'online' ? 'ONLINE' : 'NETWORK CHECK'}</div></header><section className="game-stage"><div className="game-meta"><span>房间 {snapshot.room.code}</span><span>{players.length}/{snapshot.room.maxPlayers} 位玩家</span><span>{snapshot.room.category} · {snapshot.room.difficulty}</span><span className={`network-${network}`}>{network === 'online' ? '已连接' : network === 'connecting' ? '连接中' : network === 'unstable' ? '网络波动' : '离线'}</span></div>{snapshot.room.status === 'paused' && <div className="pause-banner">{snapshot.room.pauseReason === 'WAITING_FOR_PLAYERS' ? '房间只剩一位玩家，对局已暂停。等待其他玩家加入后继续。' : '房间暂无在线玩家，五分钟后会自动销毁。'}</div>}{snapshot.room.status === 'waiting' && <div className="waiting-head"><div className="channel-card"><p className="eyebrow">PUBLIC CHANNEL</p><h1>{snapshot.room.code}</h1><p>最多 {snapshot.room.maxPlayers} 人 · {snapshot.room.category} · {snapshot.room.difficulty}</p><button type="button" onClick={() => void copyInvite()}><Copy size={17} />{copyStatus === '邀请链接已复制' ? '已复制' : '复制邀请链接'}</button>{copyStatus && <p className="copy-status" role="status">{copyStatus}</p>}</div><p className="waiting-note">{players.length < 2 ? '等待其他玩家接入频道…' : me?.isHost ? '信号已就绪，可以开始对决' : '等待房主开始对局'}</p>{me?.isHost && <button className="start-button waiting-start" disabled={busy || players.length < 2} onClick={() => credential && command(() => startGame(credential))}><span>{busy ? '正在抽取词语…' : '房主开始对决'}</span><ArrowRight /></button>}</div>}{snapshot.room.status === 'playing' && <section className="tuning-console"><div className="turn-banner">{snapshot.room.semanticThinking || busy ? '向量计算中' : `轮到 ${current?.nickname || '下一位玩家'}`}{!snapshot.room.semanticThinking && !busy && <span className={`timer ${seconds <= 8 ? 'urgent' : ''}`}>{seconds}s</span>}</div><div className="score-display"><span className="score-label">{latest ? '最新猜词' : '等待首次猜词'}</span><div className="latest-word">{latest?.displayWord || '——'}</div><strong style={{ color: scoreColor(latest?.similarity || 0) }}>{latest?.similarity || 0}<small>%</small></strong><div className="meter"><i style={{ width: `${latest?.similarity || 0}%`, background: `linear-gradient(90deg, ${scoreColor(latest?.similarity || 0)}, ${scoreColor(Math.min(100, (latest?.similarity || 0) + 18))})` }} /></div><div className="meter-ticks"><span>微弱</span><span>接近</span><span>命中</span></div></div><form className="guess-form" onSubmit={sendGuess}><label htmlFor="guess">{snapshot.room.currentPlayerId === me?.id ? '输入你的猜测（1～8 字）' : `等待 ${current?.nickname || '玩家'} 发射信号`}</label><div><input id="guess" disabled={busy || snapshot.room.semanticThinking || snapshot.room.currentPlayerId !== me?.id || seconds <= 0} maxLength={8} value={guess} onChange={(e) => setGuess([...e.target.value].slice(0, 8).join(''))} placeholder="1～8 个字" /><button disabled={busy || snapshot.room.currentPlayerId !== me?.id || !guess.trim()}>发射</button></div></form></section>}{snapshot.room.status === 'finished' && <div className="winner-card"><Trophy size={42} /><p>本局胜者</p><h2>{players.find((p) => p.id === snapshot.room.winnerId)?.nickname}</h2><strong>成功锁定：{snapshot.room.answer}</strong><button disabled={busy || Boolean(me?.rematchReady)} onClick={() => credential && command(() => requestRematch(credential))}><RotateCcw size={18} />{me?.rematchReady ? '已确认，等待其他玩家' : '确认再来一局'}</button><small>{rematchReadyCount}/{players.length} 位玩家已确认</small></div>}{playerGrid}<section className="history-board"><div className="history-heading"><div><span>公开波段</span><h2>猜测记录</h2></div><div className="history-tools"><span>共 {sortedHistory.length} 次信号</span><button className={historySort === 'time' ? 'selected' : ''} onClick={() => setHistorySort('time')}>按时间</button><button className={historySort === 'score' ? 'selected' : ''} onClick={() => setHistorySort('score')}>按百分比</button></div></div>{sortedHistory.length ? <div className="history-list">{sortedHistory.map((item) => { const player = players.find((p) => p.id === item.playerId); return <div className={`history-item p${player?.seat || 1}`} key={item.id}><span className="history-player">{player?.nickname}</span><strong>{item.displayWord}</strong><b style={{ color: scoreColor(item.similarity) }}>{item.similarity}%</b></div> })}</div> : <div className="empty-history">频道还很安静，第一条猜测会出现在这里。</div>}</section><div className="room-actions"><button className="quit-button danger" onClick={() => void exitToLobby()}>退出房间</button></div></section></main>
}
