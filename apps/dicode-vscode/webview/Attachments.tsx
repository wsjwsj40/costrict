import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
export type Attachment = { id?: string; path: string; name: string; kind?: string; size?: number; src?: string; data?: string }
const sizeLabel = (size = 0) => size < 1024 ? `${size} B` : size < 1048576 ? `${Math.round(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`
export function FileGlyph() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 15h6" /></svg> }
export function ImagePreview({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {

    const previous = document.activeElement as HTMLElement
    close.current?.focus()
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); if (event.key === 'Tab') { event.preventDefault(); close.current?.focus() } }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [onClose])
  return createPortal(<div className="attachment-lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label={name}><div className="lightbox-bar"><span>{name}</span><button ref={close} onClick={onClose} aria-label="关闭预览">×</button></div><img src={src} alt={name} onClick={event => event.stopPropagation()} /></div>, document.body)
}
export default function Attachments({ files, onRemove, post }: { files: Attachment[]; onRemove?: (file: Attachment) => void; post: (type: string, data?: any) => void }) {
  const [preview, setPreview] = useState<Attachment | null>(null)
  if (!files?.length) return null
  return <><div className={`file-attachments ${onRemove ? 'draft-files' : 'sent-files'}`}>{files.map(file => {
    const image = file.kind === 'image' || !!file.data
    const ext = file.name.split('.').length > 1 ? file.name.split('.').at(-1)?.toUpperCase() : 'FILE'
    return <div className={`file-chip ${image ? 'is-image' : ''}`} key={file.id || file.path}><button className="file-chip-open" title={image ? `预览 ${file.name}` : `打开 ${file.name}`} onClick={() => image ? setPreview(file) : post('openAttachment', { id: file.id })}><span className="file-chip-icon">{image && (file.src || file.data) ? <img src={file.src || file.data} alt="" /> : <FileGlyph />}</span><span className="file-chip-info"><strong>{file.name}</strong><small>{image ? '图片' : ext} · {file.size == null ? '附件' : sizeLabel(file.size)}</small></span></button>{onRemove && <button className="file-chip-remove" title={`移除 ${file.name}`} aria-label={`移除 ${file.name}`} onClick={() => onRemove(file)}>×</button>}</div>
  })}</div>{preview && <ImagePreview src={preview.src || preview.data || ''} name={preview.name} onClose={() => setPreview(null)} />}</>
}
