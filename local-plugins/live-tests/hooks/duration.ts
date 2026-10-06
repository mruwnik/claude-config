const pad = (n: number) => String(n).padStart(2, '0')

/** Whole seconds as 7s, 1m 05s or 1h 02m 05s. */
export const formatDuration = (ms: number) => {
  const total = Math.round(ms / 1000)
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`
  return m > 0 ? `${m}m ${pad(s)}s` : `${s}s`
}
