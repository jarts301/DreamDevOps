import about from './about.json'
import Counter from './components/Counter.tsx'

export default function App() {
  return (
    <>
      <header className="header">
        <span className="brand">{about.name}</span>
      </header>
      <main className="content">
        <h1>{about.name}</h1>
        {about.description ? (
          <p className="description">{about.description}</p>
        ) : (
          <p>
            Describe your app in <code>src/about.json</code>.
          </p>
        )}
        <p>
          Edit <code>src/App.tsx</code> to make this page your own.
        </p>
        <Counter />
      </main>
    </>
  )
}
