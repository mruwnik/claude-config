/** `path` made absolute against `cwd` with `.` and `..` folded out; a path that is already absolute, or a Windows one, is only folded/kept. */
export const resolvePath = (cwd: string, path: string): string => {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return path
  const joined = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`
  const parts = joined
    .split('/')
    .reduce<string[]>((acc, part) => (part === '' || part === '.' ? acc : part === '..' ? acc.slice(0, -1) : [...acc, part]), [])
  return `/${parts.join('/')}`
}
