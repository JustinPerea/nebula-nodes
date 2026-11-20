import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { takeToken } from './token'
import './extraction.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App token={takeToken()} />
  </StrictMode>,
)
