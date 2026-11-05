import { useState } from 'react'

export default function Counter() {
  const [count, setCount] = useState(0)

  return (
    <button type="button" onClick={() => setCount((current) => current + 1)}>
      Clicked {count} {count === 1 ? 'time' : 'times'}
    </button>
  )
}
