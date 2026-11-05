import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import about from './about.json'
import App from './App.tsx'
import './index.css'

// index.html holds only the slug, so the title shows the name however long it is.
document.title = about.name

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
