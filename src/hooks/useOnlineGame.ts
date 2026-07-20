import { useCallback, useEffect, useRef, useState } from 'react'
import { getSnapshot, heartbeat, processTimeout } from '../api'
import type { Credential, GameSnapshot } from '../types'

export type NetworkState = 'connecting' | 'online' | 'unstable' | 'offline'

export function useOnlineGame(credential: Credential | null, active = true) {
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null)
  const [network, setNetwork] = useState<NetworkState>('connecting')
  const [error, setError] = useState('')
  const failures = useRef(0)
  const timeoutVersion = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    if (!credential) return null
    try {
      const value = await getSnapshot(credential)
      failures.current = 0
      setSnapshot(value)
      setNetwork('online')
      setError('')
      return value
    } catch (reason) {
      failures.current += 1
      setNetwork(failures.current >= 3 ? 'offline' : 'unstable')
      setError(reason instanceof Error ? reason.message : '同步失败')
      return null
    }
  }, [credential])

  useEffect(() => {
    if (!credential || !active) { if (!credential) setSnapshot(null); return }
    setNetwork('connecting')
    void heartbeat(credential).catch(() => undefined)
    void refresh()
    const polling = window.setInterval(() => void refresh(), 3000)
    const pulse = window.setInterval(() => void heartbeat(credential).catch(() => setNetwork('unstable')), 15000)
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.clearInterval(polling); window.clearInterval(pulse); document.removeEventListener('visibilitychange', onVisible) }
  }, [active, credential, refresh])

  useEffect(() => {
    if (!credential || !active || snapshot?.room.status !== 'playing' || !snapshot.room.turnDeadline) return
    const delay = new Date(snapshot.room.turnDeadline).getTime() - new Date(snapshot.serverNow).getTime()
    if (delay > 0 || timeoutVersion.current === snapshot.room.version) return
    timeoutVersion.current = snapshot.room.version
    void processTimeout(credential, snapshot.room.version).then(setSnapshot).catch(() => void refresh())
  }, [active, credential, refresh, snapshot])

  return { snapshot, setSnapshot, network, error, refresh }
}
