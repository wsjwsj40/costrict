import React from 'react'

/** 16×16 线性图标。新增图标只需要往表里加一条 path。 */
export const iconPaths: Record<string, string> = {
  brand: 'M3.2 17.7 9 5.8c.8-1.7 2.5-2.1 3.7-.7l3.1 3.7 M3.2 17.7c-.8 1.7.3 3 2.3 2.4l10-3.7c2.1-.8 3.5-.4 4.4 1.1 M20 9.2v7.9c0 3.1-2.8 3.7-4.5 1.9 M20 4.2h.01',
  edit: 'M3 11.5 2.5 14l2.5-.5 8.1-8.1-2-2L3 11.5Zm7.2-8.1 1.4-1.4a1.4 1.4 0 0 1 2 2l-1.4 1.4',
  command: 'M2 3.2h12v9.6H2zM4.5 6l2.2 2-2.2 2M8.5 10h3',
  copy: 'M5 4h8v10H5zM3 11H2V2h8v1',
  changes: 'M3 2.5h7l3 3v8H3zM9.5 2.5v3H13M5.5 9h5M5.5 11.5h4',
  history: 'M8 2a6 6 0 1 1-5.7 4M8 4v4l2.5 1.5M2 3v3h3',
  new: 'M2.5 2.5h11v11h-11zM8 5v6M5 8h6',
  chat: 'M2 2.5h12v8H7l-4 3v-3H2zM5 5.5h6M5 8h4',
  right: 'M6 3l5 5-5 5',
  check: 'M3 8l3 3 7-7',
  close: 'M4 4l8 8M12 4l-8 8',
  back: 'M9.5 3 4.5 8l5 5M5 8h8',
  search: 'M6.8 2.5a4.3 4.3 0 1 0 0 8.6 4.3 4.3 0 0 0 0-8.6zM10 10l3.5 3.5',
  plus: 'M8 3v10M3 8h10',
  skills: 'M8 1.5 10 5.5 14.5 6.2 11.2 9.4 12 14 8 11.8 4 14 4.8 9.4 1.5 6.2 6 5.5z',
  user: 'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 14c.3-3 2.3-4.5 5.5-4.5s5.2 1.5 5.5 4.5',
  compact: 'M4 2h8M4 14h8M3 3v10M6 5h6M6 8h5M6 11h6M1.5 5h2M1.5 11h2',
  box: 'M2.5 5.5 8 2.5l5.5 3v5L8 13.5 2.5 10.5zM2.5 5.5 8 8.5l5.5-3M8 8.5v5',
  bell: 'M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 13.5a1.6 1.6 0 0 0 3 0',
  settings: 'M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8 1.8v1.4M8 12.8v1.4M2.4 8H3.8M12.2 8h1.4M4 4l1 1M11 11l1 1M12 4l-1 1M5 11l-1 1',
  trash: 'M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5 5 13h6l.5-8.5M7 7v3.5M9 7v3.5',
  upload: 'M8 10.5V3M5 5.5 8 2.5l3 3M3 11.5v1.5h10v-1.5',
  refresh: 'M13 8a5 5 0 1 1-1.6-3.7M13 2v3h-3',
  info: 'M8 7v4M8 4.6v.1M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z',
}

export function Icon({ kind }: { kind: string }) {
  if (kind === 'brand') return <img className="icon" src={document.querySelector<HTMLMetaElement>('meta[name="dicode-brand"]')?.content || ''} alt="" />
  return <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[kind] || iconPaths.command} /></svg>
}

export default Icon
