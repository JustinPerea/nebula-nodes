import { useRef } from 'react'

export function DropArea({ onFiles, active }: { onFiles: (files: File[]) => void; active: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className={active ? 'ex-drop ex-drop-active' : 'ex-drop'}>
      <p className="ex-drop-line">Drop, paste or choose images</p>
      <button type="button" className="ex-button" onClick={() => input.current?.click()}>
        Choose images
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept="image/*,.heic,.heif"
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length) onFiles(files)
        }}
      />
    </div>
  )
}
