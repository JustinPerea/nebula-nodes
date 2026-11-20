import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ApiError, createApi, type Api, type RecordDetail } from './api'
import { acceptDetail, type Opened } from './detail'
import { DropArea } from './DropArea'
import { recordCount } from './format'
import { RecordList } from './RecordList'
import { RecordBoundary } from './RecordBoundary'
import { RecordView } from './RecordView'
import { releaseRenderings } from './rendering'
import { springCssVars } from '../lib/springs'
import type { ExtractionRecord, FolderListing, RecordRow, SourceKind } from './types'

const FOLDER_KEY = 'extraction.folder'
const SPRING_VARS = springCssVars() as CSSProperties

function rememberedFolder(): string {
  try {
    return window.localStorage.getItem(FOLDER_KEY) ?? ''
  } catch {
    return ''
  }
}

function remember(path: string): void {
  try {
    window.localStorage.setItem(FOLDER_KEY, path)
  } catch {
    // Storage can be blocked. The folder just isn't remembered.
  }
}

const sentence = (error: unknown) => (error instanceof ApiError ? error.message : 'That didn’t work. Try again.')

const rowOf = (record: ExtractionRecord): RecordRow => ({
  id: record.id,
  status: record.status,
  name: record.source.name,
  width: record.rendering.width,
  height: record.rendering.height,
  read_at: record.source.read_at,
})

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')

export function App({ token }: { token: string | null }) {
  if (!token) {
    return (
      <div className="ex-app" style={SPRING_VARS}>
        <main className="ex-main">
          <p className="ex-quiet ex-pad">Open the address the server printed when it started.</p>
        </main>
      </div>
    )
  }
  return <Page token={token} />
}

function Page({ token }: { token: string }) {
  const api: Api = useMemo(() => createApi(token), [token])
  const [folderInput, setFolderInput] = useState(rememberedFolder)
  const [folder, setFolder] = useState<string | null>(null)
  const [rows, setRows] = useState<RecordRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RecordDetail | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set())
  const [dragging, setDragging] = useState(false)
  const opening = useRef(0)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const openRef = useRef<Opened | null>(null)
  useEffect(() => {
    openRef.current = folder !== null && selectedId !== null ? { folder, id: selectedId } : null
  }, [folder, selectedId])

  // A read or a correction can finish after the person has opened another record, or the same image in
  // another folder (one id). `from` is the record it was started for; an answer for any other changes nothing.
  const changeDetail = useCallback((next: RecordDetail, from: Opened) => {
    setDetail((current) => acceptDetail(current, next, from, openRef.current))
  }, [])

  const open = useCallback(async (id: string, inFolder: string) => {
    const mine = ++opening.current
    setSelectedId(id)
    try {
      const got = await api.record(id, inFolder)
      if (mine === opening.current) setDetail(got)
    } catch (error) {
      if (mine === opening.current) {
        setNotice(sentence(error))
        setSelectedId(null)
      }
    }
  }, [api])

  const close = useCallback(() => {
    opening.current += 1
    setSelectedId(null)
    setDetail(null)
  }, [])

  const applyListing = useCallback((listing: FolderListing, path: string) => {
    releaseRenderings()
    opening.current += 1
    setFolder(listing.folder)
    setRows(listing.records)
    setSelectedId(null)
    setDetail(null)
    setArrived(new Set())
    remember(path)
  }, [])

  const chooseFolder = useCallback((path: string) => {
    setNotice(null)
    const typed = path.trim()
    api.folder(typed).then((listing) => applyListing(listing, typed), (error: unknown) => setNotice(sentence(error)))
  }, [api, applyListing])

  const addFiles = useCallback((files: File[], kind: SourceKind) => {
    if (!folder) {
      setNotice('Choose a records folder first.')
      return
    }
    const run = async () => {
      setNotice(null)
      let last: string | null = null
      for (const [i, file] of files.entries()) {
        setBusy(files.length > 1 ? `Measuring ${i + 1} of ${files.length}` : 'Measuring')
        try {
          const { record } = await api.addRecord(folder, file, kind)
          last = record.id
          setRows((now) => (now.some((r) => r.id === record.id) ? now : [rowOf(record), ...now]))
          setArrived((now) => new Set(now).add(record.id))
        } catch (error) {
          const why = sentence(error)
          setNotice(files.length > 1 ? `Skipped ${file.name || 'an image'}. ${why}` : why)
        }
      }
      setBusy(null)
      if (last) await open(last, folder)
    }
    queue.current = queue.current.then(run, run)
  }, [api, folder, open])

  // Open the folder used last time, if it is still there.
  useEffect(() => {
    const remembered = rememberedFolder().trim()
    if (!remembered) return
    let live = true
    api.folder(remembered).then(
      (listing) => {
        if (live) applyListing(listing, remembered)
      },
      (error: unknown) => {
        if (live) setNotice(sentence(error))
      },
    )
    return () => {
      live = false
    }
  }, [api, applyListing])

  useEffect(() => {
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      setDragging(true)
    }
    const leave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragging(false)
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      setDragging(false)
      addFiles(Array.from(event.dataTransfer?.files ?? []), 'drop')
    }
    const paste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
      if (!files.length) return
      event.preventDefault()
      addFiles(files, 'paste')
    }
    window.addEventListener('dragenter', over)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('dragenter', over)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('paste', paste)
    }
  }, [addFiles])

  const shown = detail && detail.record.id === selectedId ? detail : null

  return (
    <div className="ex-app" style={SPRING_VARS}>
      <header className="ex-top">
        <h1 className="ex-title">Extraction</h1>
        <form
          className="ex-folder"
          onSubmit={(event) => {
            event.preventDefault()
            chooseFolder(folderInput)
          }}
        >
          <input
            className="ex-input"
            type="text"
            value={folderInput}
            onChange={(event) => setFolderInput(event.target.value)}
            placeholder="Records folder, for example ~/Pictures/extraction"
            aria-label="Records folder"
            spellCheck={false}
          />
          <button type="submit" className="ex-button" disabled={!folderInput.trim()}>
            Use folder
          </button>
        </form>
        {folder ? (
          <p className="ex-using">
            <span className="ex-using-path" title={folder}>{folder}</span>
            <span className="ex-using-count">{recordCount(rows.length)}</span>
          </p>
        ) : null}
      </header>
      <div className="ex-body">
        <nav className="ex-side-list" aria-label="Records">
          {folder ? (
            <>
              <div className="ex-list-head">
                <h2 className="ex-label">Records</h2>
                {busy ? <span className="ex-busy">{busy}</span> : null}
              </div>
              <RecordList api={api} folder={folder} rows={rows} selectedId={selectedId} arrivedIds={arrived} onOpen={(id) => void open(id, folder)} />
            </>
          ) : null}
        </nav>
        <main className={dragging ? 'ex-main ex-dragging' : 'ex-main'}>
          {notice ? <p className="ex-notice" role="alert">{notice}</p> : null}
          {!folder ? (
            <p className="ex-quiet ex-pad">Choose a records folder first.</p>
          ) : shown ? (
            <RecordBoundary key={`${folder}\n${shown.record.id}`} onClose={close}>
              <RecordView api={api} folder={folder} detail={shown} onClose={close} onChange={changeDetail} onNotice={setNotice} />
            </RecordBoundary>
          ) : selectedId ? null : (
            <DropArea active={dragging} onFiles={(files) => addFiles(files, 'file')} />
          )}
        </main>
      </div>
    </div>
  )
}
