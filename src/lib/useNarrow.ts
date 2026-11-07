import { useEffect, useState } from 'react'

/** A phone's width: the result screen lays its panels over the drawing there, since beside it they leave it no room. */
export const NARROW_QUERY = '(max-width: 720px)'

const matches = () => typeof window !== 'undefined' && !!window.matchMedia?.(NARROW_QUERY).matches

/** true while the window is a phone's width; follows a turn of the phone or a resize of the window */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(matches)
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW_QUERY)
    if (!mq) return
    const on = () => setNarrow(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return narrow
}
